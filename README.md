# codecks-mcp

MCP server (stdio) that lets agents read and change a [Codecks](https://codecks.io) project.
Built on the official API: <https://manual.codecks.io/api/> and <https://manual.codecks.io/api-reference>.

## Setup

Requires Node 20+.

```bash
npm install && npm run build
cp .env.example .env   # optional, for your own shell; never commit it
```

| Env var | Meaning |
|---|---|
| `CODECKS_TOKEN` | API token. Organization (`cdxat_…`) or personal (`cdxut_…`), created in Codecks organization settings. Needs read plus `card:write` / `resolvable:write` for the write tools. A legacy browser `at` token also works until 2026-12-31 (sent as `X-Auth-Token`). |
| `CODECKS_ACCOUNT` | Account subdomain (`acme` for `acme.codecks.io`). |

The token is only read from env and is never logged.

## Register it

```bash
claude mcp add codecks \
  --env CODECKS_TOKEN=cdxat_xxx --env CODECKS_ACCOUNT=acme \
  -- node /absolute/path/to/codecks-mcp/dist/index.js
```

or `.mcp.json`:

```json
{
  "mcpServers": {
    "codecks": {
      "command": "node",
      "args": ["/absolute/path/to/codecks-mcp/dist/index.js"],
      "env": { "CODECKS_TOKEN": "cdxat_xxx", "CODECKS_ACCOUNT": "acme" }
    }
  }
}
```

## Tools

| Tool | Does | Example input |
|---|---|---|
| `list_projects` | Projects with their tags | `{}` |
| `list_decks` | Decks (ids needed to create cards) | `{"project_id":"…"}` |
| `list_milestones` | Milestones | `{}` |
| `list_users` | Users seen as assignee/creator on cards (API has no direct users list) | `{}` |
| `search_cards` | Filter by deck, status, assignee, milestone, tag, text; paged; archived hidden | `{"deck_id":"…","status":"started","tag":"bug","text":"login"}` |
| `get_card` | One card with content and comment threads | `{"card_id":"…"}` |
| `create_card` | New card; first line of content is the title | `{"deck_id":"…","content":"Fix login\nSteps…","priority":"a","tags":["bug"]}` |
| `update_card` | Title/content, status, assignee, deck, priority, effort, milestone, due date, tags (replace or add/remove) | `{"card_id":"…","status":"done","add_tags":["shipped"]}` |
| `add_comment` | New comment thread on a card | `{"card_id":"…","content":"Looks good"}` |
| `archive_card` | Archive (or `archived:false` to restore); never deletes | `{"card_id":"…"}` |

Status: `not_started | started | snoozing | done`. Priority: `a` (high) `b` `c` (low).

Errors come back as readable tool errors: bad/expired token, account mismatch, missing scope (403), unknown card, rate limit (40 requests / 5 s per IP, with retry-after).

## Develop

```bash
npm test        # vitest, mocked HTTP, no network
npm run build
```

## Status / caveats

Not yet tested against a live account. Response parsing follows the documented flattened format; filters (`masterTags` with `has`, `content` with `contains`) follow the documented operators. Verify with a real token before relying on it.

## Prior art

Open-source Codecks MCPs exist (e.g. orkenstein/mcp-codecks, MIT; Simokod/codecks-mcp, MIT). This is an independent implementation; no code reused.
