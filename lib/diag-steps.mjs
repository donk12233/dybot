// 分步探针：跑到哪一步页面会跳到 /chat
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) process.exit(0);

const show = (tag) => console.log(`  [${tag}] url=${page.url()}`);

await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4500);
show("到推荐流");

const convCount = () =>
  page.evaluate(() => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).length;
  }).catch(() => 0);

console.log("  浮窗会话数（点之前）:", await convCount());

// 点 im-entry
const e = await page.evaluate(() => {
  const el = document.querySelector('[data-e2e="im-entry"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}).catch(() => null);
if (!e) { console.log("  没找到 im-entry"); process.exit(0); }
await page.mouse.move(e.x, e.y);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(3500);
show("点了 im-entry 之后");
console.log("  浮窗会话数:", await convCount());

// 点会话
const conv = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((x) => (x.innerText || "").includes("示例好友"));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}).catch(() => null);
if (!conv) { console.log("  没找到会话行"); process.exit(0); }

await page.mouse.move(conv.x, conv.y);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(3000);
show("点了会话之后");

const cards = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(v).length;
}).catch(() => -1);
console.log("  浮窗里可见卡片数:", cards);

process.exit(0);
