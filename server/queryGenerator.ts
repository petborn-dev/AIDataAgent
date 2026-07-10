import { invokeLLM } from "./_core/llm";
import { commentsDataService } from './commentsDataService';
import * as db from './db';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultRAGOrchestrator } from "./rag/RAGOrchestrator";
import { metadataRegistry } from "./metadataRegistry";
import { getQueryGeneratorSystemPrompt } from "./llm-prompts";
import { introspectTables, extractTableNamesFromQuery } from "./schemaIntrospection";
import { searchMetadataByQuery, getIndexStats } from "./metadata-rag-indexer";
import { getPrimaryKeyForTable, getPrimaryTablesCache } from "./metadata-table-analyzer";
import { reasoningTracker, formatReasoningForChat, type RagDecisionReason } from "./reasoning-tracker";
import {
  startLogSession,
  logStage,
  logRagResults,
  logKeywordResults,
  logRelationships,
  logFinalTables,
  logLlmRequest,
  logLlmResponse,
  completeLogSession,
  createTerminalProgressTracker,
  QueryStage,
  type RelationshipInfo,
} from "./llm-logger";
import { resetUsedPromptFiles, getUsedPromptFiles } from "./prompt-loader";
import { QueryResponseCase, ResponseCaseFactory, type ResponseMetadata } from "@shared/response-cases";
import type { TroubleshootingCase } from "@shared/response-cases";
import { getActiveLlmConfig } from "./db-config";
import { ENV } from "./_core/env";
import { analyzeAndLearnFromConversation } from "./autoLearningService";
import { preCorrectionService } from "./preCorrectionService";
import { twoStageQueryGenerator } from "./twoStageQueryGenerator.js";

// Feature flag: show reasoning in chat
const SHOW_RAG_REASONING = true;

// RAG toggle from environment
const ENABLE_RAG = process.env.ENABLE_RAG !== 'false';

// Keyword fallback toggle from environment
const ENABLE_KEYWORD_FALLBACK = process.env.ENABLE_KEYWORD_FALLBACK !== 'false';

// Metadata fallback toggle (first 50 tables when no matches found)
const ENABLE_METADATA_FALLBACK = process.env.ENABLE_METADATA_FALLBACK !== 'false';

// Two-stage optimization toggle (NEW)
const ENABLE_TWO_STAGE_OPTIMIZATION = true; // Force enabled to ensure optimization takes effect

// Debug: Log configuration values
console.log(`[Query Generator] 🎛️ Configuration:`);
console.log(`  - ENABLE_TWO_STAGE_OPTIMIZATION: ${ENABLE_TWO_STAGE_OPTIMIZATION} (FORCED ENABLED)`);
console.log(`  - ENABLE_RAG: ${ENABLE_RAG}`);
console.log(`  - ENABLE_KEYWORD_FALLBACK: ${ENABLE_KEYWORD_FALLBACK}`);
console.log(`  - ENABLE_METADATA_FALLBACK: ${ENABLE_METADATA_FALLBACK}`);

// Common D365 natural language to prefix mapping
const COMMON_D365_TERMS: Record<string, string[]> = {
  "vendor": ["VendTable", "VendGroup", "VendTrans", "DirPartyTable"],
  "supplier": ["VendTable", "VendGroup"],
  "customer": ["CustTable", "CustGroup", "CustTrans", "DirPartyTable"],
  "client": ["CustTable"],
  "sales": ["SalesTable", "SalesLine"],
  "order": ["SalesTable", "PurchTable"],
  "purchase": ["PurchTable", "PurchLine"],
  "product": ["InventTable", "EcoResProduct"],
  "item": ["InventTable"],
  "inventory": ["InventTable", "InventSum"],
  "address": ["LogisticsPostalAddress"],
  "worker": ["HcmWorker"],
  "employee": ["HcmWorker"],
  "project": ["ProjTable"],
  "invoice": ["CustInvoiceJour", "VendInvoiceJour"],
  "ledger": ["GeneralJournalEntry", "LedgerJournalTable"],
  "journal": ["LedgerJournalTable", "InventJournalTable"],
  "company": ["DataArea", "CompanyInfo"],
  "user": ["UserInfo", "SystemUser"],
};

/**
 * Scan the metadata registry for tables matching the user's natural language query.
 * Useful when RAG is disabled or database metadata is empty.
 */
function findTablesInRegistry(query: string): string[] {
  const words = query.toLowerCase().split(/[\s,?.!]+/);
  const foundTables = new Set<string>();
  const registryNames = metadataRegistry.getAllObjectNames();

  // Check common terms hardcoded map
  for (const word of words) {
    // Check singular and plural
    const terms = [word, word.replace(/s$/, '')];

    for (const term of terms) {
      if (COMMON_D365_TERMS[term]) {
        for (const candidate of COMMON_D365_TERMS[term]) {
          if (registryNames.has(candidate)) {
            foundTables.add(candidate);
          }
        }
      }
    }
  }

  // Also do a fuzzy check for explicit table names mentioned in query
  // e.g. "Show me TmpSomething"
  for (const word of words) {
    // If word looks like a D365 table (PascalCase-ish, long enough)
    if (word.length > 4 && /^[a-z0-9]+$/i.test(word)) {
      // Simple case-insensitive lookup
      for (const regName of Array.from(registryNames)) {
        if (regName.toLowerCase() === word) {
          foundTables.add(regName);
        }
      }
    }
  }

  return Array.from(foundTables);
}

/**
 * Filter out unwanted tables from LLM's tablesNeeded response.
 * Removes:
 * - Country-localized tables (ending with _JP, _RU, _BR, _XX pattern)
 * - Temp/staging tables (containing Tmp, Temp, Staging, Entity)
 * - Obviously fabricated table names (too long or contain weird patterns)
 */
function filterTablesNeeded(tables: string[]): string[] {
  if (!tables || tables.length === 0) return [];

  // Country/localization suffix pattern (2-3 uppercase letters at end after underscore)
  const countryPattern = /_[A-Z]{2,3}$/;
  // Country pattern in middle (e.g., TaxTrans_RU_Something)
  const countryMiddlePattern = /_[A-Z]{2,3}_/;

  // Temp/staging patterns (case insensitive)
  const tempPatterns = /^Tmp|Tmp$|Temp|Staging|Entity|_W$/i;

  const filtered = tables.filter(tableName => {
    // Skip empty or non-string values
    if (!tableName || typeof tableName !== 'string') return false;

    // Skip if too long (likely fabricated)
    if (tableName.length > 50) return false;

    // Skip country-localized tables
    if (countryPattern.test(tableName)) {
      console.log(`[Filter Tables] Removing country-localized: ${tableName}`);
      return false;
    }

    // Skip tables with country code in middle (e.g., TaxTrans_COK_MXA)
    if (countryMiddlePattern.test(tableName)) {
      console.log(`[Filter Tables] Removing country-middle pattern: ${tableName}`);
      return false;
    }

    // Skip temp/staging tables
    if (tempPatterns.test(tableName)) {
      console.log(`[Filter Tables] Removing temp/staging: ${tableName}`);
      return false;
    }

    return true;
  });

  // Deduplicate
  const unique = Array.from(new Set(filtered));

  // Limit to max 10 tables to avoid overwhelming the user
  if (unique.length > 10) {
    console.log(`[Filter Tables] Limiting from ${unique.length} to 10 tables`);
    return unique.slice(0, 10);
  }

  return unique;
}

/**
 * Conversation message for context
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Generate SQL query from natural language using metadata context
 * Uses RAG + keyword boosting for semantic search when available, falls back to all metadata
 */
export async function generateSqlQuery(
  naturalLanguageQuery: string,
  userSecurityRoles: string[],
  userId: number,
  conversationHistory?: Array<{ role: string; content: string }>,
  logSessionId?: string
): Promise<any> {
  console.log(`[Query Generator] Processing query: "${naturalLanguageQuery.substring(0, 50)}..."`);
  console.log(`[Query Generator] 🔧 DEBUG: ENABLE_TWO_STAGE_OPTIMIZATION = ${ENABLE_TWO_STAGE_OPTIMIZATION}`);
  console.log(`[Query Generator] 🔧 DEBUG: About to check two-stage optimization...`);
  console.log(`[Query Generator] 🔧 DEBUG: Query type check - contains "purchasing": ${naturalLanguageQuery.toLowerCase().includes('purchasing')}`);
  console.log(`[Query Generator] 🔧 DEBUG: Query type check - contains "po": ${naturalLanguageQuery.toLowerCase().includes('po')}`);
  console.log(`[Query Generator] 🔧 DEBUG: Query type check - contains "business": ${naturalLanguageQuery.toLowerCase().includes('business')}`);
  
  // 🚀 NEW: Two-stage optimization (if enabled)
  console.log(`[Query Generator] 🔧 DEBUG: Checking if ENABLE_TWO_STAGE_OPTIMIZATION is true...`);
  if (ENABLE_TWO_STAGE_OPTIMIZATION) {
    console.log(`[Query Generator] 🎯 Using two-stage optimization to save tokens`);
    
    // 🆕 First execute keyword matching and correction data loading (same as traditional mode)
    let commentsDataMap = new Map<string, any[]>();
    
    // Smart preload: load relevant table knowledge base based on query keywords
    const queryLower = naturalLanguageQuery.toLowerCase();
    const keywordTableMap: Record<string, string[]> = {
      'purch': ['PurchTable', 'PurchLine'],
      'purchase': ['PurchTable', 'PurchLine'],
      'purchasing': ['PurchTable', 'PurchLine', 'InventBuyerGroup'],
      'vendor': ['VendTable', 'VendTrans'],
      'customer': ['CustTable', 'CustTrans'],
      'sales': ['SalesTable', 'SalesLine'],
      'inventory': ['InventTable', 'InventSum'],
      'item': ['InventTable'],
      'worker': ['HcmWorker', 'WorkerResponsible'],
      'buyer': ['InventBuyerGroup', 'WorkerResponsible', 'ItemBuyerGroupId'],
      'group': ['InventBuyerGroup', 'PurchTable']
    };
    
    for (const [keyword, relatedTables] of Object.entries(keywordTableMap)) {
      if (queryLower.includes(keyword)) {
        for (const relatedTable of relatedTables) {
          if (!commentsDataMap.has(relatedTable)) {
            try {
              const { commentsDataService } = await import('./commentsDataService');
              const comments = await commentsDataService.getCommentsByTable(relatedTable);
              if (comments.length > 0) {
                commentsDataMap.set(relatedTable, comments);
                console.log(`[Query Generator] Loaded comments for keyword-matched table: ${relatedTable} (keyword: ${keyword})`);
              }
            } catch (error) {
              console.warn(`Failed to load comments for keyword-matched table ${relatedTable}:`, error);
            }
          }
        }
      }
    }
    
    // Special semantic matching: when query contains "purchasing group", prioritize loading relevant mappings
    if (queryLower.includes('purchasing group') || queryLower.includes('buyer group')) {
      try {
        console.log(`[Query Generator] Detected "purchasing group" query, loading relevant mappings...`);
        
        const { commentsDataService } = await import('./commentsDataService');
        const purchComments = await commentsDataService.getCommentsByTable('PurchTable');
        const purchasingGroupComments = purchComments.filter(c => 
          c.fieldName.includes('BuyerGroup') || 
          c.comments.toLowerCase().includes('purchasing group') ||
          c.comments.toLowerCase().includes('buyer group')
        );
        
        if (purchasingGroupComments.length > 0) {
          commentsDataMap.set('PurchTable', purchComments);
          console.log(`[Query Generator] Loaded purchasing group mappings: ${purchasingGroupComments.length} entries`);
          purchasingGroupComments.forEach(comment => {
            console.log(`  - ${comment.fieldName}: ${comment.comments}`);
          });
        }
      } catch (error) {
        console.warn(`Failed to load purchasing group mappings:`, error);
      }
    }
    
    // Pass correction data to two-stage generator
    const knowledgeBaseData = Array.from(commentsDataMap.entries()).map(([tableName, comments]) => ({
      tableName,
      comments
    }));
    
    // Check if this is a purchasing person query, force regeneration if so (avoid using wrong cache)
    const isPurchasingPersonQuery = naturalLanguageQuery.toLowerCase().includes('purchasing person');
    const isBusinessUnitQuery = naturalLanguageQuery.toLowerCase().includes('business unit');
    
    // For specific query types, force regeneration to avoid cache errors
    const forceRegenerateForType = isPurchasingPersonQuery || isBusinessUnitQuery;
    
    try {
      const optimizedResult = await twoStageQueryGenerator.generateQuery(
        naturalLanguageQuery,
        userId,
        conversationHistory,
        forceRegenerateForType,
        knowledgeBaseData // 🆕 Pass correction data
      );
      
      console.log(`[Query Generator] ✅ Two-stage optimization successful!`);
      console.log(`[Query Generator] 📊 Token savings: ${optimizedResult.tokenOptimization.savedTokens} tokens`);
      console.log(`[Query Generator] 🔄 From cache: ${optimizedResult.fromCache ? 'YES' : 'NO'}`);
      
      // Return result compatible with original format
      return ResponseCaseFactory.perfect(
        optimizedResult.sql,
        optimizedResult.explanation,
        {
          logSessionId: logSessionId || '',
          promptFiles: [],
          reasoning: `Two-stage optimization: ${optimizedResult.fromCache ? 'Cache hit' : 'Generated'} - Saved ${optimizedResult.tokenOptimization.savedTokens} tokens`,
          modelInfo: { model: 'two-stage-optimized', temperature: 0.5, maxTokens: optimizedResult.tokenOptimization.totalTokens },
          tablesNeeded: optimizedResult.tablesUsed,
          tokenUsage: {
            promptTokens: optimizedResult.tokenOptimization.totalTokens,
            completionTokens: 200,
            totalTokens: optimizedResult.tokenOptimization.totalTokens + 200
          }
        }
      );
      
    } catch (error: any) {
      console.warn(`[Query Generator] ⚠️ Two-stage optimization failed, falling back to original method:`);
      console.warn(`[Query Generator] Error details:`, error);
      console.warn(`[Query Generator] Error stack:`, error?.stack);
      // Continue using original method
    }
  }
  
  // Original query generation logic (fallback)
  const session = startLogSession(naturalLanguageQuery);

  // Start logging session with terminal progress tracking
  const progressCallback = createTerminalProgressTracker("");
  const currentLogSessionId = logSessionId || startLogSession(naturalLanguageQuery, progressCallback);

  // Reset prompt file tracking for this session
  resetUsedPromptFiles();

  try {
    reasoningTracker.reset();

    // Try to use RAG for semantic search first (if enabled)
    let relevantTables: string[] = [];
    let ragDecisions: RagDecisionReason[] = [];
    const indexStats = await getIndexStats();
    let usedFallback = false;

    if (!ENABLE_RAG) {
      logStage(currentLogSessionId, QueryStage.KEYWORD_FALLBACK, "RAG disabled via ENABLE_RAG=false");
      console.log(`[Query Generator] RAG disabled via ENABLE_RAG=false, using keyword-based matching`);
      usedFallback = true;
    } else if (indexStats.ready && indexStats.indexed > 0) {
      try {
        logStage(currentLogSessionId, QueryStage.RAG_SEARCH, `Searching ${indexStats.indexed} indexed tables`);
        console.log(`[Query Generator] Using RAG search for query: "${naturalLanguageQuery.substring(0, 50)}..."`);
        const searchResults = await searchMetadataByQuery(naturalLanguageQuery, 20);

        // Build reasoning data
        const primaryTablesMap = await getPrimaryTablesCache();
        ragDecisions = await Promise.all(searchResults.map(async (r, idx) => {
          const primaryInfo = primaryTablesMap.get(r.tableId);
          const pk = await getPrimaryKeyForTable(r.tableName);
          return {
            tableId: r.tableId,
            tableName: r.tableName,
            similarity: r.similarity,
            matchedKeywords: r.matchedKeywords || [],
            isPrimary: primaryInfo?.isPrimary || false,
            primaryKey: pk,
            rank: idx + 1,
          };
        }));

        relevantTables = searchResults.map(r => r.tableName);
        reasoningTracker.setRagResults(ragDecisions);
        console.log(`[Query Generator] RAG found ${relevantTables.length} relevant tables (keyword-boosted): ${relevantTables.join(', ')}`);

        // Log RAG results
        logRagResults(currentLogSessionId, searchResults.map((r, idx) => ({
          tableName: r.tableName,
          score: r.similarity,
          reason: r.matchedKeywords?.length ? `Keywords: ${r.matchedKeywords.join(", ")}` : undefined,
        })));
      } catch (ragError) {
        console.warn('[Query Generator] RAG search failed, using keyword fallback:', ragError);
        usedFallback = true;
      }
    } else {
      logStage(currentLogSessionId, QueryStage.KEYWORD_FALLBACK, `RAG not ready (${indexStats.indexed}/${indexStats.total})`);
      console.log(`[Query Generator] RAG not ready (indexed: ${indexStats.indexed}/${indexStats.total}), using keyword-based table matching`);
      usedFallback = true;
    }

    // Get all metadata tables and fields
    const allTables = await db.getMetadataTables();

    if (allTables.length === 0) {
      return ResponseCaseFactory.needsClarification(
        "Cannot generate query - system not initialized",
        ["No metadata available in the system"],
        { logSessionId },
        ["Please upload metadata files first via the Metadata Management page"]
      );
    }

    // KEYWORD-BASED FALLBACK: When RAG isn't ready, use smart keyword matching (if enabled)
    if ((usedFallback || relevantTables.length === 0) && ENABLE_KEYWORD_FALLBACK) {
      logStage(currentLogSessionId, QueryStage.KEYWORD_FALLBACK, "Using keyword-based table matching");
      const keywordResults = findRelevantTablesByKeywordsWithScores(naturalLanguageQuery, allTables);
      relevantTables = keywordResults.map(r => r.tableName);

      // Log keyword results
      logKeywordResults(currentLogSessionId, keywordResults);

      console.log(`[Query Generator] Keyword fallback found ${relevantTables.length} tables: ${relevantTables.slice(0, 10).join(', ')}${relevantTables.length > 10 ? '...' : ''}`);
    }

    // Filter tables: use matched results, with a reasonable limit
    let tablesToUse = relevantTables.length > 0
      ? allTables.filter(t => relevantTables.includes(t.tableName))
      : ENABLE_METADATA_FALLBACK
        ? allTables.slice(0, 50) // Fallback: first 50 tables
        : []; // Zero metadata mode - rely on authoritative D365 naming conventions only

    // If using RAG results, also include related/referenced tables for comprehensive join context
    if (relevantTables.length > 0) {
      logStage(currentLogSessionId, QueryStage.RELATIONSHIP_DISCOVERY, `Finding related tables for ${relevantTables.length} tables`);
      const relatedTableNames = new Set(relevantTables);
      const discoveredRelationships: RelationshipInfo[] = [];

      // For each RAG-selected table, fetch its relationships and add related tables
      for (const table of tablesToUse) {
        try {
          const relationships = await db.getRelationshipsByTableId(table.id);
          for (const rel of relationships) {
            if (rel.relatedTable && !relatedTableNames.has(rel.relatedTable)) {
              relatedTableNames.add(rel.relatedTable);
              discoveredRelationships.push({
                sourceTable: table.tableName,
                targetTable: rel.relatedTable,
                relationType: rel.relationshipType || "FK",
                foreignKey: rel.relationName,
              });
            }
          }
        } catch (error) {
          // Silently skip relationship fetch errors
        }
      }

      // Log discovered relationships
      logRelationships(currentLogSessionId, discoveredRelationships);

      // Update tablesToUse to include discovered related tables
      // IMPORTANT: keep relevancy ordering so later truncation (slice(0, 30)) doesn't drop key tables
      const relatedOnly: string[] = [];
      for (const name of Array.from(relatedTableNames)) {
        if (!relevantTables.includes(name)) relatedOnly.push(name);
      }

      const orderedTableNames = [...relevantTables, ...relatedOnly];
      const tableByName = new Map(allTables.map(t => [t.tableName, t] as const));
      tablesToUse = orderedTableNames.map(n => tableByName.get(n)).filter(Boolean) as typeof tablesToUse;
      console.log(`[Query Generator] Added ${relatedTableNames.size - relevantTables.length} related tables via relationships. Total: ${tablesToUse.length}`);
    }

    // Log final table selection
    logFinalTables(currentLogSessionId, tablesToUse.map(t => t.tableName), allTables.length);

    if (tablesToUse.length === 0) {
      logStage(currentLogSessionId, QueryStage.CONTEXT_BUILDING, "Zero metadata mode - using authoritative D365 naming only");
      console.log(`[Query Generator] Zero metadata mode enabled - relying on authoritative D365 conventions`);
    } else {
      logStage(currentLogSessionId, QueryStage.CONTEXT_BUILDING, `Building context with ${tablesToUse.length} tables`);
      console.log(`[Query Generator] Using ${tablesToUse.length} tables for context (RAG: ${relevantTables.length > 0}, All: ${allTables.length})`);
    }    // Extract table names mentioned in query
    const tableNames = tablesToUse.map(t => t.tableName);
    const mentionedTables = extractTableNamesFromQuery(naturalLanguageQuery, tableNames);

    // Introspect schemas for mentioned tables.
    // Also introspect key tables when user asks for company/legal entity filtering,
    // because metadata uploads may not include DataAreaId even if the actual DB table has it.
    let introspectedSchemas = new Map();
    const tablesForIntrospection = new Set<string>(mentionedTables);

    const queryLower = naturalLanguageQuery.toLowerCase();
    const mentionsCompany = /(\bcompany\b|\blegal\s*entity\b|\bdataareaid\b)/i.test(queryLower);
    const mentionsPurchasing = /(\bpurchase\b|\bpurch\b|\bpurchase\s+order\b|\bpo\b)/i.test(queryLower);

    if (mentionsCompany && mentionsPurchasing && tableNames.includes('PurchTable')) {
      tablesForIntrospection.add('PurchTable');
    }

    // Cap introspection scope to avoid extra latency
    const introspectList = Array.from(tablesForIntrospection).slice(0, 3);
    if (introspectList.length > 0) {
      try {
        introspectedSchemas = await introspectTables(introspectList, userId);
      } catch (error) {
        console.warn("Schema introspection failed, using metadata only:", error);
      }
    }

    // Build metadata context
    
    // 🔧 Pre-correction: load relevant correction information before building context
    const preCorrectionHints = await preCorrectionService.getPreCorrectionHints(naturalLanguageQuery);
    if (preCorrectionHints) {
      console.log(`[Query Generator] Applied pre-corrections for query`);
      console.log(`[Query Generator] Pre-correction hints length: ${preCorrectionHints.length} chars`);
    }
    
    let metadataContext = "# D365 Finance & Operations Database Schema\n\n";
    
    // Add pre-correction hints
    if (preCorrectionHints) {
      metadataContext += preCorrectionHints;
      metadataContext += "\n";
    }

    if (tablesToUse.length === 0) {
      // Zero metadata mode
      metadataContext += `## Zero Metadata Mode\n\n`;
      metadataContext += `No uploaded table schemas found in database.\n`;

      // Fallback: Check Metadata Registry (Disk Scan)
      const registryMatches = findTablesInRegistry(naturalLanguageQuery);
      if (registryMatches.length > 0) {
        metadataContext += `\n## Available D365 Objects (Identified from Disk)\n`;
        metadataContext += `The following D365 objects were found in the application source code and match your query keywords:\n`;
        metadataContext += registryMatches.map(t => `- ${t}`).join('\n');
        metadataContext += `\n\n**INSTRUCTION**: Prefer using the above table names if they fit the business requirement. They exist in the codebase.\n`;

        console.log(`[Query Generator] Registry fallback found ${registryMatches.length} tables: ${registryMatches.join(', ')}`);

        // Add to hints
        reasoningTracker.addHint(`Found ${registryMatches.length} relevant tables on disk: ${registryMatches.join(', ')}`);
      } else {
        metadataContext += `No relevant tables found in registry scan.\n`;
      }

      metadataContext += `\nGenerate query using authoritative D365 Finance & Operations naming conventions (e.g., VendTable, CustTable).\n\n`;
    } else {
      // Add context about RAG if used
      if (relevantTables.length > 0) {
        metadataContext += `## Note: Context filtered by semantic relevance (${tablesToUse.length}/${allTables.length} tables shown)\n\n`;
      }

      // Add introspected schema information first (most accurate)
      if (introspectedSchemas.size > 0) {
        metadataContext += "## Introspected Table Schemas (Actual Database Columns)\n\n";
        introspectedSchemas.forEach((schema, tableName) => {
          metadataContext += `### ${tableName}\n`;
          metadataContext += `Columns (from database):\n`;
          for (const col of schema.columns) {
            metadataContext += `  - ${col.name} (${col.type})${col.isPrimaryKey ? ' [PRIMARY KEY]' : ''}${col.nullable ? '' : ' [NOT NULL]'}\n`;
          }
          metadataContext += `\n`;
        });
        metadataContext += "**IMPORTANT**: Use ONLY the column names listed above. Do not invent or guess column names.\n\n";
      }

      // Add CommentsData knowledge base information
      const tableNames = tablesToUse.slice(0, 30).map(t => t.tableName);
      const commentsDataMap = new Map<string, any[]>();
      
      // Load comments data for relevant tables (first 30 tables)
      for (const tableName of tableNames) {
        try {
          const comments = await commentsDataService.getCommentsByTable(tableName);
          if (comments.length > 0) {
            commentsDataMap.set(tableName, comments);
          }
        } catch (error) {
          console.warn(`Failed to load comments for ${tableName}:`, error);
        }
      }
      
      // Additional loading: check tables mentioned in query to ensure relevant knowledge base is loaded
      const mentionedTables = extractTableNamesFromQuery(naturalLanguageQuery, allTables.map(t => t.tableName));
      for (const mentionedTable of mentionedTables) {
        if (!tableNames.includes(mentionedTable)) {
          try {
            const comments = await commentsDataService.getCommentsByTable(mentionedTable);
            if (comments.length > 0) {
              commentsDataMap.set(mentionedTable, comments);
              console.log(`[Query Generator] Loaded extra comments for mentioned table: ${mentionedTable}`);
            }
          } catch (error) {
            console.warn(`Failed to load comments for mentioned table ${mentionedTable}:`, error);
          }
        }
      }
      
      // Smart preload: load relevant table knowledge base based on query keywords
      const queryLower = naturalLanguageQuery.toLowerCase();
      const keywordTableMap: Record<string, string[]> = {
        'purch': ['PurchTable', 'PurchLine'],
        'purchase': ['PurchTable', 'PurchLine'],
        'purchasing': ['PurchTable', 'PurchLine', 'InventBuyerGroup'], // Add InventBuyerGroup
        'vendor': ['VendTable', 'VendTrans'],
        'customer': ['CustTable', 'CustTrans'],
        'sales': ['SalesTable', 'SalesLine'],
        'inventory': ['InventTable', 'InventSum'],
        'item': ['InventTable'],
        'worker': ['HcmWorker', 'WorkerResponsible'],
        'buyer': ['InventBuyerGroup', 'WorkerResponsible', 'ItemBuyerGroupId'],
        'group': ['InventBuyerGroup', 'PurchTable'] // Add group keyword matching
      };
      
      for (const [keyword, relatedTables] of Object.entries(keywordTableMap)) {
        if (queryLower.includes(keyword)) {
          for (const relatedTable of relatedTables) {
            if (!commentsDataMap.has(relatedTable)) {
              try {
                const comments = await commentsDataService.getCommentsByTable(relatedTable);
                if (comments.length > 0) {
                  commentsDataMap.set(relatedTable, comments);
                  console.log(`[Query Generator] Loaded comments for keyword-matched table: ${relatedTable} (keyword: ${keyword})`);
                }
              } catch (error) {
                console.warn(`Failed to load comments for keyword-matched table ${relatedTable}:`, error);
              }
            }
          }
        }
      }
      
      // Special semantic matching: when query contains "purchasing person", prioritize loading buyer group related mappings
      if (queryLower.includes('purchasing person') || queryLower.includes('without purchasing person')) {
        try {
          const purchComments = await commentsDataService.getCommentsByTable('PurchTable');
          const buyerGroupComments = purchComments.filter(c => 
            c.fieldName === 'ItemBuyerGroupId' || 
            c.comments.toLowerCase().includes('buyer group')
          );
          
          if (buyerGroupComments.length > 0) {
            // Ensure PurchTable is in commentsDataMap
            if (!commentsDataMap.has('PurchTable')) {
              commentsDataMap.set('PurchTable', purchComments);
            }
            
            console.log(`[Query Generator] Loaded buyer group mappings for "purchasing person" query`);
            console.log(`[Query Generator] Found ${buyerGroupComments.length} buyer group mappings`);
          }
        } catch (error) {
          console.warn(`Failed to load buyer group mappings:`, error);
        }
      }

      // Special semantic matching: when query contains "purchasing group", prioritize loading relevant mappings
      if (queryLower.includes('purchasing group') || queryLower.includes('buyer group')) {
        try {
          console.log(`[Query Generator] Detected "purchasing group" query, loading relevant mappings...`);
          
          // Load mappings for PurchTable
          const purchComments = await commentsDataService.getCommentsByTable('PurchTable');
          const purchasingGroupComments = purchComments.filter(c => 
            c.fieldName.includes('BuyerGroup') || 
            c.comments.toLowerCase().includes('purchasing group') ||
            c.comments.toLowerCase().includes('buyer group')
          );
          
          if (purchasingGroupComments.length > 0) {
            if (!commentsDataMap.has('PurchTable')) {
              commentsDataMap.set('PurchTable', purchComments);
            }
            
            console.log(`[Query Generator] Loaded purchasing group mappings: ${purchasingGroupComments.length} entries`);
            purchasingGroupComments.forEach(comment => {
              console.log(`  - ${comment.fieldName}: ${comment.comments}`);
            });
          }
          
          // Load mappings for InventBuyerGroup table
          try {
            const buyerGroupComments = await commentsDataService.getCommentsByTable('InventBuyerGroup');
            if (buyerGroupComments.length > 0) {
              commentsDataMap.set('InventBuyerGroup', buyerGroupComments);
              console.log(`[Query Generator] Loaded InventBuyerGroup mappings: ${buyerGroupComments.length} entries`);
            }
          } catch (error) {
            console.warn(`Failed to load InventBuyerGroup comments:`, error);
          }
          
        } catch (error) {
          console.warn(`Failed to load purchasing group mappings:`, error);
        }
      }
      
      // Add comments data to context if available
      if (commentsDataMap.size > 0) {
        metadataContext += "## Field Mapping Knowledge Base (User-Validated Mappings)\n\n";
        for (const [tableName, comments] of Array.from(commentsDataMap)) {
          metadataContext += `### ${tableName} - Field Mappings\n`;
          for (const comment of comments) {
            metadataContext += `- **${comment.fieldName}**: ${comment.comments} (used ${comment.usageCount} times)\n`;
          }
          metadataContext += `\n`;
        }
        metadataContext += "**IMPORTANT**: Prioritize field mappings from the knowledge base above. These have been validated by users.\n\n";
      }

      metadataContext += "## Schema (Minimal)\n\n";

      for (const table of tablesToUse.slice(0, 30)) { // Limit to 30 tables max
        metadataContext += `${table.tableName}: `;

        const fields = await db.getMetadataFieldsByTableId(table.id);
        
        // Smart field sorting: prioritize important fields
        const importantFieldPatterns = [
          // Geographic location fields
          'country', 'state', 'region', 'address', 'city', 'zip', 'postal',
          // Company/Legal entity
          'dataareaid',
          // Core business fields
          'accountnum', 'name', 'description', 'createddatetime', 'modifieddatetime',
          'transdate', 'amount', 'currency', 'status', 'voucher',
          // D365 grouping fields - high priority
          'buyergroupid', 'itembuyergroupid', 'vendgroupid', 'custgroupid', 'pricegroupid',
          'taxgroupid', 'group', 'buyer', 'vendor', 'customer',
          // Purchasing related fields
          'purch', 'order', 'line', 'invoice'
        ];
        
        const priorityFields = fields.filter(f => 
          f.isPrimaryKey || 
          f.isForeignKey ||
          importantFieldPatterns.some(pattern => 
            f.fieldName.toLowerCase().includes(pattern)
          )
        );
        
        const otherFields = fields.filter(f => 
          !f.isPrimaryKey && 
          !f.isForeignKey &&
          !importantFieldPatterns.some(pattern => 
            f.fieldName.toLowerCase().includes(pattern)
          )
        ).slice(0, 35); // Increase number of other fields
        
        const sortedFields = [...priorityFields, ...otherFields];
        
        const fieldNames = sortedFields.slice(0, 50).map(f => { 
          let name = f.fieldName;
          if (f.isPrimaryKey) name += "[PK]";
          if (f.isForeignKey) name += "[FK]";
          
          // Add semantic descriptions to help AI understand field meanings
          if (f.fieldName === 'ItemBuyerGroupId') {
            name += " [Buyer Group - THIS IS THE BUYER GROUP FIELD]";
          } else if (f.fieldName === 'VendGroupId') {
            name += " [Vendor Group - THIS IS THE VENDOR GROUP FIELD]";
          } else if (f.fieldName === 'CustGroupId') {
            name += " [Customer Group - THIS IS THE CUSTOMER GROUP FIELD]";
          } else if (f.fieldName === 'PriceGroupId') {
            name += " [Price Group - THIS IS THE PRICE GROUP FIELD]";
          } else if (f.fieldName === 'TaxGroupId') {
            name += " [Tax Group - THIS IS THE TAX GROUP FIELD]";
          } else if (f.fieldName === 'PurchId') {
            name += " [Purchase Order ID]";
          } else if (f.fieldName === 'SalesId') {
            name += " [Sales Order ID]";
          } else if (f.fieldName === 'AccountNum') {
            name += " [Account Number]";
          } else if (f.fieldName === 'PartyCountry') {
            name += " [Country - THIS IS THE COUNTRY FIELD]";
          } else if (f.fieldName === 'PartyState') {
            name += " [State/Region - THIS IS THE STATE/REGION FIELD]";
          } else if (f.fieldName === 'DataAreaId') {
            name += " [Company - THIS IS THE COMPANY FIELD]";
          } else if (f.labelText) {
            name += ` [${f.labelText}]`;
          }
          
          return name;
        }).join(", ");
        metadataContext += fieldNames;

        const relationships = await db.getRelationshipsByTableId(table.id);
        if (relationships.length > 0 && relationships.length <= 3) {
          metadataContext += ` | Rels: ${relationships.map(r => `${r.relationName}`).join(", ")}`;
        }

        metadataContext += `\n`;
      }
    }

    // Build intelligent hints based on selected tables
    let hintsText = "";
    if (tablesToUse.length > 0) {
      const hints: string[] = [];

      // Check for aggregation queries (COUNT, SUM, AVG)
      if (/\b(count|sum|avg|total|how\s+many|number\s+of)\b/i.test(naturalLanguageQuery)) {
        hints.push("This appears to be an aggregation query. Use GROUP BY with primary keys to avoid duplicates.");

        // Add primary key hints for top tables
        const primaryTableInfo = await getPrimaryTablesCache();
        for (const table of tablesToUse.slice(0, 3)) {
          for (const info of Array.from(primaryTableInfo.values())) {
            if (info.tableName === table.tableName && info.primaryKey) {
              hints.push(`For table ${table.tableName}, use COUNT(DISTINCT ${info.primaryKey}) to avoid duplicate rows.`);
              reasoningTracker.addHint(`Use COUNT(DISTINCT ${info.primaryKey}) for ${table.tableName}`);
              break;
            }
          }
        }
      }

      // Check for date range queries
      if (/\b(last|previous|date|month|year|from|to|between)\b/i.test(naturalLanguageQuery)) {
        hints.push("This query involves date filtering. Check for date fields like CreatedDateTime, ModifiedDateTime, TransDate, or InvoiceDate depending on the table.");
        reasoningTracker.addHint("Apply appropriate date range filtering");
      }

      // Check for YoY / trend / multi-metric comparison queries
      const queryLowerHint = naturalLanguageQuery.toLowerCase();
      const isYoYHint =
        queryLowerHint.includes('last year') ||
        queryLowerHint.includes('this year') ||
        queryLowerHint.includes('yoy') ||
        queryLowerHint.includes('year over year') ||
        queryLowerHint.includes('year-over-year') ||
        queryLowerHint.includes('trend') ||
        queryLowerHint.includes('compare') ||
        queryLowerHint.includes(' vs ') ||
        queryLowerHint.includes('growth') ||
        queryLowerHint.includes('previous year');
      if (isYoYHint) {
        hints.push(
          'TREND/YoY QUERY: Use CASE WHEN YEAR(dateField) = YEAR(GETDATE()) - 1 for last year and YEAR(GETDATE()) for this year. ' +
          'Include a GrowthPct column. Use WHERE YEAR(dateField) IN (YEAR(GETDATE()) - 1, YEAR(GETDATE())). ' +
          'For multiple metrics, use one SQL with CASE pivots or CTEs — do NOT split into separate queries.'
        );
        reasoningTracker.addHint('Apply YoY CASE pivot pattern for trend comparison');
      }

      // Check for join-heavy queries
      if (tablesToUse.length > 2) {
        hints.push(`This query uses ${tablesToUse.length} tables. Carefully use the Relationships section to build accurate JOINs.`);
        reasoningTracker.addHint(`Use relationships to join ${tablesToUse.length} tables accurately`);
      }

      if (hints.length > 0) {
        hintsText = `\n\nQuery-Specific Hints:\n${hints.map(h => `- ${h}`).join("\n")}`;
      }
    }

    // Retrieve relevant context from RAG knowledge base
    let ragContext = "";
    let ragSources: Array<{ documentId: string; filename: string }> = [];
    
    // Check if RAG is disabled
    if (process.env.ENABLE_RAG === 'false') {
      console.log('[Query Generator] RAG disabled via ENABLE_RAG=false, skipping RAG retrieval');
    } else {
      try {
        const orchestrator = getDefaultRAGOrchestrator();
        const retrieved = await orchestrator.retrieveContext(naturalLanguageQuery, 3);
        if (retrieved.chunks.length > 0) {
        ragContext = `\n\n# Additional Context from Knowledge Base\n\n`;
        ragContext += retrieved.chunks
          .map((chunk, i) => `## Context ${i + 1} (from ${chunk.source}):\n${chunk.text}`)
          .join("\n\n");
        ragContext += `\n\nUse this context to better understand the business logic, data relationships, and domain-specific terminology.\n`;
        ragSources = retrieved.sources;
        }
      } catch (error) {
        console.warn("RAG context retrieval failed:", error);
        // Continue without RAG context
      }
    }

    // Build system prompt using centralized configuration
    logStage(currentLogSessionId, QueryStage.PROMPT_BUILDING, "Building system prompt");
    const systemPrompt = getQueryGeneratorSystemPrompt({
      metadataContext,
      hintsText,
      userSecurityRoles,
    });

    // Get the prompt files used for logging
    const promptFiles = getUsedPromptFiles();

    // Get actual model being used for accurate logging
    let activeModel = ENV.llmModel;
    try {
      const dbConfig = await getActiveLlmConfig();
      if (dbConfig?.model) {
        activeModel = dbConfig.model;
      }
    } catch (e) {
      // Fall back to env default
    }

    // Get temperature from DB config for accurate logging
    let logTemperature = 0.5;
    try {
      const tempConfig = await getActiveLlmConfig();
      if (tempConfig?.temperature !== null && tempConfig?.temperature !== undefined) {
        logTemperature = tempConfig.temperature / 100;
      }
    } catch (e) { /* use default */ }

    // Log the LLM request before sending
    logStage(currentLogSessionId, QueryStage.LLM_REQUEST, "Sending request to LLM");
    logLlmRequest(
      currentLogSessionId,
      "https://oneapi.laisky.com/v1/chat/completions",
      activeModel,
      logTemperature,
      2000, // Max tokens
      systemPrompt,
      naturalLanguageQuery,
      promptFiles
    );

    logStage(currentLogSessionId, QueryStage.LLM_WAITING, "Waiting for LLM response");
    const llmStartTime = Date.now();

    // Build messages array with conversation history if available
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history (last 10 messages for context, excluding current)
    if (conversationHistory && conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-10);
      console.log(`[Query Generator] Including ${recentHistory.length} messages of conversation history`);
      for (const msg of recentHistory) {
        // Validate role and convert to proper type
        const validRole = msg.role === "user" || msg.role === "assistant" || msg.role === "system" 
          ? msg.role as "user" | "assistant" | "system"
          : "user"; // Default to user if invalid role
        
        messages.push({ role: validRole, content: msg.content });
      }
    }

    // Add current user query
    messages.push({ role: "user", content: naturalLanguageQuery });

    // === VALIDATION LOOP DISABLED ===
    // The validation loop was causing issues: it added correction messages that confused the LLM
    // and made responses slower. The LLM should follow D365 naming from the prompt.
    let response: any;

    response = await invokeLLM({
      messages,
      max_tokens: 8000, // Increased limit for complex queries
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "sql_query_response",
          strict: true,
          schema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "The generated SQL query (empty if clarification needed)" },
              explanation: { type: "string", description: "Brief explanation (under 100 words)" },
              tablesNeeded: { type: "array", items: { type: "string" }, description: "Table names to request" },
              clarifyingQuestions: { type: "array", items: { type: "string" }, description: "Questions for user" },
              schemaNotes: { type: "array", items: { type: "string" }, description: "Schema observations" },
              stagedSql: { type: "string", description: "Best-effort SQL attempt even if incomplete (for preview)" },
            },
            // When strict: true, ALL properties must be in required array
            required: ["sql", "explanation", "tablesNeeded", "clarifyingQuestions", "schemaNotes", "stagedSql"],
            additionalProperties: false,
          },
        },
      },
    });
    // === VALIDATION LOOP END (disabled) ===

    const llmResponseTime = Date.now() - llmStartTime;
    logStage(currentLogSessionId, QueryStage.LLM_RESPONSE, `Response received in ${(llmResponseTime / 1000).toFixed(2)}s`);

    // Capture token usage for cost estimation
    const usage = response.usage;
    const tokenUsage = usage ? {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      // Rough cost estimate based on GPT-5.1 pricing ($2.5/1M input, $10/1M output)
      estimatedCostUsd: (usage.prompt_tokens * 2.5 / 1_000_000) + (usage.completion_tokens * 10 / 1_000_000),
    } : undefined;

    if (tokenUsage) {
      console.log(`[QueryGenerator] Token usage: ${tokenUsage.promptTokens} in, ${tokenUsage.completionTokens} out, ~$${tokenUsage.estimatedCostUsd?.toFixed(4)}`);
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from LLM");
    }

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    // Log LLM response
    logLlmResponse(currentLogSessionId, llmResponseTime, contentStr);

    // Log the raw response for debugging Gemini JSON issues
    console.log('[QueryGenerator] Raw LLM response:', {
      length: contentStr.length,
      preview: contentStr.substring(0, 200),
      hasNewlines: contentStr.includes('\n'),
      hasBackslashes: contentStr.includes('\\'),
    });

    logStage(currentLogSessionId, QueryStage.PARSING, "Parsing JSON response");

    // Helper to try repairing truncated/runaway JSON from Gemini
    const tryRepairJson = (raw: string): any => {
      // If response is huge (>5KB), Gemini probably went into a loop - truncate aggressively
      if (raw.length > 5000) {
        console.warn(`[QueryGenerator] Response too long (${raw.length} chars), attempting repair`);

        // Try to find the first complete JSON object (ends with })
        // Look for pattern: {"sql":"...", "explanation":"...", ...}
        const patterns = [
          // Match up to first tablesNeeded array close
          /\{"sql"\s*:\s*"[^"]*"\s*,\s*"explanation"\s*:\s*"[^"]*"\s*,\s*"tablesNeeded"\s*:\s*\[[^\]]*\]\s*,\s*"clarifyingQuestions"\s*:\s*\[[^\]]*\]\s*\}/,
          // Match just sql + explanation + tablesNeeded
          /\{"sql"\s*:\s*"[^"]*"\s*,\s*"explanation"\s*:\s*"[^"]*"\s*,\s*"tablesNeeded"\s*:\s*\[[^\]]*\]\s*\}/,
          // Match just sql + explanation
          /\{"sql"\s*:\s*"[^"]*"\s*,\s*"explanation"\s*:\s*"[^"]*"\s*\}/,
        ];

        for (const pattern of patterns) {
          const match = raw.match(pattern);
          if (match) {
            try {
              return JSON.parse(match[0]);
            } catch { continue; }
          }
        }

        // Last resort: try to manually extract fields
        const sqlMatch = raw.match(/"sql"\s*:\s*"([^"]*)"/);
        const explMatch = raw.match(/"explanation"\s*:\s*"([^"]{0,500})/); // Limit explanation
        const tablesMatch = raw.match(/"tablesNeeded"\s*:\s*\[([^\]]*)\]/);
        const questionsMatch = raw.match(/"clarifyingQuestions"\s*:\s*\[([^\]]*)\]/);

        if (sqlMatch && explMatch) {
          const repaired: any = {
            sql: sqlMatch[1],
            explanation: explMatch[1].replace(/\\n/g, ' ').substring(0, 200) + '...',
          };

          if (tablesMatch) {
            try {
              repaired.tablesNeeded = JSON.parse(`[${tablesMatch[1]}]`);
            } catch { }
          }
          if (questionsMatch) {
            try {
              repaired.clarifyingQuestions = JSON.parse(`[${questionsMatch[1]}]`);
            } catch { }
          }

          console.log('[QueryGenerator] Repaired runaway JSON:', repaired);
          return repaired;
        }
      }
      return null;
    };

    // Try to parse JSON, with fallback for malformed responses
    let result;
    try {
      result = JSON.parse(contentStr);
    } catch (parseError) {
      // Log full response for debugging
      console.error('[QueryGenerator] Failed to parse JSON. Response length:', contentStr.length);
      console.error('[QueryGenerator] Parse error:', parseError);

      // Try repair for runaway responses
      const repaired = tryRepairJson(contentStr);
      if (repaired) {
        result = repaired;
      } else {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = contentStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            result = JSON.parse(jsonMatch[1].trim());
          } catch {
            throw new Error(`Failed to parse LLM response as JSON: ${(parseError as Error).message}`);
          }
        } else {
          // Try to find JSON object in the response
          const objectMatch = contentStr.match(/\{[\s\S]*\}/);
          if (objectMatch) {
            try {
              result = JSON.parse(objectMatch[0]);
            } catch {
              // Try repair on the extracted object
              const repairedObj = tryRepairJson(objectMatch[0]);
              if (repairedObj) {
                result = repairedObj;
              } else {
                throw new Error(`Failed to parse LLM response as JSON: ${(parseError as Error).message}`);
              }
            }
          } else {
            throw new Error(`Failed to parse LLM response as JSON: ${(parseError as Error).message}`);
          }
        }
      }
    }

    // Handle case where LLM intentionally returned empty SQL (requesting more info)
    const sqlTrimmed = (result.sql || "").trim();
    if (!sqlTrimmed) {
      // Empty SQL with explanation = LLM needs clarification from user
      // This is a valid "needs_clarification" case, NOT an error
      console.log(`[Query Generator] LLM returned empty SQL - needs clarification`);

      const explanation = result.explanation || "More information needed to generate a query.";

      // Use structured fields from new output format (preferred)
      // CRITICAL: Filter tables to remove country-localized and temp tables
      const rawTablesNeeded: string[] = result.tablesNeeded || [];
      const tablesNeeded = filterTablesNeeded(rawTablesNeeded);
      console.log(`[Query Generator] Tables: ${rawTablesNeeded.length} raw → ${tablesNeeded.length} filtered: ${tablesNeeded.join(', ')}`);

      const clarifyingQuestions: string[] = result.clarifyingQuestions || [];
      const schemaNotes: string[] = result.schemaNotes || [];
      const stagedSql: string | undefined = result.stagedSql || undefined;

      if (stagedSql) {
        console.log(`[Query Generator] Staged SQL preview: ${stagedSql.substring(0, 100)}...`);
      }

      // Build missing details from tables list
      const missingDetails: string[] = [];
      if (tablesNeeded.length > 0) {
        missingDetails.push(`Schema needed for tables: ${tablesNeeded.join(', ')}`);
      }

      // Fallback parsing if structured fields not provided
      if (tablesNeeded.length === 0 && clarifyingQuestions.length === 0) {
        // Try old parsing methods for backward compatibility
        if (explanation.toLowerCase().includes("metric") || explanation.toLowerCase().includes("'top'")) {
          missingDetails.push("Ranking metric not specified (e.g., by spend, count, or balance)");
        }
        if (explanation.toLowerCase().includes("schema") || explanation.toLowerCase().includes("tables")) {
          missingDetails.push("Schema context not available for requested tables");
        }
      }

      // Fallback if nothing parsed
      if (missingDetails.length === 0) {
        missingDetails.push("Additional context needed to generate accurate query");
      }

      const clarificationResult = ResponseCaseFactory.needsClarification(
        explanation,
        missingDetails,
        {
          logSessionId,
          promptFiles,
          reasoning: `LLM determined that more information is needed before generating SQL.`,
          modelInfo: { model: response.model || "unknown", temperature: 0.5, maxTokens: 2000 },
          tablesNeeded, // Pass structured tables
          schemaNotes,  // Pass schema observations
          stagedSql,    // Pass preview SQL for staged display
          tokenUsage,   // Pass token usage for cost display
        },
        clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined
      );

      completeLogSession(currentLogSessionId, clarificationResult);
      return clarificationResult;
    }

    // Basic SQL syntax validation
    if (sqlTrimmed) {
      // Check for unmatched quotes
      const singleQuotes = (sqlTrimmed.match(/'/g) || []).length;
      const doubleQuotes = (sqlTrimmed.match(/"/g) || []).length;
      
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        const errorResult = ResponseCaseFactory.troubleshooting(
          "The generated query has unmatched quotes",
          `Unmatched quotes detected: ${singleQuotes % 2 !== 0 ? 'single' : ''}${doubleQuotes % 2 !== 0 ? 'double' : ''} quotes`,
          "other", // Use "other" for syntax errors
          { logSessionId, promptFiles },
          "The query contains unmatched quotation marks. Please regenerate.",
          true // Allow retry
        );
        completeLogSession(currentLogSessionId, errorResult);
        return errorResult;
      }

      // Check for incomplete parentheses
      const openParens = (sqlTrimmed.match(/\(/g) || []).length;
      const closeParens = (sqlTrimmed.match(/\)/g) || []).length;
      
      if (openParens !== closeParens) {
        const errorResult = ResponseCaseFactory.troubleshooting(
          "The generated query has unmatched parentheses",
          `Unmatched parentheses: ${openParens} open, ${closeParens} close`,
          "other", // Use "other" for syntax errors
          { logSessionId, promptFiles },
          "The query contains unmatched parentheses. Please regenerate.",
          true // Allow retry
        );
        completeLogSession(currentLogSessionId, errorResult);
        return errorResult;
      }

      // Check for suspicious patterns that might cause parsing errors
      const suspiciousPatterns = [
        /\s+\.\s*$/, // Trailing dot with spaces
        /\.\s*\n\s*[^a-zA-Z_]/, // Dot followed by newline and non-letter
        /\bPT\.\w*\s*"/, // PT.P" pattern from error
      ];

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(sqlTrimmed)) {
          const errorResult = ResponseCaseFactory.troubleshooting(
            "The generated query contains syntax issues",
            "Suspicious SQL pattern detected that may cause parsing errors",
            "other", // Use "other" for syntax errors
            { logSessionId, promptFiles },
            "The query contains potential syntax errors. Please regenerate.",
            true // Allow retry
          );
          completeLogSession(currentLogSessionId, errorResult);
          return errorResult;
        }
      }
    }

    // Validate that non-empty SQL is a SELECT query (or CTE with SELECT)
    const sqlUpperCase = sqlTrimmed.toUpperCase();
    const isSelectQuery = sqlUpperCase.startsWith("SELECT") ||
      (sqlUpperCase.startsWith("WITH") && sqlUpperCase.includes("SELECT"));

    if (!isSelectQuery) {
      const errorResult = ResponseCaseFactory.troubleshooting(
        "The generated query is not a SELECT statement",
        "Only SELECT queries are allowed for security reasons.",
        "security_constraint",
        { logSessionId, promptFiles },
        "Ensure your request asks to retrieve (SELECT) data, not modify it"
      );
      completeLogSession(currentLogSessionId, errorResult);
      return errorResult;
    }

    // Check for dangerous keywords using word boundaries (to avoid matching CREATEDDATETIME, etc.)
    // Note: "CREATE" is excluded from CTE context - CTEs don't use CREATE
    const dangerousKeywords = ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "TRUNCATE", "EXEC", "EXECUTE"];
    // Only check CREATE if it's not part of "CREATE VIEW/TABLE/etc" patterns (dangerous) vs just being in a column name
    const hasDangerousCreate = /\bCREATE\s+(TABLE|VIEW|INDEX|PROCEDURE|FUNCTION|TRIGGER|DATABASE|SCHEMA)\b/i.test(sqlUpperCase);

    for (const keyword of dangerousKeywords) {
      // Use regex with word boundaries to match standalone keywords only
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(sqlUpperCase)) {
        const errorResult = ResponseCaseFactory.troubleshooting(
          `The generated query contains forbidden operations`,
          `Query contains forbidden keyword: ${keyword}`,
          "security_constraint",
          { logSessionId, promptFiles },
          "Only SELECT queries are permitted. Ensure your request is asking to retrieve data, not modify it",
          false // Cannot retry - this is a fundamental security constraint
        );
        completeLogSession(currentLogSessionId, errorResult);
        return errorResult;
      }
    }

    if (hasDangerousCreate) {
      const errorResult = ResponseCaseFactory.troubleshooting(
        `The generated query contains forbidden operations`,
        `Query contains CREATE statement`,
        "security_constraint",
        { logSessionId, promptFiles },
        "Only SELECT queries are permitted. Ensure your request is asking to retrieve data, not modify it",
        false
      );
      completeLogSession(currentLogSessionId, errorResult);
      return errorResult;
    }

    // Include reasoning if enabled
    let reasoning: string | undefined;
    if (SHOW_RAG_REASONING) {
      const trackedReasoning = reasoningTracker.getReasoning();
      if (trackedReasoning) {
        trackedReasoning.selectedTables = tablesToUse.map(t => t.tableName);
        trackedReasoning.selectedReason = relevantTables.length > 0
          ? `Selected from ${relevantTables.length} RAG-ranked tables (with keyword boosting)`
          : "Using all available metadata (RAG not ready)";
        reasoning = formatReasoningForChat(trackedReasoning);
      }
    }

    // Extract confidence and assumedSchema from LLM response
    const llmConfidence: "high" | "medium" | "inferred" = result.confidence || "medium";
    const assumedSchema: string[] | undefined = result.assumedSchema?.length > 0 ? result.assumedSchema : undefined;

    const metadata: ResponseMetadata = {
      sql: result.sql,
      explanation: result.explanation,
      ragSources: ragSources.length > 0 ? ragSources : undefined,
      reasoning,
      logSessionId,
      promptFiles,
      modelInfo: { model: response.model || "unknown", temperature: 0.5, maxTokens: 2000 },
      tokenUsage, // Include token usage for cost display
      assumedSchema, // Pass assumed schema notes for inferred confidence
    };

    // At this point, we have valid SQL that passed security checks
    // Determine confidence: use LLM's stated confidence, or derive from RAG
    let confidence: "high" | "medium" | "inferred" = llmConfidence;
    if (confidence === "medium" && relevantTables.length > 0) {
      confidence = "high"; // Upgrade to high if we had RAG-selected tables
    }

    if (assumedSchema) {
      console.log(`[QueryGenerator] Inferred confidence with assumed schema: ${assumedSchema.join(', ')}`);
    }

    const successResult = ResponseCaseFactory.perfect(
      result.sql,
      result.explanation || "Query generated successfully.",
      metadata,
      confidence,
      assumedSchema // Pass assumed schema for display
    );

    completeLogSession(currentLogSessionId, successResult);
    
    // Auto-learning: analyze conversation history, detect user corrections and save to knowledge base
    if (conversationHistory && conversationHistory.length > 2) {
      // Execute auto-learning asynchronously without blocking query return
      analyzeAndLearnFromConversation(conversationHistory, result.sql, userId)
        .then(() => {
          console.log('[Auto-Learning] Conversation history analysis completed');
        })
        .catch((error) => {
          console.warn('[Auto-Learning] Auto-learning failed:', error);
        });
    }
    
    return successResult;
  } catch (error) {
    console.error("Error generating SQL query:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

    // Categorize the error
    let issueType: TroubleshootingCase["issueType"] = "other";
    let suggestion: string | undefined;

    if (errorMessage.includes("fetch") || errorMessage.includes("timeout") || errorMessage.includes("network")) {
      issueType = "service_unavailable";
      suggestion = "Check LLM service connectivity and try again";
    } else if (errorMessage.includes("unauthorized") || errorMessage.includes("401") || errorMessage.includes("API key")) {
      issueType = "permission_denied";
      suggestion = "Check AI service API key configuration";
    } else if (errorMessage.includes("rate limit") || errorMessage.includes("429")) {
      issueType = "rate_limit";
      suggestion = "Wait a moment and try again";
    }

    const errorResult = ResponseCaseFactory.troubleshooting(
      "Failed to generate SQL query",
      errorMessage,
      issueType,
      { logSessionId, promptFiles: getUsedPromptFiles() },
      suggestion,
      issueType !== "permission_denied" // Can retry for most errors except permission issues
    );
    completeLogSession(currentLogSessionId, errorResult);
    return errorResult;
  }
}

/**
 * Keyword-based table matching fallback when RAG is not ready
 * Returns tables with scores for logging purposes
 */
function findRelevantTablesByKeywordsWithScores(
  query: string,
  allTables: Array<{ id: number; tableName: string; description: string | null }>
): Array<{ tableName: string; score: number; matchedKeywords?: string[] }> {
  const queryLower = query.toLowerCase();
  const scores = new Map<string, number>();
  const matchedKeywordsMap = new Map<string, string[]>();

  // D365-specific keyword mappings
  const keywordMappings: Record<string, string[]> = {
    // Customer/Sales
    'customer': ['CustTable', 'CustGroup', 'CustTrans', 'CustInvoice', 'CustPaym', 'DirPartyTable'],
    'customers': ['CustTable', 'CustGroup', 'CustTrans', 'DirPartyTable'],
    'sales': ['SalesTable', 'SalesLine', 'SalesOrder', 'CustInvoice', 'CustTrans'],
    'order': ['SalesTable', 'SalesLine', 'PurchTable', 'PurchLine'],
    'orders': ['SalesTable', 'SalesLine', 'PurchTable', 'PurchLine'],
    'invoice': ['CustInvoice', 'VendInvoice', 'CustInvoiceJour', 'VendInvoiceJour'],

    // Vendor/Purchasing
    'vendor': ['VendTable', 'VendGroup', 'VendTrans', 'VendInvoice', 'DirPartyTable'],
    'vendors': ['VendTable', 'VendGroup', 'VendTrans', 'DirPartyTable'],
    'supplier': ['VendTable', 'VendGroup', 'VendTrans'],
    'purchase': ['PurchTable', 'PurchLine', 'PurchOrder', 'VendInvoice'],
    'purchasing': ['PurchTable', 'PurchLine', 'VendTable'],
    'spend': ['VendTrans', 'VendInvoice', 'PurchTable', 'VendTable'],

    // Inventory
    'inventory': ['InventTable', 'InventTrans', 'InventSum', 'InventDim', 'InventOnHand'],
    'item': ['InventTable', 'EcoResProduct', 'InventItemGroup'],
    'items': ['InventTable', 'EcoResProduct', 'InventItemGroup'],
    'product': ['EcoResProduct', 'EcoResProductCategory', 'InventTable'],
    'products': ['EcoResProduct', 'EcoResProductCategory', 'InventTable'],
    'stock': ['InventSum', 'InventOnHand', 'InventTrans'],
    'warehouse': ['InventLocation', 'WMSLocation', 'WHSWarehouse'],

    // Finance
    'ledger': ['LedgerJournalTable', 'LedgerTrans', 'GeneralJournalEntry'],
    'journal': ['LedgerJournalTable', 'LedgerJournalTrans'],
    'account': ['MainAccount', 'LedgerAccount', 'CustTable', 'VendTable'],
    'payment': ['CustPaym', 'VendPaym', 'BankAccountTrans'],
    'bank': ['BankAccountTable', 'BankAccountTrans'],

    // Common
    'party': ['DirPartyTable', 'DirPerson', 'DirOrganization'],
    'address': ['LogisticsPostalAddress', 'DirPartyLocation'],
    'contact': ['ContactPerson', 'DirPartyContact'],
  };

  // Score tables based on keyword matches
  for (const [keyword, tables] of Object.entries(keywordMappings)) {
    if (queryLower.includes(keyword)) {
      for (const tableName of tables) {
        scores.set(tableName, (scores.get(tableName) || 0) + 10);
        const existing = matchedKeywordsMap.get(tableName) || [];
        if (!existing.includes(keyword)) {
          matchedKeywordsMap.set(tableName, [...existing, keyword]);
        }
      }
    }
  }

  // Also match table names directly mentioned in query
  for (const table of allTables) {
    const tableNameLower = table.tableName.toLowerCase();

    // Direct table name mention
    if (queryLower.includes(tableNameLower)) {
      scores.set(table.tableName, (scores.get(table.tableName) || 0) + 20);
      const existing = matchedKeywordsMap.get(table.tableName) || [];
      matchedKeywordsMap.set(table.tableName, [...existing, "direct-match"]);
    }

    // Partial match (e.g., "cust" matches "CustTable")
    const words = queryLower.split(/\s+/);
    for (const word of words) {
      if (word.length >= 4 && tableNameLower.includes(word)) {
        scores.set(table.tableName, (scores.get(table.tableName) || 0) + 5);
        const existing = matchedKeywordsMap.get(table.tableName) || [];
        if (!existing.includes(`partial:${word}`)) {
          matchedKeywordsMap.set(table.tableName, [...existing, `partial:${word}`]);
        }
      }
    }

    // Description match
    if (table.description) {
      const descLower = table.description.toLowerCase();
      for (const word of words) {
        if (word.length >= 4 && descLower.includes(word)) {
          scores.set(table.tableName, (scores.get(table.tableName) || 0) + 3);
          const existing = matchedKeywordsMap.get(table.tableName) || [];
          if (!existing.includes(`desc:${word}`)) {
            matchedKeywordsMap.set(table.tableName, [...existing, `desc:${word}`]);
          }
        }
      }
    }
  }

  // Sort by score and return top matches with details
  const sorted = Array.from(scores.entries())
    .filter(([_, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30) // Limit to top 30 tables
    .map(([tableName, score]) => ({
      tableName,
      score,
      matchedKeywords: matchedKeywordsMap.get(tableName),
    }));

  // If no matches, return some common D365 tables as fallback
  if (sorted.length === 0) {
    return ['CustTable', 'VendTable', 'SalesTable', 'PurchTable', 'InventTable', 'DirPartyTable']
      .filter(t => allTables.some(at => at.tableName === t))
      .map(t => ({ tableName: t, score: 1, matchedKeywords: ["default-fallback"] }));
  }

  return sorted;
}

/**
 * Keyword-based table matching fallback when RAG is not ready
 * Uses D365-specific keywords to find relevant tables
 * @deprecated Use findRelevantTablesByKeywordsWithScores for better logging
 */
function findRelevantTablesByKeywords(
  query: string,
  allTables: Array<{ id: number; tableName: string; description: string | null }>
): string[] {
  return findRelevantTablesByKeywordsWithScores(query, allTables).map(r => r.tableName);
}

/**
 * Extract field names from SQL query for confirmation checking
 */
function extractFieldsFromSQL(sql: string): string[] {
  const fieldRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  const matches = sql.match(fieldRegex) || [];
  
  // Filter out SQL keywords and table names
  const sqlKeywords = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'TOP', 'DISTINCT',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP', 'BY', 'ORDER', 'HAVING', 'AS', 'ON', 'JOIN',
    'INNER', 'LEFT', 'RIGHT', 'OUTER', 'UNION', 'WITH', 'NOLOCK', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'
  ]);
  
  return matches
    .map(field => field.toUpperCase())
    .filter(field => 
      !sqlKeywords.has(field) && 
      field.length > 1 && 
      !field.includes('(') && 
      !field.includes(')')
    );
}

/**
 * Check if SQL contains fields that need confirmation
 */
async function checkFieldsNeedConfirmation(
  sql: string, 
  relevantTables: string[]
): Promise<{ needsConfirmation: boolean; fields: string[]; suggestions: string[] }> {
  try {
    const usedFields = extractFieldsFromSQL(sql);
    
    // Get knowledge base for relevant tables
    const knowledgeBase = new Map<string, any[]>();
    for (const tableName of relevantTables) {
      try {
        const comments = await commentsDataService.getCommentsByTable(tableName);
        if (comments.length > 0) {
          knowledgeBase.set(tableName, comments);
        }
      } catch (error) {
        console.warn(`Failed to load comments for ${tableName}:`, error);
      }
    }
    
    // Find fields not in knowledge base
    const unverifiedFields: string[] = [];
    const suggestions: string[] = [];
    
    for (const field of usedFields) {
      let fieldVerified = false;
      
      for (const [tableName, comments] of Array.from(knowledgeBase)) {
        const fieldMatch = comments.find(comment => 
          comment.fieldName.toUpperCase() === field
        );
        
        if (fieldMatch) {
          fieldVerified = true;
          // Check if field is deprecated
          if (fieldMatch.comments.includes('[DEPRECATED]')) {
            // Find alternative field
            const alternative = comments.find(c => 
              !c.comments.includes('[DEPRECATED]') && 
              c.comments.toLowerCase().includes('buyer group')
            );
            if (alternative) {
              suggestions.push(`${field} is deprecated, use ${alternative.fieldName} instead`);
            }
          }
          break;
        }
      }
      
      if (!fieldVerified) {
        unverifiedFields.push(field);
      }
    }
    
    // Simple heuristic: only ask confirmation if there are unverified fields
    // and 30% probability to avoid being too annoying
    const needsConfirmation = unverifiedFields.length > 0 && Math.random() < 0.3;
    
    return {
      needsConfirmation,
      fields: unverifiedFields,
      suggestions
    };
    
  } catch (error) {
    console.warn('Error checking field confirmation:', error);
    return { needsConfirmation: false, fields: [], suggestions: [] };
  }
}

/**
 * Generate confirmation message for user
 */
function generateConfirmationMessage(
  unverifiedFields: string[],
  suggestions: string[]
): string {
  if (unverifiedFields.length === 0) {
    return '';
  }
  
  let message = `I used ${unverifiedFields.join(', ')} Fields`;
  
  if (unverifiedFields.length === 1) {
    message += `, is this correct?`;
  } else {
    message += `, are all these fields correct?`;
  }
  
  if (suggestions.length > 0) {
    message += `\n\n💡 Suggestions: ${suggestions.join('；')}`;
  }
  
  message += `\n\nPlease confirm or tell me the correct field names.`;
  
  return message;
}

/**
 * Enhanced query generation with conversational learning
 */
export async function generateSqlQueryWithConfirmation(
  query: string,
  userSecurityRoles: string[] = [],
  userId: number
): Promise<{
  sql: string;
  explanation: string;
  confidence: "high" | "medium" | "inferred";
  tablesNeeded?: string[];
  needsConfirmation?: boolean;
  confirmationMessage?: string;
  unverifiedFields?: string[];
}> {
  try {
    // Generate SQL normally first
    const result = await generateSqlQuery(query, userSecurityRoles, userId);
    
    // Check if we need confirmation
    const relevantTables = result.tablesNeeded && result.tablesNeeded.length > 0 ? result.tablesNeeded : ['PurchTable']; // fallback
    const confirmationCheck = await checkFieldsNeedConfirmation(result.sql || '', relevantTables);
    
    if (confirmationCheck.needsConfirmation) {
      const confirmationMessage = generateConfirmationMessage(
        confirmationCheck.fields,
        confirmationCheck.suggestions
      );
      
      return {
        sql: result.sql || '',
        explanation: result.explanation,
        confidence: result.type === 'perfect' ? result.confidence : 'medium',
        tablesNeeded: result.tablesNeeded,
        needsConfirmation: true,
        confirmationMessage,
        unverifiedFields: confirmationCheck.fields
      };
    }
    
    return {
      sql: result.sql || '',
      explanation: result.explanation,
      confidence: result.type === 'perfect' ? result.confidence : 'medium',
      tablesNeeded: result.tablesNeeded
    };
    
  } catch (error) {
    console.error('Error in generateSqlQueryWithConfirmation:', error);
    // Fallback to normal query generation
    const fallbackResult = await generateSqlQuery(query, userSecurityRoles, userId);
    return {
      sql: fallbackResult.sql || '',
      explanation: fallbackResult.explanation,
      confidence: fallbackResult.type === 'perfect' ? fallbackResult.confidence : 'medium',
      tablesNeeded: fallbackResult.tablesNeeded
    };
  }
}
