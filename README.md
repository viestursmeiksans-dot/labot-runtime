# labot-runtime

The labot.lv **VPS agent runtime** — "Claude Code on a real box." It edits a client site's Eleventy
**source** with the Claude Agent SDK, verifies the build, and pushes; the site repo's GitHub Action
deploys `_site/` to Cloudflare Pages.

This is the Step-2 MVP: a runnable **single-job CLI** (the core agent→build→QA→push loop). The queue
poller, model triage, reply transport, and systemd service are layered on next.

## What a job does (`src/job.mjs`)
1. **Checkout** — fresh `/srv/sites/<repo>` on the site's branch (`git fetch && reset --hard && clean`).
2. **Edit** — one Claude Agent SDK session (`src/agent.mjs`) with Read/Edit/Write/Bash/Grep/Glob, in
   the repo as cwd. It reads `SITE.md` (the single-source map) and edits `src/` only.
3. **QA gate (deterministic, no self-grading)** — something changed + nothing under `_site/` was
   touched + `npm ci && npx @11ty/eleventy` exits 0. A broken edit is reverted, never committed.
4. **Push** — `git commit && git push` (only with `--commit`); the repo's Action deploys.

## Setup (on the VPS, as the `labot` user)
```bash
cd /srv/labot && git clone https://github.com/viestursmeiksans-dot/labot-runtime.git
cd labot-runtime && npm ci
cp .env.example .env && chmod 600 .env   # then fill ANTHROPIC_API_KEY + GITHUB_TOKEN
```

## Run a job
```bash
set -a; . ./.env; set +a            # load env
# DRY RUN (edits + builds, does NOT push):
node src/run.mjs --site resonatekit --instruction "change the blog page heading to 'Speak boldly'"
# FOR REAL (pushes → Action deploys):
node src/run.mjs --site resonatekit --instruction "..." --commit
```

`sites.json` is the registry: `{ "<id>": { repo, branch, build, model } }`.

## Where jobs actually run

Two interchangeable runtimes drain the same D1 queue through the same `/agent/pull` endpoint:

| runtime | how it starts | when to use |
|---|---|---|
| **GitHub Actions** (`.github/workflows/run-task.yml`, `src/once.mjs`) | intake Worker dispatches it per job; `*/15` cron drains stragglers | default — nothing to keep alive, nothing to pay for |
| **VPS poller** (`src/poll.mjs`) | systemd/crontab on the box, loops forever | only if sub-minute latency matters |

`/agent/pull` claims atomically, so both may run at once without double-processing a job. The CI
path needs repo secrets `AGENT_SECRET`, `ANTHROPIC_API_KEY`, `SITES_PAT` (contents:write on every
site repo) and repo variable `WORKER_URL`; checkouts go to `$LABOT_SITES_DIR` instead of `/srv/sites`.

**Why the cron matters:** if a dispatch fails, the job sits `pending` in D1 and the client hears
nothing. The schedule is what turns a silent stall into a 15-minute delay. The VPS died unnoticed
in Aug 2026 precisely because nothing swept the queue behind it.

## Next (not in this MVP)
- Queue poller (drain a `jobs` table / Cloudflare Queue) → run jobs autonomously.
- Triage → model routing (Haiku/Sonnet/Opus) per request.
- Reply transport (Resend / Telegram) back to the client.
- systemd unit + per-site lock + concurrency pool.
