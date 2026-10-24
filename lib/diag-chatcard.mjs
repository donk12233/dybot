// 探针：在 /chat 点开视频卡片后，能否可靠拿到 aweme id
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) process.exit(0);

if (!page.url().includes("/chat")) {
  await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
}
await page.evaluate(() => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));

const conv = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes("示例好友"));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!conv) { console.log("没找到会话"); process.exit(0); }
await page.mouse.move(conv.x, conv.y);
await page.waitForTimeout(150);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2200);

// 先记录卡片作者
const authorBefore = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(v);
  if (!cards.length) return null;
  cards.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  const a = cards[0].querySelector('[class*="authorName"]');
  return { author: a ? a.textContent.trim() : null, count: cards.length };
});
console.log("卡片信息:", JSON.stringify(authorBefore));

const handle = await page.evaluateHandle(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(v);
  if (!cards.length) return null;
  cards.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  return cards[0];
});
const el = handle.asElement();
if (!el) { console.log("没有卡片"); process.exit(0); }
await el.scrollIntoViewIfNeeded().catch(() => {});
await el.click({ timeout: 8000 }).catch((e) => console.log("点击异常:", e.message.slice(0, 50)));
await page.waitForTimeout(4000);

const found = await page.evaluate(() => {
  const out = { url: location.href, vidAttr: null, descs: [], candidates: [] };
  const vidEl = document.querySelector("[data-e2e-vid]");
  out.vidAttr = vidEl ? vidEl.getAttribute("data-e2e-vid") : null;
  const d = document.querySelector('[data-e2e="video-desc"]');
  out.descs = d ? [d.innerText.replace(/\s+/g, " ").slice(0, 60)] : [];
  // 找所有带 19 位数字的属性
  const seen = new Set();
  document.querySelectorAll("*").forEach((e) => {
    for (const a of Array.from(e.attributes || [])) {
      const m = String(a.value).match(/\b(\d{19})\b/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.candidates.push({ tag: e.tagName, attr: a.name, id: m[1], cls: String(e.className || "").slice(0, 30) });
      }
    }
  });
  out.candidates = out.candidates.slice(0, 12);
  // 页面可见标题
  const title = document.title.replace(/\s*-\s*抖音\s*$/, "");
  out.title = title.slice(0, 60);
  const video = document.querySelector("video");
  out.videoSrc = video ? String(video.src || "").slice(0, 80) : null;
  return out;
});
console.log(JSON.stringify(found, null, 2));

await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));
process.exit(0);
