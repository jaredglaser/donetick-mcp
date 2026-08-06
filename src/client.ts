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

  put(path: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", path, body);
  }

  delete(path: string): Promise<unknown> {
    return this.request("DELETE", path);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
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
      throw new DonetickError(
        `Could not reach the Donetick instance at ${this.baseUrl}. ${(error as Error).message}`,
        { status: 0 },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw mapHttpError({ status: response.status, body: text, path, method });
    }

    if (text.trim().length === 0) return undefined;

    try {
      return unwrap(JSON.parse(text));
    } catch {
      throw new DonetickError(
        `${this.baseUrl}${path} returned a 200 that is not JSON. DONETICK_URL may be pointing at the wrong service.`,
        { status: response.status },
      );
    }
  }
}
