// Drain-once runner — the GitHub Actions counterpart of poll.mjs.
//
// The VPS poller loops forever; a CI runner must not. This claims jobs from the intake Worker and
// runs them until the queue is empty, then exits 0 so the workflow finishes. It is safe to have
// several runs overlap: /agent/pull claims atomically (single UPDATE…RETURNING), so two runners
// never get the same job.
//
// Env: WORKER_URL, AGENT_SECRET, ANTHROPIC_API_KEY, GITHUB_TOKEN, LABOT_SITES_DIR
import { runJob } from "./job.mjs";

const WORKER = (process.env.WORKER_URL || "").replace(/\/$/, "");
const KEY = process.env.AGENT_SECRET || "";
const MAX_JOBS = parseInt(process.env.MAX_JOBS || "5", 10);   // a runaway queue must not run forever

if (!WORKER || !KEY) {
  console.error("ERROR: WORKER_URL and AGENT_SECRET must be set.");
  process.exit(1);
}

async function pull() {
  const r = await fetch(`${WORKER}/agent/pull?key=${encodeURIComponent(KEY)}`);
  if (!r.ok) throw new Error(`pull HTTP ${r.status}`);
  return (await r.json()).job;
}

async function complete(id, result) {
  const r = await fetch(`${WORKER}/agent/complete?key=${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      ok: result.ok === true,
      status: result.status,
      reply: result.report,
      commitSha: result.committedSha,
      costUsd: result.costUsd,
      verified: result.verified,
    }),
  });
  if (!r.ok) console.error(`[job ${id}] complete HTTP ${r.status}`);
}

let done = 0;
while (done < MAX_JOBS) {
  const job = await pull();
  if (!job) break;
  console.log(`[job ${job.id}] site=${job.site_id} :: ${String(job.instruction).slice(0, 120)}`);
  let result;
  try {
    result = await runJob({
      siteId: job.site_id, instruction: job.instruction, commit: true,
      attachments: job.attachments, workerBase: WORKER, secret: KEY,
    });
  } catch (e) {
    // A thrown job must still be reported, or the client is left waiting on silence.
    result = { ok: false, status: "error", report: `Tehniska kļūme: ${String(e).slice(0, 200)}` };
  }
  await complete(job.id, result);
  console.log(`[job ${job.id}] ${result.status} files=${(result.files || []).length} cost=$${(result.costUsd || 0).toFixed(3)}`);
  done++;
}

console.log(done ? `drained ${done} job(s)` : "queue empty — nothing to do");
