import type { DonetickService } from "@/service";

/**
 * What every tool needs to run: the service, the clock, and the zone to fall back
 * on when a chore carries none.
 *
 * It lives here rather than in whichever tool module happened to be written first.
 * It was declared twice, as WriteContext in tools/write.ts and as ToolDeps in
 * tools/index.ts, and the registry converted one into the other. Four peer modules
 * plus chore-lookup.ts imported the write.ts copy, so the lowest helper in
 * src/tools pointed back up at one of the modules that depends on it. That edge was
 * type-only and erased, but it became a real ESM cycle the moment anyone needed a
 * value from write.ts, and the symptom would have been a TDZ error at import time
 * naming neither file's actual problem.
 */
export interface ToolContext {
  service: DonetickService;
  now: () => Date;
  timezone: string;
}
