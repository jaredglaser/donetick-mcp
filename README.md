# donetick-mcp

A stdio MCP server that lets an AI assistant read and manage a self-hosted [Donetick](https://donetick.com) instance: chores, recurrence, assignment, completions, activity history, circle members, and projects.

## What this is

`donetick-mcp` runs as a local process, speaks the Model Context Protocol over stdio, and calls your Donetick instance's HTTP API on your behalf. It targets MCP protocol revision `2026-07-28` using the v2 `@modelcontextprotocol/server` package, and its `serveStdio` transport defaults to `legacy: 'serve'`, so a client still speaking the older 2025-era `initialize` handshake works without any extra configuration.

The server exposes twenty tools: five that read, eight that write, and seven that act on a chore's lifecycle. Deleting is the only one that asks the user to confirm before it proceeds. Every tool carries MCP annotations, so a client can tell `list_chores` from `delete_chore` before calling either: the five readers are `readOnlyHint`, `edit_chore`, `delete_chore`, `complete_chore` and `skip_chore` are `destructiveHint`, and `openWorldHint` is false throughout since every tool talks to one known instance.

## Requirements

- [Bun](https://bun.sh) (version pinned in `.bun-version`)
- A running Donetick instance you can reach over HTTP or HTTPS
- A Donetick API token
- Docker, for `bun run verify:live` only. The server itself does not need it.

## Setup

1. Install dependencies:

   ```
   bun install
   ```

2. Copy the example environment file and fill it in:

   ```
   cp .env.example .env
   ```

3. Get an API token from Donetick: open the Donetick web UI, go to Settings, then Access Token, then Generate New Token. Paste it into `DONETICK_TOKEN`. This token is not your password; you can revoke it from the same screen.

4. Set `DONETICK_URL` to your instance's origin, with no trailing path, for example `https://donetick.example.com`. Plain `http` is allowed for LAN addresses.

5. Run the server directly to confirm it starts and can reach Donetick:

   ```
   bun src/index.ts
   ```

   A successful connection is logged to stderr as `donetick-mcp connected to <url>, N chores visible`. All diagnostic output goes to stderr; stdout is reserved for the JSON-RPC transport.

   Bun reads `.env` from the working directory, not from the script's directory, so this works from the repo root and not from elsewhere. An MCP client launches the process with its own working directory, which is why the configuration below passes the variables inline instead.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DONETICK_URL` | yes | none | Donetick instance origin. Must be an http or https URL with no path, query string, fragment, or credentials. |
| `DONETICK_TOKEN` | yes | none | API token, sent as the `secretkey` header on every request. |
| `DONETICK_TZ` | no | the system's local IANA zone | Used when a chore carries no timezone of its own. |
| `DONETICK_CACHE_TTL_MS` | no | `10000` | How long the chore list is cached in memory. `0` disables caching. |
| `DONETICK_TIMEOUT_MS` | no | `15000` | Per-request timeout in milliseconds. |

See `src/config.ts` for the exact validation rules; invalid values fail at startup with a specific message rather than a stack trace.

## Using it with Claude Code

Add an entry to your MCP configuration, using an absolute path to `src/index.ts`:

```json
{
  "mcpServers": {
    "donetick": {
      "command": "bun",
      "args": ["/absolute/path/to/donetick/src/index.ts"],
      "env": {
        "DONETICK_URL": "https://donetick.example.com",
        "DONETICK_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Tools

### Reading

| Tool | What it does |
| --- | --- |
| `list_chores` | List chores with filters for scope (all, overdue, due today, due this week, due within N days, unscheduled, archived), project, priority, label, assignee, status, a name search, sorting, and a result limit. |
| `get_chore` | Fetch one chore in full, by id or by name, including subtasks and last-completion detail. |
| `list_activity` | Recent chore completions across the circle, defaulting to the last 7 days and capped at 90. Days are calendar days in your timezone, the same unit `list_chores` uses. |
| `list_members` | Circle members with their roles and point totals. |
| `list_projects` | Projects used to group chores. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_chore` | Create a chore, with recurrence, due date, assignees, priority, points, subtasks, and notification settings. |
| `edit_chore` | Change any subset of a chore's fields. Everything not passed is preserved. |
| `delete_chore` | Permanently remove a chore and its history, after confirming with the user. Works on archived chores too. |
| `reschedule_chore` | Move a chore's due date, or clear it. |
| `reassign_chore` | Change who a chore is assigned to. |
| `set_priority` | Set or clear a chore's priority. |
| `archive_chore` | Take a chore out of active lists while keeping its history. |
| `unarchive_chore` | Put an archived chore back. |

### Acting

| Tool | What it does |
| --- | --- |
| `complete_chore` | Mark a chore done, optionally backdated or on someone else's behalf. Reports a chore that needs approval as pending rather than done. |
| `skip_chore` | Skip this occurrence and move to the next. Refuses a chore with a running or paused timer, which Donetick answers 200 to and then does nothing about, and a chore with a completion awaiting sign-off, which it would discard along with that person's points. |
| `undo_chore` | Reverse your own completion. Fails on any instance whose clock is behind UTC: see Known limitations. |
| `approve_chore` | Approve a completion that is waiting on sign-off. |
| `reject_chore` | Reject one. |
| `nudge_chore` | Remind whoever the chore is assigned to. |
| `set_subtask_completed` | Tick or untick one subtask. |

## Which Donetick API this uses, and why

This server calls Donetick's internal `/api/v1` routes rather than the documented `/eapi/v1` external API. The external API's create endpoint accepts a five-field `ChoreLiteReq` body and hardcodes `frequencyType` to `once`, so it has no way to create a recurring chore. The internal routes accept the same `secretkey` API token through Donetick's `MultiAuthMiddleware`, so no additional credential is needed.

The tradeoff is that `/api/v1` is undocumented, and Donetick is on a beta version line where these routes can change without notice. This is mitigated by keeping every path this server calls in one place, `src/endpoints.ts`, and by a verification script that checks all of them against a Donetick container pinned to a known version.

All 20 tools verified against Donetick `v0.1.76` (commit `d4eca08`), on MCP protocol revision
`2026-07-28`. Check your own instance with `curl -s https://your-host/health`, which
returns the version without needing a token. Note that unmatched paths return the
frontend HTML with a 200, so a wrong `DONETICK_URL` fails by returning a web page
rather than an error. The startup probe checks the response shape for this reason.

## Checking the API contract

This server targets Donetick's undocumented internal API, so the unit tests prove
the code is self-consistent, not that Donetick still behaves as it was read. One
command covers the rest:

```bash
bun run verify:live
```

It needs Docker and nothing else. It starts a Donetick container pinned to the tag
in `compose.verify.yaml`, signs a throwaway user up over plain HTTP, mints that
user's API token, and exercises 33 contract facts against it. A clean run reports
34 passed: the last is a cleanup assertion, not a contract fact. Scratch chores carry
a run-scoped name prefix and are deleted in a `finally`, so a mid-run failure
leaves nothing behind. It exits non-zero if any check fails, and distinguishes a warning
(something changed but nothing is broken) from a failure.

It never talks to a running instance, and reads no credentials from the
environment, so a populated `.env` cannot redirect it. Checking a newer Donetick
means pointing it at a newer container:

```bash
DONETICK_IMAGE_TAG=v0.1.77 bun run verify:live
```

The container holds its database in its own writable layer, so nothing persists
and nothing is written into the working tree. `bun run verify:up` brings it up and
bootstraps it without running any check, which is worth doing once if several runs
follow; `bun run verify:down` destroys it. `verify:live` reuses a container that is
already up rather than replacing it, and does not tear one down when it finishes, so
run `verify:down` when you are done with it. CI runs the type check, the unit suite,
and `verify:live` on every push and pull request.

The container's timezone is `America/New_York` rather than UTC on purpose. One
check asserts that `undo_chore` fails if and only if the server stores timestamps
behind UTC; on a UTC container it would pass for the opposite reason and stop
guarding the diagnosis the tool reports. The other half of that conditional is
measurable rather than assumed:

```bash
DONETICK_TZ=UTC bun run verify:live
```

Measured on 2026-08-08 against v0.1.76, undo succeeds there and `created_at` comes
back as `...Z`, which is what makes the offset the cause rather than a correlate.
`DONETICK_IMAGE_TAG` and `DONETICK_TZ` are both part of the container's recorded
identity, so changing either replaces a running container instead of reusing it.

## Known limitations

**`delete_chore` needs a client that supports elicitation.** It asks the user to
confirm through the protocol's multi-round-trip flow rather than trusting an input
flag, which means the client must declare `elicitation: {form: {}}` in its
capabilities. A client that does not gets `-32021 MissingRequiredClientCapability`
instead of a prompt, and cannot delete. A client that declares the capability but
refuses the prompt gets a plain "nothing was deleted" result. Every other tool works
regardless. Archiving is the alternative and keeps the chore's history.

These were verified against a live Donetick instance, not assumed from its source.

- **A chore driven by a Donetick Thing cannot be edited here.** Donetick drops the Thing association on every edit and restores it only for a request naming the Thing, which this server cannot build, so `edit_chore` refuses rather than severing the link silently.
- **A completion window requires a due date**, and so does an adaptive chore. Donetick reads the due date without checking whether it is there, so a chore with a completion window can never be completed and an adaptive one can never be skipped. A window of `0` is not "off": it is a real window of zero hours that makes the chore uncompletable, so both `create_chore` and `edit_chore` reject it. `edit_chore` takes `completion_window: null` to remove an existing window. A rolling chore needs no due date; Donetick schedules the first occurrence from the first completion.
- **Only reminder offsets produce a notification.** `notify`'s `due_date`, `completion`, `predue` and `nagging` flags are stored and never read, so `notify` without `reminders` sends nothing. Offsets are written to the wire negated, because Donetick adds the value to the due date rather than subtracting it; a positive one would schedule an overdue nag instead of a reminder. At most five per chore.
- **`undo_chore` fails on any instance whose timezone is behind UTC.** Donetick answers "no recent action found" immediately after both a completion and a skip, well inside its own five-minute window. Its handler accepts either action, so the refusal is not skip-specific. The cause is a string comparison: `created_at` is written in the server's own UTC offset while the cutoff is built in UTC, and SQLite compares the two as text, so on a server behind UTC the stored value always sorts earlier and nothing is ever recent enough. An instance running at UTC or ahead of it is unaffected. `verify:live` asserts the conditional directly, failing if undo starts working without the offset changing, or stops working when it has not; its container runs at `America/New_York` so that the check is exercised in the failing direction.
- **A time of day applies to three recurrence types only.** Donetick's scheduler reads `frequency.time` for `interval`, `days_of_the_week` and `day_of_the_month`, and for an hourly interval reading it freezes the chore: the clock is reset to that time before the hours are added, so from the second completion it reschedules to where it already is. Both cases are refused at build time; set the hour through `due_date` instead, which every type honors.
- **Labels are read-only.** `/api/v1/labels` requires JWT session auth, which an API token cannot provide, so this server cannot list all labels that exist in the circle. Labels already attached to a chore are readable and filterable through `list_chores` and `get_chore`. A label attached to nothing is invisible to this server.
- **Deleting a chore is creator-only.** Donetick's delete handler compares the chore's `CreatedBy` field directly and never checks edit permission, so a circle admin cannot delete a chore they did not create, even though they can edit one.
- **The chore list and chore detail views are not supersets of each other.** `GET /chores/` returns rows that alone carry `assignStrategy`, `assignees`, `frequency`, `frequencyMetadata`, `isRolling`, `isPrivate`, `labelsV2`, `notification`, `notificationMetadata`, `points`, and `requireApproval`. `GET /chores/:id/details` alone carries `lastCompletedDate`, `lastCompletedBy`, `totalCompletedCount`, `notes`, `duration`, `startTime`, and `timerUpdatedAt`. `get_chore` merges both views so neither set of fields is lost.
- **Priority is inverted.** P1 is the most urgent priority and P4 is the least; `0` means no priority is set. Filters and sorting in `list_chores` follow this scale rather than an ascending low/medium/high.
- **Chore status has four values**, where `3` means the completion is pending approval rather than confirmed done.
- **Activity history rows carry no chore name**, only a `choreId`. `list_activity` joins each row against the current chore list to recover a name, and reports a completion whose chore was later deleted rather than dropping it silently.
- **The concurrency token is the row's own stamp, never a clock reading.** The endpoints that take an `updatedAt` compare it against the stored row and refuse anything older, and `PUT /:id/assignee` writes the value it receives back into the row, so a machine running ahead of the server would stamp a chore with a version its own skew invented. `concurrencyToken` in `src/chore-request.ts` sends the stored string verbatim, because it carries nanosecond precision a `Date` round trip truncates downward.
- **Recurring chores drift by an hour across a daylight-saving boundary**, because Donetick advances daily and weekly recurrences in UTC rather than in the chore's local calendar day. This server reports that drift accurately; it does not cause it.
- **A monthly chore due on the 29th, 30th or 31st moves to the 1st and stays there.** Donetick adds a month with Go's date arithmetic, which normalises September 31 to October 1, so a chore due the 31st of August skips September entirely and is a 1st-of-the-month chore from its first completion on. This applies to `monthly` and to an `interval` measured in months. `day_of_the_month` handles month lengths properly and is the right choice for a fixed calendar day.

## AI Disclosure

Built with Claude Code. I directed and reviewed the architecture and  data flow. I've skimmed the code to confirm that my rules and direction was properly enforced.

Donetick's /api/v1 is undocumented, so the wire contracts were worked out by a fleet of Claude Code agents from the Go source and by measuring a pinned container. `bun run verify:live` is used for verifying the contracts are still accurate.

Expect that there could be edge cases that are handled wrong. There is a chance for data loss. For example, Donetick has no partial update so `edit_chore` rewrites the whole chore. Any field this server gets wrong it overwrites. There are guards and tests for that, but covering every permutation and possibility is not realistic.

Please keep backups. I auto snapshot the LXC my Donetick runs in just in case I need to revert.

## Development

See `CLAUDE.md` for the operating rules this codebase follows and the full command list.

```bash
bun run typecheck    # tsc --noEmit
bun test --isolate   # the unit suite: no network, no wall clock, no sleeps
bun run verify:live  # the wire contract, against a disposable container
```

## License

Apache-2.0. See `LICENSE`.

This project is not affiliated with or endorsed by Donetick.
