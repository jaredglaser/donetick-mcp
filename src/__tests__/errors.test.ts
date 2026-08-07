import { describe, expect, test } from "bun:test";
import { DonetickError, mapHttpError } from "@/errors";

describe("mapHttpError", () => {
  test("401 names the token variable", () => {
    const err = mapHttpError({ status: 401, body: "", path: "/api/v1/chores/", method: "GET" });
    expect(err.message).toMatch(/DONETICK_TOKEN/);
    expect(err.retryable).toBe(false);
  });

  test("400 surfaces the body's error field", () => {
    const err = mapHttpError({
      status: 400,
      body: JSON.stringify({ error: "User is not assigned to chore" }),
      path: "/api/v1/chores/7/do",
      method: "POST",
    });
    expect(err.message).toMatch(/User is not assigned to chore/);
  });

  test("400 with an unparseable body still reports something", () => {
    const err = mapHttpError({
      status: 400,
      body: "<html>nope</html>",
      path: "/api/v1/chores/",
      method: "POST",
    });
    expect(err.message).toMatch(/rejected the request/i);
  });

  test("403 with a reason surfaces it", () => {
    const err = mapHttpError({
      status: 403,
      body: JSON.stringify({ error: "chore has been modified by another user" }),
      path: "/api/v1/chores/7/dueDate",
      method: "PUT",
    });
    expect(err.message).toMatch(/modified by another user/);
    expect(err.retryable).toBe(true);
  });

  test("403 with an empty body reports both possibilities and is retryable", () => {
    const err = mapHttpError({
      status: 403,
      body: "{}",
      path: "/api/v1/chores/7/dueDate",
      method: "PUT",
    });
    expect(err.message).toMatch(/permission/i);
    expect(err.message).toMatch(/changed/i);
    expect(err.retryable).toBe(true);
  });

  test("500 on an id-scoped write means the chore is gone", () => {
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "Failed to retrieve chore" }),
      path: "/api/v1/chores/7/do",
      method: "POST",
    });
    expect(err.message).toMatch(/no longer exists/i);
    expect(err.retryable).toBe(true);
    expect(err.invalidatesCache).toBe(true);
  });

  test("500 on a read is an instance error, not a missing chore", () => {
    const err = mapHttpError({
      status: 500,
      body: "boom",
      path: "/api/v1/chores/",
      method: "GET",
    });
    expect(err.message).not.toMatch(/no longer exists/i);
    expect(err.message).toMatch(/instance/i);
  });

  test("404 is reported as not found", () => {
    const err = mapHttpError({ status: 404, body: "", path: "/api/v1/chores/7/nudge", method: "POST" });
    expect(err.message).toMatch(/not found/i);
  });

  test("errors are DonetickError instances", () => {
    expect(mapHttpError({ status: 401, body: "", path: "/x", method: "GET" })).toBeInstanceOf(
      DonetickError,
    );
  });

  test("403 with an empty body does not promise a retry", () => {
    const err = mapHttpError({
      status: 403,
      body: "{}",
      path: "/api/v1/chores/7/dueDate",
      method: "PUT",
    });
    expect(err.message.toLowerCase()).not.toMatch(/retrying/);
  });

  test("500 on an id-scoped write does not promise a retry", () => {
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "Failed to retrieve chore" }),
      path: "/api/v1/chores/7/do",
      method: "POST",
    });
    expect(err.message.toLowerCase()).not.toMatch(/retrying/);
  });

  test("403 with a reason invalidates the cache", () => {
    const err = mapHttpError({
      status: 403,
      body: JSON.stringify({ error: "chore has been modified by another user" }),
      path: "/api/v1/chores/7/dueDate",
      method: "PUT",
    });
    expect(err.invalidatesCache).toBe(true);
  });

  test("403 with an empty body invalidates the cache", () => {
    const err = mapHttpError({
      status: 403,
      body: "{}",
      path: "/api/v1/chores/7/dueDate",
      method: "PUT",
    });
    expect(err.invalidatesCache).toBe(true);
  });

  test("404 invalidates the cache", () => {
    const err = mapHttpError({ status: 404, body: "", path: "/api/v1/chores/7/nudge", method: "POST" });
    expect(err.invalidatesCache).toBe(true);
  });

  test("500 on an id-scoped write invalidates the cache", () => {
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "Failed to retrieve chore" }),
      path: "/api/v1/chores/7/do",
      method: "POST",
    });
    expect(err.invalidatesCache).toBe(true);
  });

  test("500 on a read does not invalidate the cache", () => {
    const err = mapHttpError({
      status: 500,
      body: "boom",
      path: "/api/v1/chores/",
      method: "GET",
    });
    expect(err.invalidatesCache).toBe(false);
  });

  test("a 5xx read body longer than the cap is truncated with an ellipsis", () => {
    const longBody = "x".repeat(250);
    const err = mapHttpError({
      status: 500,
      body: longBody,
      path: "/api/v1/chores/",
      method: "GET",
    });
    expect(err.message.endsWith("...")).toBe(true);
    expect(err.message).toContain("x".repeat(50));
    expect(err.message.length).toBeLessThan(longBody.length);
  });

  test("a 5xx read body at exactly the cap is included in full with no ellipsis", () => {
    const exactBody = "y".repeat(200);
    const err = mapHttpError({
      status: 500,
      body: exactBody,
      path: "/api/v1/chores/",
      method: "GET",
    });
    expect(err.message).toContain(exactBody);
    expect(err.message.endsWith("...")).toBe(false);
  });

  test("a 400 with an error field longer than the cap produces a bounded message", () => {
    const longReason = "z".repeat(500);
    const err = mapHttpError({
      status: 400,
      body: JSON.stringify({ error: longReason }),
      path: "/api/v1/chores/",
      method: "POST",
    });
    expect(err.message.length).toBeLessThan(longReason.length);
    expect(err.message.endsWith("...")).toBe(true);
  });

  describe("bodyError parsing", () => {
    const cases: Array<[string, string]> = [
      ["a nested object error field", JSON.stringify({ error: { nested: "x" } })],
      ["a numeric error field", JSON.stringify({ error: 42 })],
      ["an empty string error field", JSON.stringify({ error: "" })],
      ["a whitespace-only error field", JSON.stringify({ error: "   " })],
      ["a null body", "null"],
      ["an array body", "[]"],
      ["an empty body", ""],
    ];

    for (const [label, body] of cases) {
      test(`${label} falls back to the generic message without throwing`, () => {
        const err = mapHttpError({ status: 400, body, path: "/api/v1/chores/", method: "POST" });
        expect(err.message).toMatch(/rejected the request/i);
      });
    }
  });
});

describe("archive and unarchive are creator-only, which a 500 cannot distinguish", () => {
  // Donetick's archive repo matches on id AND created_by AND circle_id and reports a
  // zero-row update identically for "absent" and "not yours". Both are 500. Saying
  // only "the chore is gone" contradicts the list read that produced the id one call
  // earlier, and sends the user looking for data that is still there.
  test("names both possibilities rather than asserting the chore is gone", () => {
    const error = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/7/archive",
      method: "PUT",
    });
    expect(error.message).toMatch(/creator-only/i);
    expect(error.message).toMatch(/did not create it/);
  });

  test("unarchive says the same", () => {
    const error = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/7/unarchive",
      method: "PUT",
    });
    expect(error.message).toMatch(/creator-only/i);
  });

  test("the other id-scoped writes still say the chore is gone, because they do look it up", () => {
    const error = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/7/do",
      method: "POST",
    });
    expect(error.message).toMatch(/no longer exists/);
    expect(error.message).not.toMatch(/creator-only/i);
  });
});

describe("a 500 on complete or skip is not proof the chore is gone", () => {
  // Measured on v0.1.76: a chore whose recurrence Donetick cannot compute a next
  // date for is created happily and then answers 500 on every completion. Saying
  // "that chore no longer exists" sends the user looking for data that is right
  // there, and hides the thing they can actually fix.
  test("names the recurrence as the other possibility", () => {
    const error = mapHttpError({ status: 500, body: "", path: "/api/v1/chores/7/do", method: "POST" });
    expect(error.message).toMatch(/recurrence/);
    expect(error.message).toMatch(/get_chore/);
  });

  test("skip says the same, since it schedules the next date too", () => {
    expect(
      mapHttpError({ status: 500, body: "", path: "/api/v1/chores/7/skip", method: "POST" }).message,
    ).toMatch(/recurrence/);
  });

  test("a write that does not schedule still says the chore is gone", () => {
    const error = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/7/priority",
      method: "PUT",
    });
    expect(error.message).toMatch(/no longer exists/);
    expect(error.message).not.toMatch(/recurrence/);
  });

  test("both still drop the cache and stay retryable", () => {
    const error = mapHttpError({ status: 500, body: "", path: "/api/v1/chores/7/do", method: "POST" });
    expect(error.invalidatesCache).toBe(true);
    expect(error.retryable).toBe(true);
  });
});
