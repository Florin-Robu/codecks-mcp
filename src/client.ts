import { EnvHttpProxyAgent } from "undici";

// Codecks HTTP client. Source of truth: https://manual.codecks.io/api/ (auth, query, dispatch,
// rate limits) and https://manual.codecks.io/api-reference (models, actions, enums).

export const API_URL = "https://api.codecks.io";

export class CodecksError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CodecksError";
  }
}

/** Accept "acme", "acme.codecks.io" or "https://acme.codecks.io/" and return "acme". */
export function normalizeAccount(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.codecks\.io$/i, "");
}

const proxied = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
);

/** Node's built-in fetch ignores proxy env vars; honour them when set. */
const defaultFetch: FetchLike = (url, init) =>
  proxied
    ? fetch(url, { ...init, dispatcher: new EnvHttpProxyAgent() } as RequestInit)
    : fetch(url, init);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  token: string;
  account: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

// Error codes from https://manual.codecks.io/api/ ("Token Rejection Reasons").
const AUTH_HINTS: Record<string, string> = {
  invalid_token: "CODECKS_TOKEN is invalid or revoked. Create a new API token in Codecks.",
  token_expired: "CODECKS_TOKEN has expired. Create a new API token in Codecks.",
  not_a_member: "The owner of this personal token has been disabled.",
  user_api_tokens_disabled: "An org admin disabled personal API tokens. Use an organization token.",
  token_account_mismatch: "CODECKS_ACCOUNT does not match the account this token belongs to.",
};

export class CodecksClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.baseUrl = opts.baseUrl ?? API_URL;
    // Documented: `Authorization: Bearer cdxat_...|cdxut_...`. The legacy `X-Auth-Token`
    // (browser session token) works until 2026-12-31, so keep it for non-prefixed tokens.
    const bearer = /^cdx[a-z]t_/.test(opts.token);
    this.headers = {
      "Content-Type": "application/json",
      "X-Account": normalizeAccount(opts.account),
      ...(bearer ? { Authorization: `Bearer ${opts.token}` } : { "X-Auth-Token": opts.token }),
    };
  }

  /** Read: POST / with {query: {_root: [...]}}. */
  async query(root: unknown[]): Promise<any> {
    return this.post("/", { query: { _root: root } });
  }

  /** Write: POST /dispatch/<namespace>/<action>. */
  async dispatch(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.post(`/dispatch/${path}`, body);
    // Live responses wrap results as {payload, actionId}.
    return res && typeof res === "object" && "payload" in res ? res.payload : res;
  }

  private async post(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new CodecksError(`Network error talking to Codecks: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 200) };
    }
    if (res.ok) return data;
    throw toError(res, data);
  }
}

function toError(res: Response, data: any): CodecksError {
  const code: string | undefined = data?.error;
  const detail = data?.message ? ` ${data.message}` : "";
  if (res.status === 429) {
    const wait = res.headers.get("retry-after");
    return new CodecksError(
      `Codecks rate limit hit (40 requests per 5s).${wait ? ` Retry after ${wait}s.` : ""}`,
      429,
      code ?? "rate_limit",
    );
  }
  if (code && AUTH_HINTS[code]) return new CodecksError(AUTH_HINTS[code], res.status, code);
  if (res.status === 401) return new CodecksError(`Codecks rejected the token (401).${detail}`, 401, code);
  if (res.status === 403) {
    return new CodecksError(
      `Permission denied (403${code ? ` ${code}` : ""}).${detail} The token lacks a required scope or project access.`,
      403,
      code,
    );
  }
  if (res.status === 404) return new CodecksError(`Not found (404).${detail}`, 404, code);
  return new CodecksError(`Codecks API error ${res.status}${code ? ` ${code}` : ""}.${detail}`, res.status, code);
}
