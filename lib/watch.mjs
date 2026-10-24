// 监听原型：只读 DOM 轮询会话摘要，检测"真正的新消息"并写进 state/inbox.json
// 关键修正：剥掉昵称和相对时间（"5分钟前"），只比对消息正文，否则每分钟都误报。
// 用法：node lib/watch.mjs [秒数=180] [--interval=3]
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const SECONDS = parseInt(argv.find((a) => /^\d+$/.test(a)) || "180", 10);
const intervalArg = argv.find((a) => a.startsWith("--interval="));
const INTERVAL = intervalArg ? parseInt(intervalArg.split("=")[1], 10) : 3;
const CONV = process.env.DYBOT_CONV || "示例好友";
const INBOX = P("state", "inbox.json");

// 去掉昵称 + 相对时间，只留正文
const TIME_RE = /^(\d+分钟前|\d+小时前|昨天(\s*\d{1,2}:\d{2})?|前天(\s*\d{1,2}:\d{2})?|刚刚|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)\s*/;

function bodyOf(full, name) {
  let t = String(full || "").trim();
  if (name && t.startsWith(name)) t = t.slice(name.length).trim();
  t = t.replace(TIME_RE, "").trim(); // 可能连着两层时间
  t = t.replace(TIME_RE, "").trim();
  return t;
}

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
const read = () =>
  page.evaluate((name) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis);
    const t = items.find((e) => (e.innerText || "").includes(name));
    if (!t) return { found: false, total: items.length };
    return { found: true, total: items.length, text: (t.innerText || "").replace(/\s+/g, " ").trim() };
  }, CONV);

function appendInbox(entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(INBOX, "utf8")); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.push(entry);
  fs.mkdirSync(path.dirname(INBOX), { recursive: true });
  fs.writeFileSync(INBOX, JSON.stringify(arr.slice(-200), null, 2), "utf8");
}

const t0 = Date.now();
let prevBody = null;
let hits = 0;

console.log(`监听 ${SECONDS}s，每 ${INTERVAL}s 读一次 DOM（零网络请求）｜目标会话：${CONV}`);
console.log("时间   会话数  正文前 40 字");

while ((Date.now() - t0) / 1000 < SECONDS) {
  const r = await read();
  const sec = Math.round((Date.now() - t0) / 1000);
  if (!r.found) {
    console.log(`+${sec}s  ${r.total}      [找不到目标会话]`);
  } else {
    const body = bodyOf(r.text, CONV);
    const first = prevBody === null;
    const changed = !first && body !== prevBody;
    if (changed) {
      hits++;
      console.log(`+${sec}s  ${r.total}      🔔 新消息正文变化 → ${body.slice(0, 40)}`);
      appendInbox({ ts: new Date().toISOString(), conv: CONV, preview: body, detectedAt: sec });
    } else if (first) {
      console.log(`+${sec}s  ${r.total}      基准正文：${body.slice(0, 40)}`);
    }
    prevBody = body;
  }
  await page.waitForTimeout(INTERVAL * 1000);
}

console.log(`\n共检测到 ${hits} 条新消息`);
if (hits) console.log("已写入", INBOX);
else console.log("没有新消息（要验证得在这段时间里真的发一条）");
process.exit(0);
