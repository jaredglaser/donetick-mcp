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
});
