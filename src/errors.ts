import { isCreatorOnlyWrite, isIdScopedWrite, isSchedulingWrite } from "@/endpoints";

const MAX_DETAIL_LENGTH = 200;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export class DonetickError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly invalidatesCache: boolean;
  /**
   * The request may have been applied despite failing. A timeout or a dropped
   * connection says nothing about whether the server acted, and Donetick's create
   * inserts the row before later steps that can fail. Reporting those as a flat
   * failure invites the caller to retry and make a duplicate.
   */
  readonly indeterminate: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      retryable?: boolean;
      invalidatesCache?: boolean;
      indeterminate?: boolean;
    },
  ) {
    super(message);
    this.name = "DonetickError";
    this.status = options.status;
    this.indeterminate = options.indeterminate ?? false;
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

/**
 * A 5xx on a write says nothing about whether the write applied.
 *
 * Donetick's create inserts the chore row before several later steps that can fail,
 * and its router has no Recovery middleware, so a panic after partial work drops the
 * connection mid-request. Measured on v0.1.76: a create whose label step fails
 * answers 500 with the chore row already committed. Reported as a flat failure, the
 * obvious next move is to retry, which makes a duplicate. That is the whole reason
 * DonetickError carries this flag, and until now only a transport error ever set it,
 * so no HTTP response could.
 *
 * 4xx stays determinate: a rejected body, a bad token or a missing id all mean
 * nothing was written.
 */
export function mapHttpError(input: {
  status: number;
  body: string;
  path: string;
  method: string;
}): DonetickError {
  const mapped = classifyHttpError(input);
  if (input.status >= 500 && input.method !== "GET" && !mapped.indeterminate) {
    return new DonetickError(mapped.message, {
      status: mapped.status,
      retryable: mapped.retryable,
      invalidatesCache: mapped.invalidatesCache,
      indeterminate: true,
    });
  }
  return mapped;
}

function classifyHttpError(input: {
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
    if (isCreatorOnlyWrite(path, method)) {
      return new DonetickError(
        "Donetick refused that. Archiving and deleting are creator-only, and both report 'not yours' " +
          "and 'not there' identically, so either this chore is already gone or this account did not " +
          "create it.",
        { status, retryable: true, invalidatesCache: true },
      );
    }
    if (isSchedulingWrite(path, method)) {
      return new DonetickError(
        "Donetick could not complete that. Either the chore no longer exists, or its recurrence " +
          "is one Donetick cannot compute a next date for, which it reports the same way. Check " +
          "with get_chore: if the chore is there, the recurrence needs changing.",
        { status, retryable: true, invalidatesCache: true },
      );
    }
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
