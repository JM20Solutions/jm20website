import type { MCPCustomer, MCPAppointment, MCPEscalation } from "../types";

// ─── Base fixtures ──────────────────────────────────────────────────────────

export const MOCK_APPOINTMENT_UPCOMING: MCPAppointment = {
  id: "appt_upcoming_001",
  agentId: "agent_jane_smith",
  scheduledAt: "2026-06-01T14:00:00Z",
  status: "confirmed",
  topic: "Account review",
};

export const MOCK_APPOINTMENT_PENDING: MCPAppointment = {
  id: "appt_pending_002",
  agentId: "agent_bob_jones",
  scheduledAt: "2026-06-05T10:00:00Z",
  status: "pending",
  topic: "Billing dispute",
};

export const MOCK_ESCALATION_OPEN: MCPEscalation = {
  id: "esc_001",
  severity: "high",
  reason: "Repeated billing errors over 3 billing cycles",
  createdAt: "2026-05-15T09:00:00Z",
  resolvedAt: null,
};

/** Standard pro-tier customer with all features active. */
export const MOCK_MCP_CUSTOMER: MCPCustomer = {
  id: "usr_mcp_abc123",
  email: "john.customer@example.com",
  name: "John Customer",
  tier: "pro",
  preferredChannel: "web",
  agentAssigned: "agent_jane_smith",
  sensitiveDataConsent: true,
  appointments: [MOCK_APPOINTMENT_UPCOMING, MOCK_APPOINTMENT_PENDING],
  openEscalations: [MOCK_ESCALATION_OPEN],
};

/** Free-tier customer with no agent assignment and no consent. */
export const MOCK_MCP_FREE_CUSTOMER: MCPCustomer = {
  id: "usr_mcp_free999",
  email: "basic.user@example.com",
  name: "Basic User",
  tier: "free",
  preferredChannel: "email",
  agentAssigned: null,
  sensitiveDataConsent: false,
  appointments: [],
  openEscalations: [],
};

// ─── MCP tool-call response builders ───────────────────────────────────────

/** Successful MCP tool_result for customer lookup. */
export function buildMCPCustomerResponse(customer: MCPCustomer = MOCK_MCP_CUSTOMER) {
  return {
    type: "tool_result",
    tool_use_id: `toolu_mock_${customer.id}`,
    content: [{ type: "text", text: JSON.stringify({ customer }) }],
  };
}

/** MCP tool_result for an empty / not-found customer lookup. */
export function buildMCPNotFoundResponse(userId: string) {
  return {
    type: "tool_result",
    tool_use_id: `toolu_mock_notfound_${userId}`,
    content: [
      {
        type: "text",
        text: JSON.stringify({ customer: null, error: "CUSTOMER_NOT_FOUND" }),
      },
    ],
  };
}

/** MCP tool_result representing a permission / auth failure. */
export function buildMCPAuthErrorResponse() {
  return {
    type: "tool_result",
    tool_use_id: "toolu_mock_auth_error",
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "MCP_AUTH_FAILED", message: "Invalid MCP credentials" }),
      },
    ],
    is_error: true,
  };
}
