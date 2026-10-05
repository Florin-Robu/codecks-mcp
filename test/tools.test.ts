import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CodecksClient } from "../src/client.js";
import { registerTools } from "../src/tools.js";

type Call = { url: string; headers: Record<string, string>; body: any };

async function setup(responder: (c: Call) => { status?: number; body: unknown; headers?: Record<string, string> }, token = "cdxat_SECRET") {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new CodecksClient({ token, account: "acme", fetchImpl, baseUrl: "https://api.test" }));
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text as string;
    return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
  };
  return { calls, call, client };
}

const cardsResponse = {
  _root: [{ account: "acc1" }],
  account: { acc1: { 'cards({"x":1})': ["c1"] } },
  card: { c1: { title: "Fix bug", status: "started" } },
};

describe("auth + errors", () => {
  it("sends Bearer + X-Account for cdxat_ tokens, X-Auth-Token for legacy", async () => {
    const t1 = await setup(() => ({ body: { _root: [], account: {} } }));
    await t1.call("list_milestones");
    expect(t1.calls[0].headers.Authorization).toBe("Bearer cdxat_SECRET");
    expect(t1.calls[0].headers["X-Account"]).toBe("acme");
    const t2 = await setup(() => ({ body: {} }), "legacyhex");
    await t2.call("list_milestones");
    expect(t2.calls[0].headers["X-Auth-Token"]).toBe("legacyhex");
    expect(t2.calls[0].headers.Authorization).toBeUndefined();
  });
  it("maps invalid_token, never leaks the token", async () => {
    const t = await setup(() => ({ status: 401, body: { error: "invalid_token" } }));
    const r = await t.call("list_projects");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/invalid or revoked/);
    expect(r.text).not.toContain("SECRET");
  });
  it("maps rate limit with retry-after", async () => {
    const t = await setup(() => ({ status: 429, body: {}, headers: { "retry-after": "4" } }));
    const r = await t.call("list_decks");
    expect(r.text).toMatch(/rate limit.*4s/);
  });
  it("maps 403 missing_scope and unknown card", async () => {
    const t = await setup(() => ({ status: 403, body: { error: "missing_scope", message: "requires card:write" } }));
    expect((await t.call("create_card", { deck_id: "d", content: "x" })).text).toMatch(/Permission denied.*card:write/s);
    const t2 = await setup(() => ({ body: { _root: [{ account: "a" }], account: { a: {} } } }));
    expect((await t2.call("get_card", { card_id: "nope" })).text).toMatch(/not found/);
  });
});

describe("reads", () => {
  it("search_cards builds filters and resolves cards", async () => {
    const t = await setup(() => ({ body: cardsResponse }));
    const r = await t.call("search_cards", { deck_id: "d1", status: "started", assignee_id: "u1", tag: "bug", text: "fix", limit: 5 });
    expect(r.json).toEqual([{ id: "c1", title: "Fix bug", status: "started" }]);
    const key = Object.keys(t.calls[0].body.query._root[0].account[0])[0];
    expect(key.startsWith("cards(")).toBe(true);
    const f = JSON.parse(key.slice(6, -1));
    expect(f).toMatchObject({
      deckId: "d1", status: "started", assigneeId: "u1", visibility: "default",
      masterTags: { op: "has", value: "bug" }, content: { op: "contains", value: "fix" },
      $order: "-lastUpdatedAt", $limit: 5,
    });
  });
  it("get_card returns comments with authors", async () => {
    const t = await setup(() => ({
      body: {
        _root: [{ account: "a" }],
        account: { a: { 'cards({"cardId":"c1"})': ["c1"] } },
        card: { c1: { title: "T", content: "T\nbody", resolvables: ["r1"] } },
        resolvable: { r1: { context: "comment", entries: ["e1"], creator: "u1" } },
        resolvableEntry: { e1: { content: "hi", author: "u1" } },
        user: { u1: { name: "ann" } },
      },
    }));
    const r = await t.call("get_card", { card_id: "c1" });
    expect(r.json.resolvables[0].entries[0]).toMatchObject({ content: "hi", author: { name: "ann" } });
  });
  it("list_users derives users from cards", async () => {
    const t = await setup(() => ({
      body: {
        _root: [{ account: "a" }],
        account: { a: { "cards({})": ["c1", "c2"] } },
        card: { c1: { assignee: "u1", creator: "u2" }, c2: { assignee: "u1", creator: "u1" } },
        user: { u1: { name: "ann" }, u2: { name: "bob" } },
      },
    }));
    expect((await t.call("list_users")).json.map((u: any) => u.name).sort()).toEqual(["ann", "bob"]);
  });
});

describe("writes", () => {
  it("create_card dispatches cards/create", async () => {
    const t = await setup(() => ({ body: { id: "n1", accountSeq: 7 } }));
    const r = await t.call("create_card", { deck_id: "d1", content: "Hello\nbody", priority: "a", tags: ["bug"] });
    expect(r.json).toEqual({ id: "n1", accountSeq: 7 });
    expect(t.calls[0].url).toBe("https://api.test/dispatch/cards/create");
    expect(t.calls[0].body).toMatchObject({ deckId: "d1", content: "Hello\nbody", priority: "a", masterTags: ["bug"] });
  });
  it("update_card with only title keeps body", async () => {
    const t = await setup((c) =>
      c.url.endsWith("/dispatch/cards/update")
        ? { body: {} }
        : { body: { _root: [{ account: "a" }], account: { a: { 'cards({"cardId":"c1"})': ["c1"] } }, card: { c1: { content: "Old\nthe body" } } } },
    );
    await t.call("update_card", { card_id: "c1", title: "New", status: "done", add_tags: ["x"] });
    const upd = t.calls.find((c) => c.url.endsWith("/cards/update"))!;
    expect(upd.body).toEqual({ id: "c1", status: "done", content: "New\nthe body" });
    expect(t.calls.find((c) => c.url.endsWith("/cards/bulkUpdate"))!.body).toEqual({ ids: ["c1"], addMasterTag: "x" });
  });
  it("add_comment and archive_card", async () => {
    const t = await setup(() => ({ body: { id: "r1" } }));
    await t.call("add_comment", { card_id: "c1", content: "yo" });
    await t.call("archive_card", { card_id: "c1" });
    expect(t.calls[0].body).toEqual({ cardId: "c1", context: "comment", content: "yo" });
    expect(t.calls[1].body).toEqual({ id: "c1", visibility: "archived" });
  });
});

describe("account normalisation", () => {
  it("accepts url or subdomain", async () => {
    const { normalizeAccount } = await import("../src/client.js");
    for (const v of ["acme", "acme.codecks.io", "https://acme.codecks.io", "https://acme.codecks.io/", " HTTPS://acme.codecks.io/x?y "])
      expect(normalizeAccount(v).toLowerCase()).toBe("acme");
  });
});
