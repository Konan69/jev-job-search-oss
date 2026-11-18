import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BROWSER, childEnv } from "../config.js";
import { safeUrl } from "../util/redact.js";

export type Target = { id: string; type: string; url: string; title: string };
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const run = promisify(execFile);
const options = () => ({ encoding: "utf8" as const, maxBuffer: BROWSER.bridgeBytes, timeout: BROWSER.bridgeMs });
const windowsPath = (file: string) => file.replace(/^\/mnt\/([a-z])\//, (_, drive: string) => `${drive.toUpperCase()}:\\`).replaceAll("/", "\\");
const Envelope = z.object({ ok: z.boolean(), isError: z.boolean(), value: z.unknown() });
const Events = z.array(z.object({ method: z.string(), params: z.record(z.unknown()) }));
const Reply = z.object({ result: z.unknown(), events: Events });
const trackedEvents = ["Page.frameNavigated", "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"];
const Status = z.object({
  currentSession: z.string().nullable().optional(),
  extension: z.object({ browsers: z.array(z.object({ id: z.string(), default: z.boolean(), connected: z.boolean() })) }),
  sessions: z.array(z.object({ id: z.string(), browser: z.string().optional() })),
  targets: z.array(z.object({ id: z.string(), type: z.string(), url: z.string(), title: z.string(), opencodeBrowserSessionId: z.string().optional(), owner: z.string() })),
});

export function browserStatus() {
  try {
    return Status.parse(JSON.parse(execFileSync(BROWSER.command, ["status", "--json"], { ...options(), env: childEnv(), stdio: ["ignore", "pipe", "pipe"] })));
  } catch {
    throw new Error("browse status failed; run browse doctor to check CLI, relay and extension readiness");
  }
}

export async function listTargets(): Promise<Target[] | null> {
  const status = browserStatus();
  return status.targets.filter((t) => t.type === "page" && t.owner === "relay" && t.opencodeBrowserSessionId === BROWSER.session)
    .map(({ id, type, url, title }) => ({ id, type, url, title }));
}

export async function ensureBrowser(): Promise<void> {
  const status = browserStatus();
  if (!status.extension.browsers.some((b) => b.id === BROWSER.browser && b.connected)) throw new Error("Connect your configured browser to Browse first");
  const session = status.sessions.find((s) => s.id === BROWSER.session);
  if (session) {
    if (session.browser !== BROWSER.browser) throw new Error("The job-search browse session belongs to another browser");
    return;
  }
  if (!status.extension.browsers.some((b) => b.id === BROWSER.browser && b.default)) throw new Error("Make your configured browser the default browse browser before creating the job-search session");
  await run(BROWSER.command, ["session", "new", BROWSER.session], { ...options(), env: childEnv() });
  if (status.currentSession) await run(BROWSER.command, ["session", "use", status.currentSession], { ...options(), env: childEnv() });
}

// CDP events stay in the relay between CLI calls. Drain them even for synchronous takeWrites().
const BRIDGE = `
const request = JSON.parse(await files.read(REQUEST_FILE, "utf8"));
state.jevPages ??= new Map();
let entry = state.jevPages.get(request.targetId);
async function remember(p) {
  const cdp = await context.newCDPSession(p);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const e = { page: p, cdp, events: [] };
  for (const method of ${JSON.stringify(trackedEvents)})
    cdp.on(method, p => {
      const cleanUrl = value => { try { const u = new URL(value); u.search = ""; u.hash = ""; u.username = ""; u.password = ""; return u.href; } catch { return ""; } };
      let params = { requestId: p.requestId };
      if (method === "Page.frameNavigated") params = { frame: { id: p.frame.id, parentId: p.frame.parentId, url: cleanUrl(p.frame.url) } };
      else if (method === "Network.requestWillBeSent") params = { requestId: p.requestId, documentURL: cleanUrl(p.documentURL), request: { url: cleanUrl(p.request.url), method: p.request.method } };
      else if (method === "Network.responseReceived") params = { requestId: p.requestId, response: { status: p.response.status } };
      e.events.push({ method, params });
    });
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  state.jevPages.set(targetInfo.targetId, e);
  return { e, targetInfo };
}
let result = null;
if (request.op === "new") {
  const p = state.jevPages.size ? await context.newPage() : page;
  const saved = await remember(p);
  entry = saved.e;
  await entry.page.goto(request.url);
  result = { id: saved.targetInfo.targetId, type: "page", url: request.url, title: await p.title() };
} else {
  if (!entry) {
    for (const p of context.pages()) {
      const saved = await remember(p);
      if (saved.targetInfo.targetId === request.targetId) { entry = saved.e; break; }
    }
  }
  if (!entry || entry.page.isClosed()) throw new Error("The job-search tab is no longer available");
  if (request.op === "send") result = await entry.cdp.send(request.method, request.params);
  else if (request.op === "files") {
    const input = entry.page.locator(request.selector);
    result = await input.count() > 0;
    if (result) await input.setInputFiles(request.files.map(f => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes, "base64") })));
  } else if (request.op === "close") {
    await entry.cdp.detach();
    await entry.page.close();
    state.jevPages.delete(request.targetId);
  } else if (request.op !== "events") throw new Error("Unsupported browse bridge operation");
}
return { result, events: entry.events.splice(0) };
`;

type BrowserRequest =
  | { op: "new"; url: string }
  | { op: "send"; targetId: string; method: string; params: Record<string, unknown> }
  | { op: "files"; targetId: string; selector: string; files: { name: string; mimeType: string; bytes: string }[] }
  | { op: "events" | "close"; targetId: string };

function requestFiles(request: BrowserRequest) {
  const dir = mkdtempSync(path.join(BROWSER.tempDir, "jev-browse-"));
  const data = path.join(dir, "request.json");
  const script = path.join(dir, "execute.js");
  writeFileSync(data, JSON.stringify(request), { mode: 0o600 });
  writeFileSync(script, `const REQUEST_FILE = ${JSON.stringify(windowsPath(data))};\n${BRIDGE}`, { mode: 0o600 });
  return { dir, args: ["execute", "--session", BROWSER.session, "--json", "--file", windowsPath(script)] };
}
function reply(stdout: string) {
  const envelope = Envelope.parse(JSON.parse(stdout));
  if (!envelope.ok || envelope.isError) throw new Error("browse could not complete the browser operation; stopped without assuming success");
  return Reply.parse(envelope.value);
}
async function execute(request: BrowserRequest) {
  const { dir, args } = requestFiles(request);
  try { return reply((await run(BROWSER.command, args, { ...options(), env: childEnv() })).stdout); }
  catch { throw new Error("browse operation failed; no browser result was confirmed"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function executeSync(request: BrowserRequest) {
  const { dir, args } = requestFiles(request);
  try { return reply(execFileSync(BROWSER.command, args, { ...options(), env: childEnv(), stdio: ["ignore", "pipe", "pipe"] })); }
  catch { throw new Error("browse event read failed; form saves could not be confirmed"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function newTab(url: string): Promise<Target> {
  await ensureBrowser();
  return z.object({ id: z.string(), type: z.string(), url: z.string(), title: z.string() }).parse((await execute({ op: "new", url })).result);
}
export async function closeTab(id: string): Promise<void> {
  if (!(await listTargets())?.some((t) => t.id === id)) throw new Error("Refusing to close a tab outside the job-search browse session");
  await execute({ op: "close", targetId: id });
}
export async function clearBrowsingData(): Promise<void> {
  throw new Error("browse uses your existing browser; clearing shared cookies, cache or storage is refused");
}

type Sent = { url: string; status: number | null; failed: boolean };

const site = (url: string): string => {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
};
/** File stores that forms upload a resume to directly. */
const UPLOAD_HOSTS = /(^|\.)(amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net)$/;

/** Analytics and error reporting, which a site may serve from its own domain. */
const TRACKING = /snowplow|analytics|telemetry|\/collect\b|\/beacon\b|\/rum\b|rollbar|sentry|datadog|segment|amplitude/i;

/**
 * True for a write that belongs to the form: one sent to the page's own site, or a file upload to a
 * known store. Analytics, error reporting and widgets from other sites are not the form saving anything.
 */
export function isFormWrite(requestUrl: string, documentUrl: string): boolean {
  let host = "";
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  if (UPLOAD_HOSTS.test(host)) return true;
  if (TRACKING.test(requestUrl)) return false;
  return site(requestUrl) !== "" && site(requestUrl) === site(documentUrl);
}

export class Page {
  /** Writes the page itself makes (POST, PUT, PATCH): some forms save every field to their server as it changes. */
  private writes = new Map<string, Sent>();
  private inflight = new Set<string>();
  /** The address of the page itself, kept current so a widget's own frame is not mistaken for the form. */
  private mainUrl = "";
  private closed = false;
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  /** The source of the in-page helpers, kept so they can be put back when the page loads again under a fill. */
  private helpers = "";
  /** Set when the tab's own page has loaded again since the helpers were put in. */
  private stale = false;
  private constructor(readonly targetId: string) {}

  static async attach(target: Target): Promise<Page> {
    if (!(await listTargets())?.some((t) => t.id === target.id)) throw new Error("The tab is outside the job-search browse session");
    const page = new Page(target.id);
    await page.send("Runtime.enable");
    await page.send("DOM.enable");
    page.mainUrl = (await page.mainFrame()).url;
    return page;
  }

  private receive(events: z.infer<typeof Events>): void {
    for (const event of events) {
      this.onNetwork(event.method, event.params);
      for (const handler of this.listeners.get(event.method) ?? []) handler(event.params);
    }
  }

  private onNetwork(method: string, params: Record<string, unknown>): void {
    if (method === "Page.frameNavigated") {
      const frame = params.frame as { parentId?: string; url: string };
      if (!frame.parentId) {
        this.mainUrl = frame.url;
        // A page that loads again starts with nothing of ours in it.
        this.stale = true;
        // A new page: what the last one was still sending will never be answered, and is not this form's business.
        this.inflight.clear();
        this.writes.clear();
      }
      return;
    }
    const id = params.requestId as string | undefined;
    if (!id) return;
    if (method === "Network.requestWillBeSent") {
      const req = params.request as { url: string; method: string };
      if (!/^(POST|PUT|PATCH)$/.test(req.method) || !isFormWrite(req.url, this.mainUrl || String(params.documentURL ?? ""))) return;
      // Kept without its query string: that is where a site puts a token, and this text reaches reports and site notes.
      this.writes.set(id, { url: safeUrl(req.url), status: null, failed: false });
      this.inflight.add(id);
    } else if (method === "Network.responseReceived" && this.writes.has(id)) {
      // An answer is what matters. Waiting for the body to finish would hang on a stream that never closes.
      const w = this.writes.get(id) as Sent;
      w.status = (params.response as { status: number }).status;
      w.failed = w.status >= 400;
      this.inflight.delete(id);
    } else if (method === "Network.loadingFinished") {
      this.inflight.delete(id);
    } else if (method === "Network.loadingFailed" && this.writes.has(id)) {
      // Only a request that never got an answer failed.
      const w = this.writes.get(id) as Sent;
      if (w.status === null) w.failed = true;
      this.inflight.delete(id);
    }
  }

  /** Hears one kind of browser event until the returned function is called. */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    if (!trackedEvents.includes(method)) throw new Error(`browse bridge does not support the ${method} event`);
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => void set.delete(handler);
  }

  /** The tab's own frame, as the browser knows it: its id and its address. A page cannot change what this says. */
  async mainFrame(): Promise<{ id: string; url: string }> {
    const t = await this.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree");
    return t.frameTree.frame;
  }

  /** Resolves once the page has no write of its own in flight, or after the limit. True when it went quiet. */
  async writesSettled(limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    do {
      this.receive((await execute({ op: "events", targetId: this.targetId })).events);
      if (!this.inflight.size) return true;
      if (Date.now() < deadline) await sleep(40);
    } while (Date.now() < deadline);
    return this.inflight.size === 0;
  }

  /** How many of the page's own writes were made and how many failed since the last call. */
  takeWrites(): { made: number; failed: string[] } {
    this.receive(executeSync({ op: "events", targetId: this.targetId }).events);
    if (process.env.AWJ_TRACE) for (const [id, w] of this.writes) console.error(`[net] ${w.status ?? (this.inflight.has(id) ? "in flight" : "?")} ${w.url.slice(0, 110)}`);
    const all = [...this.writes.values()];
    // Writes still on their way stay tracked, so a later wait or count still sees them.
    for (const id of [...this.writes.keys()]) if (!this.inflight.has(id)) this.writes.delete(id);
    return { made: all.length, failed: all.filter((w) => w.failed).map((w) => `${w.status ?? "no answer"} ${w.url.slice(0, 80)}`) };
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("the tab was closed");
    if (/^(Fetch\.|Storage\.clear|Network\.clear|Page\.bringToFront|Emulation\.setFocus)/.test(method)) throw new Error(`browse bridge refuses ${method}`);
    const response = await execute({ op: "send", targetId: this.targetId, method, params });
    this.receive(response.events);
    return response.result as T;
  }

  /** Puts the in-page helpers on the page, and remembers them for the next time the page loads again. */
  async useHelpers(source: string): Promise<void> {
    this.helpers = source;
    this.stale = false;
    await this.rawEvaluate(source);
  }

  /**
   * Puts the helpers back when they are gone. Some sites load their page a second time after it
   * looked ready (Workday does, once it knows who is signed in). Without this, the next read of
   * the page would fail on a helper that is no longer there, in the middle of a fill.
   */
  private async restore(): Promise<void> {
    if (!this.helpers) return;
    this.stale = false;
    try {
      if (await this.rawEvaluate<boolean>("typeof window.__awj === 'object' && window.__awj !== null")) return;
      await this.rawEvaluate(this.helpers);
      if (process.env.AWJ_TRACE) console.error(`[page] loaded again, helpers put back: ${safeUrl(this.mainUrl)}`);
    } catch {
      // Still loading: the next call tries again.
      this.stale = true;
    }
  }

  /** Runs a read of the page, putting the helpers back first when the page has loaded again, or once more when it fails for want of them. */
  private async withHelpers<T>(run: () => Promise<T>): Promise<T> {
    if (this.stale) await this.restore();
    try {
      return await run();
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      if (!this.helpers || !/__awj|Cannot read properties of undefined/.test(said)) throw err;
      await this.restore();
      return run();
    }
  }

  /** Evaluates a fixed expression in the page and returns its JSON value. For anything with a value in it, use call. */
  evaluate<T>(expression: string): Promise<T> {
    return this.withHelpers(() => this.rawEvaluate<T>(expression));
  }

  private async rawEvaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /**
   * Calls a function in the page with JSON arguments. Values travel as arguments, never spliced
   * into source text, so nothing read from a page or a file can become code.
   */
  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.withHelpers(() => this.rawCall<T>(fn, ...args));
  }

  private async rawCall<T>(fn: string, ...args: unknown[]): Promise<T> {
    const root = await this.send<{ result: { objectId: string } }>("Runtime.evaluate", { expression: "globalThis" });
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.callFunctionOn", {
      functionDeclaration: fn,
      objectId: root.result.objectId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** Calls one of the helpers that pageHelpers.js installs on the page. */
  awj<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.call<T>("function (method, ...args) { return window.__awj[method](...args); }", method, ...args);
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  async click(x: number, y: number): Promise<void> {
    const at = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  }

  /** Moves the pointer without pressing. A list that follows the pointer has to be given the time to do so before the click. */
  async hover(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async key(key: "Escape" | "Enter" | "Backspace" | "Tab"): Promise<void> {
    const code = { Escape: 27, Enter: 13, Backspace: 8, Tab: 9 }[key];
    const ev = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  }

  /** Puts local files on a file input, the way a user's file picker would. */
  async setFiles(selector: string, files: string[]): Promise<boolean> {
    const response = await execute({ op: "files", targetId: this.targetId, selector,
      files: files.map((file) => ({ name: path.basename(file), mimeType: /\.pdf$/i.test(file) ? "application/pdf" : "application/octet-stream", bytes: readFileSync(file).toString("base64") })) });
    this.receive(response.events);
    return z.boolean().parse(response.result);
  }

  close(): void {
    this.closed = true;
  }
}
