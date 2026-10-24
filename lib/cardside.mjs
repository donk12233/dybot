// 修正版：以"消息浮窗自己的中心"判断左右，区分他发的 vs 我发的卡片
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!/[?&]recommend=1/.test(page.url())) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
}
const openDrawer = async () => {
  const e = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="im-entry"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!e) return false;
  await page.mouse.move(e.x, e.y); await page.waitForTimeout(250);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(3500);
  return true;
};
const visibleConvs = () =>
  page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).length;
  });

if ((await visibleConvs()) === 0) await openDrawer();
if ((await visibleConvs()) === 0) await openDrawer();

const conv = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).find((e) => (e.innerText || "").includes("示例好友"));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!conv) { console.error("没有目标会话"); process.exit(3); }
await page.mouse.move(conv.x, conv.y); await page.waitForTimeout(200);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 找浮窗容器，用它的中心当基准
  const box = document.querySelector("#imSaasContainerId") || document.querySelector('[id*="im"][class*="Container"]');
  const br = box ? box.getBoundingClientRect() : null;
  const cx = br ? br.x + br.width / 2 : window.innerWidth * 0.85;

  const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(vis).map((c, i) => {
    const r = c.getBoundingClientRect();
    const a = c.querySelector('[class*="authorName"]');
    const mid = r.x + r.width / 2;
    return {
      i,
      author: a ? a.textContent.trim() : null,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      side: mid < cx - 20 ? "RECV(他发的)" : mid > cx + 20 ? "SENT(我发的)" : "MID",
      click: { x: Math.round(mid), y: Math.round(r.y + r.height / 2) },
    };
  });
  return {
    boxRect: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height), cx: Math.round(cx) } : null,
    cards,
    // 文本消息也能看方向：列出最后 6 条消息的片段
    texts: Array.from(document.querySelectorAll('[class*="pureText"]')).slice(-6).map((e) => (e.textContent || "").trim().slice(0, 30)),
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: P("state", "cards-side.png") }).catch(() => {});
process.exit(0);
