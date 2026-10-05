import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CodecksClient, CodecksError } from "./client.js";

// Enums: https://manual.codecks.io/api-reference (Card model).
const STATUS = ["not_started", "started", "snoozing", "done"] as const;
const PRIORITY = ["a", "b", "c"] as const; // a = high, b = medium, c = low (labels are account-configurable)

const CARD_FIELDS = [
  "title", "status", "derivedStatus", "priority", "effort", "dueDate", "deckId",
  "assigneeId", "milestoneId", "masterTags", "visibility", "createdAt", "lastUpdatedAt",
];

type Json = Record<string, any>;

/**
 * Responses are flattened (https://manual.codecks.io/api/ "Response Format"): the root holds ids,
 * and every model lives in a top-level map by type and id. Resolve relation ids to objects.
 */
function pick(data: Json, model: string, ids: unknown): Json[] {
  const table: Json = data?.[model] ?? {};
  const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
  return list.map((id) => (typeof id === "string" ? { id, ...(table[id] ?? {}) } : id));
}

/** Find a relation value on a record; keys carry their query args, e.g. `cards({"deckId":"x"})`. */
function rel(rec: Json | undefined, name: string): unknown {
  if (!rec) return undefined;
  const key = Object.keys(rec).find((k) => k === name || k.startsWith(name + "("));
  return key ? rec[key] : undefined;
}

function accountRecord(data: Json): Json {
  const root = data?._root;
  const first = Array.isArray(root) ? root[0] : root;
  const id = first?.account;
  return (data?.account ?? {})[id] ?? {};
}


const ok = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

async function guard(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof CodecksError ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { isError: true, content: [{ type: "text" as const, text: msg }] };
  }
}

const q = (name: string, args?: Json) => (args ? `${name}(${JSON.stringify(args)})` : name);

function updateBody(a: Json, existing?: Json): Json {
  const body: Json = {};
  const map: [string, string][] = [
    ["status", "status"], ["priority", "priority"], ["effort", "effort"],
    ["assignee_id", "assigneeId"], ["deck_id", "deckId"], ["milestone_id", "milestoneId"],
    ["due_date", "dueDate"], ["tags", "masterTags"],
  ];
  for (const [from, to] of map) if (a[from] !== undefined) body[to] = a[from];
  // A card's title is the first line of its content.
  if (a.title !== undefined || a.content !== undefined) {
    const old: string = existing?.content ?? "";
    const oldBody = old.includes("\n") ? old.slice(old.indexOf("\n") + 1) : "";
    const title = a.title ?? old.split("\n")[0] ?? "";
    const rest = a.content !== undefined ? a.content : oldBody;
    body.content = rest ? `${title}\n${rest}` : title;
  }
  return body;
}

export function registerTools(server: McpServer, c: CodecksClient): void {

  server.registerTool(
    "list_projects",
    { description: "List projects (id, name) with their tags (tag names usable in card filters).", inputSchema: {} },
    () =>
      guard(async () => {
        const data = await c.query([
          { account: [{ projects: ["name", "visibility", { tags: ["tag", "color", "emoji"] }] }] },
        ]);
        return pick(data, "project", rel(accountRecord(data), "projects")).map((p) => ({
          ...p,
          tags: pick(data, "projectTag", p.tags),
        }));
      }),
  );

  server.registerTool(
    "list_decks",
    {
      description: "List decks (id, title, projectId). Deck ids are needed to create cards.",
      inputSchema: { project_id: z.string().optional().describe("Only decks of this project") },
    },
    ({ project_id }) =>
      guard(async () => {
        const filter = project_id ? { projectId: project_id, isDeleted: false } : { isDeleted: false };
        const data = await c.query([
          { account: [{ [q("decks", filter)]: ["title", "description", "deckType", "projectId"] }] }],
        );
        return pick(data, "deck", rel(accountRecord(data), "decks"));
      }),
  );

  server.registerTool(
    "list_milestones",
    { description: "List milestones (id, name, date, startDate).", inputSchema: {} },
    () =>
      guard(async () => {
        const data = await c.query([
          { account: [{ [q("milestones", { isDeleted: false })]: ["name", "date", "startDate", "description", "isGlobal"] }] }],
        );
        return pick(data, "milestone", rel(accountRecord(data), "milestones"));
      }),
  );

  server.registerTool(
    "list_users",
    {
      description:
        "List users (id, name, fullName) seen as assignee or creator on cards. Use ids for assignee filters. Users with no cards are not listed.",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const data = await c.query([
          { account: [{ [q("cards", { $order: "-lastUpdatedAt", $limit: 500 })]: [{ assignee: ["name", "fullName"] }, { creator: ["name", "fullName"] }] }] }],
        );
        const seen = new Map<string, Json>();
        for (const card of pick(data, "card", rel(accountRecord(data), "cards"))) {
          for (const u of [...pick(data, "user", card.assignee), ...pick(data, "user", card.creator)]) {
            if (u.id) seen.set(u.id, u);
          }
        }
        return [...seen.values()];
      }),
  );

  server.registerTool(
    "search_cards",
    {
      description:
        "Search/list cards. All filters optional and combined with AND. Archived/deleted cards are excluded unless include_archived. Returns newest-updated first.",
      inputSchema: {
        deck_id: z.string().optional(),
        status: z.enum(STATUS).optional(),
        assignee_id: z.string().optional().describe("User id (see list_users)"),
        milestone_id: z.string().optional(),
        tag: z.string().optional().describe("Project tag name, without #"),
        text: z.string().optional().describe("Substring match on card content (includes title)"),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
    },
    (a) =>
      guard(async () => {
        const f: Json = { $order: "-lastUpdatedAt", $limit: a.limit, $offset: a.offset };
        if (!a.include_archived) f.visibility = "default";
        if (a.deck_id) f.deckId = a.deck_id;
        if (a.status) f.status = a.status;
        if (a.assignee_id) f.assigneeId = a.assignee_id;
        if (a.milestone_id) f.milestoneId = a.milestone_id;
        if (a.tag) f.masterTags = { op: "has", value: a.tag };
        if (a.text) f.content = { op: "contains", value: a.text };
        const data = await c.query([{ account: [{ [q("cards", f)]: CARD_FIELDS }] }]);
        return pick(data, "card", rel(accountRecord(data), "cards"));
      }),
  );


  server.registerTool(
    "get_card",
    {
      description: "Get one card by id with full content and comment threads.",
      inputSchema: { card_id: z.string() },
    },
    ({ card_id }) =>
      guard(async () => {
        const data = await c.query([
          {
            account: [
              {
                [q("cards", { cardId: card_id })]: [
                  ...CARD_FIELDS, "content",
                  { resolvables: ["context", "isClosed", "createdAt", { creator: ["name"] }, { entries: ["content", "createdAt", { author: ["name"] }] }] },
                ],
              },
            ],
          },
        ]);
        const [card] = pick(data, "card", rel(accountRecord(data), "cards"));
        if (!card) throw new CodecksError(`Card ${card_id} not found.`, 404, "not_found");
        const threads = pick(data, "resolvable", card.resolvables).map((t) => ({
          ...t,
          creator: pick(data, "user", t.creator)[0],
          entries: pick(data, "resolvableEntry", t.entries).map((e) => ({
            ...e,
            author: pick(data, "user", e.author)[0],
          })),
        }));
        return { ...card, resolvables: threads };
      }),
  );

  server.registerTool(
    "create_card",
    {
      description: "Create a card. The first line of content is its title.",
      inputSchema: {
        deck_id: z.string(),
        content: z.string().describe("Title on the first line, optional body after"),
        priority: z.enum(PRIORITY).optional(),
        effort: z.number().optional(),
        assignee_id: z.string().optional(),
        milestone_id: z.string().optional(),
        tags: z.array(z.string()).optional().describe("Project tag names"),
        due_date: z.string().optional().describe("YYYY-MM-DD"),
      },
    },
    (a) =>
      guard(() =>
        c.dispatch("cards/create", {
          content: a.content,
          deckId: a.deck_id,
          priority: a.priority,
          effort: a.effort,
          assigneeId: a.assignee_id,
          milestoneId: a.milestone_id,
          masterTags: a.tags,
          dueDate: a.due_date,
        }),
      ),
  );

  server.registerTool(
    "update_card",
    {
      description:
        "Update a card. Only given fields change. title/content: title is the first line of content; passing only title keeps the body. tags replaces all tags; add_tags/remove_tags change them incrementally. Pass null for assignee_id/milestone_id/due_date to clear.",
      inputSchema: {
        card_id: z.string(),
        title: z.string().optional(),
        content: z.string().optional().describe("Body after the title line"),
        status: z.enum(STATUS).optional(),
        assignee_id: z.string().nullable().optional(),
        deck_id: z.string().optional(),
        priority: z.enum(PRIORITY).nullable().optional(),
        effort: z.number().nullable().optional(),
        milestone_id: z.string().nullable().optional(),
        due_date: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        add_tags: z.array(z.string()).optional(),
        remove_tags: z.array(z.string()).optional(),
      },
    },
    (a) =>
      guard(async () => {
        let existing: Json | undefined;
        if (a.title !== undefined || a.content !== undefined) {
          const data = await c.query([{ account: [{ [q("cards", { cardId: a.card_id })]: ["content"] }] }]);
          [existing] = pick(data, "card", rel(accountRecord(data), "cards"));
          if (!existing) throw new CodecksError(`Card ${a.card_id} not found.`, 404, "not_found");
        }
        const body = updateBody(a, existing);
        if (Object.keys(body).length) await c.dispatch("cards/update", { id: a.card_id, ...body });
        if (a.add_tags?.length || a.remove_tags?.length) {
          for (const t of a.add_tags ?? []) await c.dispatch("cards/bulkUpdate", { ids: [a.card_id], addMasterTag: t });
          for (const t of a.remove_tags ?? []) await c.dispatch("cards/bulkUpdate", { ids: [a.card_id], removeMasterTag: t });
        }
        return { ok: true, card_id: a.card_id };
      }),
  );

  server.registerTool(
    "add_comment",
    {
      description: "Add a comment to a card (starts a new comment thread).",
      inputSchema: { card_id: z.string(), content: z.string() },
    },
    ({ card_id, content }) =>
      guard(() => c.dispatch("resolvables/create", { cardId: card_id, context: "comment", content })),
  );

  server.registerTool(
    "archive_card",
    {
      description: "Archive a card (reversible: pass archived=false to restore). Does not delete.",
      inputSchema: { card_id: z.string(), archived: z.boolean().default(true) },
    },
    ({ card_id, archived }) =>
      guard(async () => {
        await c.dispatch("cards/update", { id: card_id, visibility: archived ? "archived" : "default" });
        return { ok: true, card_id, archived };
      }),
  );
}
