import { commentsDataService } from './commentsDataService';

/**
 * Pre-correction Service - Load relevant correction information before AI generates query
 */
export class PreCorrectionService {
  
  /**
   * Get relevant correction mappings based on query content and build pre-correction hints
   */
  async getPreCorrectionHints(query: string): Promise<string> {
    const queryLower = query.toLowerCase();
    let hints = '';
    
    // 1. Check "purchasing person" related queries
    if (queryLower.includes('purchasing person') || queryLower.includes('without purchasing person')) {
      const corrections = await this.getPurchasingPersonCorrections();
      if (corrections) {
        hints += `\n## IMPORTANT: Field Correction for "Purchasing Person"\n`;
        hints += `${corrections}\n`;
        hints += `**CRITICAL**: For queries about "purchasing person", use ItemBuyerGroupId (buyer group) instead of WorkerResponsible (individual worker).\n\n`;
      }
    }
    
    // 2. Check "purchasing group" related queries
    if (queryLower.includes('purchasing group') || queryLower.includes('buyer group')) {
      hints += `\n## IMPORTANT: Field Correction for "Purchasing Group"\n`;
      hints += `- **Correct Field**: BuyerGroupId (NOT PurchasingGroupId)\n`;
      hints += `- **Business Meaning**: Purchasing Group = Buyer Group in D365 F&O\n`;
      hints += `- **Query Pattern**: "without purchasing group" means "WHERE BuyerGroupId IS NULL"\n`;
      hints += `**CRITICAL**: Always use BuyerGroupId field for purchasing group queries.\n\n`;
    }
    
    // 3. Check YoY / trend / multi-metric comparison queries
    const isYoYQuery =
      queryLower.includes('last year') ||
      queryLower.includes('this year') ||
      queryLower.includes('yoy') ||
      queryLower.includes('year over year') ||
      queryLower.includes('year-over-year') ||
      queryLower.includes('trend') ||
      queryLower.includes('compare') ||
      queryLower.includes('comparison') ||
      queryLower.includes(' vs ') ||
      queryLower.includes('vs.') ||
      queryLower.includes('growth') ||
      queryLower.includes('change from') ||
      queryLower.includes('previous year') ||
      (queryLower.includes('multiple') && (queryLower.includes('metric') || queryLower.includes('data')));

    if (isYoYQuery) {
      hints += `\n## IMPORTANT: Year-over-Year / Trend Query Detected\n`;
      hints += `This query requires comparing data across two time periods (last year vs. this year).\n`;
      hints += `**CRITICAL SQL STRATEGY**:\n`;
      hints += `- Use CASE WHEN YEAR(dateField) = YEAR(GETDATE()) - 1 THEN value ELSE 0 END for last year\n`;
      hints += `- Use CASE WHEN YEAR(dateField) = YEAR(GETDATE()) THEN value ELSE 0 END for this year\n`;
      hints += `- Include a GrowthPct column: (ThisYear - LastYear) * 100.0 / NULLIF(LastYear, 0)\n`;
      hints += `- Filter: WHERE YEAR(dateField) IN (YEAR(GETDATE()) - 1, YEAR(GETDATE()))\n`;
      hints += `- For MULTIPLE metrics: use a CTE or CASE pivot — do NOT generate separate queries\n`;
      hints += `- Date fields: TransDate for *Trans tables; CreatedDateTime for PurchTable/SalesTable\n\n`;
    }

    // 4. Check other common correction patterns
    const otherCorrections = await this.getCommonCorrections(query);
    if (otherCorrections) {
      hints += otherCorrections;
    }
    
    return hints;
  }
  
  /**
   * Get "purchasing person" related correction information
   */
  private async getPurchasingPersonCorrections(): Promise<string> {
    try {
      const comments = await commentsDataService.getCommentsByTable('PurchTable');
      
      // Find buyer group related mappings
      const buyerGroupMapping = comments.find(c => 
        c.fieldName === 'ItemBuyerGroupId' && 
        c.comments.toLowerCase().includes('buyer group')
      );
      
      // Find worker related mappings
      const workerMapping = comments.find(c => 
        c.fieldName === 'WorkerResponsible' && 
        c.comments.toLowerCase().includes('purchasing personnel')
      );
      
      let correctionText = '';
      
      if (buyerGroupMapping && workerMapping) {
        correctionText += `- **Correct Field**: ${buyerGroupMapping.fieldName} - ${buyerGroupMapping.comments}\n`;
        correctionText += `- **Alternative Field**: ${workerMapping.fieldName} - ${workerMapping.comments}\n`;
        correctionText += `- **User Feedback**: "without purchasing person means without buyer group" (learned from user corrections)\n`;
      }
      
      return correctionText;
    } catch (error) {
      console.warn('[PreCorrection] Failed to get purchasing person corrections:', error);
      return '';
    }
  }
  
  /**
   * Get other common correction patterns
   */
  private async getCommonCorrections(query: string): Promise<string> {
    const queryLower = query.toLowerCase();
    let hints = '';
    
    // Can add more common correction patterns
    const commonPatterns = [
      {
        keywords: ['customer', 'client'],
        tableName: 'CustTable',
        corrections: [
          { field: 'AccountNum', meaning: 'customer account number' },
          { field: 'CustGroup', meaning: 'customer group' }
        ]
      },
      {
        keywords: ['vendor', 'supplier'],
        tableName: 'VendTable', 
        corrections: [
          { field: 'AccountNum', meaning: 'vendor account number' },
          { field: 'VendGroup', meaning: 'vendor group' }
        ]
      }
    ];
    
    for (const pattern of commonPatterns) {
      if (pattern.keywords.some(keyword => queryLower.includes(keyword))) {
        const comments = await commentsDataService.getCommentsByTable(pattern.tableName);
        const relevantComments = comments.filter(c => 
          pattern.corrections.some(correction => 
            c.fieldName === correction.field ||
            c.comments.toLowerCase().includes(correction.meaning.toLowerCase())
          )
        );
        
        if (relevantComments.length > 0) {
          hints += `\n## Field Corrections for ${pattern.tableName}\n`;
          relevantComments.forEach(comment => {
            hints += `- **${comment.fieldName}**: ${comment.comments}\n`;
          });
          hints += '\n';
        }
      }
    }
    
    return hints;
  }
  
  /**
   * Check if there are high-priority corrections that need to be applied
   */
  async hasHighPriorityCorrection(query: string): Promise<boolean> {
    const hints = await this.getPreCorrectionHints(query);
    return hints.includes('CRITICAL') || hints.includes('IMPORTANT');
  }
}

export const preCorrectionService = new PreCorrectionService();
