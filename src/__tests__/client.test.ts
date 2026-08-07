import { describe, expect, test } from "bun:test";
import { DonetickClient } from "@/client";
import { DonetickError } from "@/errors";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const base = { baseUrl: "https://dt.example.com", token: "tok_abc", timeoutMs: 15_000 };

describe("DonetickClient", () => {
  test("sends the secretkey header and joins the path", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ res: [] }), { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    await client.get("/api/v1/chores/");

    expect(stub.calls[0]?.url).toBe("https://dt.example.com/api/v1/chores/");
    const headers = new Headers(stub.calls[0]?.init.headers);
    expect(headers.get("secretkey")).toBe("tok_abc");
    expect(headers.get("accept")).toBe("application/json");
  });

  test("unwraps a res envelope", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ res: [{ id: 1 }] }), { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    expect(await client.get("/api/v1/chores/")).toEqual([{ id: 1 }]);
  });

  test("returns a bare array unchanged", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    expect(await client.get("/api/v1/chores/")).toEqual([{ id: 2 }]);
  });

  test("always sends a body on post, even when none is given", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ res: 1 }), { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    await client.post("/api/v1/chores/7/do");

    expect(stub.calls[0]?.init.body).toBe("{}");
    expect(new Headers(stub.calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  test("maps a 401 through errors.ts", async () => {
    const stub = stubFetch(() => new Response("", { status: 401 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/DONETICK_TOKEN/);
  });

  test("a 500 on an id-scoped write is flagged retryable", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ error: "x" }), { status: 500 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    try {
      await client.post("/api/v1/chores/7/do");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DonetickError);
      expect((error as DonetickError).retryable).toBe(true);
    }
  });

  test("reports the base url when the network fails", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new DonetickClient({ ...base, fetchFn: fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/dt\.example\.com/);
  });

  test("reports a timeout distinctly", async () => {
    const fn = (async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }) as unknown as typeof fetch;
    const client = new DonetickClient({ ...base, fetchFn: fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/timed out/i);
  });

  test("rejects an html response that claims to be json", async () => {
    const stub = stubFetch(
      () => new Response("<!doctype html><html></html>", { status: 200 }),
    );
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/not JSON/i);
  });
});

describe("failures that never leave the process", () => {
  test("a thrown non-Error does not render as the literal word undefined", async () => {
    const fn = (async () => {
      throw "socket exploded";
    }) as unknown as typeof fetch;
    const client = new DonetickClient({ ...base, fetchFn: fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/socket exploded/);
    await expect(client.get("/api/v1/chores/")).rejects.not.toThrow(/undefined/);
  });

  test("a header the runtime refuses to build points at the token, not the network", async () => {
    const fn = (async () => {
      throw new TypeError("Header 'secretkey' has invalid value");
    }) as unknown as typeof fetch;
    const client = new DonetickClient({ ...base, fetchFn: fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/DONETICK_TOKEN/);
    await expect(client.get("/api/v1/chores/")).rejects.not.toThrow(/Could not reach/);
  });

  test("an ordinary network failure still reports the base url", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new DonetickClient({ ...base, fetchFn: fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/Could not reach/);
  });
});

describe("falsy payloads survive unwrapping", () => {
  for (const [label, payload, expected] of [
    ["a numeric res, as create returns", { res: 0 }, 0],
    ["a false res", { res: false }, false],
    ["an empty-string res", { res: "" }, ""],
    ["a null res", { res: null }, null],
    ["a bare number", 7, 7],
  ] as Array<[string, unknown, unknown]>) {
    test(label, async () => {
      const stub = stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
      const client = new DonetickClient({ ...base, fetchFn: stub.fn });
      expect(await client.get("/api/v1/chores/")).toBe(expected as never);
    });
  }

  test("an empty body is undefined, distinct from a null res", async () => {
    const stub = stubFetch(() => new Response("", { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });
    expect(await client.get("/api/v1/chores/")).toBeUndefined();
  });
});


describe("redirects are refused rather than followed", () => {
  // fetch strips Authorization, Cookie, Host and Proxy-Authorization across a
  // cross-origin redirect, but secretkey is none of those. A LAN Donetick reached
  // over plain http that answers 302 would hand the token to whoever replied.
  test("asks fetch not to follow", async () => {
    const stub = stubFetch(() => new Response("[]", { status: 200 }));
    await new DonetickClient({ baseUrl: "https://x.test", token: "t", timeoutMs: 100, fetchFn: stub.fn }).get("/api/v1/chores/");

    expect(stub.calls[0]!.init.redirect).toBe("manual");
  });

  test("a 3xx throws, names DONETICK_URL, and issues no second request", async () => {
    const stub = stubFetch(
      () => new Response("", { status: 302, headers: { location: "http://elsewhere.test/" } }),
    );
    const client = new DonetickClient({ baseUrl: "https://x.test", token: "t", timeoutMs: 100, fetchFn: stub.fn });

    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/redirected/);
    await expect(client.get("/api/v1/chores/")).rejects.toThrow(/DONETICK_URL/);
    expect(stub.calls.length).toBe(2);
  });
});

describe("indeterminate marks writes whose outcome is unknown", () => {
  // A timed-out or dropped write says nothing about whether the server acted.
  // Reporting it as a flat failure invites a retry that duplicates the chore.
  const failing = (kind: "timeout" | "network") =>
    stubFetch(() => {
      if (kind === "timeout") {
        const error = new Error("The operation timed out.");
        error.name = "TimeoutError";
        throw error;
      }
      throw new TypeError("Unable to connect");
    });

  const clientFor = (stub: ReturnType<typeof stubFetch>) =>
    new DonetickClient({ baseUrl: "https://x.test", token: "t", timeoutMs: 10, fetchFn: stub.fn });

  test("a timed-out POST is indeterminate", async () => {
    try {
      await clientFor(failing("timeout")).post("/api/v1/chores/", {});
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DonetickError).indeterminate).toBe(true);
    }
  });

  test("a dropped POST is indeterminate", async () => {
    try {
      await clientFor(failing("network")).post("/api/v1/chores/", {});
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DonetickError).indeterminate).toBe(true);
    }
  });

  test("a failed GET is not, since a read that did not arrive changed nothing", async () => {
    try {
      await clientFor(failing("timeout")).get("/api/v1/chores/");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DonetickError).indeterminate).toBe(false);
    }
  });
});

describe("a 200 whose body is not JSON", () => {
  // The wrong-service reading is useful on a read and misleading on a write: the URL
  // is fine, something in between mangled the response, and the write may have
  // applied. Marked indeterminate so fail() adds its caveat rather than letting the
  // caller read it as a clean failure and retry.
  test("a read is told the URL may be wrong", async () => {
    const stub = stubFetch(() => new Response("<html>502</html>", { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    const error = (await client.get("/api/v1/chores/").catch((e: unknown) => e)) as DonetickError;
    expect(error.message).toMatch(/wrong service/);
    expect(error.indeterminate).toBe(false);
  });

  test("a write is told the response was unreadable, and is indeterminate", async () => {
    const stub = stubFetch(() => new Response("<html>502</html>", { status: 200 }));
    const client = new DonetickClient({ ...base, fetchFn: stub.fn });

    const error = (await client
      .post("/api/v1/chores/", {})
      .catch((e: unknown) => e)) as DonetickError;
    expect(error.message).not.toMatch(/wrong service/);
    expect(error.message).toMatch(/rewriting responses/);
    expect(error.indeterminate).toBe(true);
  });
});
