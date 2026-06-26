// One Claude Code (Agent SDK) session that maintains a client's Eleventy site(s).
// v3 COLLAPSE: ONE capable agent, the FULL toolbox, the WHOLE job — no triage, no splitting, no
// per-task isolation, no PreToolUse guards, no per-tier caps. The decomposition is what broke v2.
// The agent does NOT commit/push — job.mjs runs the verification gate and the git push after, so
// correctness is enforced OUTSIDE the model.
import { query } from "@anthropic-ai/claude-agent-sdk";

const LABOT_RULES = `You maintain a small business's website(s), built with Eleventy (11ty). The repository
you must EDIT and DEPLOY is your working directory (cwd). Work like a senior developer doing it for a
paying, non-technical client — do the ENTIRE request, every part of it, in one session.

READ SITE.md FIRST (repo root). It maps every editable thing to the ONE file that owns it — the single
source of truth (a nav data file, a footer include, a posts.json line). Follow it; change that one place
and let the build propagate it everywhere. Read for INTENT: the client is non-technical and may name
things loosely — deliver what they are actually trying to achieve.

YOU HAVE THE FULL TOOLBOX — use it exactly as you would in a terminal:
- Files (Read / Edit / Write), Bash (git, npm run build, image resize, curl, cp), Grep / Glob.
- WebSearch / WebFetch for external facts (e.g. finding a business's Google reviews online).
- A REAL BROWSER for pages plain HTTP can't read (Instagram posts, Google Maps reviews). Run:
    node /srv/labot/labot-runtime/tools/browse.mjs "<url>"
  it prints the rendered page text, the og:image, and the image URLs on the page. Use it to get REAL
  post images / review text, then download what you need with curl. If a page is genuinely login-walled
  and you cannot get the content, say so plainly and ask the client to send it — never invent content.
- Sub-agents (Task) for parallel research (e.g. fetch Instagram posts and Google reviews at once).

CROSS-REPO: every site this company manages is checked out under /srv/sites/ (paths listed in the task).
Your cwd is the ONE site to edit + deploy; you may READ the others to copy an asset or mirror a section
(e.g. copy the resonatekit bio image into this repo, or mirror runasskola's footer/legal here).

IMAGES: a PEXELS_API_KEY is in your environment for stock photos; or copy a real image from another
managed repo; or use the browser helper to find a real image URL and curl it down. Put images where
SITE.md specifies and point the ONE source-of-truth field at the served path. NEVER reference an image
path that is not on disk.

TEMPLATE SAFETY: HTML comments (<!-- -->) do NOT disable Nunjucks/Liquid tags — a {% include %} inside a
comment STILL runs. When you extract a block into an include, never reference that include from inside
itself (self-include → infinite recursion → build crash).

BUILD + FINISH: after your edits, run the site's build (\`npm run build\` or \`npx @11ty/eleventy\`) and
confirm it succeeds — a change that doesn't build will be rejected. Do NOT \`git commit\` or \`git push\`;
the runtime does that AFTER its own verification gate.

VERIFICATION (REQUIRED — you cannot be marked "done" without it):
- A human is NOT watching. A browser/HTTP check confirms your change is live and correct before anything
  reaches the client. Tell that checker how to prove your work. End your reply with ONE block:
    <VERIFY>
    [ {"page":"/<path-as-served>","contains":"<exact unique string now live>"},
      {"page":"/<path>","interaction":{"click":"<sel>","expectVisible":"<sel>","expectHidden":"<sel>"}} ]
    </VERIFY>
  One entry per change. Content change → a unique \`contains\` string now on the page. Interactive change
  (toggle / form / carousel / JS) → an \`interaction\` the checker can run. If you genuinely cannot make
  something checkable, say so plainly; never imply it is verified.
- Immediately BEFORE the <VERIFY> block, write a SHORT plain-language summary FOR THE CLIENT, in the
  client's language (Latvian here), one line per request.

HONESTY over completeness. If part of the request truly can't be done, do the rest and state clearly
what is left and why.`;

export async function runAgentSession({ cwd, instruction, model = "claude-opus-4-8", maxTurns = 120, onMessage }) {
  const q = query({
    prompt: instruction,
    options: {
      cwd,
      model,
      systemPrompt: { type: "preset", preset: "claude_code", append: LABOT_RULES },
      // FULL toolbox — web + real browser (via Bash helper) + sub-agents. This is the whole point of v3:
      // the v2 agent was limited to Read,Edit,Write,Bash,Grep,Glob and so could not see the web.
      allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Task", "TodoWrite"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true, // headless service: no interactive approval
      maxTurns, // generous RUNAWAY backstop only — not a per-task budget
    },
  });

  // Accumulate usage from the stream so we still have a per-job telemetry line even if the backstop is
  // hit (the SDK throws before emitting a result message). Output sums; input/cache are cumulative
  // context so we keep the max seen. A clean finish uses the result message's exact totals + cost.
  const acc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let result = null, turnsSeen = 0, thrown = null;
  try {
    for await (const m of q) {
      if (onMessage) onMessage(m);
      const u = m.type === "assistant" ? m.message?.usage : null;
      if (u) {
        acc.output_tokens += u.output_tokens || 0;
        acc.input_tokens = Math.max(acc.input_tokens, u.input_tokens || 0);
        acc.cache_read_input_tokens = Math.max(acc.cache_read_input_tokens, u.cache_read_input_tokens || 0);
        acc.cache_creation_input_tokens = Math.max(acc.cache_creation_input_tokens, u.cache_creation_input_tokens || 0);
        turnsSeen++;
      }
      if (m.type === "result") result = m;
    }
  } catch (e) {
    thrown = e;
  }
  if (result) {
    return { ok: result.subtype === "success", text: result.result ?? "", costUsd: result.total_cost_usd ?? 0, numTurns: result.num_turns, raw: result };
  }
  const maxedOut = /maximum number of turns/i.test(String(thrown || ""));
  return {
    ok: false,
    error: thrown ? String(thrown) : "agent produced no result message",
    text: "",
    costUsd: estimateCost(model, acc),
    numTurns: turnsSeen,
    raw: { usage: acc, estimated: true, maxedOut },
  };
}

// Rough per-job cost estimate (USD) from token counts, for the backstop case where the SDK gives no
// total_cost_usd. Prices per million tokens; cache_read ≈0.1× input, cache_write ≈1.25× input.
const PRICES = [
  { m: "haiku", in: 1, out: 5 },
  { m: "sonnet", in: 3, out: 15 },
  { m: "opus", in: 15, out: 75 },
];
function estimateCost(model, u) {
  const p = PRICES.find((x) => String(model || "").includes(x.m)) || PRICES[2];
  return (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_read_input_tokens * p.in * 0.1 + u.cache_creation_input_tokens * p.in * 1.25) / 1e6;
}
