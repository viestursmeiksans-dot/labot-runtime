// V2 verification (spec Part B) — headless chromium on the VPS. Two deterministic checks, no model:
//  1. Console-error smoke test on EVERY changed page that has inline JS — catches the whole class of
//     "a load-time JS error halts the script and kills all interactivity" (the toggle/hero/IG bugs).
//  2. The agent's declared interaction (click a selector → assert another element visible/hidden).
// Runs on the flat-rate box → ~€0 model cost. Imported lazily by verify.mjs; absent chromium → skip.
import { chromium } from "playwright";

// Given ALL declared checks, group by page: load each once, smoke-test console, run any interactions.
export async function runBrowserChecks(baseUrl, checks, { log = () => {} } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const byPage = new Map();
  for (const c of checks || []) {
    const p = c.page && c.page.startsWith("/") ? c.page : "/" + (c.page || "");
    if (!byPage.has(p)) byPage.set(p, []);
    if (c.interaction) byPage.get(p).push(c.interaction);
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (e) {
    log(`[verify] V2 browser launch FAILED (${String(e).slice(0, 80)}) — interactive/JS checks UNVERIFIED`);
    return [...byPage.keys()].map((page) => ({ type: "browser", page, ok: false, error: "launch_failed" }));
  }
  const results = [];
  try {
    for (const [page, interactions] of byPage) {
      const url = base + page;
      const tab = await browser.newPage();
      const errors = [];
      tab.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
      tab.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
      let ok = true; const detail = [];
      try {
        await tab.goto(url, { waitUntil: "load", timeout: 25000 });
        await tab.waitForTimeout(1500); // let load-time inline JS run (this is what catches the syntax-error class)
        if (errors.length) { ok = false; detail.push(`console_errors=${errors.length}:[${errors[0]}]`); }
        for (const it of interactions) {
          try {
            if (it.click) { await tab.click(it.click, { timeout: 6000 }); await tab.waitForTimeout(500); }
            if (it.expectVisible && !(await tab.isVisible(it.expectVisible))) { ok = false; detail.push(`not_visible:${it.expectVisible}`); }
            if (it.expectHidden && !(await tab.isHidden(it.expectHidden))) { ok = false; detail.push(`not_hidden:${it.expectHidden}`); }
          } catch (e) { ok = false; detail.push(`interaction_err:${String(e).slice(0, 60)}`); }
        }
      } catch (e) { ok = false; detail.push(`load_err:${String(e).slice(0, 60)}`); }
      log(`[verify] V2 ${ok ? "PASS" : "FAIL"} ${url} ${detail.join(" ") || "(clean console, interactions ok)"}`);
      results.push({ type: "browser", page, ok, consoleErrors: errors.length, detail });
      await tab.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}
