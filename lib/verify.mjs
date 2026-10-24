// 验证：打开私信页，看最新会话预览和最后几条消息
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

const out = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).map((e) => ({
    text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
  }));
  return { conversations: rows.slice(0, 6) };
});

console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: P("state", "verify-chat.png") }).catch(() => {});
console.log("截图: state/verify-chat.png");
process.exit(0);
