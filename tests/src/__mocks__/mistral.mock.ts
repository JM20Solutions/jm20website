import type { IntentLabel, MistralIntentResponse } from "../types";

/**
 * Builds a deterministic Mistral chat-completion response for a given intent.
 * The workflow's Intent Agent parses choices[0].message.content as JSON:
 *   { "intent": "<label>", "confidence": <0-1> }
 */
export function buildMistralResponse(
  intent: IntentLabel,
  confidence = 0.95,
  model = "mistral-small-latest"
): MistralIntentResponse {
  return {
    id: `cmpl-mock-${intent}-${Date.now()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ intent, confidence }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 48, completion_tokens: 10, total_tokens: 58 },
  };
}

/**
 * Simulates a Mistral response where the model cannot determine intent —
 * content is plain prose (not JSON), which forces the workflow into "unclear".
 */
export function buildMistralAmbiguousResponse(
  rawContent = "I cannot determine the user's intent with confidence.",
  model = "mistral-small-latest"
): MistralIntentResponse {
  return {
    id: `cmpl-mock-ambiguous-${Date.now()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // Not valid JSON — deliberately triggers the fallback branch
          content: rawContent,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 48, completion_tokens: 18, total_tokens: 66 },
  };
}

/**
 * Simulates a Mistral rate-limit / server error response (HTTP 429/500).
 * The workflow must catch this and route to the "unclear" fallback.
 */
export function buildMistralErrorResponse() {
  return {
    message: "Requests rate limit exceeded",
    request_id: "mock-rate-limit-request-id",
  };
}
