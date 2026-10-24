// 验证两件事：1) 页面有没有 WebSocket（新消息是推送来的吗）2) 未读状态能不能读
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
// 记录所有 websocket
const sockets = [];
page.on("websocket", (ws) => {
  const rec = { url: ws.url().slice(0, 120), frames: 0, samples: [] };
  sockets.push(rec);
  ws.on("framereceived", (f) => {
    rec.frames++;
    if (rec.samples.length < 3) {
      const p = typeof f.payload === "string" ? f.payload : "[binary]";
      rec.samples.push(p.slice(0, 80));
    }
  });
});
console.log("已挂 websocket 监听，去打开私信页…");

await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);

console.log(`\n发现 ${sockets.length} 个 websocket：`);
sockets.forEach((s) => console.log(`  - ${s.url}  收到帧=${s.frames}`));

// 未读状态能读吗
const unread = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).slice(0, 5);
  return items.map((e) => ({
    text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50),
    // 找红点/未读数
    badges: Array.from(e.querySelectorAll("*"))
      .filter((n) => {
        const c = String(n.className || "");
        return /badge|unread|reddot|dot|count/i.test(c) && vis(n);
      })
      .map((n) => ({ cls: String(n.className || "").slice(0, 30), t: (n.textContent || "").trim().slice(0, 6) }))
      .slice(0, 3),
    // 整行有没有数字角标
    numbers: (e.innerText || "").match(/\b\d{1,3}\b/g)?.slice(0, 3) || [],
  }));
});
console.log("\n会话未读状态:", JSON.stringify(unread, null, 2));

// 再等一会儿看有没有帧持续进来
await page.waitForTimeout(8000);
console.log("\n再等 8 秒后，各 socket 累计帧数：");
sockets.forEach((s) => console.log(`  - ${s.url}  frames=${s.frames}  samples=${JSON.stringify(s.samples)}`));

process.exit(0);
