// The autonomy loop: poll the intake Worker for the next queued job, run it (agent → build → QA →
// push), and report the outcome back (the Worker then sends the client reply). One job at a time
// (simple per-box serialization); concurrency/per-site locks can come later. Runs under systemd.
import { runJob } from "./job.mjs";

const WORKER = (process.env.WORKER_URL || "").replace(/\/$/, "");
const KEY = process.env.AGENT_SECRET || "";
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

if (!WORKER || !KEY) {
  console.error("ERROR: WORKER_URL and AGENT_SECRET must be set in the environment (.env).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

console.log(`[poller] up — worker=${WORKER} interval=${INTERVAL}ms`);
for (;;) {
  let job;
  try {
    job = await pull();
  } catch (e) {
    console.error(`[poll] ${String(e)}`);
    await sleep(INTERVAL);
    continue;
  }
  if (!job) {
    await sleep(INTERVAL);
    continue;
  }
  console.log(`[job ${job.id}] site=${job.site_id} :: ${String(job.instruction).slice(0, 90)}`);
  try {
    const result = await runJob({
      siteId: job.site_id, instruction: job.instruction, commit: true,
      attachments: job.attachments, workerBase: WORKER, secret: KEY,
    });
    await complete(job.id, result);
    console.log(`[job ${job.id}] ${result.status} files=${(result.files || []).length} cost=$${(result.costUsd || 0).toFixed(3)}`);
  } catch (e) {
    await complete(job.id, { ok: false, status: "error", report: `Tehniska kļūme: ${String(e).slice(0, 200)}` });
    console.error(`[job ${job.id}] ERROR ${String(e)}`);
  }
}
