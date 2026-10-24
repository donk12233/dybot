// 自主从私信打开转发视频，拿到 modal_id（不需要人工点）
// 依据实测：推荐流页面 + 右侧消息浮窗里点卡片 → URL 变 ?modal_id=<id>&recommend=1
// 做法：把这条路径写成状态机，每步先查状态、只认可见元素、坐标点击、失败带截图。
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const CONV = process.env.DYBOT_CONV || "示例好友";
const { browser, ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
const parseId = (u) => {
  const m = String(u).match(/[?&]modal_id=(\d{6,})/);
  if (m) return m[1];
  const v = String(u).match(/\/video\/(\d{6,})/);
  return v ? v[1] : null;
};

const state = async () =>
  await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const convItems = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis);
    const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(vis);
    return {
      url: location.href,
      convVisible: convItems.map((e) => ({ t: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 24), x: Math.round(e.getBoundingClientRect().x + e.getBoundingClientRect().width / 2), y: Math.round(e.getBoundingClientRect().y + e.getBoundingClientRect().height / 2) })),
      cardCount: cards.length,
      popupCount: document.querySelectorAll("#pc-im-popup-container").length,
    };
  });

const clickXY = async (x, y, label) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(220);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(2600);
  console.log(`  → 点击 ${label} @(${x},${y})`);
};

const waitModalId = async (ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const id = parseId(page.url());
    if (id) return id;
    await page.waitForTimeout(400);
  }
  return null;
};

// ---- 步骤 0：确保在推荐流 ----
let st = await state();
console.log("步骤0 当前:", st.url, "可见会话", st.convVisible.length, "可见卡片", st.cardCount);
if (!/[?&]recommend=1/.test(st.url) && !/modal_id=/.test(st.url)) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  st = await state();
  console.log("  已切推荐流:", st.url);
}

// ---- 步骤 1：打开右侧消息入口（真实鼠标点击！el.click() 抖音不认）----
if (st.convVisible.length === 0) {
  const entry = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="im-entry"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  console.log("步骤1 im-entry 坐标:", JSON.stringify(entry));
  if (entry) {
    await page.mouse.move(entry.x, entry.y);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(3500);
    st = await state();
  }
  console.log("步骤1 后 可见会话:", st.convVisible.length, JSON.stringify(st.convVisible.slice(0, 3)));
}

// 如果第一次没开出来，再真实点一次（可能是"点开又被他自己的悬停关掉"）
if (st.convVisible.length === 0) {
  const entry = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="im-entry"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (entry) {
    await page.mouse.move(entry.x, entry.y);
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(3500);
    st = await state();
  }
  console.log("步骤1b 后 可见会话:", st.convVisible.length, JSON.stringify(st.convVisible.slice(0, 3)));
  if (st.convVisible.length === 0) {
    console.error("[失败] 打不开消息浮窗（真实鼠标点击两次都没用）");
    await page.screenshot({ path: P("state", "fail-drawer.png") }).catch(() => {});
    process.exit(3);
  }
}

// ---- 步骤 2：点开会话 ----
const conv = st.convVisible.find((c) => c.t.includes(CONV));
if (!conv) {
  console.error("[失败] 可见会话里没有", CONV, "，实际有:", JSON.stringify(st.convVisible.map((c) => c.t)));
  process.exit(4);
}
await clickXY(conv.x, conv.y, `会话「${conv.t}」`);

// ---- 步骤 3：等卡片出现，滚到可见 ----
let scrolled = null;
for (let i = 0; i < 3; i++) {
  scrolled = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer")).filter(vis);
    if (!cards.length) return null;
    const c = cards[cards.length - 1];
    c.scrollIntoView({ block: "center" });
    const r = c.getBoundingClientRect();
    const a = c.querySelector('[class*="authorName"]');
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), author: a ? a.textContent.trim() : null, n: cards.length };
  });
  if (scrolled) break;
  await page.waitForTimeout(1500);
}
if (!scrolled) {
  console.error("[失败] 会话里没有可见的视频卡片");
  await page.screenshot({ path: P("state", "fail-card.png") }).catch(() => {});
  process.exit(5);
}
console.log(`步骤3 最新卡片 作者=${scrolled.author} 共${scrolled.n}张 → (${scrolled.x},${scrolled.y})`);
await page.waitForTimeout(600);

// ---- 步骤 4：点卡片，等 modal_id ----
let id = null;
for (let attempt = 1; attempt <= 3 && !id; attempt++) {
  await clickXY(scrolled.x, scrolled.y, `卡片(第${attempt}次)`);
  id = await waitModalId(6000);
  console.log(`  第${attempt}次点击后 URL:`, page.url(), "→ id =", id);
  if (!id) {
    // 可能打开了全屏弹层挡住了：把它 display:none 再来
    await page.evaluate(() => {
      document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none"));
    });
    await page.waitForTimeout(800);
  }
}

if (!id) {
  console.error("[失败] 三次点击都没拿到 modal_id");
  await page.screenshot({ path: P("state", "fail-modal.png") }).catch(() => {});
  process.exit(6);
}

console.log(`\n✅ modal_id = ${id}`);
console.log(`可以直接读: node lib/enrich.mjs ${id}`);
process.exit(0);
