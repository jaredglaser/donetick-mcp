import type { DonetickService } from "@/service";

/**
 * What every tool needs to run: the service, the clock, and the zone to fall back
 * on when a chore carries none.
 *
 * Its own module so that no tool module owns it: declared in one of them, every peer
 * imports a module that depends on them back, which boundaries.test.ts refuses.
 */
export interface ToolContext {
  service: DonetickService;
  now: () => Date;
  timezone: string;
}
