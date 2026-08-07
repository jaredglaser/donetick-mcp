# CLAUDE.md

Operating rules for an agent working in `donetick-mcp`, a stdio MCP server on Bun that manages chores on a self-hosted Donetick instance.

## Critical rules

1. **Imports.** Use `@/` for anything under `src/`. Inside a `__tests__/` directory, use a relative import for a sibling under test (`../index`, `../read`) and `@/` for anything outside that directory. Never mix the two styles in a single non-test file; production code always uses `@/`.

2. **Testing.** Tests live in `__tests__/` co-located with the source they cover, use `bun:test`, and run with `bun test --isolate`. Never sleep in a test. Every module that depends on time takes an injected clock (a `now: () => Date` or `now: () => number`) precisely so a test can pass a fixed instant instead of waiting on a real one.

3. **I/O boundaries.** `src/client.ts` is the only module that touches the network. `src/cache.ts` and `src/probe.ts` are the only modules that hold state, and both hold it in an instance created once at startup, never at module scope. Domain helpers (`src/time.ts`, `src/projection.ts`, `src/resolve.ts`, `src/tools/read.ts`) take their clock and their data as arguments and hold nothing themselves.

4. **MCP boundary.** Only `src/index.ts` may import `@modelcontextprotocol/server`. Tool definitions elsewhere are plain data: a name, a description, a zod raw shape for the input, and a handler function. Anything constructed inside the server factory in `src/index.ts` has per-connection lifetime, so the `DonetickService` and its caches are built once outside the factory and closed over, not rebuilt per connection.

5. **Never guess a wire field name.** Donetick's internal `/api/v1` is undocumented. A wrong field name on a write often produces a 200 with the wrong effect rather than an error, so check `src/types.ts`, `src/endpoints.ts`, and, when in doubt, the live instance before trusting a guess.

6. **Priority is inverted.** P1 is the most urgent, P4 is the least, and `0` means unset. Never map an ascending low/medium/high scale onto it. See `PRIORITY_LABEL` in `src/types.ts`.

7. **Chore status has four values.** `3` is pending approval. A completion handler must detect that status and report it rather than claiming the chore is done. See `CHORE_STATUS` in `src/types.ts`.

8. **Logging: `console.error` only.** Verified under Bun, `console.log` and `console.info` write to stdout, and stdout is the JSON-RPC transport this server speaks over. An operational line written with `console.info` corrupts the protocol stream. This is a deliberate divergence from the sibling `homelab-manager` project, where stdout is harmless.

9. **Comments default to none.** Write one only when it states a constraint the code itself cannot express, for example why an ordering matters or why a value cannot be what it looks like it should be.

10. **No em dashes, en dashes, or `--` used as a dash, anywhere in this repo's prose or code comments.** Avoid delve, robust, comprehensive, meticulous, leverage, utilize, facilitate, essentially, fundamentally, and "it's worth noting". No excessive emoji.

11. **Dependencies are pinned to exact versions.** No `^` or `~` in `package.json`.

## Commands

```
bun install              # install dependencies
bun src/index.ts         # start the server (also: bun run start)
bun --watch src/index.ts # start with auto-restart on file change (bun run dev)
bun run typecheck        # tsc --noEmit
bun test --isolate       # run the test suite (also: bun run test)
bun run test:watch       # run the test suite in watch mode
bun run verify:live      # start the pinned Donetick container and check the wire contract against it
bun run verify:up        # start and bootstrap that container without running any check
bun run verify:down      # destroy it
```

`verify:live` needs Docker and never touches a running instance. It reads no
credentials from the environment, so a populated `.env` cannot redirect it. Aim it
at a different Donetick version with `DONETICK_IMAGE_TAG=vX.Y.Z bun run verify:live`.

## Layout

- `src/index.ts` builds the `DonetickClient`, `DonetickService`, and tool definitions once, then hands them to `serveStdio`. It is the only file that imports `@modelcontextprotocol/server`.
- `src/config.ts` parses and validates environment variables into a `Config`.
- `src/client.ts` is the sole HTTP boundary: it sends the `secretkey` header, unwraps Donetick's `{"res": ...}` envelope, and turns HTTP failures into `DonetickError`.
- `src/endpoints.ts` is the single source of truth for every Donetick path this server calls.
- `src/errors.ts` maps an HTTP status and response body to a `DonetickError` with a human-readable message.
- `src/cache.ts` holds a generic `TtlCache`. It and `src/probe.ts` are the only stateful modules.
- `src/service.ts` wires the client and caches together into `DonetickService`.
- `src/types.ts` holds the raw Donetick shapes, the projected shape returned to tools, and the `CHORE_STATUS` and `PRIORITY_LABEL` lookup tables.
- `src/projection.ts` turns a raw chore into the trimmed `ProjectedChore` shape tools return.
- `src/resolve.ts` resolves a free-text name to one entity, or raises an ambiguity or no-match error with suggestions. `resolveMember` lives here so that every tool matches a person's name the same way.
- `src/time.ts` has DST-safe calendar arithmetic (day boundaries, "due in" phrasing) built on `Temporal`.
- `src/dates.ts` parses what a caller may write for a date: RFC3339, `YYYY-MM-DD`, and phrases like "tomorrow" or "in 3 days".
- `src/frequency.ts` maps a recurrence description onto Donetick's eleven `frequencyType` values and their metadata.
- `src/chore-request.ts` builds the create body and merges the edit body. The merge is the highest-risk code in the repo: Donetick has no partial update, so every field absent from the merge base is destroyed on write.
- `src/probe.ts` decides whether Donetick is reachable and is actually Donetick. A failure is re-checked on the next tool call, never latched: the server is started at login alongside the containers it talks to, so losing that race is the likeliest way it ever fails.
- `src/confirm.ts` holds the elicitation key and the pure decision that turns an elicitation response into consent, refusal, or "not asked yet". It is separate from `src/index.ts` only so it can be tested, since the suite cannot import the entry point.
- `src/tools/read.ts`, `write.ts`, `schedule.ts`, `actions.ts` and `subtasks.ts` implement the twenty tools; `src/tools/chore-lookup.ts` is the single loader they all resolve a chore id through; `src/tools/context.ts` holds the `ToolContext` every handler takes, in its own module so that no tool module owns it and none has to import a peer to get it; `src/tools/index.ts` declares them as plain data, each with the MCP annotations a client reads to tell a reader from a destructive write.
- `compose.verify.yaml` pins the Donetick version the wire contract is checked against, and `scripts/local-instance.ts` starts it and bootstraps a throwaway user and API token over plain HTTP. `scripts/verify-live.ts` runs the checks; `verify-up.ts` and `verify-down.ts` are the container's lifecycle on its own. The container's `TZ` is `America/New_York` rather than UTC because one check asserts undo fails if and only if the server stores timestamps behind UTC; UTC would satisfy it the other way round and stop guarding `explainUndoFailure`.
- `.github/workflows/ci.yml` runs the type check, the unit suite, and `verify:live` on a push to `main` and on every pull request. Push is restricted to `main` so a PR from a branch in this repo does not run the whole job twice; the concurrency group cannot dedupe those, since `github.ref` is the branch on one trigger and `refs/pull/N/merge` on the other. It tears the container down in an `always()` step, because `verify:live` deliberately leaves it up.

## Design spec

The full design, including the case for `/api/v1` over `/eapi/v1` and the plan for write and action tools, is at `docs/superpowers/specs/2026-08-05-donetick-mcp-design.md`.
