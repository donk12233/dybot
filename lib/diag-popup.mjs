// 探针：私信页点开视频后，播放器里有没有通往详情页的链接/按钮
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

const h = await page.evaluateHandle(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(v);
  cards.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  return cards[0] || null;
});
const el = h.asElement();
if (!el) { console.log("没有卡片"); process.exit(0); }
await el.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
await el.click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(3500);

const info = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const anchors = Array.from(document.querySelectorAll("a[href]"))
    .filter(v)
    .map((a) => ({ href: a.getAttribute("href"), text: (a.innerText || "").replace(/\s+/g, " ").slice(0, 20) }))
    .filter((a) => /video|note|modal_id/.test(a.href || ""))
    .slice(0, 10);
  // 播放器里可点的文字按钮
  const buttons = Array.from(document.querySelectorAll("div,span,button"))
    .filter((e) => v(e) && e.children.length === 0)
    .map((e) => (e.textContent || "").trim())
    .filter((t) => t && t.length <= 8 && /详情|主页|关注|收藏|分享|评论|作者|进入|查看/.test(t));
  return {
    url: location.href,
    anchors,
    buttons: Array.from(new Set(buttons)).slice(0, 12),
    hasVideo: !!document.querySelector("video"),
  };
});
console.log(JSON.stringify(info, null, 2));
process.exit(0);
