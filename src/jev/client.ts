/**
 * HTTP client for JEV decisions, through Cloudflare Workers AI or the OpenRouter Decisions API (`JEV.provider`).
 *
 * One call = one state + many typed questions. Answers come back under the
 * same keys. The client validates the response, retries transient failures,
 * tracks spend, and refuses to exceed a per-run spend cap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JEV, PATHS } from "../config.js";
import { DecisionResponse, type Answer, type Questions, type State, type Usage } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  model?: string;
  spendCapUsd?: number;
  /** When set, every call's usage is appended as JSON lines here. */
  usageLog?: string | null;
  siteUrl?: string;
  siteName?: string;
};

export class JevError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  /** The OpenRouter key, or null on the Cloudflare route, which signs in through wrangler on each call. */
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly spendCapUsd: number;
  private readonly usageLog: string | null;
  private readonly siteUrl: string | undefined;
  private readonly siteName: string | undefined;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  constructor(opts: JevClientOptions = {}) {
    const cloudflare = opts.apiKey === undefined && JEV.provider === "cloudflare";
    const key = cloudflare ? null : (opts.apiKey ?? process.env.OPENROUTER_API_KEY);
    if (key === undefined || key === "") throw new JevError("OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.");
    this.apiKey = key;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? (cloudflare ? JEV.cloudflare.endpoint : JEV.endpoint);
    this.model = opts.model ?? (cloudflare ? JEV.cloudflare.model : JEV.model);
    this.spendCapUsd = opts.spendCapUsd ?? JEV.runSpendCapUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.jevUsage : opts.usageLog;
    this.siteUrl = opts.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.siteName = opts.siteName ?? process.env.OPENROUTER_SITE_NAME;
  }

  /** Asks every question against one state. Throws JevError on a non-recoverable failure. */
  async decide(state: State, questions: Questions, label = "decide"): Promise<Record<string, Answer>> {
    if (Object.keys(questions).length === 0) return {};
    if (this.usage.costUsd >= this.spendCapUsd) {
      throw new JevError(`JEV spend cap of $${this.spendCapUsd} reached for this run`);
    }
    const cloudflare = this.apiKey === null;
    const body = JSON.stringify(cloudflare ? { model: this.model, input: { state, questions } } : { model: this.model, state, questions });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey ?? wranglerToken()}`,
      "Content-Type": "application/json",
    };
    if (!cloudflare && this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (!cloudflare && this.siteName) headers["X-OpenRouter-Title"] = this.siteName;
    const detail = cloudflare ? cloudflareErrors : redact;

    let lastError: JevError | undefined;
    for (let attempt = 0; attempt <= JEV.maxRetries; attempt++) {
      if (attempt > 0) await sleep(JEV.retryBaseMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JEV.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body, signal: controller.signal });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastError = new JevError(`JEV ${res.status} on ${label}`, res.status, detail(text));
          continue;
        }
        if (cloudflare && (res.status === 401 || res.status === 403)) {
          throw new JevError(`JEV ${res.status} on ${label}: the wrangler sign-in has no Workers AI access to ${JEV.cloudflare.endpoint} (${detail(text)}). Run \`npx wrangler login\` as the account that owns it.`, res.status, detail(text));
        }
        if (!res.ok) throw new JevError(`JEV ${res.status} on ${label}: ${detail(text)}`, res.status, detail(text));
        const parsed = DecisionResponse.safeParse(cloudflare ? fromCloudflare(JSON.parse(text)) : JSON.parse(text));
        if (!parsed.success) throw new JevError(`JEV returned an unexpected shape on ${label}: ${parsed.error.message}`);
        this.record(parsed.data, label);
        this.assertAllAnswered(questions, parsed.data.answers, label);
        return parsed.data.answers;
      } catch (err) {
        if (err instanceof JevError) {
          if (err.status === undefined || (err.status !== 429 && err.status < 500)) throw err;
          lastError = err;
          continue;
        }
        const name = (err as { name?: string }).name;
        lastError = new JevError(`${name === "AbortError" ? "JEV timeout" : "JEV network error"} on ${label}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new JevError(`JEV failed on ${label}`);
  }

  private record(res: DecisionResponse, label: string): void {
    const u = res.usage ?? {};
    this.usage.calls += 1;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.costUsd += u.cost ?? 0;
    if (!this.usageLog) return;
    try {
      mkdirSync(path.dirname(this.usageLog), { recursive: true });
      appendFileSync(
        this.usageLog,
        JSON.stringify({ at: new Date().toISOString(), label, id: res.id, model: res.model, ...u }) + "\n",
      );
    } catch {
      /* usage logging is best effort */
    }
  }

  private assertAllAnswered(questions: Questions, answers: Record<string, Answer>, label: string): void {
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    if (missing.length) throw new JevError(`JEV left questions unanswered on ${label}: ${missing.join(", ")}`);
    for (const [key, q] of Object.entries(questions)) {
      const a = answers[key];
      if (a && a.type !== q.type) throw new JevError(`JEV answered ${key} as ${a.type}, expected ${q.type}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The OAuth token of the first wrangler sign-in that has not expired. Never logged or passed on. */
export function wranglerToken(now = Date.now()): string {
  for (const rel of JEV.cloudflare.wranglerConfigs) {
    const file = path.join(os.homedir(), rel);
    if (!existsSync(file)) continue;
    const toml = readFileSync(file, "utf8");
    const token = toml.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
    const expires = Date.parse(toml.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] ?? "");
    if (token && !(expires <= now)) return token;
  }
  throw new JevError("JEV has no current Cloudflare sign-in: wrangler's sign-in is missing or expired. Run `npx wrangler login`.");
}

/** Workers AI wraps the decision as `result.result` and reports no cost, so the cost comes from the listed input price. */
function fromCloudflare(json: unknown): unknown {
  const outer = (json as { result?: { result?: unknown } } | null)?.result;
  const decision = (outer?.result ?? outer) as { usage?: { input_tokens?: unknown; cost?: unknown } } | undefined;
  const usage = decision?.usage;
  if (usage && usage.cost === undefined && typeof usage.input_tokens === "number") {
    return { ...decision, usage: { ...usage, cost: (usage.input_tokens * JEV.cloudflare.inputUsdPerMillion) / 1_000_000 } };
  }
  return decision;
}

/** Cloudflare's error codes and messages only, never the raw body. */
function cloudflareErrors(text: string): string {
  try {
    const errors = (JSON.parse(text) as { errors?: { code?: unknown; message?: unknown }[] }).errors ?? [];
    return errors.map((e) => `${String(e.code)} ${String(e.message)}`).join("; ").slice(0, 300) || "no error detail";
  } catch {
    return "a response that is not JSON";
  }
}

/** Strips anything that looks like a bearer token from an error body before it is surfaced. */
function redact(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-[redacted]").slice(0, 500);
}
