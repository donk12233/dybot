// 打开"对方发来的最新一条视频"并拿 modal_id
// 规则：以消息浮窗自身中心为界区分左右；只在 RECV（左侧）里取最靠下（最新）的那张。
import { connect, douyinPage } from "./cdp.mjs";

const CONV = process.env.DYBOT_CONV || "示例好友";
const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
const parseId = (u) => {
  const m = String(u).match(/[?&]modal_id=(\d{6,})/);
  if (m) return m[1];
  const v = String(u).match(/\/video\/(\d{6,})/);
  return v ? v[1] : null;
};

if (!/[?&]recommend=1/.test(page.url())) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
}

const visibleConvs = () =>
  page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).length;
  });

const clickImEntry = async () => {
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

if ((await visibleConvs()) === 0) await clickImEntry();
if ((await visibleConvs()) === 0) await clickImEntry();
if ((await visibleConvs()) === 0) { console.error("[失败] 浮窗打不开"); process.exit(3); }

const conv = await page.evaluate((name) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).find((e) => (e.innerText || "").includes(name));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, CONV);
if (!conv) { console.error("[失败] 没有会话", CONV); process.exit(4); }
await page.mouse.move(conv.x, conv.y); await page.waitForTimeout(200);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2500);

// 找 RECV 里最靠下的那张
const pick = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = document.querySelector("#imSaasContainerId");
  const br = box ? box.getBoundingClientRect() : null;
  const cx = br ? br.x + br.width / 2 : window.innerWidth * 0.85;

  const recv = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer"))
    .filter(vis)
    .map((c) => {
      const r = c.getBoundingClientRect();
      const a = c.querySelector('[class*="authorName"]');
      return {
        el: c,
        author: a ? a.textContent.trim() : null,
        mid: r.x + r.width / 2,
        y: r.y,
        h: r.height,
        w: r.width,
        x: r.x,
      };
    })
    .filter((c) => c.mid < cx - 20)   // 左侧 = 对方发的
    .sort((a, b) => b.y - a.y);       // 最靠下 = 最新

  if (!recv.length) return { none: true };
  const t = recv[0];
  t.el.scrollIntoView({ block: "center" });
  const r2 = t.el.getBoundingClientRect();
  return {
    author: t.author,
    total: recv.length,
    others: recv.slice(1).map((x) => x.author),
    click: { x: Math.round(r2.x + r2.width / 2), y: Math.round(r2.y + r2.height / 2) },
  };
});

if (pick.none) { console.error("[失败] 没有『对方发来的』视频卡片"); process.exit(5); }
console.log(`对方发的卡片 ${pick.total} 张，最新作者=${pick.author}，其他: ${JSON.stringify(pick.others)}`);
console.log("点击坐标:", JSON.stringify(pick.click));
await page.waitForTimeout(600);

let id = null;
for (let i = 1; i <= 3 && !id; i++) {
  await page.mouse.move(pick.click.x, pick.click.y);
  await page.waitForTimeout(250);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(5000);
  id = parseId(page.url());
  console.log(`第 ${i} 次点击后 URL: ${page.url()} → id=${id}`);
  if (!id) {
    await page.evaluate(() => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));
    await page.waitForTimeout(700);
  }
}

if (!id) { console.error("[失败] 没拿到 modal_id"); process.exit(6); }
console.log(`\n✅ 对方发来的视频 id = ${id}`);
process.exit(0);
