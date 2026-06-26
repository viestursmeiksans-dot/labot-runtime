// Deterministic post-deploy verification (spec Part B). NO model re-reasoning — a real HTTP fetch
// (and later a headless browser) asserts the change is live. The agent declares HOW to check its
// work in a <VERIFY> block; we run those checks and gate the "done" report on the result.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the agent's declared checks out of its final summary.
export function parseVerify(text) {
  const m = String(text || "").match(/<VERIFY>\s*([\s\S]*?)\s*<\/VERIFY>/i);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1].trim());
    return Array.isArray(v) ? v : [v];
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { status: r.status, html: "" };
    return { status: r.status, html: await r.text() };
  } catch (e) {
    return { status: 0, html: "", err: String(e) };
  }
}

// V1 — content checks. Polls the deployed page until the expected string is live (the GitHub Action
// deploy is async), or a timeout. Returns per-check {ok}. This also doubles as the deploy-wait.
export async function verifyContent(baseUrl, checks, { log = () => {}, timeoutMs = 150000 } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const content = (checks || []).filter((c) => c && c.contains && c.page);
  const results = [];
  for (const c of content) {
    const url = base + (c.page.startsWith("/") ? c.page : "/" + c.page);
    const deadline = Date.now() + timeoutMs;
    let ok = false, lastStatus = 0;
    while (Date.now() < deadline) {
      const { status, html } = await fetchText(url);
      lastStatus = status;
      if (status === 200 && html.includes(c.contains)) { ok = true; break; }
      await sleep(6000);
    }
    log(`[verify] V1 ${ok ? "PASS" : "FAIL"} ${url} contains="${String(c.contains).slice(0, 40)}" (http ${lastStatus})`);
    results.push({ type: "content", page: c.page, contains: c.contains, ok, status: lastStatus });
  }
  return results;
}

// V2 — interactive checks (console errors + declared click/assert). Requires a headless browser on
// the box (chromium). Until that's provisioned, return an explicit "skipped" so the gate treats the
// interactive task as UNVERIFIED (honest), never silently "done".
export async function verifyInteractive(baseUrl, checks, { log = () => {} } = {}) {
  const interactive = (checks || []).filter((c) => c && c.interaction && c.page);
  if (!interactive.length) return [];
  let browser;
  try {
    ({ runBrowserChecks: browser } = await import("./browser.mjs"));
  } catch {
    log(`[verify] V2 SKIPPED (no headless browser on box yet) — ${interactive.length} interactive check(s) UNVERIFIED`);
    return interactive.map((c) => ({ type: "interaction", page: c.page, ok: false, skipped: true }));
  }
  return browser(baseUrl, interactive, { log });
}

// Run the full gate. Returns { verified, results } — verified=false means do NOT claim "done".
export async function runVerification(baseUrl, checks, { log = () => {} } = {}) {
  if (!checks || !checks.length) {
    // Agent declared nothing checkable → cannot confirm. Treat as unverified (honest).
    log(`[verify] no <VERIFY> block declared → UNVERIFIED`);
    return { verified: false, results: [], reason: "no_checks_declared" };
  }
  const v1 = await verifyContent(baseUrl, checks, { log });
  const v2 = await verifyInteractive(baseUrl, checks, { log });
  const results = [...v1, ...v2];
  const verified = results.length > 0 && results.every((r) => r.ok);
  return { verified, results };
}
