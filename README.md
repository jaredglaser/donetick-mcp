# donetick-mcp

A stdio MCP server that gives an AI assistant read access to a self-hosted [Donetick](https://donetick.com) instance: chores, activity history, circle members, and projects.

## What this is

`donetick-mcp` runs as a local process, speaks the Model Context Protocol over stdio, and calls your Donetick instance's HTTP API on your behalf. It targets MCP protocol revision `2026-07-28` using the v2 `@modelcontextprotocol/server` package, and its `serveStdio` transport defaults to `legacy: 'serve'`, so a client still speaking the older 2025-era `initialize` handshake works without any extra configuration.

The server currently exposes five read-only tools. There are no write tools yet: creating, completing, or editing a chore through this server is planned but not implemented.

## Requirements

- [Bun](https://bun.sh) (version pinned in `.bun-version`)
- A running Donetick instance you can reach over HTTP or HTTPS
- A Donetick API token

## Setup

1. Install dependencies:

   ```
   bun install
   ```

2. Copy the example environment file and fill it in:

   ```
   cp .env.example .env
   ```

3. Get an API token from Donetick: open the Donetick web UI, go to Settings, then Access Token, then Generate new token. Paste it into `DONETICK_TOKEN`. This token is not your password; you can revoke it from the same screen.

4. Set `DONETICK_URL` to your instance's origin, with no trailing path, for example `https://donetick.example.com`. Plain `http` is allowed for LAN addresses.

5. Run the server directly to confirm it starts and can reach Donetick:

   ```
   bun src/index.ts
   ```

   A successful connection is logged to stderr as `donetick-mcp connected to <url>, N chores visible`. All diagnostic output goes to stderr; stdout is reserved for the JSON-RPC transport.

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

All five tools are read-only.

| Tool | What it does |
| --- | --- |
| `list_chores` | List chores with filters for scope (all, overdue, due today, due this week, due within N days, unscheduled), project, priority, label, assignee, status, a name search, sorting, and a result limit. |
| `get_chore` | Fetch one chore in full, by id or by name, including subtasks and last-completion detail. |
| `list_activity` | Recent chore completions across the circle, defaulting to the last 7 days and capped at 90. |
| `list_members` | Circle members with their roles and point totals. |
| `list_projects` | Projects used to group chores. |

Write tools (creating, editing, deleting) and action tools (completing, skipping, approving) are not implemented yet.

## Which Donetick API this uses, and why

This server calls Donetick's internal `/api/v1` routes rather than the documented `/eapi/v1` external API. The external API's create endpoint accepts a five-field `ChoreLiteReq` body and hardcodes `frequencyType` to `once`, so it has no way to create a recurring chore. The internal routes accept the same `secretkey` API token through Donetick's `MultiAuthMiddleware`, so no additional credential is needed.

The tradeoff is that `/api/v1` is undocumented, and Donetick is on a beta version line where these routes can change without notice. This is mitigated by keeping every path this server calls in one place, `src/endpoints.ts`, and by a live verification script against a real instance.

Verified against Donetick `v0.1.76` (commit `d4eca08`), on MCP protocol revision
`2026-07-28`. Check your own instance with `curl -s https://your-host/health`, which
returns the version without needing a token. Note that unmatched paths return the
frontend HTML with a 200, so a wrong `DONETICK_URL` fails by returning a web page
rather than an error. The startup probe checks the response shape for this reason.

## Known limitations

**`delete_chore` needs a client that supports elicitation.** It asks the user to
confirm through the protocol's multi-round-trip flow rather than trusting an input
flag, which means the client must declare `elicitation: {form: {}}` in its
capabilities. A client that does not gets `-32021 MissingRequiredClientCapability`
instead of a prompt, and cannot delete. Every other tool works regardless. Archiving
is the alternative and keeps the chore's history.

These were verified against a live Donetick instance, not assumed from its source.

- **Labels are read-only.** `/api/v1/labels` requires JWT session auth, which an API token cannot provide, so this server cannot list all labels that exist in the circle. Labels already attached to a chore are readable and filterable through `list_chores` and `get_chore`. A label attached to nothing is invisible to this server.
- **Deleting a chore is creator-only.** Donetick's delete handler compares the chore's `CreatedBy` field directly and never checks edit permission, so a circle admin cannot delete a chore they did not create, even though they can edit one.
- **The chore list and chore detail views are not supersets of each other.** `GET /chores/` returns rows that alone carry `assignStrategy`, `assignees`, `frequency`, `frequencyMetadata`, `isRolling`, `isPrivate`, `labelsV2`, `notification`, `notificationMetadata`, `points`, and `requireApproval`. `GET /chores/:id/details` alone carries `lastCompletedDate`, `lastCompletedBy`, `totalCompletedCount`, `notes`, `duration`, `startTime`, and `timerUpdatedAt`. `get_chore` merges both views so neither set of fields is lost.
- **Priority is inverted.** P1 is the most urgent priority and P4 is the least; `0` means no priority is set. Filters and sorting in `list_chores` follow this scale rather than an ascending low/medium/high.
- **Chore status has four values**, where `3` means the completion is pending approval rather than confirmed done.
- **Activity history rows carry no chore name**, only a `choreId`. `list_activity` joins each row against the current chore list to recover a name, and reports a completion whose chore was later deleted rather than dropping it silently.
- **Clock skew above 30 seconds will break rescheduling and reassigning** once those write tools exist, because Donetick rejects an `updatedAt` timestamp that is too far in the future.
- **Recurring chores drift by an hour across a daylight-saving boundary**, because Donetick advances daily and weekly recurrences in UTC rather than in the chore's local calendar day. This server reports that drift accurately; it does not cause it.

## Development

See `CLAUDE.md` for the operating rules this codebase follows, the full command list, and a pointer to the design spec.
