// ─── Webhook ───────────────────────────────────────────────────────────────

export interface WebhookPayload {
  sessionId: string;
  userId: string;
  message: string;
  timestamp: string;
  channel: "web" | "email" | "sms" | "phone";
  metadata?: Record<string, unknown>;
}

// ─── Intent labels ─────────────────────────────────────────────────────────

export type IntentLabel =
  | "greeting"
  | "thankyou"
  | "appointments"
  | "escalations"
  | "sensitive_data"
  | "agent_query"
  | "unclear";

// ─── Mistral ───────────────────────────────────────────────────────────────

export interface MistralIntentResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ─── MCP (Model Context Protocol) customer lookup ──────────────────────────

export interface MCPCustomer {
  id: string;
  email: string;
  name: string;
  tier: "free" | "pro" | "enterprise";
  preferredChannel: "web" | "email" | "phone";
  agentAssigned: string | null;
  sensitiveDataConsent: boolean;
  appointments: MCPAppointment[];
  openEscalations: MCPEscalation[];
}

export interface MCPAppointment {
  id: string;
  agentId: string;
  scheduledAt: string;   // ISO-8601
  status: "confirmed" | "pending" | "cancelled";
  topic: string;
}

export interface MCPEscalation {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
}

// ─── Supabase (customer support tickets / history) ─────────────────────────

export interface SupabaseSupportTicket {
  id: string;
  customerId: string;
  status: "open" | "pending" | "resolved" | "closed";
  category: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Airtable (inventory availability) ────────────────────────────────────

export interface AirtableInventoryRecord {
  id: string;
  fields: {
    SKU: string;
    Name: string;
    Stock: number;
    Price: number;
    Available: boolean;
    LeadTimeDays: number;
  };
}

// ─── Workflow execution result ─────────────────────────────────────────────

export interface BranchExecutionResult {
  intent: IntentLabel;
  sessionId: string;
  userId: string;
  routedTo: string;             // name of the terminal node that ran
  payload: Record<string, unknown>;
  executionTimeMs: number;
  error?: { code: string; message: string };
}
