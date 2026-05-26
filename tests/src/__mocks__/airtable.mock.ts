import type { AirtableInventoryRecord } from "../types";

export const MOCK_INVENTORY_IN_STOCK: AirtableInventoryRecord = {
  id: "recAirtable001",
  fields: {
    SKU: "WIDGET-PRO-42",
    Name: "Widget Pro 42",
    Stock: 150,
    Price: 29.99,
    Available: true,
    LeadTimeDays: 2,
  },
};

export const MOCK_INVENTORY_OUT_OF_STOCK: AirtableInventoryRecord = {
  id: "recAirtable002",
  fields: {
    SKU: "GADGET-LITE-07",
    Name: "Gadget Lite 07",
    Stock: 0,
    Price: 14.99,
    Available: false,
    LeadTimeDays: 14,
  },
};

/** Airtable list-records API envelope. */
export function buildAirtableListResponse(records: AirtableInventoryRecord[]) {
  return { records, offset: undefined };
}

export function buildAirtableEmptyResponse() {
  return { records: [], offset: undefined };
}

/** 403 authorization failure. */
export function buildAirtableAuthError() {
  return {
    error: "AUTHENTICATION_REQUIRED",
    message: "You must provide a valid api key to perform this operation",
    type: "AUTHENTICATION_REQUIRED",
  };
}
