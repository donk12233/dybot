// 诊断：左侧列表的预览 vs 打开会话后的真实最新消息
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!page.url().includes("/chat")) {
  await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
}
await page.evaluate(() => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));

// 1) 列表原文
const list = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).slice(0, 6).map((e) => ({
    raw: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 70),
  }));
});
console.log("=== 左侧列表前 6 行 ===");
list.forEach((l, i) => console.log(`  [${i}] ${l.raw}`));

// 2) 逐个打开 示例好友 / 示例好友B，读真实最新消息
for (const name of ["示例好友", "示例好友B"]) {
  const conv = await page.evaluate((n) => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes(n));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, name);
  if (!conv) { console.log(`\n=== ${name}：列表里没有 ===`); continue; }
  await page.mouse.move(conv.x, conv.y);
  await page.waitForTimeout(150);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(1500);

  const tl = await page.evaluate(() => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const items = [];
    const push = (el, kind, text) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      let own = el, fromMe = false;
      for (let i = 0; i < 3 && own; i++) {
        if (/isFromMe/.test(String(own.className || ""))) { fromMe = true; break; }
        own = own.parentElement;
      }
      items.push({ kind, text, fromMe, bottom: r.bottom });
    };
    document.querySelectorAll('[class*="pureText"]').forEach((e) => push(e, "text", (e.textContent || "").trim()));
    document.querySelectorAll(".MessageItemEmojiemojiBox").forEach((e) => push(e, "emoji", "[表情包]"));
    document.querySelectorAll(".MessageItemShareAwemecontainer").forEach((e) => {
      const a = e.querySelector('[class*="authorName"]');
      push(e, "card", "[视频] " + (a ? a.textContent.trim() : ""));
    });
    items.sort((a, b) => b.bottom - a.bottom);
    return items.slice(0, 4).map((m) => ({ kind: m.kind, fromMe: m.fromMe, text: m.text.slice(0, 40) }));
  });
  console.log(`\n=== ${name} 打开后最新 4 条（新→旧）===`);
  tl.forEach((m, i) => console.log(`  [${i}] ${m.fromMe ? "我" : "他"} ${m.kind}  ${m.text}`));
}
process.exit(0);
