// 探私信：能读到哪些消息？视频卡片里的 id 能不能拿到？
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

// 按白名单名字点开会话（不点第一个）
const convs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).map((e, i) => ({
    i,
    text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30),
  }))
);
console.log("会话列表:", JSON.stringify(convs.slice(0, 4)));

const target = convs.find((c) => c.text.includes("示例好友"));
if (!target) { console.error("没找到目标会话"); process.exit(3); }
await page.locator('[data-e2e="conversation-item"]').nth(target.i).click({ timeout: 15000 });
await page.waitForTimeout(2500);

const dump = await page.evaluate(() => {
  // 1) 消息节点：各种可能的容器
  const sel = ['[data-e2e*="message"]', '[class*="message"]', '[class*="Message"]'];
  const nodes = new Set();
  sel.forEach((s) => document.querySelectorAll(s).forEach((e) => nodes.add(e)));

  const items = [];
  nodes.forEach((e) => {
    const t = (e.innerText || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) return;
    if (t.length < 2) return;
    items.push({ t: t.slice(0, 60), cls: String(e.className || "").slice(0, 28), e2e: e.getAttribute("data-e2e") });
  });

  // 2) 视频卡片：找带 video 字样或 img 的消息块，看有没有 href / data-*
  const cards = [];
  document.querySelectorAll('[class*="message"], [class*="Message"], [data-e2e*="message"]').forEach((e) => {
    const hasImg = !!e.querySelector("img");
    const hasVideoWord = /分享\[视频\]|视频/.test(e.innerText || "");
    if (!hasImg && !hasVideoWord) return;
    const a = e.querySelector("a[href]");
    cards.push({
      hasImg,
      href: a ? a.getAttribute("href") : null,
      attrs: Array.from(e.attributes).map((x) => x.name).slice(0, 8),
      childrenWithData: Array.from(e.querySelectorAll("[data-aweme-id],[data-e2e-vid],[data-id]")).map((n) =>
        Array.from(n.attributes).filter((a2) => /aweme|vid|data-id/.test(a2.name)).map((a2) => a2.name + "=" + a2.value)
      ).slice(0, 4),
      text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
    });
  });

  return { messageItems: items.slice(-14), cards: cards.slice(0, 6) };
});

console.log("\n消息节点（后 14 条）:");
dump.messageItems.forEach((m) => console.log(`  [${m.t}]  <${m.e2e || m.cls}>`));
console.log("\n视频/图片卡片:");
dump.cards.forEach((c) => console.log("  " + JSON.stringify(c)));

await page.screenshot({ path: P("state", "chat-read.png") }).catch(() => {});
console.log("\n截图: state/chat-read.png");
process.exit(0);
