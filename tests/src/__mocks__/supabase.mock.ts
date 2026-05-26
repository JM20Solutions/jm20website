import type { SupabaseSupportTicket } from "../types";

export const MOCK_OPEN_TICKET: SupabaseSupportTicket = {
  id: "tkt_sb_001",
  customerId: "usr_mcp_abc123",
  status: "open",
  category: "billing",
  summary: "Overcharged on last invoice",
  createdAt: "2026-05-20T08:00:00Z",
  updatedAt: "2026-05-21T12:00:00Z",
};

export const MOCK_RESOLVED_TICKET: SupabaseSupportTicket = {
  id: "tkt_sb_002",
  customerId: "usr_mcp_abc123",
  status: "resolved",
  category: "technical",
  summary: "Login issue after password reset",
  createdAt: "2026-04-10T10:00:00Z",
  updatedAt: "2026-04-11T15:30:00Z",
};

/** Supabase REST API list response envelope. */
export function buildSupabaseTicketListResponse(
  tickets: SupabaseSupportTicket[] = [MOCK_OPEN_TICKET]
) {
  return { data: tickets, error: null, count: tickets.length, status: 200, statusText: "OK" };
}

export function buildSupabaseEmptyResponse() {
  return { data: [], error: null, count: 0, status: 200, statusText: "OK" };
}

/** Simulates a Supabase connection error (FDW or network). */
export function buildSupabaseErrorResponse(message = "connection timeout") {
  return {
    data: null,
    error: { message, code: "PGRST301", hint: null, details: null },
    count: null,
    status: 503,
    statusText: "Service Unavailable",
  };
}

/** Simulates the INSERT response when a new ticket is created. */
export function buildSupabaseInsertResponse(ticket: Partial<SupabaseSupportTicket>) {
  const created: SupabaseSupportTicket = {
    id: `tkt_sb_new_${Date.now()}`,
    customerId: ticket.customerId ?? "usr_unknown",
    status: "open",
    category: ticket.category ?? "general",
    summary: ticket.summary ?? "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...ticket,
  };
  return { data: [created], error: null, count: 1, status: 201, statusText: "Created" };
}
