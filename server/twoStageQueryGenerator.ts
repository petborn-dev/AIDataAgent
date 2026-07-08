import { invokeLLM } from './_core/llm';
import { queryCacheService } from './queryCacheService';
import { metadataRegistry } from './metadataRegistry';
import { preCorrectionService } from './preCorrectionService';
import { inferTablesFromQuery, COMMON_D365_TABLES } from './coreTableMapping';
import { startLogSession, logStage, completeLogSession, QueryStage, logLlmRequest } from './llm-logger';
import * as db from './db';
import { metadataTables, metadataFields, tableRelationships } from '../drizzle/schema';
import { eq, and } from 'drizzle-orm';

// Dynamic import for CommonJS module
let systemPromptGenerator: any;
const initSystemPromptGenerator = async () => {
  const module = await import('./systemPromptGenerator.cjs');
  systemPromptGenerator = module.systemPromptGenerator;
};

/**
 * Two-Stage Query Generator - Significantly Reduce Token Consumption
 * 
 * Stage 1: Lightweight table inference (~200 tokens)
 * Stage 2: Complete SQL generation (~1,000 tokens vs 8,000+)
 */
export class TwoStageQueryGenerator {
  private static instance: TwoStageQueryGenerator;
  
  static getInstance(): TwoStageQueryGenerator {
    if (!TwoStageQueryGenerator.instance) {
      TwoStageQueryGenerator.instance = new TwoStageQueryGenerator();
    }
    return TwoStageQueryGenerator.instance;
  }

  /**
   * Main entry: Generate optimized query
   */
  async generateQuery(
    userQuery: string,
    userId: number,
    conversationHistory?: Array<{ role: string; content: string }>,
    forceRegenerate: boolean = false,
    knowledgeBaseData?: Array<{ tableName: string; comments: any[] }> // 🆕 Receive correction data
  ): Promise<{
    sql: string;
    explanation: string;
    confidence: string;
    tablesUsed: string[];
    fromCache: boolean;
    tokenOptimization: {
      stage1Tokens: number;
      stage2Tokens: number;
      totalTokens: number;
      savedTokens: number;
    };
  }> {
    // Initialize systemPromptGenerator if needed
    if (!systemPromptGenerator) {
      await initSystemPromptGenerator();
    }

    // Start logging session for two-stage generation
    const logSessionId = startLogSession(userQuery);
    console.log(`[Two-Stage Generator] 📝 Started logging session: ${logSessionId}`);
    
    console.log(`[Two-Stage Generator] Starting optimized query generation`);

    // Check if this is a purchasing person or purchasing group query, force regeneration if so (avoid using wrong cache)
    logStage(logSessionId, QueryStage.STARTED, `Two-stage optimization started for query: "${userQuery}"`);
    
    // TEMPORARILY DISABLE CACHE FOR TESTING
    console.log(`[Two-Stage Generator] Cache disabled for testing - forcing regeneration`);
    
    // Step 2: Two-stage generation
    const stage1Result = await this.stage1_InferTables(userQuery, logSessionId);
    
    if (!stage1Result.success) {
      logStage(logSessionId, QueryStage.ERROR, `Stage 1 failed: ${stage1Result.error}`);
      throw new Error(`Stage 1 failed: ${stage1Result.error}`);
    }

    logStage(logSessionId, QueryStage.PROMPT_BUILDING, "Starting Stage 2: SQL generation");
    const stage2Result = await this.stage2_GenerateSql(userQuery, stage1Result.tables!, knowledgeBaseData, logSessionId, conversationHistory);
    
    // Save to cache
    await queryCacheService.saveQuery(
      userId,
      userQuery,
      stage2Result.sql,
      'success'
    );

    logStage(logSessionId, QueryStage.COMPLETED, `Two-stage optimization completed successfully!`);
    completeLogSession(logSessionId, {
      sql: stage2Result.sql,
      explanation: stage2Result.explanation,
      type: "perfect"
    });

    return {
      sql: stage2Result.sql,
      explanation: stage2Result.explanation,
      confidence: stage2Result.confidence,
      tablesUsed: stage1Result.tables!,
      fromCache: false,
      tokenOptimization: {
        stage1Tokens: stage1Result.tokensUsed || 0,
        stage2Tokens: stage2Result.tokensUsed,
        totalTokens: (stage1Result.tokensUsed || 0) + stage2Result.tokensUsed,
        savedTokens: 8000 - ((stage1Result.tokensUsed || 0) + stage2Result.tokensUsed)
      }
    };
  }

  /**
   * Stage 1: Lightweight table inference using dynamic System Prompt
   * Token consumption: ~200 tokens
   */
  private async stage1_InferTables(userQuery: string, logSessionId?: string): Promise<{
    success: boolean;
    tables?: string[];
    error?: string;
    tokensUsed?: number;
  }> {
    // Initialize systemPromptGenerator if needed
    if (!systemPromptGenerator) {
      await initSystemPromptGenerator();
    }

    try {
      // Use the dynamic System Prompt Generator for table inference
      const fullSystemPrompt = await systemPromptGenerator.generateSystemPrompt();
      
      console.log(`[Stage 1] Using full system prompt with ${fullSystemPrompt.length} characters`);
      
      // Log LLM request for Stage 1
      if (logSessionId) {
        logLlmRequest(
          logSessionId,
          "https://oneapi.laisky.com/v1/chat/completions",
          "gemini-2.5-flash",
          0.5,
          100,
          fullSystemPrompt,
          userQuery
        );
      }
      
      console.log(`[Stage 1] Available tables: ${COMMON_D365_TABLES.slice(0, 10).join(', ')}...`);
      
      const response = await invokeLLM({
        messages: [
          { role: "system", content: fullSystemPrompt },
          { role: "user", content: userQuery }
        ],
        maxTokens: 100
      });

      // Extract content from response (handle both string and array formats)
      let content = '';
      if (typeof response.choices[0]?.message?.content === 'string') {
        content = response.choices[0].message.content;
      } else if (Array.isArray(response.choices[0]?.message?.content)) {
        content = response.choices[0].message.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('');
      }
      
      content = content.trim();
      console.log(`[Stage 1] 🔍 Inferred tables before validation: ${content}`);

      // Parse and validate response
      let inferredTables: string[] = [];
      try {
        inferredTables = JSON.parse(content);
        if (!Array.isArray(inferredTables)) {
          throw new Error('Response is not an array');
        }
      } catch (parseError) {
        console.warn(`[Stage 1] Failed to parse JSON response: ${content}`);
        // Fallback: extract table names from text
        const tableMatches = content.match(/\b[A-Z][a-zA-Z]*Table\b/g) || [];
        inferredTables = tableMatches.slice(0, 4); // Limit to 4 tables
      }

      // Validate against available tables
      const validTables = inferredTables.filter(table => 
        COMMON_D365_TABLES.includes(table)
      );

      if (validTables.length === 0) {
        console.log(`[Stage 1] No valid tables from LLM, using local mapping fallback`);
        // Fallback to local mapping
        const fallbackTables = inferTablesFromQuery(userQuery);
        console.log(`[Stage 1] Local mapping inferred: ${fallbackTables.join(', ')}`);
        
        if (fallbackTables.length === 0) {
          return {
            success: false,
            error: 'No valid tables found'
          };
        }

        return {
          success: true,
          tables: fallbackTables,
          tokensUsed: 100
        };
      }

      console.log(`[Stage 1] Successfully inferred tables: ${validTables.join(', ')}`);
      return {
        success: true,
        tables: validTables,
        tokensUsed: 100
      };

    } catch (error) {
      console.error(`[Stage 1] Error during table inference:`, error);
      
      // Final fallback: try local mapping
      try {
        const fallbackTables = inferTablesFromQuery(userQuery);
        if (fallbackTables.length > 0) {
          console.log(`[Stage 1] Emergency fallback using local mapping: ${fallbackTables.join(', ')}`);
          return {
            success: true,
            tables: fallbackTables,
            tokensUsed: 50
          };
        }
      } catch (fallbackError) {
        console.error(`[Stage 1] Emergency fallback also failed:`, fallbackError);
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during table inference'
      };
    }
  }

  /**
   * Stage 2: Generate complete SQL based on selected tables
   * Token consumption: ~1,000 tokens (vs 8,000+)
   */
  private async stage2_GenerateSql(
    userQuery: string, 
    tables: string[], 
    knowledgeBaseData?: Array<{ tableName: string; comments: any[] }>, // 🆕 Receive correction data
    logSessionId?: string,
    conversationHistory?: Array<{ role: string; content: string }>
  ): Promise<{
    sql: string;
    explanation: string;
    confidence: string;
    tokensUsed: number;
  }> {
    // Get pre-correction hints
    const preCorrectionHints = await preCorrectionService.getPreCorrectionHints(userQuery);
    
    // Get detailed table structure
    const tableSchemas = await this.getTableSchemas(tables);
    
    // 🆕 Use passed correction data instead of reloading
    let knowledgeBaseContext = '';
    if (knowledgeBaseData && knowledgeBaseData.length > 0) {
      knowledgeBaseContext = "## Field Mapping Knowledge Base (User-Validated Mappings)\n\n";
      for (const { tableName, comments } of knowledgeBaseData) {
        knowledgeBaseContext += `### ${tableName} - Field Mappings (User-Validated)\n`;
        comments.forEach(comment => {
          knowledgeBaseContext += `- **${comment.fieldName}**: ${comment.comments} (used ${comment.usageCount} times)\n`;
        });
        knowledgeBaseContext += '\n';
      }
      knowledgeBaseContext += "**IMPORTANT**: Prioritize field mappings from the knowledge base above. These have been validated by users.\n\n";
      knowledgeBaseContext += "**CRITICAL FIELD USAGE RULES**:\n";
      knowledgeBaseContext += "- For 'buyer group' or 'purchasing group' queries, ALWAYS use 'ItemBuyerGroupId' field\n";
      knowledgeBaseContext += "- NEVER use 'BuyerGroupId' or 'PurchasingGroupId' - these are incorrect\n";
      knowledgeBaseContext += "- The correct field is 'ItemBuyerGroupId' for PurchTable\n\n";
      console.log(`[Stage 2] 📚 Using provided knowledge base for ${knowledgeBaseData.length} tables`);
    } else {
      // Fallback: if no data provided, try to load
      try {
        const { commentsDataService } = await import('./commentsDataService');
        
        for (const tableName of tables) {
          const comments = await commentsDataService.getCommentsByTable(tableName);
          if (comments.length > 0) {
            knowledgeBaseContext += `### ${tableName} - Field Mappings (User-Validated)\n`;
            comments.forEach(comment => {
              knowledgeBaseContext += `- **${comment.fieldName}**: ${comment.comments} (used ${comment.usageCount} times)\n`;
            });
            knowledgeBaseContext += '\n';
          }
        }
        
        if (knowledgeBaseContext) {
          knowledgeBaseContext = "## Field Mapping Knowledge Base (User-Validated Mappings)\n\n" + 
                                 knowledgeBaseContext + 
                                 "**IMPORTANT**: Prioritize field mappings from the knowledge base above. These have been validated by users.\n\n" +
                                 "**CRITICAL FIELD USAGE RULES**:\n" +
                                 "- For 'buyer group' or 'purchasing group' queries, ALWAYS use 'ItemBuyerGroupId' field\n" +
                                 "- NEVER use 'BuyerGroupId' or 'PurchasingGroupId' - these are incorrect\n" +
                                 "- The correct field is 'ItemBuyerGroupId' for PurchTable\n\n";
          console.log(`[Stage 2] 📚 Loaded knowledge base for ${tables.length} tables (fallback)`);
        }
      } catch (error) {
        console.warn('[Two-Stage Generator] Failed to load knowledge base:', error);
      }
    }
    
    // Build conversation context block from prior messages (last 6 turns max to stay within token budget)
    let conversationContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-6);
      conversationContext = `\n## Conversation History (most recent turns)\nUse this to understand prior queries, results, and any contradictions the user is asking about.\n\n`;
      for (const msg of recentHistory) {
        conversationContext += `[${msg.role.toUpperCase()}]: ${msg.content}\n\n`;
      }
      conversationContext += `---\nIMPORTANT: If the user is asking about a contradiction or discrepancy between previous results, \nyour SQL must be designed to reconcile those results — not simply re-run one of the prior queries.\n`;
    }

    const systemPrompt = `You are an expert SQL query generator for Microsoft Dynamics 365 F&O.

DATABASE: SQL Server (T-SQL syntax)
RULES:
- Use TOP clause (not LIMIT)
- Use GETDATE() for current date
- Use proper table/field names from D365 F&O
- Generate syntactically correct T-SQL

${preCorrectionHints}

${knowledgeBaseContext}
${conversationContext}
Available Tables:
${tableSchemas}

Generate a SQL query to answer: "${userQuery}"

CRITICAL: Return ONLY valid JSON format. No extra text or explanations outside JSON.

{
  "sql": "SELECT TOP 50 ...",
  "explanation": "Brief explanation",
  "confidence": "high|medium|low"
}`;

    try {
      console.log(`[Stage 2] 🚀 Calling LLM for SQL generation...`);
      const startTime = Date.now();
      
      // Log LLM request for Stage 2
      if (logSessionId) {
        logLlmRequest(
          logSessionId,
          "https://oneapi.laisky.com/v1/chat/completions",
          "gemini-2.5-flash",
          0.6,
          1000,
          systemPrompt,
          userQuery
        );
      }
      
      // Build messages array: system prompt + last 6 history turns (as user/assistant) + current query
      const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-6);
        for (const msg of recentHistory) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            historyMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
          }
        }
      }

      const response = await invokeLLM({
        messages: [
          { role: 'system' as const, content: systemPrompt },
          ...historyMessages,
          { role: 'user' as const, content: userQuery }
        ],
        maxTokens: 1000
      });
      
      const elapsed = Date.now() - startTime;
      console.log(`[Stage 2] ⏱️ LLM response time: ${elapsed}ms`);

      const content = typeof response.choices[0].message.content === 'string' 
        ? response.choices[0].message.content 
        : JSON.stringify(response.choices[0].message.content);

      console.log(`[Stage 2] 🔍 Raw LLM response: ${content.substring(0, 200)}...`);

      // Try to parse JSON, if failed then try to extract
      let result;
      try {
        result = JSON.parse(content);
        console.log(`[Stage 2] ✅ JSON parsed successfully`);
      } catch (parseError) {
        console.log(`[Stage 2] ⚠️ JSON parse failed, trying to extract...`);
        
        // Try to extract JSON object (multiple patterns)
        const jsonPatterns = [
          /\{[\s\S]*?\}/,  // Standard JSON object
          /\{[^{}]*\}/,    // Simple JSON object
          /\{.*?\}/        // Non-greedy match
        ];
        
        let extracted = false;
        for (const pattern of jsonPatterns) {
          const jsonMatch = content.match(pattern);
          if (jsonMatch) {
            try {
              result = JSON.parse(jsonMatch[0]);
              console.log(`[Stage 2] ✅ JSON extracted with pattern`);
              extracted = true;
              break;
            } catch (extractError) {
              continue;
            }
          }
        }
        
        if (!extracted) {
          console.log(`[Stage 2] ⚠️ All JSON extraction failed, generating fallback...`);
          
          // Try to extract SQL from content
          const sqlMatch = content.match(/SELECT[\s\S]*?(?:\n|$)/i);
          let fallbackSql = `SELECT TOP 50 * FROM ${tables[0]} WHERE 1=1`;
          
          if (sqlMatch) {
            // Extract more complete SQL - get everything until the next field or end of response
            const startIndex = content.indexOf(sqlMatch[0]);
            let endIndex = content.length;
            
            // Look for common SQL ending patterns
            const endPatterns = ['FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'HAVING'];
            for (const pattern of endPatterns) {
              const patternIndex = content.indexOf(pattern, startIndex);
              if (patternIndex > startIndex && patternIndex < endIndex) {
                endIndex = patternIndex;
              }
            }
            
            fallbackSql = content.substring(startIndex, endIndex).trim();
            // Clean up newlines and extra spaces
            fallbackSql = fallbackSql.replace(/\n\s+/g, ' ').replace(/\s+/g, ' ');
            console.log(`[Stage 2] Extracted SQL from content`);
          }
          
          result = {
            sql: fallbackSql,
            explanation: `Generated query for ${tables.join(', ')} (LLM response format issue)`,
            confidence: 'medium'
          };
        }
      }
      
      console.log(`[Stage 2] ✅ Generated SQL: ${result.sql.substring(0, 100)}...`);
      
      return {
        sql: result.sql,
        explanation: result.explanation || 'Generated SQL query',
        confidence: result.confidence || 'medium',
        tokensUsed: 1000
      };
      
    } catch (error: any) {
      // If quota error, generate a simple SQL
      if (error.message?.includes('429') || error.message?.includes('quota')) {
        console.log(`[Stage 2] ⚠️ Quota exceeded, generating simple SQL template`);
        
        // Generate a basic SQL template
        const simpleSql = `SELECT TOP 50 * FROM ${tables[0]} WHERE 1=1`;
        
        return {
          sql: simpleSql,
          explanation: `Basic query for ${tables[0]} (quota exceeded, using template)`,
          confidence: 'low',
          tokensUsed: 0
        };
      }
      
      console.error('[Stage 2] ❌ Failed to generate SQL:', error);
      throw error;
    }
  }

  /**
   * Get detailed table structure from enhanced metadata with relationships and table rules
   */
  private async getTableSchemas(tables: string[]): Promise<string> {
    const schemas: string[] = [];
    
    // Import enhanced metadata service
    const { enhancedTableMetadataService } = await import('./enhancedTableMetadataService.cjs');
    
    // Import table rules service
    const { tableRulesService } = await import('./tableRulesService.cjs');
    
    // Get relationships between selected tables
    const relationships = await this.getTableRelationships(tables);
    
    // Get table rules for all selected tables
    const tableRules = await tableRulesService.getAllRules();
    const activeRules = tableRules.filter(rule => rule.isActive && tables.includes(rule.tableName));
    
    for (const tableName of tables) {
      try {
        console.log(`[getTableSchemas] 🔍 Getting enhanced schema for ${tableName}...`);
        
        // Get enhanced table metadata with field details and enum values
        const tableMetadata = await enhancedTableMetadataService.getEnhancedTableMetadata(tableName);
        
        if (!tableMetadata) {
          // Fallback for tables not in enhanced metadata
          schemas.push(`${tableName}:
  Description: ${tableName} from D365 F&O
  Status: Basic info only (not found in enhanced metadata)
  Note: Using table name only`);
          continue;
        }
        
        let schema = `${tableName}:
  Description: ${tableMetadata.table_description || `${tableName} table from D365 F&O`}
  Label: "${tableMetadata.table_label || tableName}"
`;
        
        // Add table rules for this table if any exist
        const rulesForTable = activeRules.filter(rule => rule.tableName === tableName);
        if (rulesForTable.length > 0) {
          schema += `  Table Rules:\n`;
          // Sort by priority (highest first)
          rulesForTable.sort((a, b) => b.priority - a.priority);
          rulesForTable.forEach((rule, index) => {
            schema += `  ${index + 1}. ${rule.tableRule}`;
            if (rule.description) {
              schema += ` (${rule.description})`;
            }
            schema += ` [Priority: ${rule.priority}]\n`;
          });
        }
        
        if (tableMetadata.fields && tableMetadata.fields.length > 0) {
          schema += `  Fields:\n`;
          
          tableMetadata.fields.forEach(field => {
            schema += `  - ${field.field_name}`;
            schema += ` (${field.data_type})`;
            
            if (field.field_label) {
              schema += ` - Label: "${field.field_label}"`;
            }
            
            // Add enum values if available - this is important for SQL generation
            if (field.enum_values && field.enum_values.length > 0) {
              schema += ` - Enum Values: `;
              const enumList = field.enum_values.map(ev => 
                `${ev.enum_value}("${ev.enum_label}")`
              ).join(', ');
              schema += enumList;
            }
            
            schema += `\n`;
          });
        } else {
          schema += `  Fields: Detailed field information not available\n`;
        }
        
        schemas.push(schema);
        console.log(`[getTableSchemas] ✅ Generated enhanced schema for ${tableName} with ${tableMetadata.fields?.length || 0} fields and ${rulesForTable.length} rules`);
        
      } catch (error) {
        console.warn(`[Two-Stage Generator] Failed to get enhanced schema for ${tableName}:`, error);
        schemas.push(`${tableName}: Error retrieving enhanced schema - ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Add table rules summary section if any rules found
    if (activeRules.length > 0) {
      const rulesSummary = `\n## Active Table Rules Summary\n${activeRules.length} active rules found for the selected tables. These rules must be followed when generating SQL queries.\n`;
      return schemas.join('\n\n') + rulesSummary;
    }

    // Add relationships section if any relationships found
    if (relationships.length > 0) {
      const relationshipSection = `\n## Table Relationships\n${relationships.join('\n')}\n`;
      return schemas.join('\n\n') + relationshipSection;
    }

    return schemas.join('\n\n');
  }

  /**
   * Get relationships between selected tables
   */
  private async getTableRelationships(tables: string[]): Promise<string[]> {
    try {
      const database = await db.getDb();
      if (!database) {
        return [];
      }

      const relationshipStrings: string[] = [];
      
      // Get relationships for each table
      for (const tableName of tables) {
        // Get relationships where this table is the source
        const sourceRelationships = await database
          .select({
            sourceTable: metadataTables.tableName,
            relationName: tableRelationships.relationName,
            relatedTable: tableRelationships.relatedTable,
            sourceField: tableRelationships.sourceField,
            relatedField: tableRelationships.relatedField,
            description: tableRelationships.description
          })
          .from(tableRelationships)
          .leftJoin(metadataTables, eq(tableRelationships.sourceTableId, metadataTables.id))
          .where(eq(metadataTables.tableName, tableName));

        // Get relationships where this table is the target
        const targetRelationships = await database
          .select({
            sourceTable: tableRelationships.relatedTable, // In this case, relatedTable is the source
            relationName: tableRelationships.relationName,
            relatedTable: metadataTables.tableName, // Current table is the target
            sourceField: tableRelationships.relatedField, // Reverse the fields
            relatedField: tableRelationships.sourceField,
            description: tableRelationships.description
          })
          .from(tableRelationships)
          .leftJoin(metadataTables, eq(tableRelationships.sourceTableId, metadataTables.id))
          .where(and(
            eq(tableRelationships.relatedTable, tableName),
            eq(metadataTables.tableName, tableName)
          ));

        // Combine and filter relationships to only include those between selected tables
        const allRelationships = [...sourceRelationships, ...targetRelationships];
        
        allRelationships.forEach(rel => {
          // Only include relationships where both tables are in our selected tables
          if (rel.sourceField && rel.relatedField && 
              rel.sourceTable && rel.relatedTable &&
              tables.includes(rel.sourceTable) && 
              tables.includes(rel.relatedTable)) {
            relationshipStrings.push(`- ${rel.sourceTable}.${rel.sourceField} → ${rel.relatedTable}.${rel.relatedField}${rel.description ? ` (${rel.description})` : ''}`);
          }
        });
      }

      // Remove duplicates using Array.from
      const uniqueRelationships = Array.from(new Set(relationshipStrings));
      
      return uniqueRelationships;
    } catch (error) {
      console.warn('[getTableRelationships] Error getting relationships:', error);
      return [];
    }
  }
}

// Export singleton instance
export const twoStageQueryGenerator = TwoStageQueryGenerator.getInstance();
