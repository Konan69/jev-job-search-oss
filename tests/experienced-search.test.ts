import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../src/jobs/normalize.js";
import type { Answer } from "../src/jev/types.js";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://job-boards.greenhouse.io/acme/jobs/1", ats: "greenhouse",
  locations: ["Remote"], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null, ...over,
});

const boardTitles = ["Staff Software Engineer, AI Tooling", "Software Engineer Intern", "New Grad Software Engineer", "Software Engineer I"];

vi.mock("../src/sources/simplify.js", () => ({ fetchSimplify: async () => [job({ id: "list-1", title: "Software Engineer, Summer 2027" })] }));
vi.mock("../src/sources/githubReadme.js", () => ({ fetchReadmeSources: async () => [] }));
vi.mock("../src/sources/ats/lever.js", () => ({ fetchLeverBoard: async () => [], leverSlug: () => null }));
vi.mock("../src/sources/ats/ashby.js", () => ({ fetchAshbyBoard: async () => [], ashbySlug: () => null }));
vi.mock("../src/sources/ats/greenhouse.js", () => ({
  greenhouseSlug: (url: string) => /greenhouse\.io\/([^/]+)/.exec(url)?.[1] ?? null,
  fetchGreenhouseBoard: async (slug: string) => (slug === "acme" ? boardTitles.map((title, i) => job({ id: `acme-${i}`, title, url: `https://job-boards.greenhouse.io/acme/jobs/${i}` })) : []),
}));

const { collectJobs } = await import("../src/discover.js");
const { fitQuestions, scoreFromAnswers } = await import("../src/jobs/rate.js");
const { loadProfile } = await import("../src/profile/schema.js");
const { valueFor } = await import("../src/profile/fieldKeys.js");

const now = new Date("2026-10-02T12:00:00Z");

function answers(over: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    is_software_role: { type: "noul", noul: 0.98 },
    level: { type: "choice", choice: "experienced", probabilities: { experienced: 1 }, confidence: 0.95 },
    is_unpaid: { type: "noul", noul: 0.02 },
    needs_advanced_degree: { type: "noul", noul: 0.02 },
    work_auth: { type: "choice", choice: "remote_global", probabilities: {}, confidence: 1 },
    stack_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    experience_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    location_tier: { type: "choice", choice: "remote", probabilities: {}, confidence: 1 },
    interview_practical: { type: "noul", noul: 0.3 },
    callback_likelihood: { type: "score", score: 3, legend: { "3": "Likely" }, probabilities: {}, confidence: 0.7 },
    needs_account: { type: "noul", noul: 0.1 },
    requires_references: { type: "noul", noul: 0.05 },
    ...over,
  };
}

const experienced = { level: "experienced" as const, inCanada: false };

describe("an experienced search", () => {
  it("keeps board postings that are not early-career, and uses the lists only to find boards", async () => {
    const titles = (await collectJobs({ level: "experienced" })).map((j) => j.title);
    expect(titles).toEqual(["Staff Software Engineer, AI Tooling"]);
  });

  it("leaves the early-career search as it was", async () => {
    const titles = (await collectJobs({})).map((j) => j.title).sort();
    expect(titles).toEqual(["New Grad Software Engineer", "Software Engineer I", "Software Engineer Intern", "Software Engineer, Summer 2027"]);
  });

  it("asks nothing about terms or graduation", () => {
    const q = fitQuestions({ education: [{ school: "U", degree: "BEng", field: "ME", startYear: 2019, gradYear: 2024, status: "completed" }] }, "experienced");
    expect(q).not.toHaveProperty("term");
    expect(q).not.toHaveProperty("graduation_excluded");
    expect(q).not.toHaveProperty("returning_student_required");
  });

  it("rates an experienced role without a term or graduation answer, and skips an internship", () => {
    const fit = scoreFromAnswers(job({ title: "Staff Engineer" }), answers(), now, undefined, experienced);
    expect(fit.skipReason).toBeNull();
    expect(fit.components.levelFit).toBe(1);
    expect(fit.components.termFit).toBe(1);
    const intern = scoreFromAnswers(job(), answers({ level: { type: "choice", choice: "internship", probabilities: {}, confidence: 0.9 } }), now, undefined, experienced);
    expect(intern.skipReason).toMatch(/internship/);
  });

  it("gives a candidate outside Canada no Canadian advantage, and ranks remote first", () => {
    const at = (locations: string[]) => scoreFromAnswers(job({ locations }), answers(), now, undefined, experienced).score;
    expect(at(["Vancouver, BC"])).toBe(at(["London, UK"]));
    expect(at(["Remote"])).toBeGreaterThan(at(["Toronto, ON"]));
  });
});

describe("a profile that gives education years only", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-profile-"));
  const file = path.join(dir, "profile.json");
  const example = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "data", "profile.example.json"), "utf8"));
  const { startMonth: _s, gradMonth: _g, ...edu } = example.education[0];
  writeFileSync(file, JSON.stringify({ ...example, education: [edu] }));
  const profile = loadProfile(file);

  it("loads, and answers the year without inventing a month", () => {
    expect(profile.education[0]?.gradMonth).toBeUndefined();
    expect(valueFor(profile, "graduation_month")).toBeNull();
    expect(valueFor(profile, "education_start_month")).toBeNull();
    expect(valueFor(profile, "graduation_date")).toBe(String(edu.gradYear));
  });

  it("words the early-career graduation question by year alone", () => {
    const q = JSON.stringify(fitQuestions(profile));
    expect(q).toContain(`graduating in ${edu.gradYear} does not meet`);
  });
});
