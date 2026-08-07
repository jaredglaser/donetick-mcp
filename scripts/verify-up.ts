/**
 * Brings the disposable Donetick up and bootstraps it, without running any check.
 *
 * `bun run verify:live` does this on its own, so this exists for the case where
 * the container is wanted on its own: poking at the instance by hand, or paying
 * the startup cost once before several runs.
 */

import { ensureLocalInstance } from "./local-instance";

const instance = await ensureLocalInstance();
console.error(`[verify] Donetick is up at ${instance.baseUrl}`);
