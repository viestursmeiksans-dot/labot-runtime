// Real-browser reader for the agent (v3 toolbox). Loads a URL in headless chromium and prints the
// RENDERED text, og:image, and on-page image URLs — for content plain HTTP/curl can't get because it
// needs JS or a real UA (Instagram posts, Google Maps reviews). This is the capability v2 lacked.
//
// Usage:  node tools/browse.mjs "<url>" [--shot /abs/path.png]
// Output: JSON { title, ogTitle, ogDesc, ogImage, ogImages[], images[], text }
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) { console.error("usage: browse.mjs <url> [--shot file.png]"); process.exit(2); }
const shotIdx = process.argv.indexOf("--shot");
const shot = shotIdx > 0 ? process.argv[shotIdx + 1] : null;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => page.goto(url, { waitUntil: "load", timeout: 30000 }));
  await page.waitForTimeout(1800);
  const data = await page.evaluate(() => {
    const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || "";
    const imgs = [...document.querySelectorAll("img")].map((i) => i.currentSrc || i.src).filter((s) => s && s.startsWith("http"));
    const ogImages = [...document.querySelectorAll('meta[property="og:image"]')].map((m) => m.content).filter(Boolean);
    return {
      title: document.title,
      ogTitle: meta("og:title"),
      ogDesc: meta("og:description"),
      ogImage: meta("og:image"),
      ogImages,
      images: [...new Set(imgs)].slice(0, 50),
      text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 5000),
    };
  });
  if (shot) await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.error("browse error:", String(e).slice(0, 200));
  process.exit(1);
} finally {
  await browser.close();
}
