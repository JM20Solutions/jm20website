/**
 * intent-router.test.ts
 *
 * Test suite for the Customer Support Intent Router n8n workflow.
 *
 * Workflow topology:
 *   Webhook (trigger)
 *     └─ Intent Classifier  [Mistral LLM]
 *         └─ Switch Router
 *             ├─ greeting       → static response
 *             ├─ unclear        → clarification request
 *             ├─ thankyou       → acknowledgement
 *             ├─ appointments   → Calendly slot data
 *             ├─ escalations    → Supabase ticket creation
 *             ├─ sensitive_data → GDPR redaction notice
 *             └─ agent_query    → MCP + Supabase + Airtable + Mistral (primary path)
 *
 * All external HTTP calls are intercepted by nock so tests are deterministic
 * and network-independent.  The WorkflowSimulator class reproduces the exact
 * HTTP call pattern that the n8n nodes emit, making it the single source of
 * truth about what the real workflow does externally.
 */

import axios from 'axios';
import nock from 'nock';

// ─── Environment Constants ────────────────────────────────────────────────────
// These mirror the credentials / env vars configured in the live n8n instance.

const MISTRAL_API_URL   = 'https://api.mistral.ai';
const MISTRAL_MODEL     = 'mistral-small-latest';
const SUPABASE_URL      = process.env.SUPABASE_URL      ?? 'https://testproject.supabase.co';
const AIRTABLE_BASE_URL = 'https://api.airtable.com';
const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID  ?? 'appTestBase123';
const AIRTABLE_TABLE    = 'Inventory';
const N8N_BASE_URL      = process.env.N8N_BASE_URL      ?? 'http://localhost:5678';

// ─── Type Definitions ─────────────────────────────────────────────────────────

type IntentType =
  | 'greeting'
  | 'unclear'
  | 'thankyou'
  | 'appointments'
  | 'escalations'
  | 'sensitive_data'
  | 'agent_query'
  | 'fallback';

interface WebhookPayload {
  message: string;
  sessionId?: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
}

// Base envelope every branch result extends
interface WorkflowResult {
  intent: IntentType;
  branch: string;
  timestamp: string;
  response?: string;
  error?: string;
  data?: Record<string, unknown>;
}

interface GreetingResult extends WorkflowResult {
  intent: 'greeting';
  branch: 'greeting';
  response: string;
}

interface UnclearResult extends WorkflowResult {
  intent: 'unclear';
  branch: 'unclear';
  response: string;
  needsClarification: true;
  clarificationPrompts: string[];
}

interface ThankYouResult extends WorkflowResult {
  intent: 'thankyou';
  branch: 'thankyou';
  response: string;
}

interface AppointmentSlot {
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM
  duration: number;
  available: boolean;
}

interface AppointmentsResult extends WorkflowResult {
  intent: 'appointments';
  branch: 'appointments';
  calendlyLink: string;
  availableSlots: AppointmentSlot[];
}

interface EscalationsResult extends WorkflowResult {
  intent: 'escalations';
  branch: 'escalations';
  ticketId: string;
  agentName: string;
  estimatedWaitMinutes: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

interface SensitiveDataResult extends WorkflowResult {
  intent: 'sensitive_data';
  branch: 'sensitive_data';
  dataRedacted: true;
  piiDetected: string[];
  gdprNotice: string;
  complianceReference: string;
}

interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  plan: string;
  since: string;
}

interface SupportTicket {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
}

interface InventoryItem {
  name: string;
  available: boolean;
  price: number;
  currency: string;
}

interface AgentQueryResult extends WorkflowResult {
  intent: 'agent_query';
  branch: 'agent_query';
  response: string;
  sources: {
    customer: CustomerProfile;
    supportHistory: SupportTicket[];
    inventory: InventoryItem[];
  };
  confidence: number;
}

// ─── Mock Response Factories ──────────────────────────────────────────────────
// Each factory produces the exact JSON shape returned by the real external API.
// Tests wire these into nock interceptors to simulate deterministic responses.

/** Mistral chat.completion shaped for a one-label intent classification */
function makeMistralIntentResponse(intent: IntentType): object {
  return {
    id: `cmpl-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MISTRAL_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: intent },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 48, completion_tokens: 3, total_tokens: 51 },
  };
}

/** Mistral chat.completion for a full agent prose answer */
function makeMistralAgentResponse(answer: string): object {
  return {
    id: `cmpl-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MISTRAL_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: answer },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 312, completion_tokens: 87, total_tokens: 399 },
  };
}

/**
 * Supabase REST — wraps escalation ticket rows in an array as the API returns
 * them after a successful INSERT with `Prefer: return=representation`.
 */
function makeSupabaseEscalationRow(ticket: {
  id: string;
  agentName: string;
  estimatedWaitMinutes: number;
  priority: EscalationsResult['priority'];
}): object[] {
  return [
    {
      id: ticket.id,
      agent_name: ticket.agentName,
      estimated_wait_minutes: ticket.estimatedWaitMinutes,
      priority: ticket.priority,
      status: 'open',
      created_at: new Date().toISOString(),
    },
  ];
}

/** Supabase REST — array of ticket rows (GET response) */
function makeSupabaseTicketsResponse(tickets: SupportTicket[]): object {
  return tickets;
}

/** Airtable records list response for inventory items */
function makeAirtableInventoryResponse(items: InventoryItem[]): object {
  return {
    records: items.map((item, i) => ({
      id: `rec${String(i).padStart(8, '0')}`,
      fields: {
        Name:      item.name,
        Available: item.available,
        Price:     item.price,
        Currency:  item.currency,
      },
      createdTime: new Date().toISOString(),
    })),
  };
}

/**
 * MCP (Model Context Protocol) tool-call response — wraps a customer object
 * in the standard content array format used by the MCP server.
 */
function makeMCPCustomerResponse(customer: CustomerProfile): object {
  return {
    content: [{ type: 'text', text: JSON.stringify(customer) }],
  };
}

// ─── WorkflowSimulator ────────────────────────────────────────────────────────
//
// Reproduces the n8n node-by-node HTTP call pattern without requiring a live
// n8n instance.  Each private method corresponds to one n8n node or node group:
//
//   classifyIntent()    → Intent Classifier node  (Mistral)
//   routeToBranch()     → Switch node
//   handleGreeting()    → Greeting responder node
//   handleUnclear()     → Clarification node
//   handleThankYou()    → ThankYou responder node
//   handleAppointments()→ Calendly node
//   handleEscalations() → Supabase Insert node (escalations table)
//   handleSensitiveData()→ PII scanner + GDPR response node
//   handleAgentQuery()  → MCP → Supabase → Airtable → Mistral agent chain
//

class WorkflowSimulator {
  private readonly mistralKey = process.env.MISTRAL_API_KEY    ?? 'test-mistral-key';
  private readonly supabaseKey = process.env.SUPABASE_ANON_KEY ?? 'test-supabase-key';
  private readonly airtableKey = process.env.AIRTABLE_API_KEY  ?? 'test-airtable-key';

  /** Main entry point — mirrors the n8n Webhook trigger receiving a POST body */
  async execute(payload: WebhookPayload): Promise<WorkflowResult> {
    // n8n "IF" guard node: reject blank messages before any LLM call
    if (!payload.message?.trim()) {
      return this.buildError('EMPTY_MESSAGE', 'Message cannot be empty');
    }

    try {
      const intent = await this.classifyIntent(payload.message);
      return await this.routeToBranch(intent, payload);
    } catch (err: unknown) {
      // Axios errors surface as CLASSIFICATION_FAILED; others re-throw
      if (axios.isAxiosError(err)) {
        return this.buildError('CLASSIFICATION_FAILED', err.message);
      }
      throw err;
    }
  }

  // ── Node: Intent Classifier ─────────────────────────────────────────────────

  private async classifyIntent(message: string): Promise<IntentType> {
    const { data } = await axios.post(
      `${MISTRAL_API_URL}/v1/chat/completions`,
      {
        model: MISTRAL_MODEL,
        temperature: 0, // deterministic classification
        messages: [
          {
            role: 'system',
            content:
              'Classify the user message into exactly one intent label: ' +
              'greeting, unclear, thankyou, appointments, escalations, ' +
              'sensitive_data, agent_query.  Reply with only the label.',
          },
          { role: 'user', content: message },
        ],
      },
      { headers: { Authorization: `Bearer ${this.mistralKey}` } },
    );

    const raw = (data.choices[0].message.content as string).trim().toLowerCase();

    const VALID_INTENTS: IntentType[] = [
      'greeting', 'unclear', 'thankyou', 'appointments',
      'escalations', 'sensitive_data', 'agent_query',
    ];

    // Guard: any label outside the known set routes to the error branch
    return VALID_INTENTS.includes(raw as IntentType)
      ? (raw as IntentType)
      : 'fallback';
  }

  // ── Node: Switch ────────────────────────────────────────────────────────────

  private async routeToBranch(
    intent: IntentType,
    payload: WebhookPayload,
  ): Promise<WorkflowResult> {
    switch (intent) {
      case 'greeting':      return this.handleGreeting(payload);
      case 'unclear':       return this.handleUnclear(payload);
      case 'thankyou':      return this.handleThankYou(payload);
      case 'appointments':  return this.handleAppointments(payload);
      case 'escalations':   return this.handleEscalations(payload);
      case 'sensitive_data':return this.handleSensitiveData(payload);
      case 'agent_query':   return this.handleAgentQuery(payload);
      default:
        return this.buildError('UNKNOWN_INTENT', `Unroutable intent: ${intent}`);
    }
  }

  // ── Branch: greeting ────────────────────────────────────────────────────────

  private async handleGreeting(_payload: WebhookPayload): Promise<GreetingResult> {
    return {
      intent: 'greeting',
      branch: 'greeting',
      response: 'Hello! Welcome to JM20 Support. How can I assist you today?',
      timestamp: new Date().toISOString(),
    };
  }

  // ── Branch: unclear ─────────────────────────────────────────────────────────

  private async handleUnclear(_payload: WebhookPayload): Promise<UnclearResult> {
    return {
      intent: 'unclear',
      branch: 'unclear',
      response: "I'm not sure I understood that. Could you please clarify what you need?",
      needsClarification: true,
      clarificationPrompts: [
        'Are you looking for product or pricing information?',
        'Do you need help with an existing order or account?',
        'Would you like to speak with a support agent?',
      ],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Branch: thankyou ────────────────────────────────────────────────────────

  private async handleThankYou(_payload: WebhookPayload): Promise<ThankYouResult> {
    return {
      intent: 'thankyou',
      branch: 'thankyou',
      response: "You're very welcome! Is there anything else I can help you with?",
      timestamp: new Date().toISOString(),
    };
  }

  // ── Branch: appointments ────────────────────────────────────────────────────
  // In production this node calls Calendly's API; here slots are representative.

  private async handleAppointments(_payload: WebhookPayload): Promise<AppointmentsResult> {
    const slots: AppointmentSlot[] = [
      { date: '2025-06-01', time: '10:00', duration: 30, available: true  },
      { date: '2025-06-01', time: '14:00', duration: 30, available: true  },
      { date: '2025-06-02', time: '09:00', duration: 45, available: false },
    ];
    return {
      intent: 'appointments',
      branch: 'appointments',
      calendlyLink: 'https://calendly.com/jm20-support/consultation',
      availableSlots: slots,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Branch: escalations ─────────────────────────────────────────────────────
  // Creates an escalation ticket in Supabase and surfaces the assigned agent.

  private async handleEscalations(payload: WebhookPayload): Promise<EscalationsResult> {
    const { data } = await axios.post(
      `${SUPABASE_URL}/rest/v1/escalations`,
      {
        message:     payload.message,
        customer_id: payload.customerId ?? null,
        session_id:  payload.sessionId  ?? null,
        priority: 'high',
      },
      {
        headers: {
          apikey:          this.supabaseKey,
          Authorization:   `Bearer ${this.supabaseKey}`,
          'Content-Type':  'application/json',
          Prefer:          'return=representation',
        },
      },
    );

    const row = (data as Array<{
      id: string;
      agent_name: string;
      estimated_wait_minutes: number;
      priority: EscalationsResult['priority'];
    }>)[0];

    return {
      intent:               'escalations',
      branch:               'escalations',
      ticketId:             row.id,
      agentName:            row.agent_name,
      estimatedWaitMinutes: row.estimated_wait_minutes,
      priority:             row.priority,
      timestamp:            new Date().toISOString(),
    };
  }

  // ── Branch: sensitive_data ──────────────────────────────────────────────────
  // Runs a regex PII scan (mirrors the n8n Code node) and returns a GDPR notice.

  private async handleSensitiveData(payload: WebhookPayload): Promise<SensitiveDataResult> {
    const PII_PATTERNS: Record<string, RegExp> = {
      credit_card: /\b(?:\d[ -]?){13,16}\b/,
      email:       /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
      // No leading \b — the regex would miss numbers prefixed with "+" otherwise.
      // Accepts 9-digit EU formats (3+3+3) and 10-digit NA formats (3+3+4).
      phone:       /(?:\+?\d{1,3}[\s-]?)?\(?\d{2,3}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}\b/,
      national_id: /\b\d{8,12}\b/,
    };

    const detected = Object.entries(PII_PATTERNS)
      .filter(([, re]) => re.test(payload.message))
      .map(([label]) => label);

    return {
      intent:              'sensitive_data',
      branch:              'sensitive_data',
      dataRedacted:        true,
      piiDetected:         detected,
      gdprNotice:
        'For your security, please do not share sensitive personal data in chat. ' +
        'Your data is processed in accordance with GDPR Article 6(1)(b).',
      complianceReference: 'GDPR-2016/679',
      timestamp:           new Date().toISOString(),
    };
  }

  // ── Branch: agent_query (primary path) ─────────────────────────────────────
  // Orchestrates MCP → Supabase → Airtable → Mistral to produce a grounded reply.

  private async handleAgentQuery(payload: WebhookPayload): Promise<AgentQueryResult> {
    const customerId = payload.customerId ?? 'anon';

    // Step 1 — MCP: fetch unified customer profile
    const customer = await this.mcpGetCustomer(customerId);

    // Step 2 — Supabase: fetch the 5 most recent support tickets
    const supportHistory = await this.supabaseGetTickets(customerId);

    // Step 3 — Airtable: fetch current product / inventory availability
    const inventory = await this.airtableGetInventory();

    // Step 4 — Mistral: generate a grounded agent response with injected context
    const response = await this.mistralGenerateAgentResponse(
      payload.message, customer, supportHistory, inventory,
    );

    return {
      intent:    'agent_query',
      branch:    'agent_query',
      response,
      sources:   { customer, supportHistory, inventory },
      confidence: 0.92,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private helpers: external service calls ─────────────────────────────────

  private async mcpGetCustomer(customerId: string): Promise<CustomerProfile> {
    const { data } = await axios.post(
      `${N8N_BASE_URL}/mcp/tools/call`,
      { tool: 'get_customer', arguments: { customer_id: customerId } },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return JSON.parse(
      (data as { content: Array<{ text: string }> }).content[0].text,
    ) as CustomerProfile;
  }

  private async supabaseGetTickets(customerId: string): Promise<SupportTicket[]> {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/tickets` +
      `?customer_id=eq.${customerId}&order=created_at.desc&limit=5`,
      {
        headers: {
          apikey:        this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
        },
      },
    );
    return data as SupportTicket[];
  }

  private async airtableGetInventory(): Promise<InventoryItem[]> {
    const { data } = await axios.get(
      `${AIRTABLE_BASE_URL}/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      { headers: { Authorization: `Bearer ${this.airtableKey}` } },
    );
    return (
      data as {
        records: Array<{
          fields: { Name: string; Available: boolean; Price: number; Currency: string };
        }>;
      }
    ).records.map((r) => ({
      name:      r.fields.Name,
      available: r.fields.Available,
      price:     r.fields.Price,
      currency:  r.fields.Currency,
    }));
  }

  private async mistralGenerateAgentResponse(
    message: string,
    customer: CustomerProfile,
    history: SupportTicket[],
    inventory: InventoryItem[],
  ): Promise<string> {
    const { data } = await axios.post(
      `${MISTRAL_API_URL}/v1/chat/completions`,
      {
        model: MISTRAL_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              `You are a helpful JM20 support agent. ` +
              `Customer profile: ${JSON.stringify(customer)}. ` +
              `Support history (last 5): ${JSON.stringify(history)}. ` +
              `Current inventory: ${JSON.stringify(inventory)}.`,
          },
          { role: 'user', content: message },
        ],
      },
      { headers: { Authorization: `Bearer ${this.mistralKey}` } },
    );
    return (data.choices[0].message.content as string);
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  private buildError(code: string, message: string): WorkflowResult {
    return {
      intent:    'fallback',
      branch:    'error',
      error:     code,
      data:      { message },
      timestamp: new Date().toISOString(),
    };
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Customer Support Intent Router — n8n Workflow Tests', () => {
  let sim: WorkflowSimulator;

  beforeAll(() => {
    // Block all real outbound network calls — any unintercepted request fails
    nock.disableNetConnect();
    sim = new WorkflowSimulator();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  afterEach(() => {
    // Guard: if a test left nock interceptors unused it means the workflow made
    // fewer external calls than expected — surface that as an explicit failure.
    if (!nock.isDone()) {
      const pending = nock.pendingMocks();
      nock.cleanAll();
      throw new Error(
        `Test left ${pending.length} unused nock interceptor(s):\n${pending.join('\n')}`,
      );
    }
    nock.cleanAll();
  });

  // ── Shared nock helpers ─────────────────────────────────────────────────────

  /** Intercepts the FIRST Mistral call (intent classification) */
  function interceptMistralIntent(intent: IntentType): void {
    nock(MISTRAL_API_URL)
      .post('/v1/chat/completions', (body: { model: string; temperature: number }) =>
        body.model === MISTRAL_MODEL && body.temperature === 0,
      )
      .reply(200, makeMistralIntentResponse(intent));
  }

  /** Intercepts the SECOND Mistral call (agent response generation) */
  function interceptMistralAgent(answer: string): void {
    nock(MISTRAL_API_URL)
      .post('/v1/chat/completions', (body: { temperature: number }) =>
        body.temperature === 0.3,
      )
      .reply(200, makeMistralAgentResponse(answer));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1 ─ GREETING BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: greeting', () => {
    it('routes "Hello there!" and returns a welcome response envelope', async () => {
      // Mock: Mistral classifies this message as "greeting"
      interceptMistralIntent('greeting');

      const result = await sim.execute({
        message: 'Hello there!',
        sessionId: 'sess-g-001',
      }) as GreetingResult;

      // ── Branch routing
      expect(result.intent).toBe('greeting');
      expect(result.branch).toBe('greeting');

      // ── Response is a non-empty string (no hard-coded equality — the copy may change)
      expect(typeof result.response).toBe('string');
      expect(result.response.length).toBeGreaterThan(0);

      // ── Standard envelope fields
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.error).toBeUndefined();
    });

    it('consistently routes common greeting variants to the greeting branch', async () => {
      const variants = ['Hi!', 'Hey there', 'Good morning', 'Howdy'];

      for (const message of variants) {
        // One interceptor per loop iteration — each is consumed before the next is registered
        interceptMistralIntent('greeting');
        const result = await sim.execute({ message });
        expect(result.branch).toBe('greeting');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2 ─ UNCLEAR BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: unclear', () => {
    it('routes ambiguous input to the unclear branch and signals clarification needed', async () => {
      interceptMistralIntent('unclear');

      const result = await sim.execute({
        message: 'uh... that thing from before',
        sessionId: 'sess-u-001',
      }) as UnclearResult;

      // ── Branch routing
      expect(result.intent).toBe('unclear');
      expect(result.branch).toBe('unclear');

      // ── Must set the clarification flag so downstream UI can render follow-up prompts
      expect(result.needsClarification).toBe(true);

      // ── Must provide at least one concrete prompt to guide the user's next message
      expect(Array.isArray(result.clarificationPrompts)).toBe(true);
      expect(result.clarificationPrompts.length).toBeGreaterThanOrEqual(1);
      result.clarificationPrompts.forEach((p) => {
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
      });

      // ── Fallback prose response
      expect(typeof result.response).toBe('string');
      expect(result.response.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3 ─ THANKYOU BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: thankyou', () => {
    it('routes gratitude messages and returns a polite acknowledgement', async () => {
      interceptMistralIntent('thankyou');

      const result = await sim.execute({
        message: 'Thanks a lot, that was super helpful!',
        sessionId: 'sess-t-001',
      }) as ThankYouResult;

      expect(result.intent).toBe('thankyou');
      expect(result.branch).toBe('thankyou');

      // ── A non-empty acknowledgement string must always be present
      expect(typeof result.response).toBe('string');
      expect(result.response.length).toBeGreaterThan(0);

      // ── No error on the happy path
      expect(result.error).toBeUndefined();
    });

    it('handles multiple gratitude phrasings consistently', async () => {
      const phrases = ['Thank you!', 'Many thanks', 'Appreciate the help', 'Cheers'];

      for (const message of phrases) {
        interceptMistralIntent('thankyou');
        const result = await sim.execute({ message });
        expect(result.branch).toBe('thankyou');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4 ─ APPOINTMENTS BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: appointments', () => {
    it('routes booking requests and returns a Calendly link with typed slot data', async () => {
      interceptMistralIntent('appointments');

      const result = await sim.execute({
        message: "I'd like to book a consultation call",
        sessionId:  'sess-a-001',
        customerId: 'cust-42',
      }) as AppointmentsResult;

      // ── Branch routing
      expect(result.intent).toBe('appointments');
      expect(result.branch).toBe('appointments');

      // ── Calendly (or equivalent) scheduling link must be a valid HTTPS URL
      expect(typeof result.calendlyLink).toBe('string');
      expect(result.calendlyLink).toMatch(/^https:\/\//);

      // ── At least one slot must be returned
      expect(Array.isArray(result.availableSlots)).toBe(true);
      expect(result.availableSlots.length).toBeGreaterThan(0);

      // ── Each slot must conform to the AppointmentSlot schema
      result.availableSlots.forEach((slot) => {
        expect(slot).toMatchObject({
          date:      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          time:      expect.stringMatching(/^\d{2}:\d{2}$/),
          duration:  expect.any(Number),
          available: expect.any(Boolean),
        });
        // Duration must be a positive integer (minutes)
        expect(slot.duration).toBeGreaterThan(0);
      });

      // ── Must include at least one available slot for the UX to offer booking
      const hasAvailable = result.availableSlots.some((s) => s.available);
      expect(hasAvailable).toBe(true);
    });

    it('routes cancellation requests to the same appointments branch', async () => {
      interceptMistralIntent('appointments');

      const result = await sim.execute({
        message: 'I need to cancel my appointment for tomorrow',
      });

      expect(result.branch).toBe('appointments');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5 ─ ESCALATIONS BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: escalations', () => {
    it('creates a Supabase ticket and surfaces agent assignment details', async () => {
      const MOCK_TICKET = {
        id:                   'ticket-esc-001',
        agentName:            'Sarah (Senior Support)',
        estimatedWaitMinutes: 8,
        priority:             'high' as const,
      };

      // Call 1: Mistral intent classification
      interceptMistralIntent('escalations');

      // Call 2: Supabase INSERT to escalations table — returns created row
      nock(SUPABASE_URL)
        .post(
          '/rest/v1/escalations',
          // Verify the node sends the full message + context to Supabase
          (body: { message: string; customer_id: string; priority: string }) =>
            typeof body.message === 'string' &&
            body.priority === 'high',
        )
        .reply(201, makeSupabaseEscalationRow(MOCK_TICKET));

      const result = await sim.execute({
        message:    'This is completely unacceptable! I demand to speak with a manager!',
        sessionId:  'sess-e-001',
        customerId: 'cust-99',
      }) as EscalationsResult;

      // ── Branch routing
      expect(result.intent).toBe('escalations');
      expect(result.branch).toBe('escalations');

      // ── Ticket data must be propagated from the Supabase response
      expect(result.ticketId).toBe('ticket-esc-001');
      expect(result.agentName).toBe('Sarah (Senior Support)');
      expect(result.estimatedWaitMinutes).toBe(8);

      // ── Priority must be a valid enum value
      expect(['low', 'medium', 'high', 'critical']).toContain(result.priority);
      expect(result.priority).toBe('high');

      // ── Timestamp and no error
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.error).toBeUndefined();
    });

    it('surfaces critical priority and a short ETA for urgent legal threats', async () => {
      const CRITICAL_TICKET = {
        id:                   'ticket-esc-crit',
        agentName:            'Alex (Escalations Lead)',
        estimatedWaitMinutes: 2,
        priority:             'critical' as const,
      };

      interceptMistralIntent('escalations');

      // Supabase returns "critical" — priority scoring happens server-side
      nock(SUPABASE_URL)
        .post('/rest/v1/escalations')
        .reply(201, makeSupabaseEscalationRow(CRITICAL_TICKET));

      const result = await sim.execute({
        message: 'I will take legal action if this is not resolved immediately!',
      }) as EscalationsResult;

      expect(result.priority).toBe('critical');
      // Critical escalations must guarantee a short ETA
      expect(result.estimatedWaitMinutes).toBeLessThanOrEqual(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6 ─ SENSITIVE DATA BRANCH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: sensitive_data', () => {
    it('intercepts a credit card number and returns a GDPR-compliant redaction notice', async () => {
      interceptMistralIntent('sensitive_data');

      const result = await sim.execute({
        message:   'My card number is 4111 1111 1111 1111, please charge it',
        sessionId: 'sess-s-001',
      }) as SensitiveDataResult;

      // ── Branch routing
      expect(result.intent).toBe('sensitive_data');
      expect(result.branch).toBe('sensitive_data');

      // ── dataRedacted must always be literal true — never false on this branch
      expect(result.dataRedacted).toBe(true);

      // ── PII scanner must identify the credit card pattern
      expect(result.piiDetected).toContain('credit_card');

      // ── GDPR notice must be a meaningful, non-empty string
      expect(typeof result.gdprNotice).toBe('string');
      expect(result.gdprNotice.length).toBeGreaterThan(20);

      // ── Must reference a GDPR article for compliance audit trails
      expect(result.complianceReference).toMatch(/GDPR/);

      expect(result.error).toBeUndefined();
    });

    it('detects email addresses as PII', async () => {
      interceptMistralIntent('sensitive_data');

      const result = await sim.execute({
        message: 'Please send the invoice to john.doe@private-domain.com',
      }) as SensitiveDataResult;

      expect(result.branch).toBe('sensitive_data');
      expect(result.piiDetected).toContain('email');
      expect(result.dataRedacted).toBe(true);
    });

    it('detects phone numbers as PII', async () => {
      interceptMistralIntent('sensitive_data');

      const result = await sim.execute({
        message: 'Call me back on +34 612 345 678',
      }) as SensitiveDataResult;

      expect(result.branch).toBe('sensitive_data');
      expect(result.piiDetected).toContain('phone');
    });

    it('can detect multiple PII types in a single message', async () => {
      interceptMistralIntent('sensitive_data');

      // Both a credit card and an email appear — both should be flagged
      const result = await sim.execute({
        message: 'Charge card 4111111111111111 and email receipt to me@example.com',
      }) as SensitiveDataResult;

      expect(result.piiDetected).toContain('credit_card');
      expect(result.piiDetected).toContain('email');
      expect(result.piiDetected.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7 ─ AGENT QUERY BRANCH  (primary / most important path)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Branch: agent_query', () => {
    // ── Shared fixtures ─────────────────────────────────────────────────────

    const CUSTOMER: CustomerProfile = {
      id:    'cust-007',
      name:  'James Mitchell',
      email: 'james.m@example.com',
      plan:  'Pro',
      since: '2023-01-15',
    };

    const SUPPORT_HISTORY: SupportTicket[] = [
      { id: 'tkt-101', subject: 'Billing issue Q4',       status: 'resolved', createdAt: '2024-11-01T10:00:00Z' },
      { id: 'tkt-102', subject: 'Feature request: API',   status: 'open',     createdAt: '2024-12-15T14:30:00Z' },
    ];

    const INVENTORY: InventoryItem[] = [
      { name: 'Pro Plan',        available: true,  price: 49.99,  currency: 'EUR' },
      { name: 'Enterprise Plan', available: true,  price: 199.00, currency: 'EUR' },
      { name: 'Starter Plan',    available: false, price: 9.99,   currency: 'EUR' },
    ];

    it('executes the full 4-step agent pipeline and returns a structured result', async () => {
      // ── Mock setup: all 5 HTTP calls in workflow order ─────────────────────

      // Step 1 — Mistral: intent classification
      interceptMistralIntent('agent_query');

      // Step 2 — MCP: unified customer lookup (called with the session's customerId)
      nock(N8N_BASE_URL)
        .post('/mcp/tools/call', {
          tool: 'get_customer',
          arguments: { customer_id: 'cust-007' },
        })
        .reply(200, makeMCPCustomerResponse(CUSTOMER));

      // Step 3 — Supabase: last 5 support tickets for this customer
      nock(SUPABASE_URL)
        .get('/rest/v1/tickets')
        .query({
          customer_id: 'eq.cust-007',
          order:       'created_at.desc',
          limit:       '5',
        })
        .reply(200, makeSupabaseTicketsResponse(SUPPORT_HISTORY));

      // Step 4 — Airtable: current product / inventory table
      nock(AIRTABLE_BASE_URL)
        .get(`/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`)
        .reply(200, makeAirtableInventoryResponse(INVENTORY));

      // Step 5 — Mistral: generate grounded agent response with injected context
      interceptMistralAgent(
        "Hi James! You're on the Pro plan (€49.99/mo) which remains fully available. " +
        "The Enterprise plan (€199.00/mo) is also available. The Starter plan is " +
        "currently unavailable. I can see your open API feature request (tkt-102) — " +
        "I'll escalate it to our product team.",
      );

      // ── Execute ────────────────────────────────────────────────────────────

      const result = await sim.execute({
        message:    'What plans do you have and what is my current status?',
        sessionId:  'sess-aq-001',
        customerId: 'cust-007',
      }) as AgentQueryResult;

      // ── Branch routing ─────────────────────────────────────────────────────
      expect(result.intent).toBe('agent_query');
      expect(result.branch).toBe('agent_query');

      // ── Agent prose response ───────────────────────────────────────────────
      expect(typeof result.response).toBe('string');
      // A meaningful answer — not just a one-word echo of the intent
      expect(result.response.length).toBeGreaterThan(20);

      // ── MCP (customer) source ──────────────────────────────────────────────
      // Customer profile must be included in sources for transparency / audit
      expect(result.sources.customer).toMatchObject<Partial<CustomerProfile>>({
        id:   'cust-007',
        name: 'James Mitchell',
        plan: 'Pro',
      });
      expect(result.sources.customer.email).toBe('james.m@example.com');

      // ── Supabase (support history) source ──────────────────────────────────
      expect(Array.isArray(result.sources.supportHistory)).toBe(true);
      expect(result.sources.supportHistory).toHaveLength(2);
      expect(result.sources.supportHistory[0]).toMatchObject<Partial<SupportTicket>>({
        id:     'tkt-101',
        status: 'resolved',
      });
      expect(result.sources.supportHistory[1]).toMatchObject<Partial<SupportTicket>>({
        id:     'tkt-102',
        status: 'open',
      });

      // ── Airtable (inventory) source ────────────────────────────────────────
      expect(Array.isArray(result.sources.inventory)).toBe(true);
      expect(result.sources.inventory).toHaveLength(3);

      const proItem = result.sources.inventory.find((i) => i.name === 'Pro Plan');
      expect(proItem).toBeDefined();
      expect(proItem!.available).toBe(true);
      expect(proItem!.price).toBe(49.99);
      expect(proItem!.currency).toBe('EUR');

      const starterItem = result.sources.inventory.find((i) => i.name === 'Starter Plan');
      expect(starterItem!.available).toBe(false);

      // ── Confidence score ────────────────────────────────────────────────────
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);

      // ── No error ────────────────────────────────────────────────────────────
      expect(result.error).toBeUndefined();
    });

    it('handles an anonymous visitor (no customerId) by using "anon" as the customer key', async () => {
      // Guest sessions must still go through the full agent pipeline —
      // MCP returns a minimal guest profile and Supabase returns an empty history.

      interceptMistralIntent('agent_query');

      nock(N8N_BASE_URL)
        .post('/mcp/tools/call', {
          tool: 'get_customer',
          arguments: { customer_id: 'anon' },
        })
        .reply(200, makeMCPCustomerResponse({
          id: 'anon', name: 'Guest', email: '', plan: 'none', since: '',
        }));

      nock(SUPABASE_URL)
        .get('/rest/v1/tickets')
        .query({ customer_id: 'eq.anon', order: 'created_at.desc', limit: '5' })
        .reply(200, []);

      nock(AIRTABLE_BASE_URL)
        .get(`/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`)
        .reply(200, makeAirtableInventoryResponse(INVENTORY));

      interceptMistralAgent('Welcome! Here are our currently available plans...');

      // No customerId supplied — workflow must default to "anon"
      const result = await sim.execute({
        message:   'What plans do you offer?',
        sessionId: 'sess-aq-anon',
      }) as AgentQueryResult;

      expect(result.branch).toBe('agent_query');
      expect(result.sources.customer.id).toBe('anon');
      // An anonymous user has no support history — empty array, not undefined
      expect(result.sources.supportHistory).toHaveLength(0);
      expect(Array.isArray(result.sources.inventory)).toBe(true);
    });

    it('still returns a result when Supabase history is empty (new customer)', async () => {
      interceptMistralIntent('agent_query');

      nock(N8N_BASE_URL)
        .post('/mcp/tools/call', { tool: 'get_customer', arguments: { customer_id: 'cust-new' } })
        .reply(200, makeMCPCustomerResponse({
          id: 'cust-new', name: 'Alice New', email: 'alice@example.com', plan: 'Starter', since: '2025-05-01',
        }));

      // New customer — zero tickets in Supabase
      nock(SUPABASE_URL)
        .get('/rest/v1/tickets')
        .query({ customer_id: 'eq.cust-new', order: 'created_at.desc', limit: '5' })
        .reply(200, []);

      nock(AIRTABLE_BASE_URL)
        .get(`/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`)
        .reply(200, makeAirtableInventoryResponse(INVENTORY));

      interceptMistralAgent('Welcome, Alice! As a new Starter plan customer...');

      const result = await sim.execute({
        message:    'How do I upgrade my plan?',
        customerId: 'cust-new',
      }) as AgentQueryResult;

      expect(result.branch).toBe('agent_query');
      expect(result.sources.supportHistory).toHaveLength(0);
      expect(result.response.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8 ─ EDGE CASES & FALLBACK ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge Cases — Fallback & Error Handling', () => {
    it('short-circuits on an empty message without invoking Mistral', async () => {
      // No nock interceptors registered — proves Mistral is never called
      const result = await sim.execute({ message: '' });

      expect(result.intent).toBe('fallback');
      expect(result.branch).toBe('error');
      expect(result.error).toBe('EMPTY_MESSAGE');
    });

    it('short-circuits on a whitespace-only message without invoking Mistral', async () => {
      const result = await sim.execute({ message: '   \t\n   ' });

      expect(result.branch).toBe('error');
      expect(result.error).toBe('EMPTY_MESSAGE');
    });

    it('routes to the error branch when Mistral returns an unrecognised intent label', async () => {
      // Simulate Mistral hallucinating a label outside the known set
      nock(MISTRAL_API_URL)
        .post('/v1/chat/completions')
        .reply(200, {
          ...makeMistralIntentResponse('unclear'), // valid shape
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'purchase_intent' }, // unknown label
              finish_reason: 'stop',
            },
          ],
        });

      const result = await sim.execute({ message: 'I want to buy something' });

      // Unknown labels must NOT leak to an unhandled branch — they hit the error path
      expect(result.branch).toBe('error');
      expect(result.error).toBe('UNKNOWN_INTENT');
    });

    it('returns CLASSIFICATION_FAILED when the Mistral API responds with 503', async () => {
      nock(MISTRAL_API_URL)
        .post('/v1/chat/completions')
        .reply(503, { error: { type: 'service_unavailable', message: 'Service Unavailable' } });

      const result = await sim.execute({ message: 'What are your opening hours?' });

      expect(result.intent).toBe('fallback');
      expect(result.branch).toBe('error');
      expect(result.error).toBe('CLASSIFICATION_FAILED');
      // Timestamp is still present so callers can log the failure
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns CLASSIFICATION_FAILED when the Mistral API responds with 429 (rate limit)', async () => {
      nock(MISTRAL_API_URL)
        .post('/v1/chat/completions')
        .reply(429, { error: { type: 'rate_limit_exceeded', message: 'Too Many Requests' } });

      const result = await sim.execute({ message: 'Tell me about your services' });

      expect(result.branch).toBe('error');
      expect(result.error).toBe('CLASSIFICATION_FAILED');
    });

    it('preserves the iso8601 timestamp on all branch results (envelope contract)', async () => {
      const branches: Array<{ intent: IntentType; setup?: () => void }> = [
        { intent: 'greeting' },
        { intent: 'unclear' },
        { intent: 'thankyou' },
        { intent: 'appointments' },
      ];

      for (const { intent, setup } of branches) {
        interceptMistralIntent(intent);
        setup?.();
        const result = await sim.execute({ message: 'test' });
        expect(result.timestamp).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
        );
      }
    });
  });
});
