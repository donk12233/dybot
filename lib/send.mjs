// 发一条文本私信。硬规则：
//   1) 目标必须来自 config.json 已验证白名单（不再点会话列表第一个）
//   2) 会话列表里按昵称精确匹配，必须恰好一个
//   3) 编辑框必须先清空、输入逐字一致、发完回读
// 用法：node lib/send.mjs --to=示例好友 "消息内容"            （预演）
//       node lib/send.mjs --to=示例好友 --yes --send "内容"    （真发）
import { connect, douyinPage } from "./cdp.mjs";
import { resolveTargets, requireYes, matchExactlyOne, appendLog } from "./targets.mjs";

const strip = (s) => (s || "").replace(/\u200b/g, "").replace(/\u200c/g, "").trim();
const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const TEXT = strip(argv.find((a) => !a.startsWith("--") && a !== undefined) || "");

// 目标解析先于一切
const targets = resolveTargets(argv);
if (!TEXT) { console.error("[拒绝执行] 没有给消息内容"); process.exit(10); }
if (SEND) requireYes(argv, "发送文本私信");

if (targets.length !== 1) {
  console.error(`[拒绝执行] 文本发送要求本轮只有一个目标，当前 ${targets.length} 个。请用 --only=<名字> 指定。`);
  process.exit(10);
}
const target = targets[0];
console.log(`目标：${target.name}　内容：${JSON.stringify(TEXT)}`);

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!page.url().includes("/chat")) {
  await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
}

// 读会话列表，按昵称匹配（绝不点第一个）
const rows = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).map((el, i) => {
    const r = el.getBoundingClientRect();
    // 昵称：卡片里最长的短文本叶子（排除预览行、时间）
    const cands = Array.from(el.querySelectorAll("div,span"))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || "").trim())
      .filter((t) => t && t.length <= 20 && !/^\d+\s*(分钟|小时|天|月)前$/.test(t) && !/^\d{2}\/\d{2}$/.test(t) && t !== "刚刚");
    return { idx: i, name: cands[0] || null, at: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }, text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40) };
  });
});
console.log("会话列表：", JSON.stringify(rows.map((r) => r.name)));

const m = matchExactlyOne(rows, target.name);
if (!m.ok) {
  console.error(`[停止] 会话列表里匹配「${target.name}」失败：${m.reason}${m.count ? " ×" + m.count : ""}`);
  process.exit(4);
}

// 会话列表顺序会变（有人发来新消息就跳到顶部），所以【绝不能】
// "先算第几行、再点第几行"——那是发错人的根源。改成按名字找人、点完用
// curConversation 标记验证，不对就重试。
async function currentConvName() {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="conversation-item"][class*="curConversation"]');
    if (!el) return null;
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    return t.split(" ")[0] || null;
  });
}

async function openConvByName(name) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const h = await page.evaluateHandle((n) => {
      const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
      const el = items.find((e) => {
        const t = (e.innerText || "").replace(/\s+/g, " ").trim();
        return t.split(" ")[0] === n;
      });
      return el || null;
    }, name);
    const el = h.asElement();
    if (!el) {
      console.log(`  [尝试 ${attempt}] 列表里没找到「${name}」，等一下再看`);
      await page.waitForTimeout(1000);
      continue;
    }
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const now = await currentConvName();
    console.log(`  [尝试 ${attempt}] 点开后当前会话 = ${JSON.stringify(now)}`);
    if (now === name) return true;
  }
  return false;
}

const opened = await openConvByName(target.name);
if (!opened) {
  const now = await currentConvName();
  console.error(`[停止] 打不开「${target.name}」的会话（当前停在 ${JSON.stringify(now)}），不发`);
  process.exit(8);
}

const editor = page.locator('[class*="messageEditorinputArea"]').first();
if (!(await editor.count())) { console.error("[停止] 找不到输入框"); process.exit(3); }

await editor.click({ timeout: 15000 });
await page.waitForTimeout(400);

for (let i = 0; i < 2; i++) {
  const cur = strip(await editor.innerText());
  if (!cur) break;
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(250);
}
if (strip(await editor.innerText())) { console.error("[停止] 编辑框清不干净"); process.exit(5); }

await page.keyboard.type(TEXT, { delay: 8 });
await page.waitForTimeout(500);
const typed = strip(await editor.innerText());
if (typed !== TEXT) {
  console.error("[停止] 输入不一致\n  期望:", JSON.stringify(TEXT), "\n  实际:", JSON.stringify(typed));
  process.exit(5);
}

if (!SEND) {
  console.log("== 预演：内容一致，未按 Enter ==");
  process.exit(0);
}

// 按 Enter 之前最后一道闸：会话可能在这几秒里被切走
// （有人在别的会话发来新消息时，抖音会把焦点抢过去，这正是"发错人"的成因）
const convBeforeEnter = await currentConvName();
if (convBeforeEnter !== target.name) {
  console.error(`[停止] 准备发送时会话变了：${JSON.stringify(target.name)} → ${JSON.stringify(convBeforeEnter)}，已取消`);
  try {
    await editor.click({ timeout: 5000 });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  } catch {}
  process.exit(8);
}
const typedNow = strip(await editor.innerText());
if (typedNow !== TEXT) {
  console.error(`[停止] 发送前内容被改动：期望 ${JSON.stringify(TEXT)}，实际 ${JSON.stringify(typedNow)}`);
  process.exit(5);
}

await page.keyboard.press("Enter");
await page.waitForTimeout(1100);

const after = await page.evaluate((needle) => {
  const ed = document.querySelector('[class*="messageEditorinputArea"]');
  const lines = (document.body.innerText || "").split("\n").map((s) => s.replace(/\u200b/g, "").trim()).filter(Boolean);
  return { editorCleared: !ed || !(ed.innerText || "").replace(/\u200b/g, "").trim(), exactBubble: lines.some((l) => l === needle) };
}, TEXT);

appendLog({
  ts: new Date().toISOString(),
  channel: "chat_text",
  to: target.name,
  text: TEXT,
  result: after.exactBubble && after.editorCleared ? "text_sent" : "text_unknown",
  verify: after,
});
console.log(JSON.stringify(after, null, 2));

// 非互关限制：抖音会提示「对方回复或关注你之前，只能发送一条文字消息」。
// 这不是 bug，是平台限制；用专门的退出码 7，让上层区别对待（别当失败狂重试）。
let restricted = false;
try {
  restricted = await page.evaluate(() => {
    const t = (document.body.innerText || "");
    return t.includes("只能发送一条文字消息") || t.includes("对方回复或关注你之前") || t.includes("互相关注后才能");
  });
} catch {}
if (!(after.exactBubble && after.editorCleared) && restricted) {
  console.log("[受限] 对方还没跟你互关，抖音只允许发一条。这条不算失败，也不重试。");
  process.exit(7);
}
process.exit(after.exactBubble && after.editorCleared ? 0 : 6);
