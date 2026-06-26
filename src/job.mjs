// One edit job, end to end: ensure a fresh checkout of the site repo → run the agent session →
// deterministic QA gate (something changed + build passes + only src/ touched) → commit + push.
// The GitHub Action on the repo handles the actual Pages deploy. No model self-grading.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgentSession } from "./agent.mjs";
import { triage } from "./triage.mjs";
import { splitTasks } from "./split.mjs";
import { parseVerify, runVerification } from "./verify.mjs";

// A1 hard edit-size ceiling for a tier: generous backstop (~3× the tier's intended maxEdit, floor
// 800) so whole-file/section re-emits are blocked but genuine surgical edits never false-deny.
const capFor = (r) => (r.maxEdit === Infinity ? Infinity : Math.max(r.maxEdit * 3, 800));

// Read sites.json FRESH per job (not cached at module load) so adding a site to the registry
// takes effect after a plain `git pull` on the box — no poller restart needed.
const loadSites = () => JSON.parse(readFileSync(new URL("../sites.json", import.meta.url)));
const SITES_DIR = process.env.LABOT_SITES_DIR || "/srv/sites";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function run(cmd, cwd) {
  // returns { ok, out } without throwing
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

// Part D2: fetch the client's image attachments (stashed in R2) onto the box via the Worker, save them
// OUTSIDE the repo, and return a note appended to the instruction telling the agent where they are.
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
  return `\n\n[ATTACHED IMAGES — the client attached these files; they are saved on this server at the absolute paths below. Use them to fulfil the request: with Bash, copy the relevant file into the site's image directory (see SITE.md, e.g. src/static/images/ or src/assets/) with a sensible filename, then set the ONE source-of-truth field that points at it (favicon link, a posts.json "thumbnail", an <img> src). NEVER reference an image path that does not exist on disk. If a file is not actually a usable image, say so honestly.]\n${lines}`;
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
  const site = loadSites()[siteId];
  if (!site) throw new Error(`unknown site '${siteId}' (add it to sites.json)`);

  const dir = ensureCheckout(site);
  log(`[job] site=${siteId} dir=${dir} branch=${site.branch}`);

  // D2: fetch any image attachments onto the box and tell the agent where they are.
  const attachNote = await downloadAttachments(attachments, workerBase, secret, `j${siteId}-${git(["rev-parse", "--short", "HEAD"], dir)}`, log);
  const effectiveInstruction = instruction + attachNote;

  // 0) Triage + complexity routing (spec A3): pick model + turn cap by task tier. Explicit `model`
  // arg overrides (manual/test runs); otherwise the tier decides (most edits → Haiku).
  const route = triage(effectiveInstruction);
  const chosenModel = model || route.model;
  log(`[triage] tier=${route.tier} tasks=${route.taskCount} model=${chosenModel} maxTurns=${route.maxTurns} editCap=${capFor(route) === Infinity ? "∞" : capFor(route)} browserVerify=${route.browserVerify}`);

  // A4: split a numbered/bulleted multi-task email into independent sub-tasks, each on its own tier.
  // attachNote (image context) is shared across all sub-tasks. Single-task emails are unchanged.
  const tasks = splitTasks(instruction);
  if (tasks.length > 1) log(`[split] ${tasks.length} sub-tasks → each triaged + verified independently`);

  const onMessage = (m) => {
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) log(`[agent] ${b.text.trim().slice(0, 200)}`);
        if (b.type === "tool_use") log(`[tool]  ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
      }
    }
  };

  // One agent pass per attempt: single task → one session (unchanged); multi → one session per
  // sub-task on its own tier, merged into the SAME result shape so build/commit/verify/retry below
  // are identical. Per-task <VERIFY> blocks are concatenated, so the gate checks every sub-task.
  const usageLog = (a, tier, mdl, attempt) => {
    const u = (a.raw && a.raw.usage) || {}, mu = (a.raw && a.raw.modelUsage) || {};
    const models = Object.keys(mu).join(",") || (a.raw && a.raw.model) || mdl;
    const est = a.raw && a.raw.estimated ? " EST" : "";
    const outcome = a.ok ? "ok" : (a.raw && a.raw.maxedOut ? "max_turns" : "fail");
    log(`[usage] job_site=${siteId} tier=${tier} model=${models} in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} turns=${a.numTurns ?? 0} cost=$${(a.costUsd || 0).toFixed(4)}${est} outcome=${outcome} attempt=${attempt}`);
  };
  // Install deps ONCE up front (git clean -fd wiped node_modules), so the per-task build check is a
  // fast Eleventy compile, not a full reinstall each time.
  const compileCmd = site.compile || "npx @11ty/eleventy";
  if (existsSync(path.join(dir, "package.json")) && !existsSync(path.join(dir, "node_modules"))) {
    log(`[qa] installing deps (npm ci)…`);
    if (!run(site.install || "npm ci", dir).ok) log(`[qa] npm ci reported issues (per-task build will catch real breakage)`);
  }
  const rollback = () => { git(["reset", "--hard", "HEAD"], dir); try { git(["clean", "-fd"], dir); } catch {} };

  // Per-task build ISOLATION: each sub-task that completes AND builds is committed as a local
  // checkpoint; a task that crashes (max_turns), edits generated files, or breaks the build is rolled
  // back to the last good checkpoint — so a poisoned partial can NEVER cascade into its sibling tasks
  // (the runasskola policy-modal self-include recursion that broke all 10 tasks taught us this).
  // Commits are local; the push happens once at the end (only when commit=true).
  async function runTasks(feedback, attempt) {
    const multi = tasks.length > 1;
    const summaries = [], allChecks = [], incomplete = [];
    let cost = 0, turns = 0, committed = 0;
    for (let i = 0; i < tasks.length; i++) {
      const tr = triage(tasks[i]);
      const mdl = model || tr.model;
      const maxTurns = tr.maxTurns + (attachNote ? 6 : 0); // image/attachment work is tool-heavy
      const label = `task ${i + 1}/${tasks.length}`;
      if (multi) log(`[split] ${label} tier=${tr.tier} model=${mdl} turns=${maxTurns} :: ${tasks[i].replace(/\s+/g, " ").slice(0, 70)}`);
      let a;
      try {
        a = await runAgentSession({ cwd: dir, instruction: tasks[i] + attachNote + feedback, model: mdl, maxTurns, editCap: capFor(tr), onMessage });
        usageLog(a, tr.tier, mdl, attempt);
        cost += a.costUsd || 0; turns += a.numTurns || 0;
      } catch (e) {
        // SDK throws on max_turns (and some transient errors). Roll back partial edits; never cascade.
        const reason = /maximum number of turns/i.test(String(e)) ? "did not finish within the turn budget" : String(e).slice(0, 100);
        log(`[${label}] INCOMPLETE (${reason}) — rolling back its partial edits`);
        rollback(); incomplete.push({ task: tasks[i], reason }); continue;
      }
      if (!a.ok) { log(`[${label}] could not complete — rolling back`); rollback(); incomplete.push({ task: tasks[i], reason: a.error || "could not complete" }); continue; }

      const st = git(["status", "--porcelain"], dir);
      const prose = String(a.text || "").replace(/<VERIFY>[\s\S]*?<\/VERIFY>/i, "").trim();
      const checks = parseVerify(a.text) || [];
      if (!st) { // ran but changed nothing (e.g. "check if X works" → nothing to fix)
        if (prose) summaries.push(multi ? `• ${prose}` : prose);
        for (const c of checks) allChecks.push(c);
        log(`[${label}] no change needed`); continue;
      }
      const files = st.split("\n").filter(Boolean).map((l) => l.slice(2).trim());
      if (files.some((f) => f.startsWith("_site/"))) { log(`[${label}] touched generated _site/ — rolling back`); rollback(); incomplete.push({ task: tasks[i], reason: "edited generated files" }); continue; }

      if (!run(compileCmd, dir).ok) { log(`[${label}] build BROKE — rolling back (protects sibling tasks)`); rollback(); incomplete.push({ task: tasks[i], reason: "the change did not build" }); continue; }

      git(["add", "-A"], dir);
      git(["commit", "-m", `labot: ${tasks[i].replace(/\s+/g, " ").slice(0, 60)}`], dir);
      committed++;
      if (prose) summaries.push(multi ? `• ${prose}` : prose);
      for (const c of checks) allChecks.push(c);
      log(`[${label}] ✓ committed + builds (${files.join(", ")})`);
    }
    return { summaries, allChecks, incomplete, cost, turns, committed };
  }
  // Honest, non-technical Latvian suffix for any tasks we could not finish (NEVER a raw stack trace).
  const incompleteSuffix = (inc) => inc && inc.length
    ? `\n\n⏳ Šīs daļas mēs vēl pabeidzam un informēsim atsevišķi:\n${inc.map((t) => `  – ${String(t.task).replace(/\s+/g, " ").slice(0, 90)}`).join("\n")}`
    : "";

  // Retry-on-verify-fail loop (spec B2): feed deterministic check failures back to the agent and retry
  // within budget. Bounded to SINGLE-task jobs — a multi-task retry would re-invoke every sub-agent.
  const UNVERIFIED_NOTE = `\n\n⏳ Piezīme: daļu no izmaiņām mūsu komanda vēl pārbauda un pabeidz — par to informēsim atsevišķi. (Pārējais jau ir publicēts.)`;
  const MAX_ATTEMPTS = (commit && site.url && tasks.length === 1) ? (route.browserVerify ? 3 : 2) : 1;
  let feedback = "", totalCost = 0, lastUnverified = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) log(`[retry] attempt ${attempt}/${MAX_ATTEMPTS} — re-running with verification feedback`);

    const r = await runTasks(feedback, attempt);
    totalCost += r.cost;
    const incNote = incompleteSuffix(r.incomplete);
    log(`[job] committed_tasks=${r.committed} incomplete=${r.incomplete.length} cost=$${totalCost.toFixed(3)} turns=${r.turns}`);

    // Nothing shippable committed. Report honestly — never a stack trace, never silent.
    if (r.committed === 0) {
      if (attempt > 1 && lastUnverified) { log(`[retry] no further fix committed — keeping prior pushed result`); return lastUnverified; }
      if (r.incomplete.length) return { siteId, ok: false, status: "incomplete", costUsd: totalCost,
        report: `Pagaidām šo nepaspējām pabeigt automātiski — mūsu komanda to pārņem un izdarīs manuāli.${incNote}` };
      return { siteId, ok: false, status: "no_change", costUsd: totalCost, report: r.summaries.join("\n") || "Pārbaudīju — nekas nebija jāmaina." };
    }

    // Push the per-task checkpoint commits once.
    let committedSha = null;
    if (commit) {
      git(["push", "origin", site.branch], dir);
      committedSha = git(["rev-parse", "HEAD"], dir);
      log(`[push] ${committedSha} → origin/${site.branch} (Action will deploy)`);
    } else { log(`[dry-run] ${r.committed} task(s) built + committed locally; NOT pushing`); }

    const clientReport = r.summaries.join("\n") + incNote;
    if (!commit || !site.url) {
      return { siteId, ok: true, status: commit ? "committed" : "dry_run", tier: route.tier, model: chosenModel, verified: null, verifyResults: [], committedSha, costUsd: totalCost, report: clientReport };
    }

    // Verification done-gate over the union of committed tasks' declared checks.
    log(`[verify] deploying… checking ${r.allChecks.length} declared assertion(s) on ${site.url}`);
    const v = await runVerification(site.url, r.allChecks, { log });
    log(`[verify] ${v.verified ? "✅ VERIFIED" : "⚠️ UNVERIFIED"} (${v.results.filter((x) => x.ok).length}/${v.results.length} checks passed)`);
    if (v.verified) {
      return { siteId, ok: true, status: "committed", tier: route.tier, model: chosenModel, verified: true, verifyResults: v.results, committedSha, costUsd: totalCost, report: clientReport };
    }
    lastUnverified = { siteId, ok: true, status: "committed_unverified", tier: route.tier, model: chosenModel, verified: false, verifyResults: v.results, committedSha, costUsd: totalCost, report: clientReport + UNVERIFIED_NOTE };
    if (attempt < MAX_ATTEMPTS) {
      feedback = `\n\n[VERIFICATION FAILED on your last attempt — the change is LIVE but a deterministic browser/HTTP check shows it is NOT working as intended:\n${summarizeFailures(v.results)}\nInvestigate the actual deployed page and the source, find the real cause, and fix it (do not just repeat the same edit). Then re-declare the <VERIFY> block.]`;
      continue;
    }
    return lastUnverified;
  }
  return lastUnverified;
}
