import { useAuth } from "@/_core/hooks/useAuth";
import { useIsMobile } from "@/hooks/useMobile";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ConnectionStatusBanner } from "@/components/ConnectionStatusBanner";
import { Navigation } from "@/components/Navigation";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, Plus, Download, ChevronDown, ChevronUp, Copy, Check, Sparkles, BrainCircuit, User, Bot, MessageSquare, MoreHorizontal, Trash2, Menu } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useLocation, useRoute } from "wouter";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Database, Code } from "lucide-react";
import { SqlViewerModal } from "@/components/SqlViewerModal";
import { QueryProgressTracker, QueryStage } from "@/components/QueryProgressTracker";
import { PromptViewerModal } from "@/components/PromptViewerModal";
import { OperationIndicators, OperationType, OperationStatus } from "@/components/OperationIndicator";
import { SlashCommandMenu, generateTemplateCommands, SlashCommand } from "@/components/SlashCommandMenu";
import { ClarificationDialog } from "@/components/ClarificationDialog";
import { detectQueryAmbiguity } from "@/utils/queryAmbiguityDetector";
import { MetadataCommandModal } from "@/components/MetadataCommandModal";
import { QueryFeedback } from "@/components/QueryFeedback";
import { SqlFeedbackDialog } from "@/components/SqlFeedbackDialog";
import { useQueryResultPersistence } from "@/hooks/useQueryResultPersistence";

// Helper to extract tables needed from message content
function extractTablesNeeded(content: string): { cleanContent: string; tables: string[] } {
  const match = content.match(/<!-- TABLES_NEEDED:(\[.+?\]) -->/);
  if (match) {
    try {
      const tables = JSON.parse(match[1]) as string[];
      return {
        cleanContent: content.replace(/\n?\n?<!-- TABLES_NEEDED:\[.+?\] -->/, ''),
        tables,
      };
    } catch {
      return { cleanContent: content, tables: [] };
    }
  }
  return { cleanContent: content, tables: [] };
}

const MessageBubble = ({
  msg,
  onSchemaContext
}: {
  msg: any;
  onSchemaContext: (context: string) => void;
}) => {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === "user";

  const { cleanContent, tables } = !isUser
    ? extractTablesNeeded(msg.content)
    : { cleanContent: msg.content, tables: [] };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanContent);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}>
      <div className={`flex max-w-[92%] sm:max-w-[85%] min-w-0 ${isUser ? "flex-row-reverse" : "flex-row"} gap-2 sm:gap-3`}>
        {/* Avatar */}
        <div className={`
          flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border shadow-sm
          ${isUser ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600"}
        `}>
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </div>

        {/* Bubble */}
        <div className={`group relative rounded-2xl px-5 py-3.5 text-sm leading-relaxed border break-words overflow-hidden min-w-0
          ${isUser
            ? "bg-blue-600 border-blue-600 text-white shadow-sm"
            : "bg-white border-slate-300 shadow-sm text-slate-800"
          }
        `}>
          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className={`absolute top-2 right-2 p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 focus:opacity-100
              ${isUser
                ? "text-white/80 hover:text-white hover:bg-white/20 focus:bg-white/20 focus:text-white"
                : "text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:bg-slate-100 focus:text-slate-800"
              }
            `}
            title="Copy message"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>

          {isUser ? (
            <div className="whitespace-pre-wrap break-words overflow-wrap-anywhere">{cleanContent}</div>
          ) : (
            <div className="prose prose-sm max-w-none break-words overflow-hidden
              prose-p:my-1.5 prose-p:leading-relaxed prose-p:break-words
              prose-headings:mt-3 prose-headings:mb-2 prose-headings:text-slate-900
              prose-code:px-1 prose-code:py-0.5 prose-code:bg-slate-100 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-code:break-all
              prose-pre:p-3 prose-pre:bg-slate-50 prose-pre:border prose-pre:border-slate-200 prose-pre:rounded-lg prose-pre:overflow-x-auto prose-pre:max-w-full
              prose-ul:my-2 prose-li:my-0.5
            ">
              <Streamdown>{cleanContent}</Streamdown>
              {tables.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <MetadataCommandModal
                    tables={tables}
                    onSchemaContext={onSchemaContext}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default function Chat() {
  const { user, loading: authLoading } = useAuth();
  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const trpcUtils = trpc.useUtils();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/chat/:id");
  const conversationId = params?.id ? parseInt(params.id) : null;

  const [input, setInput] = useState("");
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(conversationId);
  const { queryResult, setQueryResult, clearQueryResult } = useQueryResultPersistence(currentConversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });

  const { data: conversations, refetch: refetchConversations } = trpc.conversation.list.useQuery(undefined, {
    enabled: !!user,
  });

  const { data: activeConfig } = trpc.config.getActiveLlmConfig.useQuery();

  // Generate slash commands with common D365 tables
  useEffect(() => {
    // Use common D365 F&O tables for templates
    const commonTables = ['CustTable', 'SalesTable', 'PurchTable', 'VendTable', 'InventTable'];
    const commands = generateTemplateCommands(commonTables);
    setSlashCommands(commands);
  }, []);

  const { data: messages, refetch: refetchMessages } = trpc.conversation.getMessages.useQuery(
    { conversationId: currentConversationId! },
    {
      enabled: !!currentConversationId,
      placeholderData: (previousData) => previousData // Keep previous data while fetching new conversation
    }
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sqlModalOpen, setSqlModalOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [queryStage, setQueryStage] = useState<QueryStage>("analyzing");
  const [queryStartTime, setQueryStartTime] = useState<number | null>(null);
  const [llmStartTime, setLlmStartTime] = useState<number | null>(null);
  const [totalElapsedMs, setTotalElapsedMs] = useState<number | undefined>(undefined);
  const [promptViewerOpen, setPromptViewerOpen] = useState(false);
  const [selectedPromptFile, setSelectedPromptFile] = useState("");
  const [showInsights, setShowInsights] = useState(false);
  const [insights, setInsights] = useState<any>(null);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [availableCompanies, setAvailableCompanies] = useState<string[]>([]);
  const [operations, setOperations] = useState<{
    type: OperationType;
    status: OperationStatus;
    label?: string;
  }[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showClarificationDialog, setShowClarificationDialog] = useState(false);
  const [pendingQuery, setPendingQuery] = useState("");
  const [missingContext, setMissingContext] = useState<string[]>([]);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [copiedContext, setCopiedContext] = useState(false);
  const [preflightQuestions, setPreflightQuestions] = useState<Array<{
    field: string;
    question: string;
    type: "text" | "select" | "date";
    options?: string[];
    required: boolean;
    context: string;
  }>>([]);

  // Get available tables for ambiguity detection
  const { data: availableTables } = trpc.metadata.listTables.useQuery(undefined, {
    enabled: !!user,
  });

  // Get feature flags from backend
  const { data: featureFlags } = trpc.config.getFeatureFlags.useQuery();

  // Force re-render every second while query is running to update timer
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (isSubmitting && llmStartTime) {
      const interval = setInterval(() => {
        forceUpdate(n => n + 1);
      }, 1000); // Update every second
      return () => clearInterval(interval);
    }
  }, [isSubmitting, llmStartTime]);

  const createConversation = trpc.conversation.create.useMutation({
    onSuccess: (data) => {
      setCurrentConversationId(data.id);
      navigate(`/chat/${data.id}`);
      refetchConversations();
      // After creating conversation, send the message
      if (input.trim()) {
        // Set operations to active
        setOperations([
          { type: 'metadata', status: 'active', label: 'Analyzing query' },
          { type: 'ai', status: 'active', label: 'Generating SQL' },
        ]);
        // Proceed with query generation
        generateQuery.mutate({
          conversationId: data.id,
          naturalLanguageQuery: input,
        });
      }
    },
    onError: (error) => {
      toast.error(error.message);
      setIsSubmitting(false);
    },
  });

  const generateQuery = trpc.query.generate.useMutation({
    onSuccess: (data) => {
      // Check if SQL is ready but pending execution
      if (data.pendingExecution && data.sql) {
        setQueryStage("complete");
        const elapsed = queryStartTime ? Date.now() - queryStartTime : undefined;
        setTotalElapsedMs(elapsed);
        setLlmStartTime(null);

        // Store the pending SQL for manual execution
        setQueryResult({
          ...data,
          pendingExecution: true,
        });

        // Mark all operations as complete
        setOperations(prev => prev.map(op => ({ ...op, status: 'complete' as OperationStatus })));
        setTimeout(() => setOperations([]), 2000);
        refetchMessages();
        setInput("");
        setIsSubmitting(false);

        toast.info("SQL generated! Click 'Run Query' to execute.");
        return;
      }

      // Quick transition through final stages (for needs_clarification case)
      setQueryStage("complete");
      const elapsed = queryStartTime ? Date.now() - queryStartTime : undefined;
      setTotalElapsedMs(elapsed);
      setLlmStartTime(null);

      setQueryResult(data);
      // Mark all operations as complete
      setOperations(prev => prev.map(op => ({ ...op, status: 'complete' as OperationStatus })));
      setTimeout(() => setOperations([]), 2000);
      refetchMessages();
      setInput("");
      setIsSubmitting(false);
    },
    onError: (error) => {
      setQueryStage("error");
      const elapsed = queryStartTime ? Date.now() - queryStartTime : undefined;
      setTotalElapsedMs(elapsed);
      setLlmStartTime(null);
      toast.error(error.message);
      setIsSubmitting(false);
    },
  });

  // NEW: Execute SQL mutation (user-initiated)
  const executeSql = trpc.query.executeSql.useMutation({
    onSuccess: (data) => {
      // Update queryResult with execution results
      setQueryResult((prev: any) => ({
        ...prev,
        ...data,
        pendingExecution: false,
      }));

      refetchMessages();

      if (data.success) {
        toast.success(`Query executed: ${data.rowCount} rows returned`);

        // Extract available companies from DataAreaId column
        if (data.data && data.columns) {
          const dataAreaCol = data.columns.find((col: any) =>
            col.name.toLowerCase() === 'dataareaid'
          );
          if (dataAreaCol) {
            const companies = Array.from(new Set(
              data.data.map((row: any) => row[dataAreaCol.name]).filter(Boolean)
            )).sort();
            setAvailableCompanies(companies as string[]);
            setCompanyFilter('all');
          } else {
            setAvailableCompanies([]);
          }
        }
      } else {
        toast.error(`Execution failed: ${data.error}`);
      }
    },
    onError: (error) => {
      toast.error(`Execution error: ${error.message}`);
    },
  });

  // Preflight mutation for LLM-based query analysis
  const queryPreflight = trpc.query.preflight.useMutation({
    onSuccess: (result) => {
      if (result.status === "NEEDS_CLARIFICATION" && result.questions.length > 0) {
        // Show clarification dialog with LLM-generated questions
        setPreflightQuestions(result.questions);
        setMissingContext(result.questions.map(q => q.context));
        setShowClarificationDialog(true);
      } else {
        // Query is ready, proceed with generation
        submitQuery(pendingQuery);
      }
    },
    onError: (error) => {
      console.warn("[Preflight] Error, proceeding with query:", error.message);
      // On preflight error, proceed with query anyway
      submitQuery(pendingQuery);
    },
  });

  const exportToExcel = trpc.query.exportToExcel.useMutation({
    onSuccess: (data) => {
      window.open(data.url, "_blank");
      toast.success("Excel file exported successfully!");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const generateInsights = trpc.query.generateInsights.useMutation({
    onSuccess: (data) => {
      setInsights(data);
      setShowInsights(true);
      toast.success("Insights generated successfully!");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Export conversation mutation
  const exportConversation = trpc.conversation.export.useMutation({
    onSuccess: (data) => {
      // Create a blob and trigger download
      const blob = new Blob([data.content], { type: data.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Conversation exported!");
    },
    onError: (error) => {
      toast.error(`Export failed: ${error.message}`);
    },
  });

  const handleExportConversation = (format: "markdown" | "json" = "markdown") => {
    if (!currentConversationId) return;
    exportConversation.mutate({ conversationId: currentConversationId, format });
  };

  // Copy all conversation context to clipboard
  const handleCopyAllContext = async () => {
    if (!messages?.length) return;

    // Build markdown-formatted conversation context
    let contextText = `# Conversation Context\n\n`;
    contextText += `**Conversation ID**: ${currentConversationId}\n`;
    contextText += `**Exported at**: ${new Date().toISOString()}\n\n---\n\n`;

    for (const msg of messages) {
      const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
      // Extract clean content (remove hidden TABLES_NEEDED markers)
      const { cleanContent } = extractTablesNeeded(msg.content);
      contextText += `## ${role}\n\n${cleanContent}\n\n---\n\n`;
    }

    try {
      await navigator.clipboard.writeText(contextText);
      setCopiedContext(true);
      toast.success("Conversation context copied to clipboard!");
      setTimeout(() => setCopiedContext(false), 2000);
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (conversationId) {
      // 切换到新对话时清理状态
      if (conversationId !== currentConversationId) {
        clearQueryResult();
        setQueryStage("analyzing");
        setIsSubmitting(false);
        setTotalElapsedMs(undefined);
        setLlmStartTime(null);
      }
      setCurrentConversationId(conversationId);
    }
  }, [conversationId, currentConversationId, clearQueryResult]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // Show slash menu if input starts with /
    if (value.startsWith('/') && value.length > 1) {
      setShowSlashMenu(true);
      // Calculate menu position
      if (inputRef.current) {
        const rect = inputRef.current.getBoundingClientRect();
        setMenuPosition({
          top: rect.top - 300, // Position above input
          left: rect.left,
        });
      }
    } else {
      setShowSlashMenu(false);
    }
  };

  const handleCommandSelect = (command: SlashCommand) => {
    setInput(command.template);
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!user) {
    window.location.href = getLoginUrl();
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSubmitting) return;

    // Save the query for potential preflight use
    setPendingQuery(input);

    // First, do a quick client-side check for obviously ambiguous queries
    if (availableTables && availableTables.length > 0) {
      const tableNames = availableTables.map((t: any) => t.tableName);
      const ambiguityCheck = detectQueryAmbiguity(input, tableNames);

      // Only use client-side for high-confidence obvious cases
      if (ambiguityCheck.isAmbiguous && ambiguityCheck.confidence > 0.8) {
        // Show clarification dialog
        setMissingContext(ambiguityCheck.missingContext);
        setPreflightQuestions([]);
        setShowClarificationDialog(true);
        return;
      }
    }

    // For less obvious cases, use LLM-based preflight analysis
    // Controlled by ENABLE_PREFLIGHT env var (default: ON)
    const enablePreflight = featureFlags?.enablePreflight ?? true;

    if (enablePreflight) {
      // Use LLM to analyze if query needs clarification
      queryPreflight.mutate({ query: input });
      return;
    }

    // Proceed with query submission directly
    submitQuery(input);
  };

  const submitQuery = (query: string) => {
    setIsSubmitting(true);
    setQueryStage("analyzing");
    const startTime = Date.now();
    setQueryStartTime(startTime);
    setTotalElapsedMs(undefined);
    setLlmStartTime(null);

    if (!currentConversationId) {
      // Create conversation and send message atomically
      createConversation.mutate({ title: query.substring(0, 100) });
      return;
    }

    // Set operations to active and proceed with query
    setOperations([
      { type: 'metadata', status: 'active', label: 'Loading metadata' },
      { type: 'ai', status: 'active', label: 'Generating SQL' },
    ]);

    // Quick transitions through preparatory stages to get to the main LLM wait
    // Users care most about the AI thinking time, so we get there quickly
    setTimeout(() => setQueryStage("relationships"), 200);
    setTimeout(() => setQueryStage("context"), 400);
    setTimeout(() => {
      setQueryStage("generating");
      setLlmStartTime(Date.now());
    }, 600);

    // Send message to existing conversation
    generateQuery.mutate({
      conversationId: currentConversationId,
      naturalLanguageQuery: query,
    });
  };

  const handleClarificationSubmit = (clarifications: Record<string, string>) => {
    // Append clarifications to the original query
    let clarifiedQuery = pendingQuery;

    Object.entries(clarifications).forEach(([key, value]) => {
      if (key === 'tableName') {
        clarifiedQuery += ` from ${value} table`;
      } else if (key === 'dateRange') {
        clarifiedQuery += ` for ${value}`;
      } else if (key === 'filterCondition') {
        clarifiedQuery += ` where ${value}`;
      } else if (key === 'company') {
        clarifiedQuery += ` in company ${value}`;
      } else if (key === 'limit') {
        clarifiedQuery += ` limit ${value}`;
      } else {
        clarifiedQuery += ` (${key}: ${value})`;
      }
    });

    // Update input with clarified query
    setInput(clarifiedQuery);
    setShowClarificationDialog(false);

    // Submit the clarified query
    submitQuery(clarifiedQuery);
  };

  const handleNewChat = () => {
    setCurrentConversationId(null);
    setQueryResult(null);
    navigate("/chat");
  };

  // 处理 SQL 反馈
  const handleSqlFeedback = (feedback: string) => {
    if (!currentConversationId || !queryResult?.sql) return;
    
    // 获取原始查询（从输入框或最后一条消息）
    const originalQuery = input.trim() || 
      (messages && messages.length > 0 ? 
        messages[messages.length - 1].content : 
        "Can you provide me all the purchase order without purchasing group");
    
    // 创建修改后的查询请求
    const modifiedQuery = `${originalQuery}\n\n用户反馈: ${feedback}`;
    
    // 重新生成 SQL（携带反馈信息）
    setIsSubmitting(true);
    setQueryStage("analyzing");
    
    generateQuery.mutate({
      conversationId: currentConversationId,
      naturalLanguageQuery: modifiedQuery,
    });
    
    toast.info("正在根据您的反馈修改 SQL...");
  };

  const handleExport = () => {
    if (!queryResult?.data || !queryResult?.columns) {
      toast.error("No data to export");
      return;
    }

    exportToExcel.mutate({
      data: queryResult.data,
      columns: queryResult.columns,
      naturalLanguageQuery: input,
      sql: queryResult.sql,
      executionTime: queryResult.executionTime,
      rowCount: queryResult.rowCount,
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      <Navigation />

      {/* Connection Status Banner */}
      <div className="container mx-auto px-4 pt-4">
        <ConnectionStatusBanner />
      </div>

      <div className="container mx-auto px-2 sm:px-4 py-2 sm:py-4 flex gap-6 h-[calc(100dvh-130px)] sm:h-[calc(100dvh-140px)]">
        {/* Sidebar - Desktop */}
        <aside className="hidden lg:flex w-72 flex-col gap-3 shrink-0 bg-slate-50 rounded-2xl border border-slate-300 p-3 shadow-sm overflow-hidden">
          <Button
            onClick={handleNewChat}
            className={`w-full justify-start gap-3 h-12 shadow-sm transition-all text-sm font-medium border shrink-0
              ${!currentConversationId
                ? "bg-blue-600 text-white border-blue-700 hover:bg-blue-700 shadow-blue-200"
                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-400"
              }
            `}
          >
            <div className={`h-6 w-6 rounded-full flex items-center justify-center transition-colors
              ${!currentConversationId ? "bg-white/20 text-white" : "bg-blue-100/50 text-blue-600"}
            `}>
              <Plus className="h-4 w-4" />
            </div>
            New Chat
          </Button>

          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-2 py-2 flex items-center justify-between shrink-0">
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">History</h3>
            </div>
            <ScrollArea className="flex-1 -mx-1 px-1 h-full">
              <div className="space-y-1 pb-2">
                {conversations?.filter(conv => conv.title && conv.title.trim()).map((conv) => (
                  <button
                    key={conv.id}
                    title={conv.title || "Conversation"}
                    onClick={() => {
                      setCurrentConversationId(conv.id);
                      clearQueryResult(); // 使用持久化 hook 的清理方法
                      setQueryStage("analyzing"); // 重置查询状态
                      navigate(`/chat/${conv.id}`);
                    }}
                    className={`
                      group w-full flex items-center gap-3 px-3 py-3 text-sm text-left rounded-xl transition-all duration-200 border
                      ${currentConversationId === conv.id
                        ? "bg-white border-blue-300 ring-1 ring-blue-100 shadow-sm text-blue-700 font-semibold z-10"
                        : "border-transparent text-slate-600 hover:bg-white hover:border-slate-300 hover:shadow-sm hover:text-slate-900"
                      }
                    `}
                  >
                    <MessageSquare className={`h-4 w-4 shrink-0 transition-colors ${currentConversationId === conv.id ? "text-blue-600" : "text-slate-400 group-hover:text-slate-500"}`} />
                    <div className="truncate flex-1 leading-snug">
                      {conv.title || "Conversation"}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </aside>

        {/* Mobile Sidebar Sheet */}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" className="w-72 p-0 flex flex-col">
            <div className="flex flex-col gap-3 p-3 h-full">
              <Button
                onClick={() => { handleNewChat(); setMobileSidebarOpen(false); }}
                className={`w-full justify-start gap-3 h-12 shadow-sm transition-all text-sm font-medium border shrink-0
                  ${
                    !currentConversationId
                      ? "bg-blue-600 text-white border-blue-700 hover:bg-blue-700 shadow-blue-200"
                      : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-400"
                  }
                `}
              >
                <div className={`h-6 w-6 rounded-full flex items-center justify-center transition-colors
                  ${!currentConversationId ? "bg-white/20 text-white" : "bg-blue-100/50 text-blue-600"}
                `}>
                  <Plus className="h-4 w-4" />
                </div>
                New Chat
              </Button>
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="px-2 py-2 flex items-center justify-between shrink-0">
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">History</h3>
                </div>
                <ScrollArea className="flex-1 -mx-1 px-1 h-full">
                  <div className="space-y-1 pb-2">
                    {conversations?.filter(conv => conv.title && conv.title.trim()).map((conv) => (
                      <button
                        key={conv.id}
                        title={conv.title || "Conversation"}
                        onClick={() => {
                          setCurrentConversationId(conv.id);
                          clearQueryResult();
                          setQueryStage("analyzing");
                          navigate(`/chat/${conv.id}`);
                          setMobileSidebarOpen(false);
                        }}
                        className={`
                          group w-full flex items-center gap-3 px-3 py-3 text-sm text-left rounded-xl transition-all duration-200 border
                          ${currentConversationId === conv.id
                            ? "bg-white border-blue-300 ring-1 ring-blue-100 shadow-sm text-blue-700 font-semibold z-10"
                            : "border-transparent text-slate-600 hover:bg-white hover:border-slate-300 hover:shadow-sm hover:text-slate-900"
                          }
                        `}
                      >
                        <MessageSquare className={`h-4 w-4 shrink-0 transition-colors ${currentConversationId === conv.id ? "text-blue-600" : "text-slate-400 group-hover:text-slate-500"}`} />
                        <div className="truncate flex-1 leading-snug">
                          {conv.title || "Conversation"}
                        </div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-h-0 bg-white rounded-2xl shadow-sm border border-slate-300 overflow-hidden relative">
          {/* Chat Header with Model Info & Export */}
          <div className="flex items-center justify-between px-3 sm:px-6 py-2 sm:py-3 border-b border-slate-200 bg-white/95 backdrop-blur-sm sticky top-0 z-20">
            <div className="flex items-center gap-2 sm:gap-3 overflow-hidden flex-1 mr-2">
              {/* Mobile hamburger menu */}
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden h-8 w-8 p-0 shrink-0"
                onClick={() => setMobileSidebarOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <h3
                className="font-semibold text-slate-700 truncate max-w-[160px] sm:max-w-[300px] cursor-default text-sm sm:text-base"
                title={currentConversationId ? (conversations?.find(c => c.id === currentConversationId)?.title || 'New Chat') : 'New Chat'}
              >
                {currentConversationId ? (conversations?.find(c => c.id === currentConversationId)?.title || 'Chat') : 'New Chat'}
              </h3>

              {activeConfig && (
                <div className="hidden sm:flex items-center gap-2 text-xs shrink-0">
                  <Badge variant="outline" className="gap-1 font-normal bg-background/50 text-xs px-2 py-0.5 h-6">
                    <Sparkles className="h-3 w-3 text-primary" />
                    {activeConfig.model.length > 25 ? activeConfig.model.substring(0, 22) + '...' : activeConfig.model}
                  </Badge>

                  <div className="hidden sm:flex items-center gap-2">
                    <Badge variant="secondary" className="gap-1 font-normal text-muted-foreground bg-muted/50 text-[10px] px-2 py-0.5 h-6">
                      {activeConfig.provider === 'manus_builtin' ? 'Manus' :
                        activeConfig.provider === 'azure_openai' ? 'Azure' :
                          activeConfig.provider === 'openai' ? 'OpenAI' : 'Custom'}
                    </Badge>

                    <span className="text-muted-foreground flex items-center gap-1 text-[10px]" title="Temperature (Creativity)">
                      <BrainCircuit className="h-3 w-3" />
                      {activeConfig.temperature}%
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {currentConversationId && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyAllContext}
                    disabled={!messages?.length}
                    title="Copy all conversation context to clipboard"
                  >
                    {copiedContext ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                    <span className="ml-1 text-xs hidden sm:inline">Copy All</span>
                  </Button>
                  {showExportOptions && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExportConversation("markdown")}
                        disabled={exportConversation.isPending}
                        title="Export as Markdown"
                      >
                        <Download className="h-4 w-4" />
                        <span className="ml-1 text-xs">.md</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExportConversation("json")}
                        disabled={exportConversation.isPending}
                        title="Export as JSON"
                      >
                        <Download className="h-4 w-4" />
                        <span className="ml-1 text-xs">.json</span>
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowExportOptions(!showExportOptions)}
                    title={showExportOptions ? "Hide export options" : "Show export options"}
                  >
                    {showExportOptions ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 sm:p-4 min-h-0" ref={scrollRef}>
            {!currentConversationId ? (
              <div className="h-full flex items-center justify-center px-2">
                <div className="text-center max-w-2xl w-full">
                  <Database className="h-10 w-10 sm:h-16 sm:w-16 mx-auto mb-3 sm:mb-4 text-blue-600" />
                  <h2 className="text-lg sm:text-2xl font-semibold mb-2">Welcome to D365 F&O Data Agent</h2>
                  <p className="text-muted-foreground mb-4 sm:mb-6 text-sm sm:text-base">
                    Ask questions about your Dynamics 365 Finance and Operations data in natural language.
                  </p>
                  <div className="text-left space-y-2 text-sm text-muted-foreground">
                    <p className="font-medium">Try asking:</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Show me all purchase orders from last month</li>
                      <li>Why can't we ship to customer ABC123?</li>
                      <li>Which purchase orders could impact production?</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6 w-full max-w-full overflow-x-hidden">
                {messages?.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    msg={msg}
                    onSchemaContext={(context) => {
                      setInput(prev => prev
                        ? `${context}\n\n---\n\n${prev}`
                        : `Here's the schema context for the tables you mentioned:\n\n${context}\n\n---\n\nNow, `
                      );
                      inputRef.current?.focus();
                    }}
                  />
                ))}
                {/* SQL Ready to Execute - 在消息流中显示 */}
                {queryResult?.pendingExecution && queryResult?.sql && (
                  <div className="flex justify-start w-full">
                    <div className="w-full max-w-2xl">
                      <div className="border rounded-lg p-4 bg-blue-50 border-blue-200">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <h3 className="font-semibold text-blue-800">SQL Ready to Execute</h3>
                            {queryResult.confidence === "inferred" && (
                              <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                                ⚠️ Inferred schema
                              </span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button onClick={() => setSqlModalOpen(true)} size="sm" variant="outline">
                              <Code className="h-4 w-4 mr-2" />
                              View SQL
                            </Button>
                            <Button onClick={() => setFeedbackDialogOpen(true)} size="sm" variant="outline">
                              <MessageSquare className="h-4 w-4 mr-2" />
                              Modify SQL
                            </Button>
                            <Button
                              onClick={() => {
                                if (!currentConversationId || !queryResult?.sql) return;
                                executeSql.mutate({
                                  conversationId: currentConversationId,
                                  sql: queryResult.sql,
                                });
                              }}
                              size="sm"
                              variant="default"
                              disabled={executeSql.isPending}
                              className="bg-blue-600 hover:bg-blue-700"
                            >
                              {executeSql.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              ) : (
                                <Database className="h-4 w-4 mr-2" />
                              )}
                              Run Query
                            </Button>
                          </div>
                        </div>
                        {queryResult.assumedSchema && queryResult.assumedSchema.length > 0 && (
                          <p className="text-xs text-yellow-700 mt-2">
                            📝 Assumed: {queryResult.assumedSchema.join('; ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {/* Query Results - 在消息流中显示 */}
                {queryResult?.success && (
                  <div className="flex justify-start w-full">
                    <div className="w-full max-w-2xl">
                      <div className="border rounded-lg p-4 bg-white shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-semibold text-sm sm:text-base">Query Results ({queryResult.rowCount} rows)</h3>
                            {availableCompanies.length > 0 && (
                              <select
                                value={companyFilter}
                                onChange={(e) => setCompanyFilter(e.target.value)}
                                className="border rounded px-2 py-1 text-sm"
                              >
                                <option value="all">All Companies</option>
                                {availableCompanies.map(company => (
                                  <option key={company} value={company}>{company}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <Button onClick={() => setSqlModalOpen(true)} size="sm" variant="outline">
                              <Code className="h-4 w-4 mr-2" />
                              <span className="hidden sm:inline">View </span>SQL
                            </Button>
                            <Button
                              onClick={() => {
                                if (!queryResult?.data || !queryResult?.sql) return;
                                generateInsights.mutate({
                                  originalQuestion: input,
                                  sql: queryResult.sql,
                                  results: queryResult.data,
                                  rowCount: queryResult.rowCount,
                                });
                              }}
                              size="sm"
                              variant="outline"
                              disabled={generateInsights.isPending}
                            >
                              {generateInsights.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              ) : (
                                <Database className="h-4 w-4 mr-2" />
                              )}
                              Generate Insights
                            </Button>
                            <Button onClick={handleExport} size="sm" disabled={exportToExcel.isPending}>
                              {exportToExcel.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              ) : (
                                <Download className="h-4 w-4 mr-2" />
                              )}
                              Export to Excel
                            </Button>
                          </div>
                        </div>
                        
                        {/* Debug Info - 只在开发环境显示 */}
                        {process.env.NODE_ENV === 'development' && (
                          <div className="text-xs text-muted-foreground mb-2 p-2 bg-gray-50 rounded">
                            Debug: success={queryResult?.success}, data.length={queryResult?.data?.length}, rowCount={queryResult?.rowCount}
                          </div>
                        )}
                        
                        {queryResult.data && queryResult.data.length > 0 ? (
                          <>
                            <div className="border rounded-lg overflow-auto max-h-64 sm:max-h-96">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    {queryResult.columns?.map((col: any) => (
                                      <TableHead key={col.name}>{col.name}</TableHead>
                                    ))}
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {queryResult.data
                                    .filter((row: any) => {
                                      if (companyFilter === 'all') return true;
                                      const dataAreaCol = queryResult.columns?.find((col: any) =>
                                        col.name.toLowerCase() === 'dataareaid'
                                      );
                                      return dataAreaCol && row[dataAreaCol.name] === companyFilter;
                                    })
                                    .slice(0, 100)
                                    .map((row: any, idx: number) => (
                                      <TableRow key={idx}>
                                        {queryResult.columns?.map((col: any) => (
                                          <TableCell key={col.name}>
                                            {row[col.name]?.toString() || ""}
                                          </TableCell>
                                        ))}
                                      </TableRow>
                                    ))}
                                </TableBody>
                              </Table>
                              {queryResult.data.length > 100 && (
                                <div className="p-2 text-sm text-muted-foreground text-center border-t">
                                  Showing first 100 rows. Export to Excel to see all {queryResult.rowCount} rows.
                                </div>
                              )}
                            </div>
                            
                            {/* User Feedback */}
                            <QueryFeedback
                              naturalLanguageQuery={input}
                              generatedSql={queryResult.sql}
                              onFeedbackSubmitted={(satisfied) => {
                                console.log(`User feedback: ${satisfied ? 'satisfied' : 'not satisfied'}`);
                              }}
                            />
                          </>
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            <p>No data returned from query.</p>
                            <p className="text-sm">Query executed successfully but returned 0 rows.</p>
                            
                            {/* User Feedback - Show even for empty results */}
                            <QueryFeedback
                              naturalLanguageQuery={input}
                              generatedSql={queryResult.sql}
                              onFeedbackSubmitted={(satisfied) => {
                                console.log(`User feedback: ${satisfied ? 'satisfied' : 'not satisfied'}`);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {isSubmitting && (
                  <div className="flex justify-start w-full">
                    <div className="w-full max-w-2xl">
                      <QueryProgressTracker
                        stage={queryStage}
                        error={generateQuery.error?.message}
                        llmElapsedMs={llmStartTime ? Date.now() - llmStartTime : undefined}
                        totalElapsedMs={totalElapsedMs}
                        modelInfo={queryResult?.modelInfo}
                        tokenUsage={queryResult?.tokenUsage}
                        promptFiles={queryResult?.promptFiles}
                        onPromptFileClick={(filename) => {
                          setSelectedPromptFile(filename);
                          setPromptViewerOpen(true);
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Insights Display */}
          {showInsights && insights && (
            <div className="border-t p-4 bg-blue-50">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-blue-900">Data Insights</h3>
                <Button onClick={() => setShowInsights(false)} size="sm" variant="ghost">
                  Close
                </Button>
              </div>

              <div className="space-y-4">
                {/* Summary */}
                <div>
                  <h4 className="font-medium text-sm text-blue-800 mb-1">Summary</h4>
                  <p className="text-sm text-gray-700">{insights.summary}</p>
                </div>

                {/* Key Findings */}
                {insights.keyFindings && insights.keyFindings.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm text-blue-800 mb-1">Key Findings</h4>
                    <ul className="list-disc list-inside space-y-1">
                      {insights.keyFindings.map((finding: string, idx: number) => (
                        <li key={idx} className="text-sm text-gray-700">{finding}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Patterns */}
                {insights.patterns && insights.patterns.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm text-blue-800 mb-1">Patterns</h4>
                    <ul className="list-disc list-inside space-y-1">
                      {insights.patterns.map((pattern: string, idx: number) => (
                        <li key={idx} className="text-sm text-gray-700">{pattern}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Statistics */}
                {insights.statistics && insights.statistics.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm text-blue-800 mb-1">Statistics</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {insights.statistics.map((stat: any, idx: number) => (
                        <div key={idx} className="bg-white p-2 rounded border">
                          <div className="text-xs text-gray-600">{stat.label}</div>
                          <div className="text-sm font-semibold text-gray-900">{stat.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Anomalies */}
                {insights.anomalies && insights.anomalies.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm text-red-800 mb-1">Anomalies</h4>
                    <ul className="list-disc list-inside space-y-1">
                      {insights.anomalies.map((anomaly: string, idx: number) => (
                        <li key={idx} className="text-sm text-red-700">{anomaly}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Recommendations */}
                {insights.recommendations && insights.recommendations.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm text-green-800 mb-1">Recommendations</h4>
                    <ul className="list-disc list-inside space-y-1">
                      {insights.recommendations.map((rec: string, idx: number) => (
                        <li key={idx} className="text-sm text-green-700">{rec}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Input Area */}
          <div className="border-t border-slate-100 p-2 sm:p-4 bg-white/50 backdrop-blur-sm">
            <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3 items-end max-w-4xl mx-auto w-full">
              <div className="relative flex-1 bg-white rounded-xl shadow-sm border border-slate-200 focus-within:ring-2 focus-within:ring-blue-500/10 focus-within:border-blue-500/50 transition-all">
                <Textarea
                  ref={inputRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={(e) => {
                    // Submit on Enter (without Shift)
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Ask about your D365 data..."
                  disabled={isSubmitting}
                  className="w-full min-h-[48px] sm:min-h-[60px] max-h-[150px] sm:max-h-[200px] resize-none border-0 focus-visible:ring-0 bg-transparent py-3 sm:py-4 px-3 sm:px-4 placeholder:text-slate-400 text-sm"
                  rows={2}
                />
                <SlashCommandMenu
                  show={showSlashMenu}
                  commands={slashCommands.filter(cmd =>
                    cmd.name.toLowerCase().includes(input.slice(1).toLowerCase())
                  )}
                  onSelect={handleCommandSelect}
                  onClose={() => setShowSlashMenu(false)}
                  position={menuPosition}
                />
              </div>
              <Button
                type="submit"
                disabled={!input.trim() || isSubmitting}
                className={`h-[48px] w-[48px] sm:h-[60px] sm:w-[60px] rounded-xl shadow-sm transition-all shrink-0 ${!input.trim() || isSubmitting ? "bg-slate-100 text-slate-400" : "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/20"
                  }`}
              >
                {isSubmitting ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </Button>
            </form>
          </div>
        </main>
      </div>

      {/* SQL Viewer Modal */}
      {queryResult?.sql && (
        <SqlViewerModal
          open={sqlModalOpen}
          onOpenChange={setSqlModalOpen}
          sql={queryResult.sql}
          explanation={{
            technical: queryResult.explanation?.technical || "",
            layman: queryResult.explanation?.layman || "",
          }}
        />
      )}

      {/* Clarification Dialog */}
      <ClarificationDialog
        open={showClarificationDialog}
        onClose={() => setShowClarificationDialog(false)}
        onSubmit={handleClarificationSubmit}
        originalQuery={pendingQuery}
        missingContext={missingContext}
        preformattedFields={preflightQuestions.map(q => ({
          name: q.field,
          label: q.question,
          type: q.type,
          options: q.options,
          placeholder: `Enter ${q.field}`,
          required: q.required,
          context: q.context,
        }))}
      />

      {/* SQL Feedback Dialog */}
      {queryResult?.sql && (
        <SqlFeedbackDialog
          isOpen={feedbackDialogOpen}
          onClose={() => setFeedbackDialogOpen(false)}
          sql={queryResult.sql}
          explanation={queryResult.explanation?.layman || queryResult.explanation || ""}
          onSubmitFeedback={handleSqlFeedback}
        />
      )}

      {/* Prompt Viewer Modal */}
      <PromptViewerModal
        open={promptViewerOpen}
        onClose={() => setPromptViewerOpen(false)}
        filename={selectedPromptFile}
      />
    </div>
  );
}
