import { mapHttpError, DonetickError } from "@/errors";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

/**
 * Donetick wraps most internal API responses in {"res": ...} but returns bare
 * arrays from a few handlers. Both shapes reach here.
 *
 * res is always unwrapped, including when siblings ride alongside it: POST /:id/do
 * answers {res, message} and callers read status off the chore, so keeping the
 * envelope for those would break every one of them. A caller that needs a sibling
 * asks for the envelope explicitly through the raw variants below.
 */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "res" in payload) {
    return (payload as { res: unknown }).res;
  }
  return payload;
}

export class DonetickClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  /**
   * The response with its envelope intact, for the caller that needs a sibling of
   * res rather than res itself. Create answers {res, warnings} when it defaults a
   * field, and those warnings are the only signal that the chore Donetick made is
   * not quite the one that was asked for.
   */
  postEnvelope(path: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, body, { unwrapRes: false });
  }

  put(path: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", path, body);
  }

  delete(path: string): Promise<unknown> {
    return this.request("DELETE", path);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    { unwrapRes = true }: { unwrapRes?: boolean } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      secretkey: this.token,
      accept: "application/json",
    };

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };

    if (method !== "GET" && method !== "DELETE") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DonetickError(
          `The request to ${this.baseUrl} timed out after ${this.timeoutMs}ms.`,
          { status: 0 },
        );
      }
      const detail = error instanceof Error ? error.message : String(error);

      // A header the runtime refuses to build never leaves the process, so reporting
      // it as unreachable would send someone debugging the network instead of the
      // token. config.ts rejects control characters first; this is the backstop.
      if (error instanceof TypeError && /header/i.test(detail)) {
        throw new DonetickError(
          `The request could not be built, which usually means DONETICK_TOKEN contains an invalid character. ${detail}`,
          { status: 0 },
        );
      }

      throw new DonetickError(
        `Could not reach the Donetick instance at ${this.baseUrl}. ${detail}`,
        { status: 0 },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw mapHttpError({ status: response.status, body: text, path, method });
    }

    if (text.trim().length === 0) return undefined;

    try {
      const parsed = JSON.parse(text);
      return unwrapRes ? unwrap(parsed) : parsed;
    } catch {
      throw new DonetickError(
        `${this.baseUrl}${path} returned a 200 that is not JSON. DONETICK_URL may be pointing at the wrong service.`,
        { status: response.status },
      );
    }
  }
}
