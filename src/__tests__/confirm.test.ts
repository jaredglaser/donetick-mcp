import { describe, expect, test } from "bun:test";
import { CONFIRM_KEY, decideConfirmation } from "../confirm";

describe("CONFIRM_KEY", () => {
  test("is the key both the request builder and the response reader use", () => {
    // Not a tautology: the reader in src/index.ts cannot learn the key from the
    // handler, because it has to read the answer before calling it. If the two
    // sides ever name it differently the answer is never found and the request
    // repeats to the round limit.
    expect(CONFIRM_KEY).toBe("confirm");
  });
});

describe("decideConfirmation", () => {
  test("a missing response means the question has not been asked yet", () => {
    expect(decideConfirmation({ kind: "missing" })).toBeUndefined();
  });

  test("an accepted confirm true is consent", () => {
    expect(decideConfirmation({ kind: "elicit", action: "accept", content: { confirm: true } })).toEqual({
      confirm: true,
    });
  });

  test("an accepted confirm false is a refusal, not a missing answer", () => {
    expect(decideConfirmation({ kind: "elicit", action: "accept", content: { confirm: false } })).toEqual({
      confirm: false,
    });
  });

  test("a declined elicitation is a refusal rather than an unasked question", () => {
    // The bug this guards: acceptedContent maps decline and missing to the same
    // undefined, so the handler re-asked a declined question until the round
    // limit aborted the call with a protocol error instead of reporting that
    // nothing was deleted.
    expect(decideConfirmation({ kind: "elicit", action: "decline" })).toEqual({ confirm: false });
  });

  test("a cancelled elicitation is a refusal", () => {
    expect(decideConfirmation({ kind: "elicit", action: "cancel" })).toEqual({ confirm: false });
  });

  test("a response of another kind is a refusal, since it answers a different question", () => {
    expect(decideConfirmation({ kind: "roots" })).toEqual({ confirm: false });
  });

  test("an accept whose content omits confirm is a refusal, because absent consent is not consent", () => {
    expect(decideConfirmation({ kind: "elicit", action: "accept", content: {} })).toEqual({
      confirm: false,
    });
  });

  test("an accept whose confirm is not a boolean is a refusal", () => {
    // "false" and 0 are the dangerous shapes here: a truthiness check would read
    // the string as consent, and this guards a permanent delete.
    expect(
      decideConfirmation({ kind: "elicit", action: "accept", content: { confirm: "false" } }),
    ).toEqual({ confirm: false });
    expect(
      decideConfirmation({ kind: "elicit", action: "accept", content: { confirm: "true" } }),
    ).toEqual({ confirm: false });
  });

  test("an accept with no content at all is a refusal", () => {
    expect(decideConfirmation({ kind: "elicit", action: "accept" })).toEqual({ confirm: false });
  });
});
