import { isIdScopedWrite } from "@/endpoints";

const MAX_DETAIL_LENGTH = 200;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export class DonetickError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly invalidatesCache: boolean;

  constructor(
    message: string,
    options: { status: number; retryable?: boolean; invalidatesCache?: boolean },
  ) {
    super(message);
    this.name = "DonetickError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.invalidatesCache = options.invalidatesCache ?? false;
  }
}

function bodyError(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string" && value.trim().length > 0) return truncate(value, MAX_DETAIL_LENGTH);
    }
  } catch {
    // Donetick returns HTML for some proxy failures. Fall through.
  }
  return undefined;
}

export function mapHttpError(input: {
  status: number;
  body: string;
  path: string;
  method: string;
}): DonetickError {
  const { status, body, path, method } = input;
  const reason = bodyError(body);

  if (status === 401) {
    return new DonetickError(
      "Donetick rejected the API token. Check DONETICK_TOKEN, and confirm it has not been revoked in Donetick under Settings, Access Tokens.",
      { status },
    );
  }

  if (status === 400) {
    return new DonetickError(
      reason
        ? `Donetick rejected the request: ${reason}`
        : "Donetick rejected the request and returned no reason.",
      { status },
    );
  }

  if (status === 403) {
    if (reason) {
      return new DonetickError(`Donetick refused: ${reason}`, {
        status,
        retryable: true,
        invalidatesCache: true,
      });
    }
    return new DonetickError(
      "Donetick refused the write and gave no reason. Either the account lacks permission for this chore, or the chore changed since it was read.",
      { status, retryable: true, invalidatesCache: true },
    );
  }

  if (status === 404) {
    return new DonetickError("Donetick reported that chore was not found. It may have been deleted.", {
      status,
      invalidatesCache: true,
    });
  }

  if (status >= 500) {
    if (isIdScopedWrite(path, method)) {
      return new DonetickError(
        "That chore no longer exists, or is no longer visible to this account.",
        { status, retryable: true, invalidatesCache: true },
      );
    }
    const detail = body.length > 0 ? ` ${truncate(body, MAX_DETAIL_LENGTH)}` : "";
    return new DonetickError(`The Donetick instance returned an error.${detail}`, { status });
  }

  return new DonetickError(`Donetick returned an unexpected status ${status}.`, { status });
}
