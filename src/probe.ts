import type { DonetickClient } from "@/client";
import { endpoints } from "@/endpoints";

export interface ProbeGate {
    run(): Promise<void>;
  /**
   * The reason Donetick is unreachable, or undefined if it is fine. Cheap while
   * healthy: it costs a request only when the last known state was a failure.
   */
  reason(): Promise<string | undefined>;
}

/**
 * Guards tool calls against a Donetick that is not there, or is there but is not
 * Donetick. The second case is the one that needs a probe at all: an unmatched
 * path on a Donetick host returns the frontend HTML with a 200, so a wrong
 * DONETICK_URL fails by handing back a web page rather than by erroring.
 *
 * A failure is a snapshot of one moment, never a standing verdict. The server is
 * usually started by a desktop client at login, alongside the containers it talks
 * to, so losing the race with Donetick's own startup is the single most likely way
 * this ever fails. Latching that first result would answer every request for the
 * rest of the process with a stale complaint about an instance that came up
 * seconds later and has been healthy since, and nothing in that message tells the
 * user the fix is to restart a server they did not know they were running.
 */
export function createProbeGate(client: DonetickClient, baseUrl: string): ProbeGate {
  let failure: string | undefined;

  async function run(): Promise<void> {
    try {
      const result = await client.get(endpoints.listChores());
      if (!Array.isArray(result)) {
        failure = `${baseUrl} answered but did not return a chore array. DONETICK_URL may be pointing at the wrong service.`;
        console.error(failure);
        return;
      }
      failure = undefined;
      // console.info writes to stdout under Bun, which would corrupt the JSON-RPC
      // stream shared with the transport. Every diagnostic here goes to stderr instead.
      console.error(`donetick-mcp connected to ${baseUrl}, ${result.length} chores visible`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      console.error(`donetick-mcp could not reach Donetick: ${failure}`);
    }
  }

  return {
    run,
    async reason(): Promise<string | undefined> {
      if (failure === undefined) return undefined;
      await run();
      return failure;
    },
  };
}
