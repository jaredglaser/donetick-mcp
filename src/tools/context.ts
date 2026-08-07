import type { DonetickService } from "@/service";

/**
 * What every tool needs to run: the service, the clock, and the zone to fall back
 * on when a chore carries none.
 *
 * Its own module so that no tool module owns it. Declared in tools/write.ts, it made
 * the four peers and chore-lookup.ts import a module that depends on them: type-only
 * and erased, but a real ESM cycle the moment anyone wants a value from write.ts.
 * boundaries.test.ts holds that line.
 */
export interface ToolContext {
  service: DonetickService;
  now: () => Date;
  timezone: string;
}
