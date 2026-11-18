import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { browserStatus, clearBrowsingData, closeTab, newTab, Page } from "../src/browser/cdp.js";
import { applyFills, uploadFile } from "../src/browser/fill.js";
import { emptyRequired, isReady } from "../src/browser/report.js";
import { controlStates, dump, inFront, install, mutateSession, shownValues, type Point } from "../src/browser/session.js";
import { verifyIntended, watchForConfirmation } from "../src/browser/submit.js";
import { JevClient } from "../src/jev/client.js";
import { BROWSER, childEnv } from "../src/config.js";
import { FillPlan } from "../src/forms/fields.js";
import { loadProfile } from "../src/profile/schema.js";

it.skipIf(process.env.RUN_BROWSE_FIXTURE !== "1")("fills, reads back and submits an owned background form through browse", async () => {
  const status = browserStatus();
  expect(status.targets.filter((t) => t.opencodeBrowserSessionId === BROWSER.session)).toEqual([]);
  const existing = status.sessions.find((s) => s.id === BROWSER.session);
  if (existing) expect(existing.browser).toBe(BROWSER.browser);
  const dir = mkdtempSync(path.join(tmpdir(), "jev-browse-fixture-"));
  const file = path.join(dir, "fixture-resume.txt");
  writeFileSync(file, "Made-up fixture resume. No personal information.");
  const target = await newTab("about:blank");
  try {
    execFileSync(BROWSER.command, ["execute", "--session", BROWSER.session, "--json", `await page.setContent(${JSON.stringify(`<form onsubmit="event.preventDefault(); document.body.innerHTML='<h1>Fixture application received</h1>'">
      <label for="name">Full name</label><input id="name" required>
      <label for="region">Location</label><select id="region" required><option value="">Choose</option><option>Remote</option></select>
      <fieldset><legend>Contact method</legend><label><input id="contact-email" type="radio" name="contact" value="Email" required>Email</label><label><input type="radio" name="contact" value="Phone">Phone</label></fieldset>
      <label for="resume">Resume</label><input id="resume" type="file" required>
      <button id="submit">Submit application</button></form>`)}); return true;`], { encoding: "utf8", env: childEnv() });
    const page = await Page.attach(target);
    await install(page);
    const before = await dump(page);
    const values = new Map([["text", "Fixture Candidate"], ["select", "Remote"], ["radio", "Email"]]);
    const plan = FillPlan.parse({
      jobId: "browse-fixture", url: "about:blank",
      fields: before.fields.map((f) => ({ ...f, action: f.kind === "file" ? "upload" : "fill", key: "fixture", value: values.get(f.kind) ?? null, optionLabel: null, confidence: 1, note: null })),
      fills: before.fields.filter((f) => f.kind !== "file").map((f) => ({ selector: f.selector, kind: f.kind, value: values.get(f.kind) })),
      uploads: [{ selector: "#resume", path: file }], drafts: [], reviews: [], submitSelectors: before.submitSelectors, jevCostUsd: 0,
    });
    const profile = loadProfile(new URL("../data/profile.example.json", import.meta.url).pathname);
    const failed = await applyFills(page, plan.fills, profile, { prefer: () => "typed", landed: () => undefined });
    expect(failed).toEqual([]);
    expect(await uploadFile(page, "#resume", file)).toBeUndefined();
    expect(await verifyIntended(page, plan, [])).toEqual([]);
    const selectors = plan.fields.map((f) => f.selector);
    const missingRequired = emptyRequired(before, plan, await shownValues(page, selectors), await controlStates(page, selectors));
    expect(isReady({ state: "filled", drafts: [], reviews: [], failed: failed.map((f) => ({ ...f, label: f.selector })), missingRequired, hasNext: false })).toBe(true);
    await page.call("function () { document.querySelector('#name').value = ''; }");
    expect(await verifyIntended(page, plan, [])).not.toEqual([]);
    await applyFills(page, plan.fills, profile);
    expect(await verifyIntended(page, plan, [])).toEqual([]);
    await expect(page.bringToFront()).rejects.toThrow(/refuses/);
    await expect(clearBrowsingData()).rejects.toThrow(/refused/);
    await expect(page.send("Fetch.enable")).rejects.toThrow(/refuses/);
    await inFront(page, async () => {
      const point = await page.awj<Point>("point", "#submit");
      expect(point.ok).toBe(true);
      await page.click(point.x, point.y);
    });
    expect(await page.evaluate("document.body.innerText")).toContain("Fixture application received");
    mutateSession((s) => { s["browse-fixture"] = { targetId: target.id, url: "about:blank" }; });
    const jev = new JevClient({ apiKey: "fixture-key-never-sent", usageLog: null, fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init.body)).state.text).toContain("Fixture application received");
      return new Response(JSON.stringify({ answers: {
        state: { type: "choice", choice: "submitted", confidence: 1, probabilities: { submitted: 1 } },
        ...Object.fromEntries(["has_apply_button", "has_more_pages", "requires_references", "requires_cover_letter"].map((key) => [key, { type: "noul", noul: 0 }])),
      } }), { status: 200 });
    } });
    expect(await watchForConfirmation(jev, "browse-fixture", { timeoutMs: 10_000 })).toBe("submitted");
    page.close();
  } finally {
    mutateSession((s) => { delete s["browse-fixture"]; });
    await closeTab(target.id);
    execFileSync(BROWSER.command, ["session", "delete", BROWSER.session], { env: childEnv() });
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
