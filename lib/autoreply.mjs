// 自动回复（B 方案）：监听私信 → 判断是否他发的 → 生成回复 → 三道安检 → 发送 → 记账
// 用法：
//   node lib/autoreply.mjs --once          看一眼（不发送）
//   node lib/autoreply.mjs --once --send   看+真发
//   node lib/autoreply.mjs --interval=3    常驻监听（每 3 秒读 DOM，0 请求）
import { connect, douyinPage, loginState } from "./cdp.mjs";
import { P as pathP } from "./paths.mjs";
import { loadConfig } from "./targets.mjs";
import { buildChatPrompt } from "./prompt.mjs";
import { generateReply, loadLlm } from "./llm.mjs";
import { emit, writeRunner, clearRunner } from "./events.mjs";
import { getNewestIncomingCardId, readVideoContent, describeVideo } from "./video.mjs";
import { fetchAiSummary } from "./videosummary.mjs";
import { memoryBlock, addFacts } from "./memory.mjs";
import { lexiconBlock, addTerm, banTerm, shouldLearnNow, setMeaning } from "./lexicon.mjs";
import { likeVideo } from "./like.mjs";
import { judgeVideo } from "./judge.mjs";

// ---------- 退出留痕（放最前面，任何退出路径都能记到）----------
var STARTED_M = Date.now();
var lastPauseReasonM = "";
function recordExitM(reason, detail) {
  try {
    fs.writeFileSync(
      pathP("state", "runner-exit.json"),
      JSON.stringify({ reason, detail: detail || null, ts: new Date().toISOString(), uptimeSec: Math.round((Date.now() - STARTED_M) / 1000), pid: process.pid }, null, 2),
      "utf8"
    );
  } catch {}
}
process.on("uncaughtException", (e) => {
  try { console.error("[致命] 未捕获异常：", e && e.stack ? e.stack : e); } catch {}
  try { emit("error", { stage: "uncaught", message: String((e && e.message) || e).slice(0, 200) }); } catch {}
  recordExitM("uncaught", String((e && e.message) || e));
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  try { console.error("[致命] 未处理的 Promise 拒绝：", e && e.stack ? e.stack : e); } catch {}
  try { emit("error", { stage: "unhandledRejection", message: String((e && e.message) || e).slice(0, 200) }); } catch {}
  recordExitM("unhandledRejection", String((e && e.message) || e));
  process.exit(1);
});
process.on("exit", (code) => { recordExitM("exit-code:" + code, lastPauseReasonM); });
import { shouldFire, markFired, summary as scheduleSummary } from "./schedule.mjs";
import { digestBusy } from "./busy.mjs";
import { verifyPresent } from "./guard.mjs";
import { checkReply } from "./checkreply.mjs";
import { cleanupStrayTabs } from "./tabs.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const SEND = argv.includes("--send");
const intervalArg = argv.find((a) => a.startsWith("--interval="));
// 默认 8 秒：3 秒一轮意味着每分钟几十次点击，风控最容易盯上
const INTERVAL = intervalArg
  ? parseInt(intervalArg.split("=")[1], 10)
  : Number((() => { try { return loadConfig().limits?.pollSeconds ?? 8; } catch { return 8; } })());
// 不再写死单个会话：白名单里所有 verified=true 的人都要回
function friendsList() {
  try {
    return (loadConfig().friends || [])
      .filter((f) => f.verified === true && String(f.name || "").trim())
      .map((f) => String(f.name).trim());
  } catch { return []; }
}
let FRIENDS = friendsList();
const CONV = process.env.DYBOT_CONV || (FRIENDS[0] || "示例好友"); // 仅作日志/兜底
const LOG = pathP("state", "autoreply.jsonl");

const cfg = loadConfig();
const P = cfg.persona || {};
const LIM = cfg.limits || {};
// 每日回复上限从 config.limits.dailyReplyCap 读，每轮重读（改了立刻生效）
function dailyReplyCap() {
  try { return Number(loadConfig().limits?.dailyReplyCap ?? 20); } catch { return 20; }
}
const SAME_CONV_COOLDOWN_MS = 10 * 1000;      // 同一会话 10 秒内只回一次（太大等于丢消息）
// 回复安检统一从 checkreply.mjs 取（控制台"试聊"用的是同一份，避免口径不一致）

function log(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n", "utf8");
}

function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.sent);
}

function lastReplyAgoMs() {
  const sent = readLog();
  if (!sent.length) return Infinity;
  return Date.now() - new Date(sent[sent.length - 1].ts).getTime();
}

function repliedToday() {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return readLog().filter((e) => {
    const t = new Date(e.ts);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}` === key;
  }).length;
}

// ---------- 读消息 ----------
async function readConversation(page) {
  const conv = await page.evaluate((name) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(vis).find((e) => (e.innerText || "").includes(name));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, CONV);
  if (!conv) return { error: "没有目标会话" };

  await page.mouse.move(conv.x, conv.y);
  await page.waitForTimeout(200);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(2200);

  return await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const texts = Array.from(document.querySelectorAll('[class*="pureText"]')).filter(vis);
    if (!texts.length) return { items: [] };
    const rects = texts.map((e) => e.getBoundingClientRect());
    const cx = (Math.min(...rects.map((r) => r.x)) + Math.max(...rects.map((r) => r.right))) / 2;
    const items = texts.map((e) => {
      const r = e.getBoundingClientRect();
      const mid = r.x + r.width / 2;
      return { text: (e.textContent || "").trim(), side: mid < cx - 10 ? "RECV" : mid > cx + 10 ? "SENT" : "MID" };
    });
    // 重要：抖音私信 DOM 是「新→旧」排列，所以 items[0] 才是最新一条
    return { items: items.slice(0, 12) };
  });
}

// ---------- 发送 ----------
function sendViaScript(to, text) {
  return new Promise((resolve) => {
    const ps = spawn(process.execPath, [pathP("lib", "send.mjs"), `--to=${to}`, "--yes", "--send", text], {
      stdio: "inherit",
      cwd: pathP(),
      windowsHide: true,   // 不加这个，每发一条消息都会闪一个 node.exe 黑窗
    });
    ps.on("exit", (code) => resolve({ ok: code === 0, code }));
    ps.on("error", () => resolve({ ok: false, code: -1 }));
  });
}

// 提示词统一从 prompt.mjs 取，保证"控制台里改的判据/禁止话题"真的进 prompt
function buildSystemPrompt(P, R) {
  return buildChatPrompt(P || {}, R || {});
}

// ---------- 闸门自检：不调模型，只验证 checkReply ----------
const GATE = argv.find((a) => a.startsWith("--gate="));
if (GATE) {
  const s = GATE.slice("--gate=".length);
  const g = checkReply(s);
  console.log(`输入：${JSON.stringify(s)}`);
  console.log(g.ok ? `通过（${s.length} 字）` : `拦下：${g.why}`);
  process.exit(g.ok ? 0 : 1);
}

// ---------- 模拟模式：不碰浏览器、不发送，只验证"提示词 + 生成 + 安检" ----------
const SIM = argv.find((a) => a.startsWith("--simulate="));
if (SIM) {
  const incoming = SIM.slice("--simulate=".length);
  const history = [{ role: "user", content: incoming }];
  console.log("=== system prompt ===");
  const simSys = [buildSystemPrompt(loadConfig().persona, loadConfig().rules), memoryBlock(process.env.DYBOT_CONV || ""), lexiconBlock(12, { context: incoming })].filter(Boolean).join("\n\n");
  console.log(simSys);
  console.log("\n=== 收到的消息 ===");
  console.log(incoming);
  const r = await generateReply({ system: simSys, messages: history });
  console.log(`\n=== 生成（${r.mode} / ${r.model || "-"}）===`);
  console.log(r.text);
  const g = checkReply(r.text);
  console.log(`\n=== 安检 ===`);
  console.log(g.ok ? `通过（${r.text.length} 字）` : `拦下：${g.why}`);
  process.exit(g.ok ? 0 : 1);
}

// ---------- 主循环 ----------
let ctx;
try {
  ({ ctx } = await connect());
} catch (e) {
  const msg = String(e.message || e);
  if (/ECONNREFUSED|9222/.test(msg)) {
    console.error("");
    console.error("[停止] 连不上浏览器的调试端口 9222。");
    console.error("        你现在开着的 Edge 是普通模式，CDP 用不了。");
    console.error("        做法：先关掉所有 Edge 窗口，再双击 start-edge.bat（它会用调试模式重开）。");
    console.error("        注意：用 start-edge.bat 开出来的那个窗口才连得上。");
    console.error("");
    recordExitM?.("cdp-unreachable", msg.slice(0, 120));
    process.exit(9);
  }
  console.error("[停止] 连接浏览器失败：", msg);
  process.exit(9);
}
// 没有抖音页面就自己开一个：以前 create:false 会在"页面被关掉/停在空白页"时
// 静默 exit(2)，一个字都不打印 —— 表现出来就是"点启动没反应/立刻停止"。
let page = await douyinPage(ctx, { create: true });
// 启动时清掉上次遗留的临时标签页（进程被杀时来不及关，会越积越多）
try {
  const n = await cleanupStrayTabs(ctx);
  if (n) console.log(`[清理] 关掉 ${n} 个残留标签页`);
} catch {}
if (!page) {
  console.error("[停止] 找不到也开不出抖音页面：请在 Edge 里打开 douyin.com 后重试");
  emit("error", { stage: "page", message: "没有抖音页面" });
  process.exit(2);
}

// 启动护栏：没登录就别空转（重启后抖音可能掉登录）
const ls = await loginState(page).catch(() => null);
if (!ls) {
  emit("error", { stage: "login", message: "读不到登录态" });
  console.error("[停止] 读不到登录态，请检查 Edge 是否开着、抖音是否登录");
  process.exit(9);
}
if (ls.hasLoginBtn) {
  emit("error", { stage: "login", message: "看起来未登录" });
  console.error("[停止] 抖音未登录（页面出现了「登录」按钮）。请在那个 Edge 里扫码登录后重试。");
  process.exit(9);
}
// ---------- 崩溃自愈 ----------
// 实测过：抖音页面会偶发"渲染进程崩"（不是浏览器退出），表现为 evaluate 报
// "Execution context was destroyed" 或页面白屏。这里挂监听，崩了就自动重载回私信页。
let crashCount = 0;
page.on("crash", async () => {
  crashCount++;
  console.error(`[崩溃] 页面渲染进程崩了（第 ${crashCount} 次），正在恢复…`);
  emit("error", { stage: "page-crash", count: crashCount });
  if (crashCount >= 5) {
    pause("页面反复崩溃", 20 * 60 * 1000, `连续 ${crashCount} 次，可能是内存不足或风控`);
    return;
  }
  try {
    await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    lastOpenConv = null;
    lastSigClear();
    console.error("[崩溃] 已重载回私信页");
  } catch (e) {
    console.error("[崩溃] 恢复失败：", e.message);
  }
});

function lastSigClear() {
  try { Object.keys(lastSig).forEach((k) => delete lastSig[k]); } catch {}
}
emit("ready", { url: ls.url, title: ls.title });
console.log("登录态 OK：", ls.title);

console.log(`自动回复｜会话=${FRIENDS.join(" / ")}｜模式=${ONCE ? "单次" : "常驻(每" + INTERVAL + "s)"}｜发送=${SEND ? "开" : "关（预演）"}`);
const llm = loadLlm();
console.log(`模型通道：${llm.dry ? "dry（无 key，不会真调）" : llm.model + " @ " + llm.baseUrl}`);

const lastHandledBy = {};   // convName -> 已处理的消息键
const retryNoteAt = {};   // convName -> 上次提示冷却的时间（避免刷屏）
// 同类噪音 10 分钟只记一次：面板是给人看的，不是日志倾倒场
const quietUntil = {};
function shouldLog(key, ttlMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (quietUntil[key] && now < quietUntil[key]) return false;
  quietUntil[key] = now + ttlMs;
  return true;
}
let stopped = false;

// 抖音的全屏播放器弹层会盖住 /chat，挡住点击又不让消息区渲染 —— 每次 tick 先掀掉
async function dismissCover(page) {
  const n = await page.evaluate(() => {
    let c = 0;
    document.querySelectorAll("#pc-im-popup-container").forEach((e) => {
      if (e.style.display !== "none") { e.style.display = "none"; c++; }
    });
    return c;
  });
  if (n) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(700);
  }
  return n;
}
// 上下文窗口：以前固定只给最近 6 条，视频描述一长就几乎没上下文了。
// 现在按"字数预算"往前取，长消息截断，保证既有上下文又不炸 token。
function buildHistory(chrono, opts = {}) {
  const maxChars = Number(opts.maxChars || 3000);
  const maxMsgs = Number(opts.maxMsgs || 30);
  const items = (chrono || []).slice(-maxMsgs);
  const out = [];
  let acc = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    let text = String(m.text || "");
    if (!text) continue;
    if (text.length > 240) text = text.slice(0, 240) + "…";
    if (acc + text.length > maxChars && out.length >= 3) break;
    acc += text.length;
    out.unshift({ role: m.side === "RECV" ? "user" : "assistant", content: text });
  }
  return out;
}

// 读时间线：文本 / 表情包 / 视频卡片，混排后按屏幕纵向位置排序（不依赖 DOM 顺序）
// 方向用 isFromMe 类名判断（比左右坐标可靠得多）；没这个类就当对方发的。
let lastOpenConv = null;

// 新的读取实现（readMode = "new"）。旧实现保留在 readTimeline 里，可用 readMode="legacy" 回退。
// 设计原则：会话已经开着时不要再切走切回 —— 抖音本来就实时更新 DOM，
// 切走切回等于把对的弄乱再花几秒修回来（这就是"回一条纯文字很慢"的根因）。

async function _readPreviews(page) {
  return await page.evaluate(() => {
    const out = {};
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const it of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v)) {
      const t = (it.innerText || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      out[t.split(" ")[0]] = t.slice(0, 60);
    }
    return out;
  }).catch(() => ({}));
}

async function _curName(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('[class*="curConversation"]');
    const t = el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
    return t ? t.split(" ")[0] : null;
  }).catch(() => null);
}

async function _clickConv(page, name) {
  const h = await page.evaluateHandle((n) => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes(n)) || null;
  }, name).catch(() => null);
  const el = h && h.asElement ? h.asElement() : null;
  if (!el) return false;
  const box = await el.boundingBox().catch(() => null);
  await el.evaluate((node) => { try { node.scrollIntoView({ block: "center" }); } catch {} }).catch(() => {});
  await page.waitForTimeout(150);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    await page.waitForTimeout(100);
    await page.mouse.down().catch(() => {});
    await page.mouse.up().catch(() => {});
  } else {
    await el.click({ timeout: 4000 }).catch(() => {});
  }
  return true;
}

async function _readDom(page) {
  return await page.evaluate(() => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const items = [];
    const push = (el, kind, text, quote) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      let own = el, fromMe = false;
      for (let i = 0; i < 3 && own; i++) {
        if (/isFromMe/.test(String(own.className || ""))) { fromMe = true; break; }
        own = own.parentElement;
      }
      items.push({ kind, text: String(text || ""), quote: !!quote, fromMe, x: r.x, right: r.right, bottom: r.bottom });
    };
    document.querySelectorAll('[class*="pureText"]').forEach((e) => push(e, "text", (e.textContent || "").trim()));
    document.querySelectorAll(".MessageItemEmojiemojiBox").forEach((e) => push(e, "emoji", "[表情包]"));
    document.querySelectorAll(".MessageItemShareAwemecontainer").forEach((e) => {
      const a = e.querySelector('[class*="authorName"]');
      push(e, "card", `[视频] ${a ? a.textContent.trim() : ""}`);
    });
    // 转发评论卡片：内容（评论正文 + 来源）直接在 DOM 里，不需要点开
    // 转发评论卡片：卡片里就有「谁 + 评论正文 + 来源」，不需要点开任何东西
    document.querySelectorAll(".MessageItemCommentSharecontainer").forEach((e) => {
      const q = (sel) => {
        const n = e.querySelector(sel);
        return n ? (n.innerText || "").replace(/\s+/g, " ").trim() : "";
      };
      const who = q('[class*="commentTitle"]');            // "分享 @某某 的评论"
      const sec = q('[class*="commentSection"]');          // 标题 + 评论正文
      const inner = q('[class*="cardInner"]');             // 评论 + 来源
      const name = (who.match(/@\s*([^\s]+)/) || [])[1] || "";
      let comment = sec.replace(who, "").trim();          // 去掉标题，只留评论
      if (!comment) comment = (e.innerText || "").replace(/\s+/g, " ").trim();
      let source = inner.replace(sec, "").trim();         // 去掉评论，只留来源
      const text = `[评论] ${name ? "@" + name + "：" : ""}${comment}${source ? "｜来源：" + source.slice(0, 60) : ""}`;
      push(e, "comment", text, false);
    });
    document.querySelectorAll(".MessageBoxContentactiveClickArea").forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!(r.width >= 80 && r.height >= 100)) return;
      if (e.closest(".MessageItemShareAwemecontainer")) return;
      const txt = (e.innerText || "").replace(/\s+/g, " ").trim();
      push(e, "card", `[视频/卡片] ${txt.slice(0, 40)}`, /\[分享视频\]/.test(txt));
    });
    if (!items.length) return { items: [] };
    const cx = (Math.min(...items.map((m) => m.x)) + Math.max(...items.map((m) => m.right))) / 2;
    items.forEach((m) => {
      if (m.fromMe) { m.side = "SENT"; return; }
      const mid = (m.x + m.right) / 2;
      m.side = mid > cx + 15 ? "SENT" : "RECV";
    });
    const uniq = [];
    const seen = new Set();
    for (const m of items) {
      const key = m.side + "|" + Math.round(m.bottom) + "|" + Math.round(m.right);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(m);
    }
    const newestFirst = [...uniq].sort((a, b) => b.bottom - a.bottom);
    const chronological = [...uniq].sort((a, b) => a.bottom - b.bottom);
    return { newest: newestFirst[0], chronological };
  });
}

async function readTimelineNew(page, convName) {
  const t0 = Date.now();
  const previews = await _readPreviews(page);
  const pv = previews[convName] || "";
  const want = previewMessagePart(pv);

  const reloadAndOpen = async (why) => {
    console.log(`[读取] ${why} → 刷新页面`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(3200);
    await _clickConv(page, convName);
    await page.waitForTimeout(1200);
  };

  // ① 该开着的会话是否已经开着（这是常态，别乱点）
  let open = await _curName(page);
  if (open !== convName) {
    // 记住切换前最后一条，用来判断"内容真的换了"
    const before = String((((await _readDom(page)) || {}).newest || {}).text || "");
    await _clickConv(page, convName);
    // 等到内容变了再往下（只等"会话名对了"不够：实测会读到上一个会话的残留）
    const changed = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await page.waitForTimeout(350);
        const now = String((((await _readDom(page)) || {}).newest || {}).text || "");
        if (now && now !== before) return true;
      }
      return false;
    };
    const switched = await changed(3000);
    open = await _curName(page);
    if (!switched || open !== convName) {
      await reloadAndOpen(`切换后内容没变（当前 ${open ?? "空"}）`);
      open = await _curName(page);
      if (open !== convName) return { error: `切不到 ${convName}` };
    }
  }

  // ② 读 DOM（读完再确认一次会话，防止"切了但内容还是上一个"）
  let res = await _readDom(page);
  {
    const nowOpen = await _curName(page);
    if (nowOpen && nowOpen !== convName) {
      return { error: `当前会话是 ${nowOpen}，不是 ${convName}` };
    }
  }
  const got = (r) => String((r.newest || {}).text || "");

  // ③ 只在校验对不上时刷新一次（唯一的慢路径）
  if (want && !got(res).includes(want)) {
    await reloadAndOpen(`最新与预览不符（读到"${got(res).slice(0, 14)}"，预览含"${want.slice(0, 10)}"）`);
    res = await _readDom(page);
    if (want && !got(res).includes(want)) {
      return { error: `定位到最新失败（读到"${got(res).slice(0, 14)}"）` };
    }
  }

  lastOpenConv = convName;
  console.log(`[读取] ${convName} 最新="${got(res).slice(0, 18)}" ${Date.now() - t0}ms`);
  return res;
}

async function readTimeline(page, convName) {
  // 读取模式开关：新实现（默认）/ 旧实现（回退用）
  // 想回退：config.json 里 limits.readMode = "legacy"
  const mode = (() => { try { return loadConfig().limits?.readMode || "new"; } catch { return "new"; } })();
  if (mode !== "legacy") return await readTimelineNew(page, convName);
  // 会话已经开着就别重复点（省 1 秒多）；只有切会话或首次才点
  // ── 补丁① hasMessages ─────────────────────────────────────────────
  // 为什么存在：判断这个会话的消息区是不是已经渲染出来了。
  // 没有它就会：每 8 秒都重新点一次会话，慢一倍，而且点击本身有失败风险。
  // 能不能删：能。删掉后每次都点会话，功能仍正确，只是更慢更脆。
  const hasMessages = async () =>
    await page.evaluate(() => {
      const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(
        document.querySelectorAll('[class*="pureText"], .MessageItemEmojiemojiBox, .MessageItemShareAwemecontainer, .MessageBoxContentactiveClickArea')
      ).filter(v).length > 0;
    });

  // 会话列表里每个会话的最后一条消息预览：这是"有没有新消息"最可靠的信号
  // ── 补丁② readPreviews（会话列表预览）──────────────────────────────
  // 为什么存在：判断有没有新消息，以及作为「定位到最新」的比对基准。
  // 踩过的坑：预览的最后一段不一定是消息文字——
  //   · 媒体：「分享[视频]」「[图片]」
  //   · 状态：「今天在线」「离线」「正在输入」
  //   · 时间：「刚刚」「昨天」「周一」「3分钟前」
  // 所以必须过 previewMessagePart()，否则这类会话会被判成永远没定位到最新 → 每轮跳过。
  // 真实事故：某位好友的预览是「今天在线」（状态而非消息），他一条回复都没收到过。
  // 能不能删：不能。它是判断要不要处理的唯一信号源。
  const readPreviews = async () =>
    await page.evaluate(() => {
      const out = {};
      const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (const it of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v)) {
        const t = (it.innerText || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        const name = t.split(" ")[0];
        out[name] = t.slice(0, 60);
      }
      return out;
    }).catch(() => ({}));

  const previews = await readPreviews();
  const myPreview = previews[convName] || "";
  const previewChanged = !!myPreview && myPreview !== (lastPreview[convName] || "");
  lastPreview[convName] = myPreview;

  // ── 补丁③ clickConv（用元素点击，不用坐标）────────────────────────
  // 为什么存在：切会话。
  // 踩过的坑：以前用坐标点击，但会话列表会因新消息重排，坐标算完到点下去之间
  // 列表可能已经动了 → 点到别的会话 → 用别人的内容回复。
  const curName = async () =>
    await page.evaluate(() => {
      const el = document.querySelector('[class*="curConversation"]');
      const t = el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
      return t ? t.split(" ")[0] : null;
    }).catch(() => null);

  const clickConv = async (name) => {
    // 实测教训：elementHandle.click() 会因为"被遮挡/动画未稳定"超时 5 秒；
    // 而列表项本身对 DOM click 是有反应的。所以：JS 点击 → 校验 → 坐标点击 → 校验。
    const h = await page.evaluateHandle((n) => {
      const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes(n)) || null;
    }, name).catch(() => null);
    const el = h && h.asElement ? h.asElement() : null;
    if (!el) return false;

    await el.evaluate((node) => {
      try { node.scrollIntoView({ block: "center" }); } catch {}
      try { node.click(); } catch {}
    }).catch(() => {});
    await page.waitForTimeout(700);
    if ((await curName()) === name) return true;

    const box = await el.boundingBox().catch(() => null);
    if (box) {
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y).catch(() => {});
      await page.waitForTimeout(120);
      await page.mouse.down().catch(() => {});
      await page.mouse.up().catch(() => {});
      await page.waitForTimeout(800);
    }
    return true;
  };

  // 强制重渲染：切到别的会话再切回来。
  // 为什么必须这样：点"已经打开的会话"不会重新渲染，消息区会一直停在旧位置，
  // 而列表是虚拟化的（只渲染视口附近那几十条），滚到最底也未必是最新 —— 实测过。
  // ── 补丁④ bounce（切走再切回 + 最多重试 3 次）─────────────────────
  // 为什么存在：点「已经打开的会话」不会重新渲染，消息区会一直停在旧位置；
  // 而消息列表是虚拟化的（只渲染视口附近几十条），滚到最底也未必是最新
  // （实测：scrollTop=0 时可视区一条消息都没有）。
  // 所以只能靠切到别的会话再切回来，强制它重新定位到最新。
  // 能不能删：不能。删掉会出现「读到几小时前的旧视频并回复」。
  // 重构方向：最稳的替代是「每次读之前 reload 页面」（慢 4~6 秒，但确定）。
  const bounce = async () => {
    const other = Object.keys(previews).find((n) => n !== convName);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (other) {
        await clickConv(other);
        await page.waitForTimeout(600);
      }
      await clickConv(convName);
      await page.waitForTimeout(800);
      if ((await curName()) === convName) return true;
      if (process.env.DYBOT_DEBUG_READ) console.log(`[debug] 切换重试#${attempt + 1}（当前 ${await curName()}）`);
    }
    // 兜底：页面状态可能卡死（抽屉遮罩残留、列表错位）。
    // 实测：卡死时点十次也没用，刷新一次就好 —— 所以这里直接刷新重来。
    try {
      console.log("[切换] 点击无效，刷新页面后重试");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(3500);
      await clickConv(convName);
      await page.waitForTimeout(1800);
      lastOpenConv = convName;
      return true;
    } catch (e) {
      console.log("[切换] 刷新也失败：" + String(e.message || e).slice(0, 60));
      return false;
    }
  };

  // 当前打开的是哪个会话：从高亮项里取名字。读错会话会导致"用别人的消息回复"，
  // 所以下面切完必须校验。
  // ── 补丁⑤ openConvName（当前会话名校验）──────────────────────────
  // 为什么存在：切会话可能失败（列表重排/点击被遮挡）。
  // 踩过的坑：切失败后仍继续读 → 读到别的会话的内容 → 用别人的消息回复。
  // 能不能删：不能。这是「别回错人」的最后一道闸。
  const openConvName = async () =>
    await page.evaluate(() => {
      const el = document.querySelector('[class*="curConversation"]');
      if (!el) return null;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      return t ? t.split(" ")[0] : null;
    }).catch(() => null);

  // 消息区最底下那条消息的文字：用来校验"是否已经定位到最新"
  // ── 补丁⑥ bottomMessage（消息区最底下那条）────────────────────────
  // 为什么存在：给补丁⑦提供「我看到的最新一条是什么」。
  // 能不能删：只有删掉补丁⑦时才能一起删。
  const bottomMessage = async () =>
    await page.evaluate(() => {
      let el = null;
      for (const e of document.querySelectorAll("[class*=MessageList]")) {
        const over = e.scrollHeight - e.clientHeight;
        if (!el || over > el.scrollHeight - el.clientHeight) el = e;
      }
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll('[class*="pureText"], .MessageItemShareAwemecontainer, .MessageBoxContentactiveClickArea')];
      const vis = kids
        .filter((k) => { const r = k.getBoundingClientRect(); return r.bottom > box.top + 4 && r.top < box.bottom - 4; })
        .sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
      const last = vis[vis.length - 1];
      return last ? (last.innerText || "").replace(/\s+/g, " ").trim() : null;
    }).catch(() => null);

  // 一直切到"底部消息 = 列表预览里最后那条"为止。
  // 这是可自检的判据：既防"卡在旧位置读不到新消息"，也防"读到别的会话"。
  // ── 补丁⑦ settleAtNewest（定位到最新才放行）──────────────────────
  // 为什么存在：bounce 之后也可能还没渲染完，需要确认真的到最新了再读。
  // 判据：底部消息里应包含预览中的消息文字（媒体/状态/时间类预览不比对，见补丁②）。
  // 踩过的坑：最初拿「预览整段」去比对底部消息——
  //   · 媒体预览「分享[视频]」永远对不上 → 纯视频全部不处理
  //   · 状态预览「今天在线」永远对不上 → 该会话永远跳过
  // 现在：比对前先过 previewMessagePart()，为空则不比对（只校验会话名）。
  // 4 次还定位不到 → 返回 false → 上层「这轮跳过」，宁可不动也不拿旧内容回复。
  // 能不能删：能，但删掉后要接受「偶尔拿旧消息回复」的风险。

  const settleAtNewest = async () => {
    for (let i = 0; i < 4; i++) {
      // 每轮重算期望：预览可能在我们重试期间又变了
      const fresh = await readPreviews();
      const pv = fresh[convName] || previews[convName] || "";
      const want = previewMessagePart(pv).slice(0, 14);
      const tail = await bottomMessage();
      const open = await page.evaluate(() => {
        const el = document.querySelector('[class*="curConversation"]');
        const t = el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
        return t ? t.split(" ")[0] : null;
      }).catch(() => null);
      // 视频/卡片类预览没有可比文字（如「分享[视频]」），拿它校验会让纯视频永远失败
      const okConv = open === null || open === convName;
      const okTail = !want || (tail || "").includes(want);
      if (okConv && okTail) return true;
      if (process.env.DYBOT_DEBUG_READ) console.log(`[debug] 定位重试#${i + 1} 当前=${open} 底部="${String(tail).slice(0, 20)}" 期望含"${want}"`);
      const other = Object.keys(previews).find((n) => n !== convName);
      if (other) { await clickConv(other); await page.waitForTimeout(600); }
      await clickConv(convName);
      await page.waitForTimeout(900);
    }
    return false;
  };

  const needClick = lastOpenConv !== convName || !(await hasMessages());
  if (needClick) {
    const okBounce = await bounce();
    const settled = await settleAtNewest();
    if (!settled) {
      lastOpenConv = null;
      return { error: `消息区没定位到最新（${convName}），这轮跳过` };
    }
    await page.waitForTimeout(400);
    if (!okBounce) return { error: "没有目标会话" };
    lastOpenConv = convName;
    const open1 = await openConvName();
    if (process.env.DYBOT_DEBUG_READ) console.log(`[debug] bounce → ${convName} ok=${okBounce} 当前打开="${open1}"`);
    if (open1 && open1 !== convName) {
      // 切失败：宁可这轮不处理，也不能用别的会话的内容回复
      lastOpenConv = null;
      return { error: `没能切到 ${convName}（当前是 ${open1}）` };
    }
  } else if (previewChanged) {
    // 会话已经开着，但列表预览变了 → 有新消息，而消息区可能卡在旧位置。
    if (await bounce()) {
      await page.waitForTimeout(800);
      await settleAtNewest();
      lastOpenConv = convName;
      const open2 = await openConvName();
      if (open2 && open2 !== convName) {
        lastOpenConv = null;
        return { error: `没能切到 ${convName}（当前是 ${open2}）` };
      }
      console.log(`[切换] 检测到 ${convName} 有新消息，已重新打开会话`);
    }
  }


  return await page.evaluate(() => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 消息列表容器：用来判断"这条消息是否真的在可视区里"
    let listBox = null;
    for (const el of document.querySelectorAll("[class*=MessageList]")) {
      const over = el.scrollHeight - el.clientHeight;
      if (over > 20 && (!listBox || over > listBox.scrollHeight - listBox.clientHeight)) listBox = el;
    }
    const box = listBox ? listBox.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const items = [];

    const push = (el, kind, text, quote) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      // isFromMe 在元素自身或 2 层祖先上
      let own = el, fromMe = false;
      for (let i = 0; i < 3 && own; i++) {
        if (/isFromMe/.test(String(own.className || ""))) { fromMe = true; break; }
        own = own.parentElement;
      }
      const visible = r.bottom > box.top + 4 && r.top < box.bottom - 4;
      items.push({ kind, text, quote: !!quote, fromMe, x: r.x, right: r.right, bottom: r.bottom, visible });
    };

    document.querySelectorAll('[class*="pureText"]').forEach((e) => push(e, "text", (e.textContent || "").trim()));
    document.querySelectorAll(".MessageItemEmojiemojiBox").forEach((e) => push(e, "emoji", "[表情包]"));
    document.querySelectorAll(".MessageItemShareAwemecontainer").forEach((e) => {
      const a = e.querySelector('[class*="authorName"]');
      push(e, "card", `[视频] ${a ? a.textContent.trim() : ""}`);
    });
    // 第二种卡片（新类名）：MessageBoxContentactiveClickArea，尺寸像卡片、里面有图
    document.querySelectorAll(".MessageBoxContentactiveClickArea").forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!(r.width >= 80 && r.height >= 100)) return;
      if (e.closest(".MessageItemShareAwemecontainer")) return;
      const txt = (e.innerText || "").replace(/\s+/g, " ").trim();
      // 只有带「XX：[分享视频]」标记的才是"引用"（留言在卡片里）
      push(e, "card", `[视频/卡片] ${txt.slice(0, 40)}`, /\[分享视频\]/.test(txt));
    });

    if (!items.length) return { items: [] };
    // 方向：**每条独立判断**
    const cx = (Math.min(...items.map((m) => m.x)) + Math.max(...items.map((m) => m.right))) / 2;
    items.forEach((m) => {
      if (m.fromMe) { m.side = "SENT"; return; }
      const mid = (m.x + m.right) / 2;
      m.side = mid > cx + 15 ? "SENT" : "RECV";
    });

    // 去重：两个选择器可能命中同一张卡片
    const uniq = [];
    const seenPos = new Set();
    for (const m of items) {
      const key = m.side + "|" + Math.round(m.bottom) + "|" + Math.round(m.right);
      if (seenPos.has(key)) continue;
      seenPos.add(key);
      uniq.push(m);
    }

    // 只用"可视"会丢掉卡片（卡片高，常被判不可见）→ 改成用全部 DOM 消息；
    // 可视标记保留在 m.visible 里，仅用于诊断。
    const newestFirst = [...uniq].sort((a, b) => b.bottom - a.bottom);
    const chronological = [...uniq].sort((a, b) => a.bottom - b.bottom);
    const visCount = uniq.filter((m) => m.visible).length;
    return { newest: newestFirst[0], chronological, visCount };
  });
}
// 给一次视频读取补上「抖音 AI 总结」（受实验室开关控制）。
// 视频分支和转发评论分支共用：AI 总结只需要 video_id，不关心视频是怎么打开的。
// opts.preLine: 拿到总结前要不要先回一句（视频场景要，评论场景不要，免得刷屏）
async function attachAiSummary(convName, videoId, content, opts = {}) {
  const labCfg = (() => { try { return loadConfig().lab?.aiSummary || {}; } catch { return {}; } })();
  if (labCfg.enabled !== true || !videoId) return false;
  try {
    const pre = String(labCfg.preLine || "").trim();
    if (opts.preLine !== false && pre) {
      const r0 = await sendViaScript(convName, pre);
      console.log(r0.ok ? `[AI总结] 先回了一句「${pre}」` : `[AI总结] 那句没发出去（码 ${r0.code}），继续取总结`);
    }
    const sumTab = await page.context().newPage();
    try {
      const s = await fetchAiSummary(sumTab, videoId, { maxWaitMs: Number(labCfg.maxWaitMs || 40000) });
      if (s.ok) {
        content.aiSummary = s.text;
        console.log(`[AI总结] 拿到 ${s.text.length} 字（${s.ms}ms）`);
        emit("video-summary", { conv: convName, id: videoId, ok: true, chars: s.text.length, ms: s.ms });
        return true;
      }
      console.log(`[AI总结] 失败${s.softFail ? "（软失败：AI 没给真总结）" : ""}：${s.error}`);
      emit("video-summary", { conv: convName, id: videoId, ok: false, soft: !!s.softFail, error: s.error });
      return false;
    } finally {
      try {
        if (page.context().pages().length > 1) await sumTab.close();
        else await sumTab.goto("about:blank");
      } catch {}
    }
  } catch (e) {
    console.log("[AI总结] 异常：" + String(e.message || e).slice(0, 60));
    return false;
  }
}

// 看完视频后"要不要点赞"：复用评分表，但用更高的门槛（点赞比转发更随意，容易滥）。
// 关键：**在回复发出之后才调用**，绝不拖慢回复。
// 默认 dryRun（只记录不点），你确认几十条都合理后再关掉 dryRun。
// 这条视频最近有没有点过（成功或尝试过）。
// 为什么必须查：点赞按钮点了之后如果判不出状态，再点一次就变成「取消赞」，
// 对方能看到赞消失 —— 比不点更糟。所以同一条视频 24 小时内只允许尝试一次。
function likeAttemptedBefore(id, withinMs = 24 * 3600 * 1000) {
  try {
    const f = pathP("state", "likes.jsonl");
    if (!fs.existsSync(f)) return null;
    const since = Date.now() - withinMs;
    const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && String(e.id) === String(id) && (e.clicked || e.attempted));
    for (let i = rows.length - 1; i >= 0; i--) {
      if (new Date(rows[i].ts).getTime() > since) return rows[i];
    }
  } catch {}
  return null;
}
function likeCap() {
  const n = Number((() => { try { return loadConfig().lab?.autoLike?.dailyCap ?? 10; } catch { return 10; } })());
  return Math.max(0, Math.min(20, Number.isFinite(n) ? n : 10));   // 硬上限 20
}

function likesToday() {
  try {
    const f = pathP("state", "likes.jsonl");
    if (!fs.existsSync(f)) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.clicked && String(e.ts || "").slice(0, 10) === today).length;
  } catch { return 0; }
}

// 查这条视频上次读到的内容（标题/时长）。
// 为什么要这个：视频被判"已处理过"时不会重读，模型只看到一句催回复的话，
// 于是回「视频打不开」（用户实测过）。带上已知标题就能正常接话。
function cachedVideoInfo(id) {
  try {
    const f = pathP("state", "events.jsonl");
    if (!fs.existsSync(f)) return null;
    const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(rows[i]);
        if (e && e.type === "video-seen" && String(e.id) === String(id)) {
          return { title: e.title || "", duration: e.duration || null };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function maybeAutoLike(convName, videoId, content) {
  const cfgL = (() => { try { return loadConfig().lab?.autoLike || {}; } catch { return {}; } })();
  if (cfgL.enabled !== true || !videoId) return;
  const dryRun = cfgL.dryRun !== false;          // 默认预演
  const minScore = Number(cfgL.minScore || 24);
  console.log(`[点赞] 开始判断 ${videoId}（${dryRun ? "预演，不会真点" : "真实模式"}，门槛 ${minScore} 分）`);

  const cap = likeCap();
  if (!dryRun && likesToday() >= cap) {
    console.log(`[点赞] 今日已达上限 ${cap}，跳过`);
    emit("like-skip", { conv: convName, id: videoId, reason: "daily-cap", cap });
    return;
  }

  try {
    // 复用判据，但把"通过线"抬到 minScore
    const scoring = (() => {
      const base = (() => { try { return loadConfig().rules?.scoring || {}; } catch { return {}; } })();
      return { ...base, enabled: true, sendAt: minScore };
    })();
    const j = await judgeVideo({ ...content, conv: convName, id: videoId }, { scoring });
    const score = Number(j.score || 0);
    const pass = score >= minScore;
    console.log(`[点赞] 评分 ${score}（门槛 ${minScore}）→ ${pass ? "可以点" : "不点"}`);

    if (!pass) {
      // 没到门槛也要留一条记录：否则面板上永远是空的，你根本看不到"它判过但没点"
      try {
        fs.appendFileSync(pathP("state", "likes.jsonl"), JSON.stringify({
          ts: new Date().toISOString(), conv: convName, id: videoId,
          score, minScore, dryRun, clicked: false, already: false, ok: true,
          skipped: "low-score", error: null,
        }) + "\n", "utf8");
      } catch {}
      emit("like-skip", { conv: convName, id: videoId, reason: "low-score", score, minScore });
      return;
    }

    // 同一条视频 24 小时内只尝试一次：点了判不出状态时再点就成「取消赞」了
    const doneBefore = likeAttemptedBefore(videoId);
    if (doneBefore) {
      console.log("[点赞] 这条视频 24 小时内已经点过/试过，跳过");
      emit("like-skip", { conv: convName, id: videoId, reason: "same-video-attempted" });
      return;
    }

    const tab = await page.context().newPage();
    let r;
    try {
      r = await likeVideo(tab, videoId, { dryRun });
    } finally {
      try {
        if (page.context().pages().length > 1) await tab.close();
        else await tab.goto("about:blank");
      } catch {}
    }

    const rec = {
      ts: new Date().toISOString(),
      conv: convName,
      id: videoId,
      score,
      minScore,
      dryRun,
      clicked: !!r.clicked,
      verified: !!r.verified,
      by: r.by || null,
      apiAfter: typeof r.apiAfter === "number" ? r.apiAfter : null,
      attempted: !!r.attempted,
      already: !!r.already,
      ok: !!r.ok,
      error: r.error || null,
    };
    try { fs.appendFileSync(pathP("state", "likes.jsonl"), JSON.stringify(rec) + "\n", "utf8"); } catch {}
    emit(r.ok ? "like" : "like-fail", { conv: convName, id: videoId, score, dryRun, clicked: !!r.clicked, already: !!r.already, error: r.error || null });
    console.log(`[点赞] ${dryRun ? "预演" : "已点"}：${r.ok ? (r.already ? "之前已赞" : r.clicked ? "点了" : "未点") : "失败：" + r.error}`);
  } catch (e) {
    console.log("[点赞] 异常：" + String(e.message || e).slice(0, 80));
  }
}
async function extractAndRemember(convName, history, replyText) {
  try {
    const r = await generateReply({
      system: [
        "从这段对话里判断：有没有「一周之后还用得上」的信息，只抽这一类。",
        "【要记】身份职业、长期在做的事、正在学的技能、明确计划、稳定的喜好或厌恶、生活状况。",
        "【绝不记】今天的临时状态、一次性动作、对某个视频或内容的评价、玩笑口头禅、对话原句、临时情绪。",
        "他明说或明显暗示的偏好也算（如「我还是吃小蛋糕吧」→ 他喜欢小蛋糕）。",
        "最多 2 条，不超过 20 字，以「他」开头，一行一条。拿不准就输出 NONE。只输出事实本身，不要聊天。",
      ].join("\n"),
      // 关键：最后一条必须是 user，否则模型会接着"她"的话继续聊天，
      // 根本不做抽取（这是记忆长期为空的原因）
      messages: [
        ...history.slice(-12),
        { role: "assistant", content: replyText },
        { role: "user", content: "按上面的规则抽取关于他的事实。一行一条，没有就只回 NONE。不要聊天、不要解释。" },
      ],
      maxTokens: 80,
    });
    const lines = String(r.text || "")
      .split("\n")
      .map((x) => x.replace(/^[-·•\d.、)\s]+/, "").trim())
      .filter(Boolean)
      .filter((x) => !/^NONE$/i.test(x));
    if (!lines.length) {
      emit("memory-none", { conv: convName });
      return;
    const r2 = addFacts(convName, lines.slice(0, 2), { strict: true });   // 最多 2 条 + 严格过滤
    if (r2.added) {
      console.log("[记忆] 新增 " + r2.added + " 条：" + lines.slice(0, 2).join(" / "));
      emit("memory", { conv: convName, added: lines.slice(0, 2) });
    } else if (r2.rejected && r2.rejected.length) {
      emit("memory-rejected", { conv: convName, items: r2.rejected });
    }
    }
  } catch (e) {
    console.log("[记忆] 抽取失败（不影响回复）：", e.message);
    try { emit("error", { stage: "memory", conv: convName, message: String(e.message).slice(0, 120) }); } catch {}
  }
}
// 这条视频以前处理过吗（读事件流，跨重启生效）
// 去重窗口：默认 1 小时（以前写死 24 小时 —— 你过一会儿重发同一条视频她就不看了）
function videoHandledBefore(id, withinMs) {
  if (!withinMs) {
    const h = Number((() => { try { return loadConfig().limits?.videoDedupeHours ?? 1; } catch { return 1; } })());
    withinMs = Math.max(0, Math.min(168, Number.isFinite(h) ? h : 1)) * 3600 * 1000;
  }
  try {
    const lines = fs.readFileSync(pathP("state", "events.jsonl"), "utf8").split("\n").filter(Boolean);
    const since = Date.now() - withinMs;
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && (e.type === "video-sent") && String(e.id) === String(id))
      .some((e) => new Date(e.ts).getTime() > since);
  } catch { return false; }
}
async function tickSetup() {
  // 上一轮处理视频后可能停在详情页，先回私信页
  if (!page.url().includes("/chat")) {
    await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2800);
    lastOpenConv = null; // 页面换了，会话状态要重来
  }
  const covered = await dismissCover(page);
  if (covered) console.log("[清理] 掀掉 " + covered + " 个残留弹层");
}

// 便宜的会话预览读取：不点开会话，只读左侧列表那一行的最后一条消息摘要
async function previewOf(page, name) {
  return await page.evaluate((n) => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v);
    const t = items.find((e) => (e.innerText || "").includes(n));
    if (!t) return null;
    let s = (t.innerText || "").replace(/\s+/g, " ").trim();
    if (s.startsWith(n)) s = s.slice(n.length).trim();
    s = s.replace(/^(\d+分钟前|\d+小时前|昨天(\s*\d{1,2}:\d{2})?|前天(\s*\d{1,2}:\d{2})?|刚刚|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)\s*/, "");
    return s;
  }, name);
}

// 旧版遗留变量（不再用于判断新消息，预览数据不可靠）
const mediaCheckAt = {};  // 旧版遗留，保留变量避免引用报错
const lastSig = {};      // convName -> 上次看到的时间线签名（条数|种类|文字）
const cardRetryAt = {};
const cardGiveUpAt = {};
const lastIdleDump = {};   // 空闲诊断节流
const lastPreview = {};      // convName -> 上次看到的会话列表预览（判断有没有新消息）
let rotationIdx = 0;
const limitedConvs = new Set();
const videoAskCooldown = {};   // convName -> 下次可以再给视频的时间

// ---------- 风控暂停 ----------
let pausedUntil = 0;          // 暂停到这个时间点（毫秒）
let pauseReason = "";
let consecutiveSendFails = 0; // 连续发送失败次数
const CAPTCHA_PAUSE_MS = 30 * 60 * 1000;  // 弹验证 → 停 30 分钟
const FAIL_PAUSE_MS = 10 * 60 * 1000;     // 连续失败 → 停 10 分钟

function pause(reason, ms, detail) {
  pausedUntil = Date.now() + ms;
  pauseReason = reason;
  lastPauseReasonM = reason;
  console.error(`[暂停] ${reason}${detail ? "｜" + detail : ""}　恢复时间 ${new Date(pausedUntil).toLocaleTimeString()}`);
  emit("paused", { reason, minutes: Math.round(ms / 60000), resumeAt: new Date(pausedUntil).toISOString(), detail: detail || null });
}
// 会话列表预览的最后一段，不一定就是消息文字：
// 可能是「今天在线」「周一」「刚刚」这类状态/时间，也可能是「分享[视频]」这类媒体占位。
// 拿它去做"是否定位到最新"的比对，会让这类会话永远判失败（实测：预览是「今天在线」）。
function previewMessagePart(pv) {
  const t = String(pv || "").trim();
  if (!t) return "";
  const last = (t.split(" ").pop() || "").trim();
  if (!last) return "";
  if (last.includes("[")) return "";
  if (/(在线|离线|输入中|正在输入|已读|未读)$/.test(last)) return "";   // 「今天在线」「昨天在线」都算状态
  if (/^(刚刚|昨天|前天|周[一二三四五六日])$/.test(last)) return "";
  if (/^\d+(秒|分钟|小时|天)前$/.test(last)) return "";
  return last.length >= 2 ? last : "";
}

const MEDIA_PREVIEW_RE = /\[(?:分享)?(?:视频|图片|表情|语音|红包)\]|分享\[(?:视频|图片)\]/;
const MEDIA_RECHECK_MS = 120 * 1000;   // 媒体消息预览不带内容，2 分钟内最多复查一次

// 卡片自带的文字里既有留言，也有「XX：[分享视频]」这个标记，留言要剥出来
function captionFromCard(text) {
  return String(text || "")
    .replace(/\s*[^：:\s]{1,20}\s*[：:]\s*\[分享视频\]\s*$/, "")
    .replace(/\s*\[分享视频\]\s*$/, "")
    .replace(/\s*\[视频\/卡片\]\s*/, "")
    .trim();
}

async function tickOne(convName) {
  let forceLearn = false;   // 他说「学会了没」时立刻学一次
  // 每个会话独立一次：配置每轮重读，控制台改完立刻生效
  const cfgNow = loadConfig();
  const P = cfgNow.persona || {};

  // 直接读时间线来判断"有没有新消息"。
  // 不能用会话列表的预览：实测它会停留在旧消息上（列表显示"[分享视频]"，
  // 而会话里最新其实是我自己的回复），拿它做"没变化就跳过"会漏掉新消息。
  const tl = await readTimeline(page, convName);
  if (tl.error) {
    if (shouldLog("notfound:" + convName)) {
      console.log("[跳过] " + convName + "：" + tl.error + "（昵称不一致，或还没互关/聊过）");
      emit("skip", { conv: convName, reason: "conv_not_found", hint: tl.error });
    }
    return;
  }
  if (!tl.newest) {
    emit("skip", { conv: convName, reason: "no-messages" });
    return;
  }

  const chrono = tl.chronological || [];

  // 他"转发视频并留言"有两种落法：卡片带留言（同一条）、或先卡片后文字。
  // 共同点：**卡片比我上一条回复更新** → 那就是我还没看过的视频。
  const lastMine = [...chrono].reverse().find((m) => m.side === "SENT");
  const mineBottom = lastMine ? lastMine.bottom : -1e9;
  const freshCards = chrono.filter((m) => m.kind === "card" && m.side === "RECV" && m.bottom > mineBottom + 2);
  if (process.env.DYBOT_DEBUG_READ) {
    console.log(`[debug] ${convName} 全量=${chrono.length} 可视=${tl.visCount ?? "?"} 新卡片=${freshCards.length} newest=${tl.newest.kind}/${tl.newest.side}:"${String(tl.newest.text || "").slice(0, 16)}"`);
  }
  const newestIsCard = tl.newest.kind === "card";
  // 转发评论：卡片里就有评论原文和来源，不需要打开任何东西（比视频快得多）
  const newestIsComment = tl.newest.kind === "comment";
  const freshComments = chrono.filter((m) => m.kind === "comment" && m.side === "RECV" && m.bottom > mineBottom + 2);
  const pendingComment = !newestIsComment && !newestIsCard && freshComments.length > 0 ? freshComments[freshComments.length - 1] : null;
  const pendingCard = !newestIsCard && freshCards.length > 0 ? freshCards[freshCards.length - 1] : null;
  const sig = `${chrono.length}|${tl.newest.kind || ""}|${String(tl.newest.text || "").slice(0, 30)}`;
  if (lastSig[convName] === sig) {
    emit("idle", { conv: convName, unchanged: true, kind: tl.newest.kind, text: String(tl.newest.text || "").slice(0, 40) });
    return;
  }

  if (tl.newest.side !== "RECV") {
    console.log(`[空闲] ${convName} 最新是${tl.newest.side === "SENT" ? "我发的" : "中间态"}：${String(tl.newest.text || "").slice(0, 30)}`);
    emit("idle", { conv: convName, lastSide: tl.newest.side, text: String(tl.newest.text || "").slice(0, 40) });
    // 诊断：空闲时把末尾 3 条打出来（每会话 60 秒最多一次），用于查"为什么看不到新消息"
    if (Date.now() > (lastIdleDump[convName] || 0)) {
      lastIdleDump[convName] = Date.now() + 60000;
      const tail = (tl.chronological || []).slice(-3).map((m) => `${m.side}:${String(m.text || "").slice(0, 18)}`).join(" | ");
      console.log(`[空闲] 末尾3条：${tail}`);
    }
    lastSig[convName] = sig;
    return;
  }

  let incomingText = tl.newest.text;

  // ---------- 看不到图：别猜画面 ----------
  // 我们没有识图能力，模型却会"看图说话"编内容。这里直接把事实写进消息里。
  const rawIncoming = String(tl.newest.text || "");   // 原始文本：日志用它，避免把注入写进记录
  const isMediaOnly = tl.newest.kind === "emoji" || /^\[(表情包|图片|语音|视频)\]$/.test(String(incomingText || "").trim());
  if (isMediaOnly) {
    incomingText = `${incomingText || "[图片]"}（这是一张图片/表情包，你看不到画面内容。别猜画面是什么，也别描述它；可以顺着情绪回一句，或者说"这个我看不到"）`;
  }

  // ---------- 禁用词通道：他在私信里说"以后别说 XX" ----------
  // 为什么要有：他这句话只在对话历史里有效，历史滚出窗口（或重启）就失效，
  // 而词库是持久注入 → 会复发。所以这里把它落盘成硬规则。
  {
    const banCmd = /^\s*(?:以后|从此)?\s*(?:别再|别|不要|不许|不准|禁止)\s*(?:再)?\s*(?:说|用|提|讲|叫|喊)\s*[「“\"]?([^\s」「”\"'，。！？,.!?]{1,8})/;
    // 收紧：必须"整句就是一句命令"（短句、以禁止词开头、不含"例子/比如"）；
    // 否则「什么不提了，我这是给你举个例子」这种也会被当成禁词命令（实测误伤）。
    const isJustCmd = (x) => x.length <= 30 && !/(例子|比如|举例|例如|假如|如果)/.test(x);
    const mBan = isJustCmd(String(incomingText || "")) ? String(incomingText || "").match(banCmd) : null;
    if (mBan && mBan[1]) {
      // "以后别叫我哥哥" 会捕获到"我哥哥" → 去掉引导代词；"这个词/那个词" 视为无效
      let word = mBan[1].replace(/^(这个|那个|这词|这词儿)$/, "").trim();
      if (word.length > 2) word = word.replace(/^[我你他]/, "");
      if (word && word.length >= 1) {
        banTerm(word, "用户在私信里要求");
        emit("lexicon-ban", { conv: convName, term: word });
        console.log(`[禁词] 记住了：以后不说「${word}」`);
        const ack = ["行 不说这个", "好 不提了", "成 那个词我禁了"][Math.floor(Math.random() * 3)];
        await sendViaScript(convName, ack);
        lastSig[convName] = `${(tl.chronological || []).length}|${tl.newest.kind || ""}|${String(incomingText).slice(0, 30)}`;
        return;
      }
    }

  // ---------- 教词通道：他主动让"记住这个词" ----------
  // 以前只能等她自己在聊天里学（每 12 次回复才学一次）；现在他说一句就能立刻入库。
  {
    const tTeach = String(incomingText || "");
    // 他在问"学会了没"= 想确认；这时候别等节流，立刻抽一次词
    if (/(学会|记住|懂了|知道)了?(没|吗|么)|学到了?(没|吗)|考考你/.test(tTeach)) forceLearn = true;
    let term = "", meaning = "";
    const m1 = tTeach.match(/(?:教你(?:个|一个)?(?:新)?词|教一下|记住|记一下|记着|学一下|学学|学着点)\s*(?:这个词|这词|一个词)?\s*[：:「“"]?\s*([^\s，。！？,.!?」”"]{1,12})/);
    const m2 = tTeach.match(/([^\s，。！？,.!?「」“”"]{2,12})\s*(?:的意思|意思是|就是说|指的是)\s*(.{2,40})/);
    // ③ 「大家都管猫叫哈基米」——隐式教学：管 X 叫 Y
    const m3 = tTeach.match(/(?:管|把|称)[^，。！？,.!?]{0,8}叫\s*([^\s，。！？,.!?「」“”"]{2,8})/);
    // ④ 「老吴是猫的外号」——X 是…的外号/梗/说法
    const m4 = tTeach.match(/([^\s，。！？,.!?「」“”"]{2,8})\s*(?:是|就是)[^，。！？,.!?]{0,10}(?:外号|梗|黑话|说法|叫法)/);
    if (m1 && m1[1] && m1[1] !== "这个词") term = m1[1];
    else if (m2 && m2[1]) { term = m2[1]; meaning = m2[2]; }
    else if (m3 && m3[1]) { term = m3[1]; meaning = "从聊天里学到的说法"; }
    else if (m4 && m4[1]) { term = m4[1]; meaning = "从聊天里学到的说法"; }
    term = String(term || "").trim();
    term = term.replace(/^(所以|那|这|然后|就|是|而且|但是|不过)/, "");
    term = term.replace(/(或者|和|与|、|\/).*$/, "");
    if (term.length >= 4) term = term.replace(/[的了]$/, "");   // 短词不剥（"卡了"别变成"卡"）
    if (term) {
      const rr = addTerm({ term, meaning, conv: convName, source: tTeach.slice(0, 40) });
      if (rr.added || String(rr.reason || "").includes("累加")) {
        console.log(`[教词] 学到：${term}${meaning ? "＝" + meaning.slice(0, 20) : ""}`);
        emit("lexicon-teach", { conv: convName, term, meaning });
        const ack2 = ["行 学到了", "哦这样 记住了", "记下了 以后会用"][Math.floor(Math.random() * 3)];
        await sendViaScript(convName, ack2);
        // 意思没抓到 → 用他这句话问一次模型补上（否则词库里只有词、没有意思）
        if (!meaning) {
          try {
            const rm = await generateReply({
              system: "给一个网络用语写含义。只输出一行 6~16 字的含义，不要解释、不要引号、不要重复那个词。",
              messages: [{ role: "user", content: `词：${term}\n他当时的原话：${tTeach.slice(0, 80)}` }],
              maxTokens: 50,
            });
            const mm = String(rm.text || "").trim()
              .replace(/[（(]\s*不确定\s*[)）]/g, "")
              .replace(/^["'「」]+|["'「」]+$/g, "")
              .slice(0, 40);
            if (mm && !/^(不确定|NONE|无法判断)$/i.test(mm)) {
              setMeaning(term, mm);
              console.log(`[教词] 补上意思：${term}＝${mm}`);
            }
          } catch {}
        }
        lastSig[convName] = `${(tl.chronological || []).length}|${tl.newest.kind || ""}|${tTeach.slice(0, 30)}`;
        return;
      }
    }
  }
  }
  // 去重键：文本短、表情包内容全一样（连续发两个会被误判成"已处理"），
  // 所以键里带上"时间线总条数"，条数变了就是新消息。
  let handleKey = `${(tl.chronological || []).length}|${tl.newest.kind}|${incomingText}`;
  let history;
  let likeMeta = null;   // 视频内容快照，供回复之后再判点赞
  let cardId = null;

  // ---------- 他主动要视频 ----------
  // 以前只能从控制台点"转发"；现在私信里直接要，她自己挑一条发过去（不判"有没有意思"，只守硬线）。
  const WANT_VIDEO_RE = /(给我|帮我)?(发|转|来|整)(点|几|个|条)?(视频|片子|好玩的|好看的)|有什么(好看|好玩)的(视频|东西)?|来点视频/;
  if (tl.newest.kind === "text" && WANT_VIDEO_RE.test(String(incomingText)) && Date.now() > (videoAskCooldown[convName] || 0)) {
    videoAskCooldown[convName] = Date.now() + 20 * 60 * 1000;
    console.log(`\n[他要视频] ${convName}：${String(incomingText).slice(0, 40)}`);
    emit("video-request", { conv: convName, text: String(incomingText).slice(0, 60) });
    // 先回一句，别让他干等（挑视频要 1~2 分钟）。发不出去要重试，不能默默跳过。
    const acks = ["等等 找找", "行 挑一个", "等着 我翻翻"];
    const ackText = acks[Math.floor(Math.random() * acks.length)];
    let ackRes = await sendViaScript(convName, ackText);
    if (!ackRes.ok) {
      console.log("[他要视频] 先回那句失败（码 " + ackRes.code + "），重试一次");
      await new Promise((r) => setTimeout(r, 1200));
      ackRes = await sendViaScript(convName, ackText);
    }
    console.log(ackRes.ok ? "[他要视频] 已回「" + ackText + "」，开始挑视频" : "[他要视频] 那句没发出去（码 " + ackRes.code + "），仍然去挑视频");
    emit("video-request-ack", { conv: convName, text: ackText, ok: ackRes.ok, code: ackRes.code });
    const res = await runDigestChild({ max: 6, top: 1, only: convName, relax: true });
    console.log(res.ok ? "[他要视频] 已发出一条" : `[他要视频] 失败，退出码 ${res.code}`);
    emit(res.ok ? "video-request-done" : "video-request-fail", { conv: convName, code: res.code });
    if (!res.ok) {
      // 别让他等到最后没动静：按原因补一句人话
      const why = ({
        10: "今天的视频额度用完了 明天再给你找",
        11: "刷了半天没碰到合适的 过会儿再要",
        12: "挑到的都是发过的 换点时间再试",
      })[res.code] || "这边卡住了 等下再试";
      await sendViaScript(convName, why);
      emit("video-request-explain", { conv: convName, why });
    }
    lastSig[convName] = sig;
    return;
  }
  // ---------- 他转发了评论：卡片里就有原文，直接读，不用点开 ----------
  const commentItem = newestIsComment ? tl.newest : pendingComment;
  if (commentItem) {
    const raw = String(commentItem.text || "").replace(/^\[评论\]\s*/, "").trim();
    // 卡片形如：@某某：评论正文｜来源：来自图文 #话题 文案
    const [cmtPart, srcPartRaw] = raw.split("｜来源：");
    const srcPart = String(srcPartRaw || "").trim();
    // 实测：这类卡片在私信里点不开（JS 点击、坐标点击都不跳转、也不弹播放器），
    // 所以只能拿到评论文字和来源那一行。必须明确告诉模型"你没看过原视频"，
    // 否则它会顺着评论瞎猜视频情节（用户反馈过）。
    incomingText = [
      "他转发了一条别人的评论给你：",
      `评论：${String(cmtPart || "").trim()}`,
      ...(srcPart ? [`来源（你只知道这一行）：${srcPart}`] : []),
      "",
      "注意：你看不到原视频，只能看到上面这些文字。",
      "所以：只就评论本身接话，或者顺着来源那句话聊；**不要编造视频里的情节，也不要假装看过**。",
      "如果好奇，可以直接问他“原视频到底啥样”。",
    ].join("\n");
    history = buildHistory((tl.chronological || []).slice(0, -1), {
      maxChars: Number((() => { try { return loadConfig().limits?.historyChars || 3000; } catch { return 3000; } })()),
      maxMsgs: Number((() => { try { return loadConfig().limits?.historyMsgs || 30; } catch { return 30; } })()),
    });
    history.push({ role: "user", content: incomingText });
    console.log(`[收到评论] ${raw.slice(0, 60)}`);
    // 先试着按「视频的方式」打开源视频（推荐页 → 打开浮窗 → 点卡片）。
    // 用户实测：在推荐页点评论卡片，视频会在推荐流里打开并带出评论区。
    // 打不开就退回诚实模式（只聊评论，不编视频内容）。
    try {
      const cv = await getNewestIncomingCardId(page, convName);
      if (cv && cv.id) {
        const vc = await readVideoContent(page, cv.id);
        if (vc && (vc.title || (vc.chapterLines || []).length)) {
          incomingText += `\n\n【源视频内容（你真的看到了）】\n` + describeVideo({ author: cv.author, id: cv.id, ...vc }).slice(0, 900);
          console.log(`[收到评论] 顺带看到了源视频：${String(vc.title || "").slice(0, 40)}`);
          emit("comment-source-video", { conv: convName, id: cv.id, title: vc.title || null });
          // 视频内容 + AI 总结一起用：总结能补上「整片讲了什么」，正文只有标题/章节/热评
          await attachAiSummary(convName, cv.id, vc, { preLine: false });
          if (vc.aiSummary) {
            incomingText += `\n\n【抖音AI总结（整片内容，最可靠）】\n` + String(vc.aiSummary).slice(0, 1200);
            console.log(`[收到评论] 已附上 AI 总结 ${String(vc.aiSummary).length} 字`);
          }
        }
      }
    } catch (e) {
      console.log("[收到评论] 打不开源视频（不影响回复）：" + String(e.message || e).slice(0, 60));
    }
    // 视频流程会跳到推荐页；不管成功失败都回到私信页，否则下一轮读不到会话
    try {
      if (!/\/chat/.test(page.url())) {
        await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      lastOpenConv = null;
    } catch {}
    emit("comment-seen", { conv: convName, text: raw.slice(0, 120) });
  } else cardBranch: if (tl.newest.kind === "card" || pendingCard) {
    // 两种完全不同的形态，都要支持：
    //  ① 引用视频：留言被塞进卡片文字里（"看这个 张三：[分享视频]"）——留言和视频是同一条
    //  ② 分享视频+留言：卡片和留言是两条独立消息，且顺序不定（留言可能在上面，也可能在下面）
    const anchor = pendingCard || tl.newest;
    const anchorItem = pendingCard || tl.newest;
    // 只有引用卡（带 [分享视频] 标记）的文字才是留言；普通分享卡的文字是作者名
    const embedded = anchorItem.quote ? captionFromCard(anchorItem.text) : "";

    const NEAR_PX = 60;
    const adjacent = chrono
      .filter((m) => m.side === "RECV" && m.kind === "text")
      .filter((m) => {
        const gapAbove = Math.abs(m.bottom - anchor.top);
        const gapBelow = Math.abs(m.top - anchor.bottom);
        const overlap = m.bottom > anchor.top && m.top < anchor.bottom;
        return gapAbove < NEAR_PX || gapBelow < NEAR_PX || overlap;
      })
      .map((m) => String(m.text || "").trim())
      .filter(Boolean);

    const parts = [embedded, ...adjacent].filter((t) => t && t !== "[视频]" && t !== "[视频/卡片]");
    const captionText = [...new Set(parts)].join(" / ").slice(0, 120);
    const shape = embedded && adjacent.length ? "引用+留言" : embedded ? "引用" : adjacent.length ? "视频+单独留言" : "纯视频";
    console.log(`\n[收到视频] 形态=${shape}${captionText ? "　留言=" + captionText : ""}`);
    // 失败后 60 秒内不再尝试，否则每 3 秒跳一次推荐流，页面疯狂来回跳
    const retryAt = cardRetryAt[convName] || 0;
    if (Date.now() < retryAt) {
      emit("idle", { conv: convName, cooling: true, kind: "card", retryInSec: Math.round((retryAt - Date.now()) / 1000) });
      return;
    }
    const got = await getNewestIncomingCardId(page, convName);
    if (got.error) {
      console.log("[失败] 打开卡片失败：", got.error, "（60 秒后重试）");
      if (got.detail) console.log("[失败] 诊断：" + JSON.stringify(got.detail).slice(0, 220));
      emit("error", { stage: "opencard", message: got.error, retryInSec: 60, detail: got.detail || null });
      lastSig[convName] = sig;
      cardRetryAt[convName] = Date.now() + 60 * 1000;
      // 别装死：打不开就回一句让他重发（同一会话 10 分钟内只说一次，避免刷屏）
      if (Date.now() > (cardGiveUpAt[convName] || 0)) {
        cardGiveUpAt[convName] = Date.now() + 10 * 60 * 1000;
        const line = ["打不开 你重发一次", "这个我这边没加载出来 再发一遍", "卡住了 再甩一次"][Math.floor(Math.random() * 3)];
        try {
          const r = await sendViaScript(convName, line);
          console.log(r.ok ? `[失败] 已回「${line}」` : `[失败] 连提示都没发出（码 ${r.code}）`);
          emit("opencard-fallback", { conv: convName, ok: r.ok, text: line });
        } catch {}
      }
      return;
    }
    handleKey = "video:" + got.id;
    cardId = got.id;
    if (lastHandledBy[convName] === handleKey || videoHandledBefore(got.id)) {
      console.log("[跳过] 这条视频 24 小时内已经处理过：", got.id);
      emit("idle", { handled: true, text: "这条视频已处理过", videoId: got.id });
      // 注意：只有当"最新一条就是这张视频卡"时，才把当前签名记成已处理。
      // 如果是"视频+下面的文字"这种形态（pendingCard），sig 是按**那条文字**算的，
      // 记下来等于把他的新消息标记成看过 → 永远不回（真实事故：他后来的一句追问被吞了）。
      if (tl.newest && tl.newest.kind === "card") {
        lastSig[convName] = sig;
        mediaCheckAt[convName] = Date.now();
        return;
      }
      // 最新是一条文字（视频在上面）：不能 return，否则那条文字永远轮不到。
      // 转去按"普通文字"处理它，视频这轮就不管了。
      console.log("[跳过] 视频已处理过，继续处理下面那条文字：", String(tl.newest.text || "").slice(0, 30));
      cardId = null;
      incomingText = tl.newest.text;
      const cvInfo = cachedVideoInfo(got.id);
      const cvLine = cvInfo && cvInfo.title
        ? "\n\n（上面那条视频你之前已经看过：" + cvInfo.title + (cvInfo.duration ? "｜" + cvInfo.duration + " 秒" : "") + "。别再说打不开，直接接他这句话。）"
        : "\n\n（上面那条视频你之前已经处理过。别再说打不开。）";
      incomingText = String(incomingText || "") + cvLine;
      history = buildHistory(tl.chronological, {
        maxChars: Number((() => { try { return loadConfig().limits?.historyChars || 3000; } catch { return 3000; } })()),
        maxMsgs: Number((() => { try { return loadConfig().limits?.historyMsgs || 30; } catch { return 30; } })()),
      });
      break cardBranch;
    }

    // 用临时标签页读内容：主页面停在 /chat，直接导航 /video 有时会被重定向回 /chat（读到空内容）
    const tmpTab = await page.context().newPage();
    let content = { title: "", duration: null, chapterLines: [], comments: [] };
    try {
      content = await readVideoContent(tmpTab, got.id);
    } catch (e) {
      console.log("[读内容失败]", e.message);
    } finally {
      try {
        if (page.context().pages().length > 1) await tmpTab.close();
        else await tmpTab.goto("about:blank");
      } catch {}
    }
    // ---------- 实验室：抖音 AI 总结（开关在控制台「实验室」，关掉就完全走原来的逻辑）----------
    try {
      const labCfg = loadConfig().lab?.aiSummary || {};
      if (labCfg.enabled === true && got.id) {
        const pre = String(labCfg.preLine || "").trim();
        if (pre) {
          const r0 = await sendViaScript(convName, pre);
          console.log(r0.ok ? `[AI总结] 先回了一句「${pre}」` : `[AI总结] 那句没发出去（码 ${r0.code}），继续取总结`);
        }
        const sumTab = await page.context().newPage();
        try {
          const s = await fetchAiSummary(sumTab, got.id, { maxWaitMs: Number(labCfg.maxWaitMs || 40000) });
          if (s.ok) {
            content.aiSummary = s.text;
            console.log(`[AI总结] 拿到 ${s.text.length} 字（${s.ms}ms）`);
            emit("video-summary", { conv: convName, id: got.id, ok: true, chars: s.text.length, ms: s.ms });
          } else {
            console.log(`[AI总结] 失败${s.softFail ? "（软失败：AI 没给真总结）" : ""}：${s.error}`);
            emit("video-summary", { conv: convName, id: got.id, ok: false, soft: !!s.softFail, error: s.error });
          }
        } finally {
          try {
            if (page.context().pages().length > 1) await sumTab.close();
            else await sumTab.goto("about:blank");
          } catch {}
        }
      }
    } catch (e) {
      console.log("[AI总结] 出错（不影响回复）：" + String(e.message).slice(0, 80));
    }
    // 新式卡片没有作者名，它的 text 其实是留言，别当作者名塞给模型
    const cleanAuthor = /\[分享视频\]|\[视频/.test(String(got.author || "")) ? null : got.author;
    incomingText = describeVideo({ author: cleanAuthor, id: got.id, ...content });
    if (captionText) incomingText += `\n他随视频一起写了一句：${captionText}`;
    const emptyContent = !content.title || /^抖音/.test(String(content.title)) || (!content.chapterLines.length && !content.comments.length);
    console.log(`[看懂视频] ${String(content.title || "").slice(0, 40)} | ${content.duration}s | 章节${content.chapterLines.length}条 | 评论${content.comments.length}条`);
    if (emptyContent && content.diag) {
      // 读不到内容时把现场留下来：URL、是否就绪、重试几次、为什么
      console.log(`[看懂视频] ⚠ 内容为空：ready=${content.diag.ready} tries=${content.diag.tries} 原因=${content.diag.reason || "-"} url=${String(content.diag.url || "").slice(0, 70)}`);
      emit("video-empty", { conv: convName, id: got.id, ready: content.diag.ready, tries: content.diag.tries, reason: content.diag.reason || "", url: String(content.diag.url || "").slice(0, 80) });
    }
    likeMeta = { title: content.title, duration: content.duration, chapterLines: content.chapterLines, comments: content.comments, aiSummary: content.aiSummary, caption: captionText };
    emit("video-seen", { conv: convName, id: got.id, author: got.author, title: content.title, duration: content.duration, hasChapter: content.chapterLines.length > 0, comments: content.comments.length });
    {
      // 视频分支：以前 history 只有视频描述一条，之前的聊天全丢了。
      // 现在 = 最近对话（不含这张卡本身）+ 视频描述。
      const lim = (() => { try { return loadConfig().limits || {}; } catch { return {}; } })();
      const prior = buildHistory((tl.chronological || []).slice(0, -1), {
        maxChars: Number(lim.historyChars || 3000),
        maxMsgs: Number(lim.historyMsgs || 30),
      });
      history = [
        ...prior,
        {
          role: "user",
          content: incomingText + (captionText
            ? "\n（他同时写了句留言。先说你看到视频的感受，再顺带接他那句留言。）"
            : ""),
        },
      ];
      console.log(`[上下文] 视频分支：前置 ${prior.length} 条 + 视频描述 ${incomingText.length} 字`);
    }

    // 回私信页，后续 tick 才能继续读
    await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    lastOpenConv = null;
  } else {
    if (lastHandledBy[convName] === handleKey) { emit("idle", { conv: convName, lastSide: "RECV", handled: true, text: incomingText.slice(0, 40) }); lastSig[convName] = sig; return; }
    {
      // 上下文窗口：按字数预算往前取（以前固定 6 条，视频描述一长就没上下文了）
      const lim = (() => { try { return loadConfig().limits || {}; } catch { return {}; } })();
      history = buildHistory(tl.chronological, {
        maxChars: Number(lim.historyChars || 3000),
        maxMsgs: Number(lim.historyMsgs || 30),
      });
      const chars = history.reduce((n, m) => n + String(m.content || "").length, 0);
      console.log(`[上下文] ${history.length} 条 / ${chars} 字（预算 ${lim.historyChars || 3000} 字）`);
    }
  }

  const last = { text: incomingText, side: "RECV" };
  console.log(`\n[他说的] ${String(last.text).slice(0, 140)}`);

  // ---------- 花钱之前先做闸门判断（顺序很重要）----------
  // ① 日上限：今天已经用完 → 直接记成"已处理"，不再重试、不再调模型。
  //    之前把它和"冷却"混成一类（都可重试），导致每 3 秒重生成一次、直到天亮。
  if (SEND && repliedToday() >= dailyReplyCap()) {
    console.log(`[跳过] 今日回复已达上限 ${dailyReplyCap()} 条，这条不再重试`);
    emit("skip", { conv: convName, reason: "daily-cap", cap: dailyReplyCap(), terminal: true });
    lastHandledBy[convName] = handleKey;
    lastSig[convName] = sig;
    return;
  }

  // ② 冷却：等到时间就行 → 不调模型，下一轮再来（不算处理过）
  if (SEND && lastReplyAgoMs() < SAME_CONV_COOLDOWN_MS) {
    const wait = Math.round((SAME_CONV_COOLDOWN_MS - lastReplyAgoMs()) / 1000);
    const now = Date.now();
    if (!retryNoteAt[convName] || now - retryNoteAt[convName] > 15000) {
      retryNoteAt[convName] = now;
      console.log(`[等待] 冷却中 ${wait}s，先不生成（省 token）`);
      emit("skip", { conv: convName, reason: "cooldown", waitSec: wait, terminal: false });
    }
    return;
  }

  emit("recv", { conv: convName, text: String(last.text).slice(0, 80) });
  let reply;
  try {
    const lexOn = (() => { try { return loadConfig().lexicon?.enabled !== false; } catch { return true; } })();
  const ctxText = (history || []).slice(-3).map((m) => String(m.content || "")).join("\n").slice(-600);
    const sys = [buildSystemPrompt(P, cfgNow.rules), memoryBlock(convName), lexiconBlock(12, { terms: lexOn, context: ctxText })].filter(Boolean).join("\n\n");
    reply = await generateReply({ system: sys, messages: history });
  } catch (e) {
    console.log("[失败] 模型调用出错：", e.message);
    emit("error", { stage: "llm", message: e.message });
    log({ ts: new Date().toISOString(), conv: convName, incoming: rawIncoming, error: e.message, sent: false });
    return;
  }
  console.log(`[生成] ${reply.mode}｜${reply.text}`);
  emit("reply", { conv: convName, incoming: last.text, draft: reply.text, mode: reply.mode, model: reply.model, usage: reply.usage });

  // 拆成 1~3 条：模型可以用换行分条（像真人连发），每条单独过安检
  const rawLines = String(reply.text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const lines = [];
  for (const l of rawLines.slice(0, 3)) {
    const g = checkReply(l);
    if (!g.ok) {
      console.log(`[拦下] 这一条没过安检：${g.why}｜${l}`);
      emit("blocked", { conv: convName, draft: l, why: g.why });
      continue;
    }
    lines.push(l);
  }
  if (!lines.length) {
    console.log("[拦下] 全部没过安检，这条不回");
    lastSig[convName] = sig;
    log({ ts: new Date().toISOString(), conv: convName, incoming: last.text, draft: reply.text, blocked: "all", sent: false });
    return;
  }

  if (!SEND || reply.mode === "dry") {
    console.log(`[预演] ${lines.length} 条：${lines.join(" ／ ")}`);
    emit("preview", { conv: convName, draft: lines.join(" ／ "), lines: lines.length, reason: !SEND ? "no-send-flag" : "dry-mode" });
    log({ ts: new Date().toISOString(), conv: convName, incoming: last.text, draft: lines.join(" | "), sent: false, preview: true });
    lastHandledBy[convName] = handleKey;
    lastSig[convName] = sig;
    return;
  }
  // 非互关的人抖音只允许发一条：碰过限制就只发第一条，别再撞
  if (limitedConvs.has(convName) && lines.length > 1) {
    console.log(`[受限] ${convName} 还没互关，只发第一条`);
    lines.length = 1;
  }

  let ok = true;
  let restrictedHit = false;
  for (let i = 0; i < lines.length; i++) {
    const r = await sendViaScript(convName, lines[i]);
    if (!r.ok) {
      if (r.code === 7) {
        restrictedHit = true;
        limitedConvs.add(convName);
        console.log(`[受限] ${convName} 触发"未互关只能发一条"，不再重试`);
        emit("restricted", { conv: convName, draft: lines[i] });
        ok = i > 0;
      } else {
        ok = false;
      }
      break;
    }
    if (i < lines.length - 1) await new Promise((r2) => setTimeout(r2, 1200));
  }
  if (restrictedHit) consecutiveSendFails = 0;
  if (ok) {
    consecutiveSendFails = 0;
  } else {
    consecutiveSendFails++;
    console.log(`[失败计数] 连续 ${consecutiveSendFails} 次发送失败`);
    if (consecutiveSendFails >= 3) {
      pause("连续发送失败", FAIL_PAUSE_MS, consecutiveSendFails + " 次全部失败（多半被风控挡住，或页面结构变了）");
      consecutiveSendFails = 0;
    }
  }
  if (ok) {
    // 抽取频率：每 N 次回复才抽一次（默认 6），计数落盘，重启不清零
    const every = (() => { try { return Math.max(1, Number(loadConfig().memory?.extractEvery ?? 6)); } catch { return 6; } })();
    const cntFile = pathP("state", "memory-counter.json");
    let counters = {};
    try { counters = JSON.parse(fs.readFileSync(cntFile, "utf8")) || {}; } catch {}
    counters[convName] = Number(counters[convName] || 0) + 1;
    const due = counters[convName] % every === 0;
    try { fs.writeFileSync(cntFile, JSON.stringify(counters), "utf8"); } catch {}
    if (due) {
      console.log(`[记忆] 第 ${counters[convName]} 次回复，抽一次（每 ${every} 次一抽）`);
      await extractAndRemember(convName, history, lines.join("\n"));

    // 学新词：独立节流（默认每 12 次回复学一次，一次最多 1 个）。
    // 比记忆抽取更慢——热梗变化快，学多了反而容易学歪。
    const lexCfg = (() => { try { return loadConfig().lexicon || {}; } catch { return {}; } })();
    if (lexCfg.enabled !== false && (forceLearn || shouldLearnNow(convName, Number(lexCfg.everyReplies || 12)))) {
      try {
        const rl = await generateReply({
          system: [
            "从这段对话里找出一个【新出现的网络词/梗/黑话/方言词】——只要词，不要句子。",
            "要求：必须是对方用过的、且不属于常见普通话（例如：破防、上岸、栓Q、整活、抽象、典）。",
            "没有就只输出 NONE。有就只输出一行 JSON：{\"term\":\"词\",\"meaning\":\"一句话意思\",\"usage\":\"他当时的原话，20 字内\"}",
          ].join("\n"),
          messages: [...history.slice(-8), { role: "user", content: "按规则抽一个词。没有就只回 NONE。不要解释。" }],
          maxTokens: 120,
        });
        const raw = String(rl.text || "").trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const o = JSON.parse(m[0]);
          const res = addTerm({ term: o.term, meaning: o.meaning, usage: o.usage, conv: convName, source: String(incomingText || "").slice(0, 40) });
          if (res.added) {
            console.log(`[学词] 新学：${o.term}＝${String(o.meaning || "").slice(0, 20)}`);
            emit("lexicon-learn", { conv: convName, term: o.term, meaning: o.meaning });
          }
        }
      } catch (e) {
        console.log("[学词] 失败：" + String(e.message || e).slice(0, 60));
      }
    }
    }
  }
  console.log(ok ? `[已发送] ${lines.length} 条` : "[发送失败]");
  emit(ok ? "sent" : "send-failed", { conv: convName, draft: lines.join(" ／ "), lines: lines.length, incoming: last.text, videoId: cardId || null });
  if (ok && cardId) emit("video-sent", { conv: convName, id: cardId });
  // 点赞判断放在回复之后：绝不拖慢回复（评分要 2~4 秒）
  if (ok && cardId && likeMeta) {
    await maybeAutoLike(convName, cardId, likeMeta);
  }
  log({ ts: new Date().toISOString(), conv: convName, incoming: last.text, draft: lines.join(" | "), sent: ok, mode: reply.mode });
  if (ok) {
    lastHandledBy[convName] = handleKey;
    // 不要把"当前预览"缓存成已处理：发送那几秒里你可能又发了新消息，
    // 缓存它等于把新消息标记成看过了（真实发生过：视频就是这么被吞掉的）
    lastSig[convName] = sig;
    mediaCheckAt[convName] = Date.now();
  }
};


// ---------- 单实例守卫 ----------
// 之前踩过：旧进程没退，新的照常启动，两个抢同一个浏览器，事件流里出现两份不同代码的日志。
function otherRunnerAlive() {
  try {
    const j = JSON.parse(fs.readFileSync(pathP("state", "runner.json"), "utf8"));
    if (!j || !j.pid || j.pid === process.pid) return null;
    process.kill(j.pid, 0);
    return j;
  } catch { return null; }
}

// ---------- 单实例锁（原子创建 + 心跳）----------
// 之前只靠 runner.json 判断，而它会被"停止/重置/测试"删掉，于是能同时跑两个进程，
// 表现就是同一条消息被回两遍、三遍（真实发生过）。
const RUN_LOCK = pathP("state", "runner.lock.json");
const LOCK_STALE_MS = 30 * 1000;

function readLock() {
  try { return JSON.parse(fs.readFileSync(RUN_LOCK, "utf8")); } catch { return null; }
}
function lockPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireLock() {
  const mine = { pid: process.pid, startedAt: new Date().toISOString(), ts: Date.now() };
  try {
    fs.writeFileSync(RUN_LOCK, JSON.stringify(mine), { encoding: "utf8", flag: "wx" });
    return { ok: true };
  } catch {
    const cur = readLock();
    const fresh = cur && Date.now() - Number(cur.ts || 0) < LOCK_STALE_MS;
    if (cur && fresh && cur.pid !== process.pid && lockPidAlive(cur.pid)) {
      return { ok: false, holder: cur };
    }
    try { fs.writeFileSync(RUN_LOCK, JSON.stringify(mine), "utf8"); } catch {}
    return { ok: true, tookOver: true };
  }
}

let lockHeartbeat = null;
if (!ONCE) {
  const got = acquireLock();
  if (!got.ok) {
    console.error(`[拒绝启动] 已经有一个自动回复在跑（pid ${got.holder.pid}，开始于 ${got.holder.startedAt}）。`);
    console.error("           同一条消息被回复多次，几乎都是两个进程同时跑造成的。");
    console.error("           先点控制台「停止」，或在任务管理器里结束那个 node.exe。");
    process.exit(13);
  }
  if (got.tookOver) console.error("[提示] 接管了一个旧的实例锁（上一个进程已经不在）");
  lockHeartbeat = setInterval(() => {
    try {
      const beat = { pid: process.pid, startedAt: new Date().toISOString(), ts: Date.now() };
    fs.writeFileSync(RUN_LOCK, JSON.stringify(beat), "utf8");
    // 顺带刷新 runner.json：它被清掉时能自愈，控制台就不会显示"已停止"
    try { writeRunner({ pid: process.pid, startedAt: beat.startedAt, interval: INTERVAL, send: SEND, convs: FRIENDS, ts: beat.ts }); } catch {}
    } catch {}
  }, 10 * 1000);
  process.on("exit", () => {
    try {
      const cur = readLock();
      if (cur && cur.pid === process.pid) fs.unlinkSync(RUN_LOCK);
    } catch {}
  });
}

const other = null;

// ---------- 停止旗标 ----------
// 控制台「停止」除了按 pid 杀，还会写这个文件；这样即使 pid 丢了也能停。
const STOP_FLAG = pathP("state", "stop.flag");
function stopRequested() {
  try {
    if (!fs.existsSync(STOP_FLAG)) return false;
    let ageMs = 0;
    try {
      const raw = fs.readFileSync(STOP_FLAG, "utf8").trim();
      const t = Date.parse(raw);
      ageMs = isNaN(t) ? 0 : Date.now() - t;
    } catch {}
    fs.unlinkSync(STOP_FLAG);
    // 超过 2 分钟的老旗标是残留（测试或上次停止留下的），不执行，否则你刚启动就会被秒杀
    if (ageMs > 2 * 60 * 1000) {
      console.log("[忽略] 发现 " + Math.round(ageMs / 1000) + " 秒前的旧停止旗标，不执行");
      return false;
    }
    return true;
  } catch { return false; }
}
// 常驻模式：登记 runner.json，退出时清掉，控制台据此显示"运行中/已停止"
if (!ONCE) {
  writeRunner({ pid: process.pid, startedAt: new Date().toISOString(), interval: INTERVAL, send: SEND, convs: FRIENDS });
  emit("start", { interval: INTERVAL, send: SEND, convs: FRIENDS });
  process.on("exit", () => { try { clearRunner(); } catch {} });
  process.on("SIGINT", () => { clearRunner(); process.exit(0); });
}

// ---------- 概率触发：主动聊天 ----------
// 上一次有动静是什么时候（读事件流，跨重启有效）
function lastActivityTs(convName) {
  try {
    const lines = fs.readFileSync(pathP("state", "events.jsonl"), "utf8").split("\n").filter(Boolean).slice(-400);
    const types = new Set(["recv", "sent", "proactive-sent"]);
    let latest = 0;
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.conv !== convName || !types.has(e.type)) continue;
      const t = new Date(e.ts).getTime();
      if (t > latest) latest = t;
    }
    return latest;
  } catch { return 0; }
}

async function maybeProactive() {
  const cfg = loadConfig();
  const P = cfg.proactive || {};
  if (P.enabled === false) return;

  for (const name of FRIENDS) {
    const last = lastActivityTs(name);
    const idleH = last ? (Date.now() - last) / 3600000 : 999;
    if (idleH < Number(P.idleHours ?? 4)) continue;

    const mem = memoryBlock(name);
    if (P.requireMemory !== false && !mem) {
      if (shouldLog("pmem:" + name)) emit("proactive-skip", { conv: name, reason: "no-memory" });
      continue;
    }

    const r = shouldFire("proactive", P, { conv: name });
    if (!r.fire) {
      if (r.reason !== "too-soon" && shouldLog("pskip:" + name + ":" + r.reason)) emit("proactive-skip", { conv: name, reason: r.reason });
      continue;
    }

    const sys = [
      buildChatPrompt(cfg.persona || {}, cfg.rules || {}),
      mem,
      "现在轮到你主动开口。要求：一句话，20 字以内；不要问「在吗」「在干嘛」；",
      "围绕你记得的关于他的事，或者你刚刷到的一个视频；不要解释你为什么找他。",
    ].filter(Boolean).join("\n\n");

    let reply;
    try {
      reply = await generateReply({
        system: sys,
        messages: [{ role: "user", content: `（他已经 ${idleH.toFixed(1)} 小时没说话了，你主动说一句）` }],
        maxTokens: 80,
      });
    } catch (e) {
      emit("error", { stage: "proactive-llm", conv: name, message: e.message });
      continue;
    }

    const gate = checkReply(reply.text);
    if (!gate.ok) {
      emit("proactive-blocked", { conv: name, draft: reply.text, why: gate.why });
      console.log(`[主动] ${name} 被安检拦下：${gate.why}`);
      markFired("proactive", { conv: name, note: "blocked:" + gate.why });
      continue;
    }

    if (!SEND) {
      console.log(`[主动·预演] ${name} → ${reply.text}`);
      emit("proactive-preview", { conv: name, draft: reply.text, idleHours: Number(idleH.toFixed(1)) });
      markFired("proactive", { conv: name, note: "preview" });
      continue;
    }

    const ok = (await sendViaScript(name, reply.text)).ok;
    console.log(ok ? `[主动·已发] ${name} → ${reply.text}` : `[主动·失败] ${name}`);
    emit(ok ? "proactive-sent" : "proactive-failed", { conv: name, draft: reply.text, idleHours: Number(idleH.toFixed(1)) });
    markFired("proactive", { conv: name, note: reply.text });
    if (ok) {
      lastHandledBy[name] = null;
      lastSig[name] = "";
    }
    return; // 一轮最多主动一个人，别让它一次找好几个人说话
  }
}

// ---------- 概率触发：跑一轮转发 ----------
function runDigestChild(D) {
  return new Promise((resolve) => {
    const logPath = pathP("state", "digest.log");
    let fd;
    try { fd = fs.openSync(logPath, "a"); } catch { fd = "ignore"; }
    const args = [
      pathP("lib", "digest.mjs"),
      `--max=${Number(D.max ?? 6)}`,
      `--top=${Number(D.top ?? 1)}`,
      "--send",
    ];
    if (D.only) args.push(`--only=${D.only}`);
    if (D.relax) args.push("--relax");
    const ps = spawn(process.execPath, args, { cwd: pathP(), stdio: ["ignore", fd, fd], windowsHide: true });
    ps.on("exit", (c) => {
      try { if (typeof fd === "number") fs.closeSync(fd); } catch {}
      resolve({ ok: c === 0, code: c });
    });
    ps.on("error", () => resolve(false));
  });
}

async function maybeDigest() {
  const cfg = loadConfig();
  const D = cfg.digest || {};
  if (D.enabled === false) return;

  const r = shouldFire("digest", D);
  if (!r.fire) {
    if (r.reason !== "too-soon" && shouldLog("dskip:" + r.reason)) emit("digest-skip", { reason: r.reason });
    return;
  }

  console.log(`[概率转发] 命中骰子，开始跑一轮（max=${D.max} top=${D.top}）`);
  emit("digest-auto-start", { max: D.max, top: D.top, chance: D.chance });
  const runRes = await runDigestChild(D);
  markFired("digest", { note: runRes.ok ? "ok" : ("fail:" + runRes.code) });
  emit(runRes.ok ? "digest-auto-done" : "digest-auto-failed", { code: runRes.code });
  console.log(runRes.ok ? "[概率转发] 完成" : `[概率转发] 失败，退出码 ${runRes.code}`);
}

// 一轮 = 先做一次全局准备，然后逐个会话处理
const tick = async () => {
  await tickSetup();

  if (stopRequested()) {
    console.log("[收到停止指令] 退出");
    emit("stop", { by: "flag" });
    try { clearRunner(); } catch {}
    process.exit(0);
  }

  // 浏览器同一时间只能给一个进程用：digest 在跑就整轮暂停（连导航都不做）
  const busy = (loadConfig().limits?.pauseDuringDigest === true) ? digestBusy() : null;

  // 暂停中：不做任何浏览器操作，也不调模型
  if (Date.now() < pausedUntil) {
    if (shouldLog("paused", 5 * 60 * 1000)) {
      console.log(`[暂停中] ${pauseReason}，还有 ${Math.round((pausedUntil - Date.now()) / 60000)} 分钟`);
      emit("paused-still", { reason: pauseReason, leftMin: Math.round((pausedUntil - Date.now()) / 60000) });
    }
    return;
  }

  // 人机验证：弹出来就停手，别继续撞（继续操作只会让风控更重）
  const vp = await verifyPresent(page);
  if (vp.yes) {
    pause("人机验证", CAPTCHA_PAUSE_MS, vp.why + (vp.sample ? "：" + vp.sample : ""));
    return;
  }
  if (busy) {
    if (shouldLog("digestbusy")) {
      console.log("[暂停] 转发任务正在用浏览器（pid " + busy.pid + "），回复暂时让位，它跑完自动恢复");
      emit("paused", { reason: "digest-busy", pid: busy.pid });
    }
    return;
  }
  FRIENDS = friendsList();            // 每轮重读白名单：新加的人下一轮就生效
  if (!FRIENDS.length) {
    console.log("[跳过] 白名单里没有已验证的人");
    emit("skip", { reason: "no-verified-friends" });
    return;
  }
  // 降低点击频率：当前开着的会话每轮都读（便宜），其余会话【轮流】点开一个。
  // 之前是"按顺序跳过"，排在后面的会话永远轮不到（排后面的朋友就是这么被饿死的）。
  const nonOpen = FRIENDS.filter((n) => n !== lastOpenConv);
  let rotatedPick = null;
  if (nonOpen.length) {
    rotatedPick = nonOpen[rotationIdx % nonOpen.length];
    rotationIdx = (rotationIdx + 1) % 1000;
  }

  for (const name of FRIENDS) {
    try {
      const isOpen = lastOpenConv === name;
      if (!isOpen && name !== rotatedPick) {
        emit("idle", { conv: name, skipped: "rotation" });
        continue;
      }
      await tickOne(name);
    } catch (e) {
      console.log(`[错误] 处理 ${name} 时出错：${e.message}`);
      emit("error", { stage: "tick", conv: name, message: e.message });
    }
  }

  await maybeProactive();
  await maybeDigest();
};
// 自检：验证"读消息"是否可靠（不改任何行为，只报告）
// 用法：node lib/autoreply.mjs --selftest=10
// 每轮：对白名单每个会话，读一次时间线，核对
//   ① 当前打开的会话名 == 目标会话
//   ② 读到的最新消息 == 会话列表预览（媒体类预览不比对文字）
// 输出每轮明细 + 总体通过率。
const SELFTEST = (() => {
  const a = argv.find((x) => x.startsWith("--selftest"));
  if (!a) return 0;
  const n = parseInt(a.split("=")[1] || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

// 白名单体检：node lib/autoreply.mjs --audit
// 逐个检查：配置里有没有 / 会话列表里有没有 / 能不能读到 / 最新一条是什么
// 点赞自检：node lib/autoreply.mjs --like-test=<videoId>
// 只打开视频、读点赞按钮状态，不点（用来确认选择器/环境是否正常）
const LIKE_TEST = argv.find((a) => a.startsWith("--like-test="))?.split("=")[1];
if (LIKE_TEST) {
  const tab = await page.context().newPage();
  try {
    const r = await likeVideo(tab, LIKE_TEST, { dryRun: true });
    console.log("点赞自检结果：" + JSON.stringify(r, null, 2));
  } catch (e) {
    console.log("点赞自检失败：" + String(e.message || e).slice(0, 100));
  } finally {
    try {
      if (page.context().pages().length > 1) await tab.close();
      else await tab.goto("about:blank");
    } catch {}
  }
  process.exit(0);
}

const AUDIT = argv.includes("--audit");

async function auditFriends() {
  const cfgNow = loadConfig();
  const all = (cfgNow.friends || []);
  console.log(`白名单共 ${all.length} 人（其中 verified 的是实际会回复的）\n`);
  const previews = await _readPreviews(page);
  const names = Object.keys(previews);
  console.log(`抖音会话列表共 ${names.length} 个：${names.join(" / ")}\n`);
  for (const f of all) {
    const name = String(f.name || "").trim();
    const ok = [];
    if (!name) { console.log("- （空名字，跳过）"); continue; }
    if (f.verified === true) ok.push("已验证"); else ok.push("⚠ 未勾已验证（永远不会发）");
    const inList = !!previews[name];
    if (!inList) ok.push("⚠ 会话列表里没有这个名字（名字必须和面板一字不差）");
    let tail = "";
    if (inList) {
      const tl = await readTimeline(page, name).catch((e) => ({ error: String(e.message || e) }));
      if (tl.error) ok.push("⚠ 读不到：" + tl.error);
      else {
        tail = String((tl.newest || {}).text || "").slice(0, 24);
        ok.push(`可读（最新 ${tl.newest && tl.newest.side === "RECV" ? "他发的" : "我发的"}）`);
      }
    }
    console.log(`- ${name}：${ok.join("｜")}`);
    if (tail) console.log(`    最新：${tail}`);
  }
  process.exit(0);
}

if (AUDIT) {
  await auditFriends();
}

async function selfTest() {
  const names = friendsList();   // 已经是名字数组
  console.log(`自检开始：${SELFTEST} 轮 × ${names.length} 个会话\n`);
  let pass = 0, total = 0;
  const fails = [];
  for (let round = 1; round <= SELFTEST; round++) {
    for (const name of names) {
      total++;
      let ok = true, why = "";
      try {
        const previews = await page.evaluate(() => {
          const out = {};
          const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          for (const it of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v)) {
            const t = (it.innerText || "").replace(/\s+/g, " ").trim();
            if (t) out[t.split(" ")[0]] = t;
          }
          return out;
        });
        const pv = previews[name] || "";
        const want = previewMessagePart(pv).trim();

        const tl = await readTimeline(page, name);
        if (tl.error) { ok = false; why = tl.error; }
        else {
          const open = await page.evaluate(() => {
            const el = document.querySelector('[class*="curConversation"]');
            const t = el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
            return t ? t.split(" ")[0] : null;
          });
          if (open && open !== name) { ok = false; why = `会话不符（当前 ${open}）`; }
          else if (want && !want.includes("[") && !String(tl.newest?.text || "").includes(want)) {
            ok = false;
            why = `最新不符：读到"${String(tl.newest?.text || "").slice(0, 16)}"，预览含"${want.slice(0, 12)}"`;
          }
        }
      } catch (e) {
        ok = false;
        why = String(e.message || e).slice(0, 80);
      }
      if (ok) pass++; else fails.push(`第${round}轮 ${name}：${why}`);
      console.log(`  ${ok ? "✅" : "❌"} 第${round}轮 ${name}${ok ? "" : "　" + why}`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  console.log(`\n结果：${pass}/${total} 通过（${Math.round((pass / total) * 100)}%）`);
  if (fails.length) {
    console.log("失败明细：");
    fails.slice(0, 20).forEach((f) => console.log("  - " + f));
  }
  process.exit(0);
}

if (SELFTEST) {
  await selfTest();
}

if (ONCE) {
  await tick();
  process.exit(0);
}

while (!stopped) {
  try {
    await tick();
  } catch (e) {
    console.log("[错误]", e.message);
    emit("error", { stage: "tick", message: e.message });
  }
  await page.waitForTimeout(INTERVAL * 1000);
}
