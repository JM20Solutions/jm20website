import axios from "axios";
import type {
  WebhookPayload,
  IntentLabel,
  BranchExecutionResult,
  MistralIntentResponse,
} from "./types";

/**
 * WorkflowRunner mirrors n8n's synchronous webhook-response model
 * (respondMode=lastNode).  The runner fires the webhook; the workflow
 * internally calls Mistral, MCP, Supabase, and/or Airtable depending on
 * the classified intent; the terminal node writes back to the webhook response.
 *
 * In tests, axios-mock-adapter intercepts every outbound HTTP call so no
 * real network traffic is generated.
 */
export class WorkflowRunner {
  readonly webhookUrl: string;
  readonly mistralUrl: string;
  readonly mcpUrl: string;
  readonly supabaseUrl: string;
  readonly airtableUrl: string;

  constructor(
    webhookUrl   = "http://localhost:5678/webhook/support-router",
    mistralUrl   = "https://api.mistral.ai/v1/chat/completions",
    mcpUrl       = "http://localhost:3100/mcp/v1/tools/call",
    supabaseUrl  = "http://localhost:54321/rest/v1/support_tickets",
    airtableUrl  = "https://api.airtable.com/v0/appINVENTORY/Inventory"
  ) {
    this.webhookUrl  = webhookUrl;
    this.mistralUrl  = mistralUrl;
    this.mcpUrl      = mcpUrl;
    this.supabaseUrl = supabaseUrl;
    this.airtableUrl = airtableUrl;
  }

  /** Named accessor so test beforeEach blocks can destructure cleanly. */
  get urls() {
    return {
      webhook:  this.webhookUrl,
      mistral:  this.mistralUrl,
      mcp:      this.mcpUrl,
      supabase: this.supabaseUrl,
      airtable: this.airtableUrl,
    };
  }

  /**
   * Fires the webhook and returns the terminal-node result.
   * The mock adapter in tests intercepts this POST and returns a
   * pre-built BranchExecutionResult, simulating the full execution path.
   */
  async execute(payload: WebhookPayload): Promise<BranchExecutionResult> {
    const start = Date.now();
    const response = await axios.post<BranchExecutionResult>(
      this.webhookUrl,
      payload,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15_000,
        validateStatus: () => true,
      }
    );
    return { ...response.data, executionTimeMs: Date.now() - start };
  }

  /** Builds a canonical payload, allowing per-test overrides. */
  static buildPayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
    return {
      sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
      userId:    "usr_mcp_abc123",
      message:   "Hello",
      timestamp: new Date().toISOString(),
      channel:   "web",
      ...overrides,
    };
  }

  /**
   * Parses the classified intent out of a Mistral response body.
   * Mirrors the Code node logic in the n8n workflow.
   * Returns "unclear" for any non-JSON or missing-intent content.
   */
  static parseIntent(res: MistralIntentResponse): IntentLabel {
    try {
      const parsed = JSON.parse(
        res.choices[0]?.message?.content ?? ""
      ) as { intent?: IntentLabel };
      return parsed.intent ?? "unclear";
    } catch {
      return "unclear";
    }
  }
}
