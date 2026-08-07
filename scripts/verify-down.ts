/**
 * Destroys the disposable Donetick and the credentials that belong to it.
 *
 * The container holds its sqlite file in its own writable layer, so nothing
 * survives this and nothing was ever written into the working tree.
 */

import { tearDownLocalInstance } from "./local-instance";

await tearDownLocalInstance();
console.error("[verify] Donetick is down");
