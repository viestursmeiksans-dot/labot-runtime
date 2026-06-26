// One edit job, end to end: ensure a fresh checkout of the site repo → run the agent session →
// deterministic QA gate (something changed + build passes + only src/ touched) → commit + push.
// The GitHub Action on the repo handles the actual Pages deploy. No model self-grading.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runAgentSession } from "./agent.mjs";

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

export async function runJob({ siteId, instruction, model, commit = false, log = console.log }) {
  const site = loadSites()[siteId];
  if (!site) throw new Error(`unknown site '${siteId}' (add it to sites.json)`);

  const dir = ensureCheckout(site);
  log(`[job] site=${siteId} dir=${dir} branch=${site.branch}`);

  // 1) The agent edits the source.
  const agent = await runAgentSession({
    cwd: dir,
    instruction,
    model: model || site.model || "claude-sonnet-4-6",
    onMessage: (m) => {
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type === "text" && b.text.trim()) log(`[agent] ${b.text.trim().slice(0, 200)}`);
          if (b.type === "tool_use") log(`[tool]  ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
        }
      }
    },
  });
  log(`[agent] done ok=${agent.ok} cost=$${(agent.costUsd || 0).toFixed(3)} turns=${agent.numTurns ?? "?"}`);
  // Per-job cost telemetry (parseable) — model + token usage for the cost report.
  const _u = (agent.raw && agent.raw.usage) || {};
  const _mu = (agent.raw && agent.raw.modelUsage) || {};
  const _models = Object.keys(_mu).join(",") || (agent.raw && agent.raw.model) || "claude-sonnet-4-6";
  log(`[usage] job_site=${siteId} model=${_models} in=${_u.input_tokens || 0} out=${_u.output_tokens || 0} cache_read=${_u.cache_read_input_tokens || 0} cache_write=${_u.cache_creation_input_tokens || 0} turns=${agent.numTurns ?? 0} cost=$${(agent.costUsd || 0).toFixed(4)}`);
  if (!agent.ok) return { siteId, ok: false, status: "agent_error", report: agent.text || agent.error };

  // 2) Did anything actually change?
  const status = git(["status", "--porcelain"], dir);
  if (!status) return { siteId, ok: false, status: "no_change", report: agent.text };
  // porcelain v1 lines are "XY <path>"; slice past the 2 status chars + trim the separator.
  const files = status.split("\n").filter(Boolean).map((l) => l.slice(2).trim());
  log(`[diff] ${files.length} file(s): ${files.join(", ")}`);

  // 3) Guard: never accept edits to the generated output dir.
  const generated = files.filter((f) => f.startsWith("_site/"));
  if (generated.length) {
    git(["checkout", "--", "."], dir);
    return { siteId, ok: false, status: "touched_generated", report: agent.text, files: generated };
  }

  // 4) QA gate: the build MUST pass.
  log(`[qa] building…`);
  const build = run(site.build || "npm ci && npx @11ty/eleventy", dir);
  if (!build.ok) {
    git(["checkout", "--", "."], dir); // revert the broken edit; never commit a non-building site
    return { siteId, ok: false, status: "build_failed", report: agent.text, buildOut: build.out.slice(-1200) };
  }
  log(`[qa] build OK`);

  // 5) Commit + push (the repo's GitHub Action deploys _site/ to Cloudflare Pages).
  let committedSha = null;
  if (commit) {
    git(["add", "-A"], dir);
    git(["commit", "-m", `labot: ${instruction.replace(/\s+/g, " ").slice(0, 60)}`], dir);
    git(["push", "origin", site.branch], dir);
    committedSha = git(["rev-parse", "HEAD"], dir);
    log(`[push] ${committedSha} → origin/${site.branch} (Action will deploy)`);
  } else {
    log(`[dry-run] build passed; NOT committing (pass commit:true / --commit to push)`);
  }

  return {
    siteId, ok: true, status: commit ? "committed" : "dry_run",
    files, committedSha, costUsd: agent.costUsd, report: agent.text,
  };
}
