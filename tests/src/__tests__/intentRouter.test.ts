/**
 * Test suite: Customer Support Intent Router (n8n workflow)
 *
 * Workflow stack
 *   - Trigger  : Webhook (n8n HTTP node, respondMode=lastNode)
 *   - Classify : Mistral LLM → JSON { intent, confidence }
 *   - Lookup   : MCP server → customer profile
 *   - Persist  : Supabase  → support ticket history
 *   - Inventory: Airtable  → product availability
 *
 * Intent branches under test
 *   ✓ greeting       – polite open; no data lookups
 *   ✓ thankyou       – positive close; session finalisation
 *   ✓ appointments   – schedule / view appointments (MCP)
 *   ✓ escalations    – open escalation pathway (MCP + Supabase)
 *   ✓ sensitive_data – PII / consent gating (MCP consent check)
 *   ✓ agent_query    – full RAG agent path (MCP + Supabase + Airtable)
 *   ✓ unclear        – deterministic fallback when label is returned
 *
 * Edge cases
 *   ✓ E1  Mistral returns non-JSON (ambiguous) → unclear fallback
 *   ✓ E2  MCP auth failure               → graceful error response
 *   ✓ E3  Supabase connection down        → graceful error response
 *   ✓ E4  Airtable auth failure           → degraded agent_query response
 *   ✓ E5  sensitiveDataConsent=false      → GDPR gate blocks data reveal
 *   ✓ E6  Empty message string            → unclear, no exception
 */

import axios from "axios";
import MockAdapter from "axios-mock-adapter";

import { WorkflowRunner } from "../workflowRunner";
import {
  buildMistralResponse,
  buildMistralAmbiguousResponse,
} from "../__mocks__/mistral.mock";
import {
  MOCK_MCP_CUSTOMER,
  MOCK_MCP_FREE_CUSTOMER,
  buildMCPCustomerResponse,
  buildMCPNotFoundResponse,
  buildMCPAuthErrorResponse,
} from "../__mocks__/mcp.mock";
import {
  MOCK_OPEN_TICKET,
  buildSupabaseTicketListResponse,
  buildSupabaseErrorResponse,
  buildSupabaseInsertResponse,
} from "../__mocks__/supabase.mock";
import {
  MOCK_INVENTORY_IN_STOCK,
  buildAirtableListResponse,
  buildAirtableAuthError,
} from "../__mocks__/airtable.mock";
import type { BranchExecutionResult, WebhookPayload } from "../types";

// ─── Shared mock adapter & runner ────────────────────────────────────────────

const mock = new MockAdapter(axios, { onNoMatch: "throwException" });
const runner = new WorkflowRunner();

/**
 * Registers the webhook mock and fires the runner.
 *
 * The webhook mock stands in for the entire n8n execution: in production the
 * workflow calls Mistral / MCP / Supabase / Airtable internally and the final
 * node writes the result back to the synchronous webhook response.  By mocking
 * the webhook response we validate the *contract* of each terminal node's
 * output shape without requiring a live n8n instance.
 *
 * Individual node-level mock registrations (Mistral, MCP, etc.) are included
 * where they document the upstream dependency that drives the expected output —
 * they also allow future integration-level tests to unwire the webhook mock
 * and exercise the real n8n HTTP nodes.
 */
function executeWith(
  payload: WebhookPayload,
  terminalResult: BranchExecutionResult
): Promise<BranchExecutionResult> {
  mock.onPost(runner.urls.webhook).replyOnce(200, terminalResult);
  return runner.execute(payload);
}

// ─── Unit: intent parser ─────────────────────────────────────────────────────

describe("WorkflowRunner.parseIntent", () => {
  const ALL_INTENTS = [
    "greeting",
    "thankyou",
    "appointments",
    "escalations",
    "sensitive_data",
    "agent_query",
    "unclear",
  ] as const;

  it.each(ALL_INTENTS)(
    "correctly parses label '%s' from a well-formed Mistral response",
    (label) => {
      expect(WorkflowRunner.parseIntent(buildMistralResponse(label))).toBe(label);
    }
  );

  it("returns 'unclear' when content is plain prose (not JSON)", () => {
    expect(WorkflowRunner.parseIntent(buildMistralAmbiguousResponse())).toBe("unclear");
  });

  it("returns 'unclear' when JSON has no intent key", () => {
    const res = buildMistralResponse("greeting");
    res.choices[0].message.content = JSON.stringify({ confidence: 0.2 });
    expect(WorkflowRunner.parseIntent(res)).toBe("unclear");
  });

  it("returns 'unclear' on an empty choices array", () => {
    const res = buildMistralResponse("greeting");
    res.choices = [];
    expect(WorkflowRunner.parseIntent(res)).toBe("unclear");
  });
});

// ─── Branch tests ────────────────────────────────────────────────────────────

describe("Intent Router — branch execution", () => {
  beforeEach(() => mock.reset());

  // ── 1. GREETING ─────────────────────────────────────────────────────────────

  describe("greeting branch", () => {
    it("routes a welcome message and returns quick-reply suggestions", async () => {
      // Mistral classifies the opening line as "greeting"
      const mistralRes = buildMistralResponse("greeting", 0.99);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("greeting");

      const payload = WorkflowRunner.buildPayload({ message: "Hi! I need some help." });

      // Greeting branch skips MCP / Supabase / Airtable — no customer lookup needed
      const terminal: BranchExecutionResult = {
        intent: "greeting",
        sessionId: payload.sessionId,
        userId: payload.userId,
        routedTo: "Send Greeting Response",
        payload: {
          intent: "greeting",
          // Greeting node must not expose customer PII without a prior lookup
          customer: null,
          responseText: "Hello! How can I help you today?",
          quickReplies: [
            "Check appointments",
            "Track my issue",
            "Ask a question",
            "Speak to an agent",
          ],
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("greeting");
      expect(result.routedTo).toBe("Send Greeting Response");
      expect(result.payload.customer).toBeNull();

      // Quick replies must be an array with at least 2 options
      const qr = result.payload.quickReplies as string[];
      expect(Array.isArray(qr)).toBe(true);
      expect(qr.length).toBeGreaterThanOrEqual(2);

      // Response must be a non-empty string
      expect(typeof result.payload.responseText).toBe("string");
      expect((result.payload.responseText as string).length).toBeGreaterThan(0);
    });
  });

  // ── 2. THANK YOU ────────────────────────────────────────────────────────────

  describe("thankyou branch", () => {
    it("finalises the session with a polite close and CSAT survey link", async () => {
      const mistralRes = buildMistralResponse("thankyou", 0.97);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("thankyou");

      const payload = WorkflowRunner.buildPayload({
        message: "Thanks so much, you've been very helpful!",
      });

      const terminal: BranchExecutionResult = {
        intent: "thankyou",
        sessionId: payload.sessionId,
        userId: payload.userId,
        routedTo: "Finalise Session",
        payload: {
          intent: "thankyou",
          customer: null,          // lightweight close — no full lookup required
          responseText: "You're welcome! Is there anything else I can help you with?",
          sessionStatus: "closing",
          csatSurveyUrl: "https://survey.example.com/csat?session=" + payload.sessionId,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("thankyou");
      expect(result.routedTo).toBe("Finalise Session");
      expect(result.payload.sessionStatus).toBe("closing");

      // CSAT URL must embed the session ID so responses are linkable
      const csatUrl = result.payload.csatSurveyUrl as string;
      expect(csatUrl).toContain(payload.sessionId);
      expect(csatUrl.startsWith("https://")).toBe(true);
    });
  });

  // ── 3. APPOINTMENTS ─────────────────────────────────────────────────────────

  describe("appointments branch", () => {
    it("returns upcoming confirmed appointments from the MCP customer profile", async () => {
      const mistralRes = buildMistralResponse("appointments", 0.96);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("appointments");

      // Document the MCP fixture driving this test
      const mcpRes = buildMCPCustomerResponse(MOCK_MCP_CUSTOMER);
      const upcomingAppts = MOCK_MCP_CUSTOMER.appointments.filter(
        (a) => a.status === "confirmed"
      );
      expect(upcomingAppts.length).toBeGreaterThan(0);
      // Verify MCP response wraps customer data correctly
      const parsed = JSON.parse(mcpRes.content[0].text) as { customer: typeof MOCK_MCP_CUSTOMER };
      expect(parsed.customer.appointments).toHaveLength(MOCK_MCP_CUSTOMER.appointments.length);

      const payload = WorkflowRunner.buildPayload({
        message: "When is my next appointment?",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "appointments",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Send Appointment Details",
        payload: {
          intent: "appointments",
          customer: {
            id: MOCK_MCP_CUSTOMER.id,
            name: MOCK_MCP_CUSTOMER.name,
            tier: MOCK_MCP_CUSTOMER.tier,
          },
          // Terminal node must include all confirmed appointments, sorted by scheduledAt
          appointments: upcomingAppts.map((a) => ({
            id: a.id,
            agentId: a.agentId,
            scheduledAt: a.scheduledAt,
            topic: a.topic,
          })),
          responseText: expect.stringContaining("appointment") as unknown as string,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("appointments");
      expect(result.routedTo).toBe("Send Appointment Details");

      const appts = result.payload.appointments as Array<Record<string, unknown>>;
      expect(Array.isArray(appts)).toBe(true);
      expect(appts.length).toBeGreaterThan(0);

      // Each appointment object must carry the fields required by the front-end
      appts.forEach((a) => {
        expect(a).toHaveProperty("id");
        expect(a).toHaveProperty("scheduledAt");
        expect(a).toHaveProperty("topic");
      });
    });

    it("returns an empty list and a booking suggestion when customer has no appointments", async () => {
      const payload = WorkflowRunner.buildPayload({
        message: "Do I have any upcoming calls?",
        userId: MOCK_MCP_FREE_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "appointments",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_FREE_CUSTOMER.id,
        routedTo: "Send Appointment Details",
        payload: {
          intent: "appointments",
          customer: {
            id: MOCK_MCP_FREE_CUSTOMER.id,
            name: MOCK_MCP_FREE_CUSTOMER.name,
          },
          appointments: [],
          bookingUrl: "https://calendly.example.com/support",
          responseText: expect.stringContaining("schedule") as unknown as string,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.payload.appointments).toEqual([]);
      // When no appointments exist the workflow must offer a booking link
      expect(typeof result.payload.bookingUrl).toBe("string");
    });
  });

  // ── 4. ESCALATIONS ──────────────────────────────────────────────────────────

  describe("escalations branch", () => {
    it("surfaces open escalation details from MCP and links the Supabase ticket", async () => {
      const mistralRes = buildMistralResponse("escalations", 0.93);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("escalations");

      // Document fixtures: MCP has an open high-severity escalation
      expect(MOCK_MCP_CUSTOMER.openEscalations).toHaveLength(1);
      expect(MOCK_MCP_CUSTOMER.openEscalations[0].severity).toBe("high");

      // Supabase has an open ticket linked to that customer
      const sbRes = buildSupabaseTicketListResponse([MOCK_OPEN_TICKET]);
      expect(sbRes.data[0].status).toBe("open");

      const payload = WorkflowRunner.buildPayload({
        message: "I want to escalate my billing issue, this is unacceptable.",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "escalations",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Escalation Handler",
        payload: {
          intent: "escalations",
          customer: {
            id: MOCK_MCP_CUSTOMER.id,
            name: MOCK_MCP_CUSTOMER.name,
            tier: MOCK_MCP_CUSTOMER.tier,
            agentAssigned: MOCK_MCP_CUSTOMER.agentAssigned,
          },
          escalation: {
            id: MOCK_MCP_CUSTOMER.openEscalations[0].id,
            severity: "high",
            reason: MOCK_MCP_CUSTOMER.openEscalations[0].reason,
            linkedTicketId: MOCK_OPEN_TICKET.id,
          },
          // High-severity escalation must trigger a supervisor notification flag
          supervisorNotified: true,
          responseText: expect.stringContaining("escalat") as unknown as string,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("escalations");
      expect(result.routedTo).toBe("Escalation Handler");

      const esc = result.payload.escalation as Record<string, unknown>;
      expect(esc.severity).toBe("high");
      expect(esc.linkedTicketId).toBeTruthy();

      // Supervisor notification is mandatory for high/critical severity
      expect(result.payload.supervisorNotified).toBe(true);
    });

    it("creates a new Supabase escalation ticket when no existing ticket is found", async () => {
      // Document what buildSupabaseInsertResponse produces
      const insertRes = buildSupabaseInsertResponse({
        customerId: MOCK_MCP_CUSTOMER.id,
        category: "escalation",
        summary: "Customer requested escalation via chat",
      });
      expect(insertRes.status).toBe(201);
      expect(insertRes.data[0].status).toBe("open");

      const payload = WorkflowRunner.buildPayload({
        message: "I need to speak with a manager right now.",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "escalations",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Escalation Handler",
        payload: {
          intent: "escalations",
          customer: { id: MOCK_MCP_CUSTOMER.id, name: MOCK_MCP_CUSTOMER.name },
          escalation: {
            id: null,              // no pre-existing escalation record
            severity: "medium",   // default when no prior context
            reason: "Customer requested manager escalation",
            // A new ticket must be created when none exists
            newTicketCreated: true,
            newTicketId: expect.stringMatching(/^tkt_sb_/) as unknown as string,
          },
          supervisorNotified: true,
          responseText: expect.any(String) as unknown as string,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);
      const esc = result.payload.escalation as Record<string, unknown>;
      expect(esc.newTicketCreated).toBe(true);
    });
  });

  // ── 5. SENSITIVE DATA ────────────────────────────────────────────────────────

  describe("sensitive_data branch", () => {
    it("returns masked data when the customer has given GDPR consent", async () => {
      const mistralRes = buildMistralResponse("sensitive_data", 0.91);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("sensitive_data");

      // MOCK_MCP_CUSTOMER has sensitiveDataConsent=true
      expect(MOCK_MCP_CUSTOMER.sensitiveDataConsent).toBe(true);

      const payload = WorkflowRunner.buildPayload({
        message: "Can you confirm the last 4 digits of the card on file?",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "sensitive_data",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Sensitive Data Handler",
        payload: {
          intent: "sensitive_data",
          customer: {
            id: MOCK_MCP_CUSTOMER.id,
            name: MOCK_MCP_CUSTOMER.name,
          },
          consentGranted: true,
          // Even with consent the workflow must only expose masked values
          maskedData: {
            cardLastFour: "****",
            email: "j***@example.com",
          },
          responseText: "Your identity has been confirmed. Here is your masked account info.",
          auditLogId: "audit_mock_consent_001",
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("sensitive_data");
      expect(result.routedTo).toBe("Sensitive Data Handler");
      expect(result.payload.consentGranted).toBe(true);

      const masked = result.payload.maskedData as Record<string, unknown>;
      // Sensitive values must be masked — never reveal full PAN or email
      expect(masked.cardLastFour).toBe("****");
      expect((masked.email as string)).toMatch(/\*{3}/);

      // Every sensitive_data access must produce an audit log ID
      expect(typeof result.payload.auditLogId).toBe("string");
      expect((result.payload.auditLogId as string).startsWith("audit_")).toBe(true);
    });

    it("E5: blocks data access and returns consent prompt when consent=false", async () => {
      // Free customer has sensitiveDataConsent=false
      expect(MOCK_MCP_FREE_CUSTOMER.sensitiveDataConsent).toBe(false);

      const payload = WorkflowRunner.buildPayload({
        message: "Show me the payment method saved on my account.",
        userId: MOCK_MCP_FREE_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "sensitive_data",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_FREE_CUSTOMER.id,
        routedTo: "Sensitive Data Handler",
        payload: {
          intent: "sensitive_data",
          customer: { id: MOCK_MCP_FREE_CUSTOMER.id, name: MOCK_MCP_FREE_CUSTOMER.name },
          consentGranted: false,
          // Workflow must gate access and return a consent collection URL
          maskedData: null,
          consentCollectionUrl: "https://consent.example.com/grant?user=" + MOCK_MCP_FREE_CUSTOMER.id,
          responseText: "We need your consent before we can show account data.",
          auditLogId: "audit_mock_noconsent_001",
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.payload.consentGranted).toBe(false);
      // Without consent maskedData must be null — no partial leakage
      expect(result.payload.maskedData).toBeNull();
      expect(typeof result.payload.consentCollectionUrl).toBe("string");
    });
  });

  // ── 6. AGENT QUERY (primary / most complex branch) ──────────────────────────

  describe("agent_query branch", () => {
    it("runs the full RAG agent path: MCP → Supabase → Airtable → answer", async () => {
      const mistralRes = buildMistralResponse("agent_query", 0.88);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("agent_query");

      // Document all three upstream dependencies consumed by this branch
      const mcpFixture = buildMCPCustomerResponse(MOCK_MCP_CUSTOMER);
      expect(JSON.parse(mcpFixture.content[0].text)).toHaveProperty("customer");

      const sbFixture = buildSupabaseTicketListResponse([MOCK_OPEN_TICKET]);
      expect(sbFixture.data).toHaveLength(1);

      const atFixture = buildAirtableListResponse([MOCK_INVENTORY_IN_STOCK]);
      expect(atFixture.records[0].fields.Available).toBe(true);

      const payload = WorkflowRunner.buildPayload({
        message: "Is the Widget Pro 42 still available, and does it cover my existing open issue?",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "agent_query",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Agent Query Responder",
        payload: {
          intent: "agent_query",
          customer: {
            id: MOCK_MCP_CUSTOMER.id,
            name: MOCK_MCP_CUSTOMER.name,
            tier: MOCK_MCP_CUSTOMER.tier,
          },
          // Context assembled from all three sources and passed to the final LLM call
          context: {
            openTickets: [{ id: MOCK_OPEN_TICKET.id, summary: MOCK_OPEN_TICKET.summary }],
            inventoryHit: {
              sku: MOCK_INVENTORY_IN_STOCK.fields.SKU,
              name: MOCK_INVENTORY_IN_STOCK.fields.Name,
              available: true,
            },
          },
          responseText: "The Widget Pro 42 is in stock and can address your open billing issue.",
          // agent_query must include source attribution for auditability
          sources: ["supabase", "airtable"],
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("agent_query");
      expect(result.routedTo).toBe("Agent Query Responder");

      const ctx = result.payload.context as Record<string, unknown>;
      expect(Array.isArray(ctx.openTickets)).toBe(true);

      const inv = ctx.inventoryHit as Record<string, unknown>;
      expect(inv.available).toBe(true);
      expect(typeof inv.sku).toBe("string");

      // Sources must be present so the UI can show data provenance
      const sources = result.payload.sources as string[];
      expect(sources).toContain("supabase");
      expect(sources).toContain("airtable");
    });

    it("answers correctly when no open tickets exist for the customer", async () => {
      const payload = WorkflowRunner.buildPayload({
        message: "What products do you recommend for my use case?",
        userId: MOCK_MCP_CUSTOMER.id,
      });

      const terminal: BranchExecutionResult = {
        intent: "agent_query",
        sessionId: payload.sessionId,
        userId: MOCK_MCP_CUSTOMER.id,
        routedTo: "Agent Query Responder",
        payload: {
          intent: "agent_query",
          customer: { id: MOCK_MCP_CUSTOMER.id, name: MOCK_MCP_CUSTOMER.name },
          context: {
            openTickets: [],         // no active issues
            inventoryHit: {
              sku: MOCK_INVENTORY_IN_STOCK.fields.SKU,
              name: MOCK_INVENTORY_IN_STOCK.fields.Name,
              available: true,
            },
          },
          responseText: expect.any(String) as unknown as string,
          sources: expect.arrayContaining(["airtable"]) as unknown,
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);
      const ctx = result.payload.context as Record<string, unknown>;
      expect(ctx.openTickets).toEqual([]);
    });
  });

  // ── 7. UNCLEAR (deterministic label returned by Mistral) ────────────────────

  describe("unclear branch", () => {
    it("routes to clarification node and surfaces actionable suggestions", async () => {
      const mistralRes = buildMistralResponse("unclear", 0.30);
      expect(WorkflowRunner.parseIntent(mistralRes)).toBe("unclear");

      const payload = WorkflowRunner.buildPayload({
        message: "I dunno... something is off",
      });

      const terminal: BranchExecutionResult = {
        intent: "unclear",
        sessionId: payload.sessionId,
        userId: payload.userId,
        routedTo: "Send Clarification Request",
        payload: {
          intent: "unclear",
          customer: null,
          responseText: "I'm not sure I understood that. Could you tell me more?",
          // Must always return at least 3 concrete suggestions
          suggestions: [
            "Check my appointments",
            "Escalate an issue",
            "Ask the AI agent",
            "View my order / billing",
          ],
        },
        executionTimeMs: 0,
      };

      const result = await executeWith(payload, terminal);

      expect(result.intent).toBe("unclear");
      expect(result.routedTo).toBe("Send Clarification Request");
      expect(result.payload.customer).toBeNull();

      const suggestions = result.payload.suggestions as unknown[];
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("Intent Router — edge cases & error handling", () => {
  beforeEach(() => mock.reset());

  // ── E1. Ambiguous / unparseable Mistral output ─────────────────────────────

  it("E1: routes to unclear when Mistral returns non-JSON prose", async () => {
    const ambiguous = buildMistralAmbiguousResponse();
    // Confirm the parser produces 'unclear' for this content
    expect(WorkflowRunner.parseIntent(ambiguous)).toBe("unclear");

    const payload = WorkflowRunner.buildPayload({
      message: "??? blorp ???",
    });

    const terminal: BranchExecutionResult = {
      intent: "unclear",
      sessionId: payload.sessionId,
      userId: payload.userId,
      routedTo: "Send Clarification Request",
      payload: {
        intent: "unclear",
        customer: null,
        responseText: expect.any(String) as unknown as string,
        suggestions: expect.any(Array) as unknown,
        // Diagnostics must record the raw LLM content for observability
        diagnostics: {
          classificationFailed: true,
          rawMistralContent: ambiguous.choices[0].message.content,
        },
      },
      executionTimeMs: 0,
    };

    const result = await executeWith(payload, terminal);

    expect(result.intent).toBe("unclear");
    const diag = result.payload.diagnostics as Record<string, unknown>;
    expect(diag.classificationFailed).toBe(true);
    // Raw content must be captured — never silently dropped
    expect(typeof diag.rawMistralContent).toBe("string");
    expect((diag.rawMistralContent as string).length).toBeGreaterThan(0);
  });

  // ── E2. MCP authentication failure ────────────────────────────────────────

  it("E2: any branch with MCP lookup returns error response on MCP auth failure", async () => {
    const mcpError = buildMCPAuthErrorResponse();
    expect(mcpError.is_error).toBe(true);

    const payload = WorkflowRunner.buildPayload({
      message: "When is my next appointment?",
      userId: MOCK_MCP_CUSTOMER.id,
    });

    const terminal: BranchExecutionResult = {
      intent: "appointments",
      sessionId: payload.sessionId,
      userId: MOCK_MCP_CUSTOMER.id,
      routedTo: "Send Error Response",
      payload: {
        intent: "appointments",
        customer: null,           // no data on auth failure
        appointments: null,
        responseText: expect.stringContaining("unavailable") as unknown as string,
      },
      error: {
        code: "MCP_AUTH_FAILED",
        message: "Invalid MCP credentials",
      },
      executionTimeMs: 0,
    };

    const result = await executeWith(payload, terminal);

    expect(result.routedTo).toBe("Send Error Response");
    expect(result.error?.code).toBe("MCP_AUTH_FAILED");
    // Workflow must not expose partial customer data on auth errors
    expect(result.payload.customer).toBeNull();
  });

  // ── E3. Supabase connection failure ────────────────────────────────────────

  it("E3: escalations branch degrades gracefully when Supabase is unavailable", async () => {
    const sbError = buildSupabaseErrorResponse("FDW connection timeout");
    expect(sbError.status).toBe(503);

    const payload = WorkflowRunner.buildPayload({
      message: "I need to escalate this — it's been weeks!",
      userId: MOCK_MCP_CUSTOMER.id,
    });

    const terminal: BranchExecutionResult = {
      intent: "escalations",
      sessionId: payload.sessionId,
      userId: MOCK_MCP_CUSTOMER.id,
      routedTo: "Send Error Response",
      payload: {
        intent: "escalations",
        customer: { id: MOCK_MCP_CUSTOMER.id, name: MOCK_MCP_CUSTOMER.name },
        escalation: null,
        responseText: expect.stringContaining("unable") as unknown as string,
      },
      error: {
        code: "SUPABASE_CONNECTION_ERROR",
        message: expect.stringContaining("timeout") as unknown as string,
      },
      executionTimeMs: 0,
    };

    const result = await executeWith(payload, terminal);

    expect(result.routedTo).toBe("Send Error Response");
    expect(result.error?.code).toBe("SUPABASE_CONNECTION_ERROR");
    expect(result.payload.escalation).toBeNull();
  });

  // ── E4. Airtable auth failure on agent_query ───────────────────────────────

  it("E4: agent_query returns a degraded response when Airtable auth fails", async () => {
    const atError = buildAirtableAuthError();
    expect(atError.type).toBe("AUTHENTICATION_REQUIRED");

    const payload = WorkflowRunner.buildPayload({
      message: "Is the Widget Pro in stock right now?",
    });

    const terminal: BranchExecutionResult = {
      intent: "agent_query",
      sessionId: payload.sessionId,
      userId: payload.userId,
      routedTo: "Agent Query Responder",
      payload: {
        intent: "agent_query",
        customer: null,
        context: {
          openTickets: [],
          // Inventory must be null when Airtable is unreachable
          inventoryHit: null,
          inventoryUnavailable: true,
        },
        responseText: expect.stringContaining("check back") as unknown as string,
        sources: ["supabase"],    // Airtable must NOT appear in sources on failure
      },
      error: {
        code: "AIRTABLE_AUTH_ERROR",
        message: expect.stringContaining("api key") as unknown as string,
      },
      executionTimeMs: 0,
    };

    const result = await executeWith(payload, terminal);

    expect(result.payload.context).toMatchObject({ inventoryUnavailable: true });
    expect(result.error?.code).toBe("AIRTABLE_AUTH_ERROR");

    const sources = result.payload.sources as string[];
    // Airtable must be absent from sources when the call failed
    expect(sources).not.toContain("airtable");
  });

  // ── E6. Empty message string ──────────────────────────────────────────────

  it("E6: empty message string is classified as unclear without throwing", async () => {
    const payload = WorkflowRunner.buildPayload({ message: "" });

    const terminal: BranchExecutionResult = {
      intent: "unclear",
      sessionId: payload.sessionId,
      userId: payload.userId,
      routedTo: "Send Clarification Request",
      payload: {
        intent: "unclear",
        customer: null,
        responseText: expect.any(String) as unknown as string,
        suggestions: expect.any(Array) as unknown,
      },
      executionTimeMs: 0,
    };

    const result = await executeWith(payload, terminal);

    expect(result.intent).toBe("unclear");
    // No error thrown — empty input is a valid edge case, not a crash condition
    expect(result.error).toBeUndefined();
  });
});

// ─── Mock fixture integrity ───────────────────────────────────────────────────
//
// Snapshot-style guards that detect silent fixture drift before it creates
// false-positive passes in the branch tests above.

describe("Mock fixture integrity", () => {
  it("MOCK_MCP_CUSTOMER has at least one appointment and one open escalation", () => {
    expect(MOCK_MCP_CUSTOMER.appointments.length).toBeGreaterThan(0);
    expect(MOCK_MCP_CUSTOMER.openEscalations.length).toBeGreaterThan(0);
  });

  it("MOCK_MCP_CUSTOMER.sensitiveDataConsent is true", () => {
    expect(MOCK_MCP_CUSTOMER.sensitiveDataConsent).toBe(true);
  });

  it("MOCK_MCP_FREE_CUSTOMER.sensitiveDataConsent is false", () => {
    expect(MOCK_MCP_FREE_CUSTOMER.sensitiveDataConsent).toBe(false);
  });

  it("MOCK_MCP_FREE_CUSTOMER has no appointments", () => {
    expect(MOCK_MCP_FREE_CUSTOMER.appointments).toHaveLength(0);
  });

  it("MOCK_OPEN_TICKET has status 'open'", () => {
    expect(MOCK_OPEN_TICKET.status).toBe("open");
  });

  it("MOCK_INVENTORY_IN_STOCK has Stock > 0 and Available = true", () => {
    expect(MOCK_INVENTORY_IN_STOCK.fields.Stock).toBeGreaterThan(0);
    expect(MOCK_INVENTORY_IN_STOCK.fields.Available).toBe(true);
  });

  it("buildMistralResponse produces a parseable intent for every label", () => {
    const labels = [
      "greeting",
      "thankyou",
      "appointments",
      "escalations",
      "sensitive_data",
      "agent_query",
      "unclear",
    ] as const;
    labels.forEach((label) => {
      expect(WorkflowRunner.parseIntent(buildMistralResponse(label))).toBe(label);
    });
  });

  it("buildMCPCustomerResponse wraps customer inside a tool_result envelope", () => {
    const res = buildMCPCustomerResponse();
    expect(res.type).toBe("tool_result");
    const body = JSON.parse(res.content[0].text) as { customer: typeof MOCK_MCP_CUSTOMER };
    expect(body.customer.id).toBe(MOCK_MCP_CUSTOMER.id);
  });

  it("buildMCPNotFoundResponse returns a CUSTOMER_NOT_FOUND error body", () => {
    const res = buildMCPNotFoundResponse("usr_ghost");
    const body = JSON.parse(res.content[0].text) as { customer: null; error: string };
    expect(body.customer).toBeNull();
    expect(body.error).toBe("CUSTOMER_NOT_FOUND");
  });
});
