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

  test("500 on approve names the recurrence, since approve is the third scheduling write", () => {
    // ApproveChore calls scheduleNextDueDate exactly as complete and skip do, so an
    // unschedulable recurrence 500s here too. It reaches approve by the only route it
    // has: complete_chore on an approval-gated chore reports pending, and approve is
    // the second half. Left out of SCHEDULING_WRITE_PATHS it fell through to the
    // id-scoped message and reported a chore still visible in list_chores as gone.
    //
    // Asserted on the recurrence half of the sentence: both messages contain "no
    // longer exists", so matching that alone cannot tell them apart.
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "Error scheduling next due date" }),
      path: "/api/v1/chores/7/approve",
      method: "POST",
    });
    expect(err.message).toMatch(/recurrence/i);
  });

  test("500 on reject keeps the id-scoped message, since reject never schedules", () => {
    // ChoreRepository.RejectChore takes no due date and never calls
    // scheduleNextDueDate, so a recurrence explanation there would be a guess.
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "Failed to retrieve chore" }),
      path: "/api/v1/chores/7/reject",
      method: "POST",
    });
    expect(err.message).not.toMatch(/recurrence/i);
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

describe("a 5xx on a write says nothing about whether it applied", () => {
  // Only a transport error ever set indeterminate, so no HTTP response could, and
  // the flag's own docstring names create as the reason it exists. Donetick inserts
  // the chore row before later steps that can fail: measured on v0.1.76, a create
  // whose label step fails answers 500 with the row already committed. Reported as a
  // flat failure, the obvious next move is a retry that makes a duplicate.
  test("a 500 on a create is indeterminate", () => {
    const err = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "db locked" }),
      path: "/api/v1/chores/",
      method: "POST",
    });
    expect(err.indeterminate).toBe(true);
  });

  test("a 502 on an edit is indeterminate too", () => {
    const err = mapHttpError({ status: 502, body: "", path: "/api/v1/chores/", method: "PUT" });
    expect(err.indeterminate).toBe(true);
  });

  test("a 500 on a read is not, since a read changes nothing", () => {
    const err = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/?includeSubtasks=true",
      method: "GET",
    });
    expect(err.indeterminate).toBe(false);
  });

  test("a 4xx on a write stays determinate, since nothing was written", () => {
    for (const status of [400, 401, 403, 404]) {
      const err = mapHttpError({ status, body: "", path: "/api/v1/chores/", method: "PUT" });
      expect(err.indeterminate).toBe(false);
    }
  });

  test("the specific message for the path is preserved, not replaced", () => {
    const err = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/",
      method: "PUT",
    });
    expect(err.indeterminate).toBe(true);
    expect(err.message).toMatch(/instance returned an error/i);
  });

  test("the id-scoped writes are not indeterminate, because they wrote nothing", () => {
    // Measured on v0.1.76. Archive and unarchive are a single UPDATE that matched no
    // rows; DELETE the same; the scheduling writes compute the next due date before
    // persisting, so a 500 there leaves the due date, status, history and points
    // untouched. Telling someone a delete they just confirmed "may have been applied"
    // is a false alarm about data loss, and it contradicted the branch message it was
    // appended to.
    const paths: Array<[string, string]> = [
      ["/api/v1/chores/7/archive", "PUT"],
      ["/api/v1/chores/7/unarchive", "PUT"],
      ["/api/v1/chores/7", "DELETE"],
      ["/api/v1/chores/7/do", "POST"],
      ["/api/v1/chores/7/skip", "POST"],
      ["/api/v1/chores/7/approve", "POST"],
      ["/api/v1/chores/7/priority", "PUT"],
    ];
    for (const [path, method] of paths) {
      const err = mapHttpError({ status: 500, body: "", path, method });
      expect(err.indeterminate).toBe(false);
    }
  });

  test("the scheduling branch keeps its own message while staying determinate", () => {
    const err = mapHttpError({
      status: 500,
      body: "",
      path: "/api/v1/chores/7/approve",
      method: "POST",
    });
    expect(err.message).toMatch(/recurrence/i);
    expect(err.indeterminate).toBe(false);
  });
});


describe("a 500 that reports a failed retrieve", () => {
  // Reached when a chore is deleted elsewhere while this server's cache still holds
  // it: the whole-chore PUT reads the row before changing anything, so nothing was
  // written. It is in none of the three path sets, so it was stamped indeterminate
  // and the caller was told an edit that never happened might have.
  const retrieveFailure = {
    status: 500,
    body: JSON.stringify({ error: "Failed to retrieve chore" }),
    path: "/api/v1/chores/",
    method: "PUT",
  };

  test("is not indeterminate, because a read failure wrote nothing", () => {
    expect(mapHttpError(retrieveFailure).indeterminate).toBe(false);
  });

  test("names the chore rather than blaming the instance", () => {
    const err = mapHttpError(retrieveFailure);
    expect(err.message).toMatch(/no longer exists/i);
    expect(err.message).not.toMatch(/instance returned an error/i);
  });

  test("invalidates the cache, since the cached row is what caused it", () => {
    expect(mapHttpError(retrieveFailure).invalidatesCache).toBe(true);
  });

  test("an unrelated 500 on the same endpoint is still indeterminate", () => {
    const other = mapHttpError({
      status: 500,
      body: JSON.stringify({ error: "db locked" }),
      path: "/api/v1/chores/",
      method: "PUT",
    });
    expect(other.indeterminate).toBe(true);
  });
});
