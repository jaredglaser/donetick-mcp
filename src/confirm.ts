/**
 * The elicitation key for a confirmation. src/index.ts has to read the answer out
 * of inputResponses before it calls the handler that would name the key, so the
 * two sides cannot negotiate it and must share this constant instead. A key set
 * on a confirmRequired sentinel that the reader does not use produces an
 * unanswerable request that repeats until the round limit aborts the call.
 */
export const CONFIRM_KEY = "confirm";

/**
 * The parts of the SDK's InputResponseView this module needs, restated locally so
 * that only src/index.ts imports the MCP SDK.
 */
export interface ConfirmationResponseView {
  kind: string;
  action?: string;
  content?: Record<string, unknown>;
}

/**
 * Turns an embedded elicitation response into the answer a handler expects, or
 * undefined when the question has not been asked yet.
 *
 * The distinction is the whole point: the SDK's acceptedContent returns undefined
 * for a declined or cancelled elicitation just as it does for a missing one, so
 * reading through it alone makes a refusal look like a fresh call. The handler
 * then re-issues the same request, the client refuses again, and the call ends at
 * the round limit with a protocol error instead of reporting that nothing was
 * deleted.
 *
 * Anything other than an accept carrying a boolean confirm is a refusal, since the
 * only caller guards a destructive delete and an unreadable answer is not consent.
 */
export function decideConfirmation(
  response: ConfirmationResponseView,
): { confirm: boolean } | undefined {
  if (response.kind === "missing") return undefined;
  if (response.kind !== "elicit" || response.action !== "accept") return { confirm: false };
  return { confirm: response.content?.confirm === true };
}
