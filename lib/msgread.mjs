// 读私信里最近几条文本消息，并判断方向（他发的 / 我发的）
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const CONV = process.env.DYBOT_CONV || "示例好友";
const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!page.url().includes("/chat")) {
  await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
}

// 点开目标会话（用可见元素 + 坐标点击）
const conv = await page.evaluate((name) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).find((e) => (e.innerText || "").includes(name));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, CONV);
if (!conv) { console.error("没有目标会话"); process.exit(3); }
await page.mouse.move(conv.x, conv.y);
await page.waitForTimeout(200);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const texts = Array.from(document.querySelectorAll('[class*="pureText"]')).filter(vis);
  if (!texts.length) return { none: true };

  // 用消息区域自身中心判断左右：取所有消息节点的包围盒
  const rects = texts.map((e) => e.getBoundingClientRect());
  const minX = Math.min(...rects.map((r) => r.x));
  const maxX = Math.max(...rects.map((r) => r.right));
  const cx = (minX + maxX) / 2;

  return {
    center: Math.round(cx),
    msgs: texts.slice(-8).map((e, i) => {
      const r = e.getBoundingClientRect();
      const mid = r.x + r.width / 2;
      return {
        t: (e.textContent || "").trim().slice(0, 40),
        x: Math.round(r.x),
        side: mid < cx - 10 ? "RECV" : mid > cx + 10 ? "SENT" : "MID",
      };
    }),
  };
});

console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: P("state", "msgread.png") }).catch(() => {});
process.exit(0);
