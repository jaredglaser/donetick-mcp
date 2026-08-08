/**
 * Stands up the disposable Donetick that verify-live runs against, and mints the
 * credential it uses.
 *
 * verify-live creates, edits and deletes chores, so it must never point at an
 * instance anyone relies on. It points at a container started from the pinned tag
 * in compose.verify.yaml instead. Bootstrapping is fully scripted over plain
 * HTTP: sign a throwaway user up, log in for a JWT, then mint the long-lived
 * token. That token is what Donetick looks up for the `secretkey` header
 * (GetUserByToken joins api_tokens on the header value), so it is the same
 * credential src/client.ts sends, not a second kind of key.
 *
 * Progress lines go to stderr so the report verify-live prints to stdout stays
 * clean when it is redirected.
 */

import { chmodSync, mkdirSync } from "node:fs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE_FILE = `${REPO_ROOT}compose.verify.yaml`;

/**
 * Where the minted token lands. Gitignored, mode 600, and disposable: it belongs
 * to a container that `bun run verify:down` destroys.
 */
const CREDENTIALS_FILE = `${REPO_ROOT}.donetick-local/credentials.json`;

const IMAGE_TAG = Bun.env.DONETICK_IMAGE_TAG ?? "v0.1.76";
const HOST_PORT = Bun.env.DONETICK_LOCAL_PORT ?? "12021";
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

/**
 * The container's own zone, which decides the offset Donetick writes into
 * created_at. Separate from LOCAL_TIMEZONE below, which is the zone the scratch
 * chores carry in their frequency metadata; the undo check reads the first and every
 * scheduling check reads the second.
 *
 * The default has to match compose.verify.yaml's, since this string is what the
 * reuse check compares against.
 */
const CONTAINER_TZ = Bun.env.DONETICK_TZ ?? "America/New_York";

/**
 * What the running container is, as opposed to whether it answers.
 *
 * The reuse path used to ask only whether the stored token still worked, so every
 * container-level knob was silently ignored whenever one was already up. That made
 * the documented `DONETICK_IMAGE_TAG=vX.Y.Z bun run verify:live` re-check v0.1.76 and
 * report the checks as passing for the new tag, and it is how the first attempt to
 * measure undo at UTC measured America/New_York instead.
 */
const containerIdentity = (): string => `${IMAGE_TAG} ${CONTAINER_TZ} ${HOST_PORT}`;

/**
 * Matches the instance this server is written for. verify-live asserts that undo
 * fails if and only if Donetick stores timestamps behind UTC, so a UTC container
 * would satisfy that check the other way round and stop guarding the diagnosis in
 * explainUndoFailure. compose.verify.yaml sets the same zone on the container.
 */
export const LOCAL_TIMEZONE = "America/New_York";

const USERNAME = "verify-live";
const EMAIL = "verify-live@donetick-mcp.invalid";
const SUBACCOUNT_NAME = "second";

export interface LocalInstance {
  baseUrl: string;
  token: string;
  timezone: string;
}

function log(line: string): void {
  console.error(`[verify] ${line}`);
}

function randomSecret(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function compose(args: string[], secret: string): void {
  const result = Bun.spawnSync(["docker", "compose", "--file", COMPOSE_FILE, ...args], {
    env: {
      ...process.env,
      DONETICK_IMAGE_TAG: IMAGE_TAG,
      DONETICK_LOCAL_PORT: HOST_PORT,
      DONETICK_JWT_SECRET: secret,
      // Explicit rather than inherited, so the value compose interpolates is the
      // same one containerIdentity() recorded.
      DONETICK_TZ: CONTAINER_TZ,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} exited ${result.exitCode}`);
  }
}

/**
 * A fresh secret every time, which is also why a container is never reused across
 * a restart: a different secret invalidates the sessions the old one signed.
 */
const composeUp = (): void => compose(["up", "--detach", "--wait"], randomSecret(32));

// Nothing to sign on the way down, but the compose file interpolates the secret
// on every command, so one has to be there.
const composeDown = (): void => compose(["down", "--remove-orphans", "--volumes"], "");

async function readCredentials(): Promise<LocalInstance | undefined> {
  const file = Bun.file(CREDENTIALS_FILE);
  if (!(await file.exists())) return undefined;
  try {
    const parsed = (await file.json()) as Partial<LocalInstance> & { identity?: unknown };
    if (typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string") return undefined;
    // A file written before the identity was recorded names a container that cannot
    // be shown to match, so it is replaced rather than trusted.
    if (parsed.identity !== containerIdentity()) return undefined;
    return { baseUrl: parsed.baseUrl, token: parsed.token, timezone: LOCAL_TIMEZONE };
  } catch {
    return undefined;
  }
}

async function writeCredentials(instance: LocalInstance): Promise<void> {
  mkdirSync(`${REPO_ROOT}.donetick-local`, { recursive: true, mode: 0o700 });
  const stored = { ...instance, identity: containerIdentity() };
  await Bun.write(CREDENTIALS_FILE, `${JSON.stringify(stored, null, 2)}\n`);
  // After the write, not as an option to it: Bun.write's mode applies only when it
  // creates the file, so a rewrite would keep whatever mode was there before.
  chmodSync(CREDENTIALS_FILE, 0o600);
}

/** True when the token still authenticates and the instance still answers as Donetick. */
async function tokenWorks(instance: LocalInstance): Promise<boolean> {
  try {
    const response = await fetch(`${instance.baseUrl}/api/v1/chores/`, {
      headers: { secretkey: instance.token },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { res?: unknown };
    return Array.isArray(body.res);
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Donetick at ${BASE_URL} did not become healthy within ${timeoutMs}ms (${lastError})`);
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  }
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * Signs a user up, logs in, and mints the long-lived token, in that order: the
 * token endpoint sits behind the JWT middleware alone, so the `secretkey` this
 * function returns cannot be used to obtain itself.
 */
async function bootstrap(): Promise<LocalInstance> {
  const password = randomSecret(16);

  log("signing up the throwaway user");
  await postJson("/api/v1/auth/", {
    username: USERNAME,
    password,
    email: EMAIL,
    displayName: "Verify Live",
  });

  log("logging in");
  const login = await postJson("/api/v1/auth/login", { username: USERNAME, password });
  const jwt = typeof login.access_token === "string" ? login.access_token : login.token;
  if (typeof jwt !== "string" || jwt === "") {
    throw new Error(`login returned no access_token or token: ${JSON.stringify(Object.keys(login))}`);
  }
  const bearer = { authorization: `Bearer ${jwt}` };

  // A second member so the nudge check has someone to nudge: Donetick drops the
  // caller from the target list, so a one-member circle cannot exercise it. A
  // subaccount is the only way to add one without a second signup and an invite
  // handshake, and it joins the parent's circle directly.
  log("adding a subaccount so the circle has two members");
  await postJson(
    "/api/v1/users/subaccounts",
    { childName: SUBACCOUNT_NAME, displayName: "Verify Second", password: randomSecret(16) },
    bearer,
  );

  log("minting the long-lived token");
  const minted = await postJson("/api/v1/users/tokens", { name: "verify-live" }, bearer);
  const record = minted.res as { token?: unknown } | undefined;
  const token = record?.token;
  if (typeof token !== "string" || token === "") {
    throw new Error("POST /api/v1/users/tokens returned no token in its res envelope");
  }

  return { baseUrl: BASE_URL, token, timezone: LOCAL_TIMEZONE };
}

/** Destroys the container and the credentials that belong to it. */
export async function tearDownLocalInstance(): Promise<void> {
  composeDown();
  await Bun.file(CREDENTIALS_FILE)
    .delete()
    .catch(() => undefined);
}

/**
 * Returns a Donetick that is up, bootstrapped, and safe to write to. Reuses a
 * running one when its token still works; otherwise replaces it, because a
 * container that outlived its credentials cannot be signed up again under the
 * same username.
 */
export async function ensureLocalInstance(): Promise<LocalInstance> {
  const existing = await readCredentials();
  if (existing !== undefined && (await tokenWorks(existing))) {
    log(`reusing the Donetick already running at ${existing.baseUrl} (${containerIdentity()})`);
    return existing;
  }

  log(`starting donetick/donetick:${IMAGE_TAG} on ${BASE_URL}, TZ ${CONTAINER_TZ}`);
  composeDown();
  composeUp();
  await waitForHealth(60_000);

  const instance = await bootstrap();
  await writeCredentials(instance);
  log("bootstrapped");
  return instance;
}
