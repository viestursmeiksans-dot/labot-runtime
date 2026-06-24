// CLI for a single edit job — the manual test harness for the runtime before the queue poller is added.
//   node src/run.mjs --site resonatekit --instruction "change the FAQ heading to ..." [--model claude-...] [--commit]
// Without --commit it's a DRY RUN: the agent edits + the build is verified, but nothing is pushed.
import { runJob } from "./job.mjs";

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const siteId = val("site");
const instruction = val("instruction");
const model = val("model");
const commit = args.includes("--commit");

if (!siteId || !instruction) {
  console.error('usage: node src/run.mjs --site <id> --instruction "what to change" [--model <model>] [--commit]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set in the environment.");
  process.exit(1);
}

const r = await runJob({ siteId, instruction, model, commit });
console.log("\n=== RESULT ===");
console.log(JSON.stringify({
  site: r.siteId, ok: r.ok, status: r.status,
  files: r.files, committedSha: r.committedSha, costUsd: r.costUsd,
}, null, 2));
if (r.report) console.log("\n--- agent reply ---\n" + r.report.slice(0, 800));
if (r.buildOut) console.log("\n--- build output (tail) ---\n" + r.buildOut);
process.exit(r.ok ? 0 : 1);
