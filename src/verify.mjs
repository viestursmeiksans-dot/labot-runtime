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

// V2 — browser checks. Runs the console-error smoke test on EVERY changed page (catches the JS-break
// class even when the agent declared only a content check) PLUS any declared click/assert. Requires
// chromium on the box; if it can't launch, return an explicit failure so interactive edits stay
// UNVERIFIED (honest), never silently "done".
export async function verifyBrowser(baseUrl, checks, { log = () => {} } = {}) {
  const pages = (checks || []).filter((c) => c && c.page);
  const hasInteraction = pages.some((c) => c.interaction);
  if (!pages.length) return [];
  let runBrowserChecks;
  try {
    ({ runBrowserChecks } = await import("./browser.mjs"));
  } catch (e) {
    // No browser available. Only HARD-fail when an interactive assertion was needed; for pure content
    // edits the V1 HTTP check already proved the change is live, so don't block on a missing browser.
    if (hasInteraction) {
      log(`[verify] V2 unavailable (${String(e).slice(0, 60)}) — interactive checks UNVERIFIED`);
      return pages.filter((c) => c.interaction).map((c) => ({ type: "browser", page: c.page, ok: false, skipped: true }));
    }
    log(`[verify] V2 unavailable — skipping console smoke (content already verified via V1)`);
    return [];
  }
  return runBrowserChecks(baseUrl, pages, { log });
}

// Run the full gate. Returns { verified, results } — verified=false means do NOT claim "done".
export async function runVerification(baseUrl, checks, { log = () => {} } = {}) {
  if (!checks || !checks.length) {
    // Agent declared nothing checkable → cannot confirm. Treat as unverified (honest).
    log(`[verify] no <VERIFY> block declared → UNVERIFIED`);
    return { verified: false, results: [], reason: "no_checks_declared" };
  }
  const v1 = await verifyContent(baseUrl, checks, { log });
  const v2 = await verifyBrowser(baseUrl, checks, { log });
  const results = [...v1, ...v2];
  const verified = results.length > 0 && results.every((r) => r.ok);
  return { verified, results };
}
