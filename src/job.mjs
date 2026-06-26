// One edit job, end to end (v3 COLLAPSE): check out ALL managed repos (target editable, others readable
// for cross-repo work) → run ONE full-toolbox Agent SDK session on the WHOLE instruction → build gate →
// push → deterministic verification gate on the live deploy → bounded self-fix if it fails → report.
// No triage, no splitting, no per-task isolation, no tool guards. The agent is the engine; the build +
// verify gate and the git push are the only correctness controls, applied ONCE to the whole change.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgentSession } from "./agent.mjs";
import { parseVerify, runVerification } from "./verify.mjs";

// Read sites.json FRESH per job so adding a site takes effect after a plain `git pull` (no restart).
const loadSites = () => JSON.parse(readFileSync(new URL("../sites.json", import.meta.url)));
const SITES_DIR = process.env.LABOT_SITES_DIR || "/srv/sites";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function run(cmd, cwd) {
  try {
    const out = execFileSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
function repoUrl(repo) {
  const t = process.env.GITHUB_TOKEN;
  return t ? `https://x-access-token:${t}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
}

// Part D2: fetch the client's image attachments (stashed in R2) onto the box, saved OUTSIDE the repo,
// and return a note telling the agent where they are.
const ATTACH_DIR = "/srv/sites/_inbox";
async function downloadAttachments(attachmentsJson, workerBase, secret, jobTag, log) {
  let list;
  try { list = JSON.parse(attachmentsJson || "[]"); } catch { return ""; }
  if (!Array.isArray(list) || !list.length || !workerBase) return "";
  mkdirSync(ATTACH_DIR, { recursive: true });
  const saved = [];
  for (const a of list.slice(0, 6)) {
    try {
      const url = `${workerBase}/agent/attachment?key=${encodeURIComponent(secret)}&k=${encodeURIComponent(a.key)}`;
      const r = await fetch(url);
      if (!r.ok) { log(`[attach] fetch ${a.filename} HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const safe = String(a.filename || "image").replace(/[^A-Za-z0-9._-]/g, "_");
      const p = `${ATTACH_DIR}/${jobTag}-${safe}`;
      writeFileSync(p, buf);
      saved.push({ path: p, filename: a.filename || safe });
      log(`[attach] saved ${a.filename} → ${p} (${buf.length} bytes)`);
    } catch (e) { log(`[attach] ${a.filename} failed: ${String(e).slice(0, 60)}`); }
  }
  if (!saved.length) return "";
  const lines = saved.map((s) => `  - ${s.path}  (original filename: ${s.filename})`).join("\n");
  return `\n\n[ATTACHED IMAGES — the client attached these files; they are on this server at the absolute paths below. Use them: copy the relevant one into the site's image directory (see SITE.md) with a sensible name, then set the ONE source-of-truth field that points at it. NEVER reference an image path that does not exist on disk.]\n${lines}`;
}

// Fresh, deterministic working tree at /srv/sites/<repo-name> on the site's branch.
export function ensureCheckout(site) {
  const name = site.repo.split("/")[1];
  const dir = path.join(SITES_DIR, name);
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(SITES_DIR, { recursive: true });
    git(["clone", "--branch", site.branch, repoUrl(site.repo), dir], SITES_DIR);
  } else {
    git(["remote", "set-url", "origin", repoUrl(site.repo)], dir);
    git(["fetch", "origin", site.branch], dir);
    git(["reset", "--hard", `origin/${site.branch}`], dir);
    git(["clean", "-fd"], dir);
  }
  return dir;
}

// Turn failed verification results into concrete feedback the agent can act on (no model grading).
function summarizeFailures(results) {
  return results.filter((r) => !r.ok).map((r) => {
    if (r.type === "content") return `  - the text "${String(r.contains).slice(0, 50)}" is NOT present on ${r.page} (HTTP ${r.status})`;
    if (r.type === "browser") {
      if (r.skipped) return `  - ${r.page}: browser check could not run`;
      if (r.consoleErrors) return `  - ${r.page}: ${r.consoleErrors} JavaScript console error(s) on load${r.detail?.length ? " [" + r.detail.join(", ") + "]" : ""} — a script is crashing`;
      return `  - ${r.page}: the declared interaction did not work${r.detail?.length ? " [" + r.detail.join(", ") + "]" : ""}`;
    }
    return `  - a check failed on ${r.page}`;
  }).join("\n");
}

export async function runJob({ siteId, instruction, model, commit = false, log = console.log, attachments = null, workerBase = "", secret = "" }) {
  const sites = loadSites();
  const site = sites[siteId];
  if (!site) throw new Error(`unknown site '${siteId}' (add it to sites.json)`);

  // Cross-repo: check out EVERY managed site (readable for copy/mirror work), target last + editable.
  const crossRepoLines = [];
  for (const [id, s] of Object.entries(sites)) {
    if (id === siteId) continue;
    try {
      const d = ensureCheckout(s);
      crossRepoLines.push(`  - ${id}: ${d}  (${s.url || "no url"}) — READ-ONLY reference`);
    } catch (e) { log(`[checkout] ${id} skipped: ${String(e).slice(0, 60)}`); }
  }
  const dir = ensureCheckout(site);
  log(`[job] site=${siteId} dir=${dir} branch=${site.branch} — ${crossRepoLines.length} other repo(s) checked out for cross-repo read`);

  const tag = `j${siteId}-${git(["rev-parse", "--short", "HEAD"], dir)}`;
  const attachNote = await downloadAttachments(attachments, workerBase, secret, tag, log);
  const crossRepoNote = crossRepoLines.length
    ? `\n\n[OTHER MANAGED REPOS you may READ (do not edit/push them) — for copying assets or mirroring sections:\n${crossRepoLines.join("\n")}]`
    : "";

  // v3: ONE capable model, the whole job. (A cheaper fast-path for obviously-trivial single-line emails
  // is a LATER refinement — never mandatory decomposition.) Explicit `model` arg overrides.
  const chosenModel = model || site.model_v3 || "claude-opus-4-8";
  log(`[job] model=${chosenModel} maxTurns=120 (single full-toolbox session — no triage, no split)`);

  const onMessage = (m) => {
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) log(`[agent] ${b.text.trim().slice(0, 220)}`);
        if (b.type === "tool_use") log(`[tool]  ${b.name} ${JSON.stringify(b.input).slice(0, 140)}`);
      }
    }
  };
  const usageLog = (a, attempt) => {
    const u = (a.raw && a.raw.usage) || {}, mu = (a.raw && a.raw.modelUsage) || {};
    const models = Object.keys(mu).join(",") || (a.raw && a.raw.model) || chosenModel;
    const est = a.raw && a.raw.estimated ? " EST" : "";
    log(`[usage] job_site=${siteId} model=${models} in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} turns=${a.numTurns ?? 0} cost=$${(a.costUsd || 0).toFixed(4)}${est} ok=${a.ok} attempt=${attempt}`);
  };

  const baseInstruction = instruction + attachNote + crossRepoNote;
  const UNVERIFIED_NOTE = `\n\n⏳ Piezīme: daļu no izmaiņām mūsu komanda vēl pārbauda un pabeidz — par to informēsim atsevišķi. (Pārējais jau ir publicēts.)`;
  // The single session fixes its own verification failures: a second pass (fresh session on the same
  // edited tree) gets the browser's findings and corrects them. Bounded so we never loop.
  const MAX_ATTEMPTS = commit && site.url ? 2 : 1;
  let feedback = "", totalCost = 0, lastUnverified = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) log(`[fix] attempt ${attempt}/${MAX_ATTEMPTS} — handing the verification failure back to the agent`);

    const a = await runAgentSession({ cwd: dir, instruction: baseInstruction + feedback, model: chosenModel, maxTurns: 120, onMessage });
    totalCost += a.costUsd || 0;
    usageLog(a, attempt);
    log(`[agent] done ok=${a.ok} cost=$${(a.costUsd || 0).toFixed(3)} turns=${a.numTurns ?? "?"}`);

    // Did anything change? (The agent may have hit the backstop but still left valid edits.)
    const status = git(["status", "--porcelain"], dir);
    if (!status) {
      if (attempt > 1 && lastUnverified) return lastUnverified;
      if (!a.ok) return { siteId, ok: false, status: "incomplete", costUsd: totalCost,
        report: `Pagaidām šo nepaspējām pabeigt automātiski — mūsu komanda to pārņem un izdarīs manuāli.` };
      return { siteId, ok: false, status: "no_change", costUsd: totalCost, report: a.text || "Pārbaudīju — nekas nebija jāmaina." };
    }
    const files = status.split("\n").filter(Boolean).map((l) => l.slice(2).trim());
    log(`[diff] ${files.length} file(s): ${files.slice(0, 12).join(", ")}${files.length > 12 ? " …" : ""}`);

    // Never accept edits to generated output.
    const generated = files.filter((f) => f.startsWith("_site/"));
    if (generated.length) { git(["checkout", "--", "."], dir); git(["clean", "-fd"], dir); return { siteId, ok: false, status: "touched_generated", costUsd: totalCost, report: "Iekšēja kļūme (ģenerētie faili) — komanda pārbaudīs." }; }

    // V0 — build must pass.
    log(`[qa] building…`);
    const build = run(site.build || "npm ci && npx @11ty/eleventy", dir);
    if (!build.ok) {
      git(["checkout", "--", "."], dir); git(["clean", "-fd"], dir);
      if (attempt > 1 && lastUnverified) { log(`[fix] re-attempt broke the build — keeping the prior pushed version`); return lastUnverified; }
      return { siteId, ok: false, status: "build_failed", costUsd: totalCost, buildOut: build.out.slice(-1200),
        report: `Pagaidām šo nepaspējām pabeigt automātiski (tehniska kļūme būvēšanā) — mūsu komanda to pārņem.` };
    }
    log(`[qa] build OK`);

    // Commit + push (the GitHub Action deploys).
    let committedSha = null;
    if (commit) {
      git(["add", "-A"], dir);
      git(["commit", "-m", `labot: ${instruction.replace(/\s+/g, " ").slice(0, 60)}`], dir);
      git(["push", "origin", site.branch], dir);
      committedSha = git(["rev-parse", "HEAD"], dir);
      log(`[push] ${committedSha} → origin/${site.branch} (Action will deploy)`);
    } else { log(`[dry-run] build passed; NOT committing`); }

    const clientReport = String(a.text || "").replace(/<VERIFY>[\s\S]*?<\/VERIFY>/i, "").trim();
    if (!commit || !site.url) {
      return { siteId, ok: true, status: commit ? "committed" : "dry_run", model: chosenModel, verified: null, verifyResults: [], files, committedSha, costUsd: totalCost, report: clientReport };
    }

    // V1/V2 — deterministic verification gate over the whole change, on the live deploy.
    const checks = parseVerify(a.text);
    log(`[verify] deploying… checking ${checks ? checks.length : 0} declared assertion(s) on ${site.url}`);
    const v = await runVerification(site.url, checks, { log });
    log(`[verify] ${v.verified ? "✅ VERIFIED" : "⚠️ UNVERIFIED"} (${v.results.filter((r) => r.ok).length}/${v.results.length} checks passed)`);
    if (v.verified) {
      return { siteId, ok: true, status: "committed", model: chosenModel, verified: true, verifyResults: v.results, files, committedSha, costUsd: totalCost, report: clientReport };
    }
    lastUnverified = { siteId, ok: true, status: "committed_unverified", model: chosenModel, verified: false, verifyResults: v.results, files, committedSha, costUsd: totalCost, report: clientReport + UNVERIFIED_NOTE };
    if (attempt < MAX_ATTEMPTS) {
      feedback = `\n\n[VERIFICATION FAILED — the change is LIVE but a deterministic browser/HTTP check shows it is NOT working as intended:\n${summarizeFailures(v.results)}\nInvestigate the actual deployed page + the source, find the real cause, fix it (do not just repeat the same edit), rebuild, and re-declare the <VERIFY> block.]`;
      continue;
    }
    return lastUnverified;
  }
  return lastUnverified;
}
