// 推荐流转发：hover 分享 → 面板里按「已验证白名单」精确匹配 → 点分享 → 记录
// 用法：node lib/forward.mjs                （预演，不发）
//       node lib/forward.mjs --yes --click   （真发）
import { connect, douyinPage, loginState } from "./cdp.mjs";
import { P } from "./paths.mjs";
import { cleanupStrayTabs, closeWorkerTab } from "./tabs.mjs";
import { resolveTargets, requireYes, matchExactlyOne, appendLog, limits, loadConfig } from "./targets.mjs";
import { verifyJudgment } from "./judgment.mjs";
import { evaluate } from "./rules.mjs";
import { generateReply } from "./llm.mjs";
import { memoryBlock } from "./memory.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const DO_CLICK = argv.includes("--click");
const NO_TEXT = argv.includes("--no-text");
const DRY_LINE = argv.includes("--dry-line");   // 只生成附言打印，不转发       // 默认发完卡片再补一句"现写的话"，--no-text 关掉

const T0 = Date.now();
const SESSION_MAX_MIN = Number(loadConfig().limits?.sessionMinutesMax ?? 20);

// 机器硬限制（来自 config.json，不依赖我的记忆）
const RULES = loadConfig().rules || {};
const MAX_DUR = Number(RULES.maxDurationSeconds ?? 0);

// 目标先于一切：名单不合法就在这里退出，连浏览器都不连
const targets = resolveTargets(argv);
if (DO_CLICK) requireYes(argv, "转发视频");
const LIM = limits();

// 每日上限必须跨运行累计 —— 读 sent.jsonl 统计"今天已成功发出几条"
function sentTodayCount() {
  const p = P("sent.jsonl");
  if (!fs.existsSync(p)) return 0;
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const n = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.result === "share_success" && e.ts)
    .filter((e) => {
      const t = new Date(e.ts);
      const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      return k === key;
    }).length;
  return n;
}
const ALREADY = sentTodayCount();

// --dry-line：只验证"附言生成"，不打开浏览器、不分享、不吃额度
if (DRY_LINE) {
  const t0 = targets && targets[0];
  const jArg = argv.find((a) => a.startsWith("--judged="));
  let jd = null;
  if (jArg) {
    try { jd = JSON.parse(fs.readFileSync(P("state", "judgments") + jArg.split("=")[1].trim() + ".json", "utf8")); } catch (e) { console.log("  （读精判记录失败：" + e.message + "）"); }
  }
  console.log("目标：" + (t0?.name || "?") + "　视频：" + (jd?.title || "（无精判记录）"));
  for (let i = 0; i < 3; i++) {
    const line = await composeLine(jd ? { title: jd.title, chapter: jd.chapter, comments: jd.comments } : null, t0?.name);
    console.log("  附言 " + (i + 1) + "：" + (line || "（生成失败/被过滤）"));
  }
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(0);
}


const REMAINING = Math.max(0, LIM.dailyOutgoingCap - ALREADY);
const DRY_LINE_EARLY = argv.includes("--dry-line");
if (!DRY_LINE_EARLY) console.log(`今日已发成功 ${ALREADY} 条 / 上限 ${LIM.dailyOutgoingCap}，本轮最多还能发 ${REMAINING} 条`);
if (REMAINING <= 0 && !DRY_LINE && !argv.includes("--click-limited")) {
  console.error("[拒绝执行] 今天的额度已经用完（跨运行累计统计，来自 sent.jsonl）。明天再来，或去控制台调高每日上限。");
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(11);
}

console.log("本轮目标（来自 config.json 已验证白名单）：");
targets.forEach((t) => console.log(`  - ${t.name}${t.douyinId ? "  (" + t.douyinId + ")" : ""}`));
console.log(`上限：每日 ${LIM.dailyOutgoingCap} 条，单视频最多 ${LIM.maxRecipientsPerVideo} 人`);

const { ctx } = await connect();
  // 用【自己的临时标签页】干活：跟 autoreply 共用主标签页会互相打断（实测并发时 digest 会崩）
  const cleared = await cleanupStrayTabs(ctx).catch(() => 0);
  if (cleared) console.log(`  (清掉 ${cleared} 个残留标签页)`);
  const page = await ctx.newPage();
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
// --video=<id>：直接打开该视频详情页再发。判和发都用 id 定位，不依赖推荐流当前是哪条。
const videoArg = argv.find((a) => a.startsWith("--video="));
if (videoArg) {
  const vid = videoArg.slice("--video=".length).trim();
  if (!/^\d{6,}$/.test(vid)) { console.error("[停止] --video 需要合法 id"); process.exit(3); }
  if (!page.url().includes("/video/" + vid)) {
    await page.goto(`https://www.douyin.com/video/${vid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3800);
  }
}

// 两种模式：
//   detail  —— 在 /video/{id} 详情页就地判+发（推荐：判和发同一页，没有"导航后换了视频"的竞态）
//   feed    —— 在推荐流 /?recommend=1 上发（适合"已经定好要发哪条"的场景）
const probe = async () =>
  await page.evaluate(() => ({
    url: location.href,
    onDetail: /\/video\/\d{6,}/.test(location.href),
    onFeed: /[?&]recommend=1/.test(location.href),
    detailShareBtn: document.querySelectorAll('[data-e2e="video-share-icon-container"]').length,
    shareBtns: document.querySelectorAll('[data-e2e="video-player-share"]').length,
  }));

let health = await probe();
if (!/douyin\.com/.test(health.url)) { console.error("[停止] 不在抖音页面:", health.url); process.exit(3); }

let MODE = health.onDetail ? "detail" : "feed";

if (MODE === "feed" && !health.onFeed) {
  console.log(`当前既不是详情页也不是推荐流（${health.url}），切到推荐流…`);
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  health = await probe();
  MODE = health.onDetail ? "detail" : "feed";
  console.log("切换后:", JSON.stringify(health));
  if (!health.onFeed && !health.onDetail) {
    console.error("[停止] 既没切到推荐流也没到详情页，URL=" + health.url);
  await closeWorkerTab(page, ctx).catch(() => {});
    process.exit(3);
  }
}

if (MODE === "feed" && !health.shareBtns) {
  console.error(`[停止] 推荐流上找不到分享按钮（shareBtns=${health.shareBtns}）`);
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(3);
}
if (MODE === "detail" && !health.detailShareBtn) {
  console.error(`[停止] 详情页上找不到分享入口（detailShareBtn=${health.detailShareBtn}）`);
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(3);
}
console.log(`模式：${MODE === "detail" ? "详情页（判+发同页，无竞态）" : "推荐流"}`);

const ls = await loginState(page);
if (ls.hasLoginBtn) { console.error("[停止] 未登录"); process.exit(3); }

// 记录当前视频（id 既用于追溯，也是精判凭证的键）
const cur = await page.evaluate(() => {
  const d = document.querySelector('[data-e2e="video-desc"]');
  let id = null;
  const m = location.href.match(/\/video\/(\d{6,})/);
  if (m) id = m[1];
  // 推荐流真正的 id 来源：[data-e2e="feed-video"][data-e2e-vid]
  if (!id) {
    const vidEl = document.querySelector("[data-e2e-vid]");
    if (vidEl) id = vidEl.getAttribute("data-e2e-vid") || null;
  }
  if (!id) {
    const n = document.querySelector("[data-aweme-id]");
    if (n) id = n.getAttribute("data-aweme-id");
  }
  // 详情页的 video-desc 常常是空的，文案要从 document.title 兜底
  const desc = (d && d.innerText.trim()) || document.title.replace(/\s*-\s*抖音\s*$/, "").trim();
  return {
    id,
    desc: desc ? desc.slice(0, 80) : null,
    descFull: desc,
    url: location.href,
  };
});
console.log("\n当前视频:", JSON.stringify({ id: cur.id, desc: cur.desc }));

// ---- 内容交接凭证 ----
// 两层：--judged=<video_id> 是强凭证（必须有精判记录、verdict=send、且当前文案对得上）
//       --expect-desc=<前缀> 是弱凭证（只看文案）
// 防的是两件事：判断完之后推荐流滑走了；以及"发一条我自己都没判过的东西"。
const judgedArg = argv.find((a) => a.startsWith("--judged="));
const expectArg = argv.find((a) => a.startsWith("--expect-desc="));
let judgment = null;

if (judgedArg) {
  const jid = judgedArg.slice("--judged=".length).trim();
  const v = verifyJudgment({ id: jid, currentDesc: cur.desc });
  if (!v.ok) {
    console.error(
      `[停止] 精判记录不通过（${v.reason}）。\n` +
        (v.expect ? `  判定时文案: ${JSON.stringify(v.expect)}\n  屏幕上文案: ${JSON.stringify(v.got)}\n` : "") +
        (v.verdict !== undefined ? `  verdict = ${JSON.stringify(v.verdict)}\n` : "") +
        `  拒绝发送。先用 node lib/enrich.mjs <video_id> --verdict=send --write 产出精判记录。`
    );
  await closeWorkerTab(page, ctx).catch(() => {});
    process.exit(7);
  }
  judgment = v.judgment;
  console.log(`精判凭证 OK：id=${jid} 指纹=${judgment.fingerprint}`);
  if (judgment.chapter) console.log(`  判断依据（章节要点）: ${judgment.chapter.slice(0, 120)}…`);
} else if (expectArg) {
  const expect = expectArg.slice("--expect-desc=".length).trim();
  const got = (cur.desc || "").trim();
  if (!got.startsWith(expect)) {
    console.error(
      `[停止] 内容不符，拒绝发送。\n  判断过的是: ${JSON.stringify(expect)}\n  当前屏幕上是: ${JSON.stringify(got.slice(0, 60))}\n  视频可能已经滑走了——请重新判断当前这一条。`
    );
  await closeWorkerTab(page, ctx).catch(() => {});
    process.exit(7);
  }
  console.log(`弱凭证 OK（只有文案，没有精判记录）：${JSON.stringify(expect)}`);
} else if (DO_CLICK) {
  console.error(
    "[停止] 真发必须带 --judged=<video_id>（推荐）或 --expect-desc=<文案前缀>。\n" +
      "  没有凭证，脚本无法确认要发的内容就是被判据认可的那条。"
  );
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(7);
}

// ---- 机器开关第二道：即使凭证放行，发送前再按"当前开关"跑一遍 ----
const durNow = await page.evaluate(() => {
  const v = document.querySelector("video");
  return v && isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;
});
const judgedDur = judgment && typeof judgment.duration === "number" ? judgment.duration : null;
const effectiveDur = durNow ?? judgedDur;
if (MAX_DUR > 0) {
  console.log(`时长检查：屏幕 ${durNow ?? "?"}s，精判记录 ${judgedDur ?? "?"}s，上限 ${MAX_DUR}s`);
  if (effectiveDur && effectiveDur > MAX_DUR) {
    console.error(
      `[停止] 时长 ${effectiveDur}s 超过 config.json 的 maxDurationSeconds=${MAX_DUR}s。\n` +
        `  这条对应判据「明确不算有意思：超过5分钟的长视频」。拒绝发送。`
    );
  await closeWorkerTab(page, ctx).catch(() => {});
    process.exit(8);
  }
  if (!effectiveDur) console.log("  （拿不到时长，仅凭精判记录的 verdict）");
}
{
  const rg = evaluate({
    desc: cur.descFull || cur.desc,
    duration: effectiveDur,
    hasChapter: judgment ? !!judgment.hasChapter : undefined,
    comments: judgment ? judgment.comments : undefined,
  });
  if (rg.blocked) {
    console.error("[停止] 当前开关不允许发这条：");
    rg.reasons.forEach((r) => console.error(`  · ${r.label} —— ${r.detail}`));
  await closeWorkerTab(page, ctx).catch(() => {});
    process.exit(9);
  }
}

const iconSel = MODE === "detail" ? '[data-e2e="video-share-icon-container"]' : '[data-e2e="video-player-share"]';
const icon = page.locator(iconSel).first();
const panelOpen = async () =>
  await page.evaluate(() =>
    !!Array.from(document.querySelectorAll("div,span")).find(
      (e) => (e.textContent || "").trim() === "分享给朋友" && e.getBoundingClientRect().width > 0
    )
  );

const openPanel = async () => {
  for (let i = 1; i <= 3; i++) {
    try { await icon.hover({ timeout: 5000 }); } catch {}
    await page.waitForTimeout(1400);
    if (await panelOpen()) return true;
    try { await icon.click({ timeout: 5000 }); } catch {}
    await page.waitForTimeout(1400);
    if (await panelOpen()) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
};

const readRows = async () =>
  await page.evaluate(() => {
    const header = Array.from(document.querySelectorAll("div,span")).find(
      (e) => (e.textContent || "").trim() === "分享给朋友" && e.getBoundingClientRect().width > 0
    );
    if (!header) return null;
    let box = header;
    for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;

    const rows = [];
    const seen = new Set();
    box.querySelectorAll("div,span,button").forEach((b) => {
      if ((b.textContent || "").trim() !== "分享") return;
      const br = b.getBoundingClientRect();
      if (!br.width || !br.height) return;
      let row = b, name = null, rowText = null;
      for (let i = 0; i < 5 && row.parentElement; i++) {
        row = row.parentElement;
        const t = (row.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length > 30) break;
        if (!t.includes("分享")) continue;
        const cands = Array.from(row.querySelectorAll("div,span"))
          .filter((e) => e.children.length === 0)
          .map((e) => (e.textContent || "").trim())
          .filter((x) => x && x !== "分享" && x !== "在线" && x.length <= 20);
        if (cands.length) { name = cands.sort((a, b2) => b2.length - a.length)[0]; rowText = t; break; }
      }
      if (!name) return;
      const key = name + "|" + Math.round(br.y);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ name, rowText, btn: { x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2) } });
    });
    return rows;
  });

// --dry-line：只验证"附言生成"，不分享不发送（也不吃额度）
if (DRY_LINE) {
  const t0 = targets && targets[0];
  const jArg = argv.find((a) => a.startsWith("--judged="));
  let jd = null;
  if (jArg) {
    try { jd = JSON.parse(fs.readFileSync(P("state", "judgments") + jArg.split("=")[1].trim() + ".json", "utf8")); } catch (e) { console.log("  （读精判记录失败：" + e.message + "）"); }
  }
  console.log("目标：" + (t0?.name || "?"));
  for (let i = 0; i < 3; i++) {
    const line = await composeLine(jd ? { title: jd.title, chapter: jd.chapter, comments: jd.comments } : null, t0?.name);
    console.log("  附言 " + (i + 1) + "：" + (line || "（生成失败/被过滤）"));
  }
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(0);
}
const results = [];
let sentCount = 0;

// 单次运行时长上限（config.limits.sessionMinutesMax），到点就停，不硬跑
function elapsedMin() {
  return (Date.now() - T0) / 60000;
}

// 同一条视频在冷却期内不重复发给同一个人
function sentRecently(videoId, hours) {
  if (!videoId) return null;
  const p = P("sent.jsonl");
  if (!fs.existsSync(p)) return null;
  const cutoff = Date.now() - Number(hours || 24) * 3600 * 1000;
  return (
    fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.result === "share_success" && String(e.video_id) === String(videoId))
      .find((e) => new Date(e.ts).getTime() > cutoff) || null
  );
}

// 转发附言：让模型看着视频内容 + 这个人的记忆现写一句。
// 关键是"角度随机 + 禁掉空话"，否则每条都是"这个你肯定用得上"。

function safeLine(text) {
  let t = String(text || "").trim().replace(/^["'“”「」]+|["'“”「」]+$/g, "").replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 30) t = t.slice(0, 30);
  if (/我(答应|保证|承诺)|(钱|付款|转账|红包|多少钱|价格)|https?:\/\/|\d{6,}/.test(t)) return null;
  // 空话直接作废，宁可不说
  if (/你(肯定|一定)?(会)?(用得上|喜欢|需要)|必看|强烈推荐|震惊|绝了/.test(t)) return null;
  return t;
}

async function composeLine(judgment, targetName) {
  const LINE_ANGLES = [
    "只说你自己的反应（比如笑到、看不懂、想起谁），不复述内容",
    "点出视频里某一个具体细节，别的都不提",
    "用一句调侃，语气像损朋友",
    "给一句很短的评价，不超过 8 个字",
    "说这东西让你想到了他之前提过的事",
  ];
  const ctx = [];
  if (judgment?.title) ctx.push("视频文案：" + String(judgment.title).slice(0, 120));
  if (judgment?.chapter) ctx.push("视频内容：" + String(judgment.chapter).slice(0, 200));
  if (judgment?.comments?.length) ctx.push("热评：" + judgment.comments.slice(0, 2).map((c) => String(c).slice(0, 40)).join(" ｜ "));
  const mem = memoryBlock(targetName);
  if (mem) ctx.push(mem);

  const angle = LINE_ANGLES[Math.floor(Math.random() * LINE_ANGLES.length)];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await generateReply({
        system: [
          "你要给一个很熟的朋友转发一条抖音视频，配一句话。",
          "这一句的角度：" + angle,
          "硬要求：20 字以内；一句话；像微信里随口说的；不要解释为什么发；不要提 AI；不要用「这个你肯定用得上」这类空话。",
        ].join("\n"),
        messages: [{ role: "user", content: ctx.filter(Boolean).join("\n") || "（没什么信息，就随口一句）" }],
        maxTokens: 60,
        temperature: 1.15,
      });
      const line = safeLine(r.text);
      if (line) return line;
    } catch (e) {
      console.log("  [附言] 生成失败：" + e.message);
      return null;
    }
  }
  return null; // 三次都不合格就不说话，宁可不配话
}
// 用 send.mjs 发一句话术（复用它的白名单匹配 + 逐字校验 + 回读）
function sendText(to, text) {
  return new Promise((resolve) => {
    const ps = spawn(
      process.execPath,
      [P("lib", "send.mjs"), `--to=${to}`, "--yes", "--send", text],
      { cwd: P(), stdio: "inherit", windowsHide: true }
    );
    ps.on("exit", (c) => resolve(c === 0));
    ps.on("error", () => resolve(false));
  });
}

for (const t of targets) {
  if (elapsedMin() > SESSION_MAX_MIN) {
    results.push({ to: t.name, result: "skipped", reason: `session-limit(${SESSION_MAX_MIN}min)` });
    console.log(`[停止] 已跑 ${elapsedMin().toFixed(1)} 分钟，超过单次上限 ${SESSION_MAX_MIN} 分钟`);
    break;
  }
  if (sentCount >= REMAINING || sentCount >= LIM.maxRecipientsPerVideo) {
    results.push({ to: t.name, result: "skipped", reason: "limit" });
    continue;
  }

  const dup = sentRecently(cur.id, LIM.sameVideoCooldownHours);
  if (dup) {
    results.push({ to: t.name, result: "skipped", reason: `duplicate(${LIM.sameVideoCooldownHours}h 内已发过)` });
    console.log(`  ${t.name} → 跳过：这条视频 ${LIM.sameVideoCooldownHours}h 内已发过（${dup.ts}）`);
    continue;
  }

  if (!(await panelOpen()) && !(await openPanel())) {
    results.push({ to: t.name, result: "skipped", reason: "panel_not_open" });
    continue;
  }

  const rows = await readRows();
  if (rows === null) { results.push({ to: t.name, result: "skipped", reason: "panel_not_open" }); continue; }

  const m = matchExactlyOne(rows, t.name);
  if (!m.ok) {
    console.log(`  ${t.name} → 跳过（${m.reason}${m.count ? " ×" + m.count : ""}）`);
    results.push({ to: t.name, result: "skipped", reason: m.reason, count: m.count || 0 });
    continue;
  }

  // 点击前二次回读：用 readRows 刚刚爬到的"行文本"来确认，而不是坐标命中测试。
  // 原因：详情页的分享面板里，昵称不是「分享」按钮的祖先节点，elementFromPoint 只会命中按钮本身，
  // 拿到的文本永远只有「分享」，会把正常发送全部误拦（2026-10-18 实测）。
  const readback = m.target.rowText || null;

  if (!readback || !readback.includes(t.name)) {
    console.log(`  ${t.name} → 跳过（回读不符：${JSON.stringify(readback)}）`);
    results.push({ to: t.name, result: "skipped", reason: "readback_mismatch", readback });
    continue;
  }

  console.log(`  ${t.name} → 命中唯一行，回读="${readback}"`);

  if (!DO_CLICK) {
    results.push({ to: t.name, result: "dry_run", at: m.target.btn });
    continue;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = P("state", "sent");
  fs.mkdirSync(dir, { recursive: true });
  const shot = `${dir}\\${stamp}-${cur.id || "noid"}-${t.name}.png`;
  await page.screenshot({ path: shot }).catch(() => {});

  // 用 DOM 元素点击（Playwright 会自己滚到可视区再发真实鼠标事件），
  // 比按坐标点稳：详情页面板有时候贴在视口顶边，坐标点会被头部挡住。
  const btnHandle = await page.evaluateHandle((name) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const header = Array.from(document.querySelectorAll("div,span")).find(
      (e) => (e.textContent || "").trim() === "分享给朋友" && e.getBoundingClientRect().width > 0
    );
    if (!header) return null;
    let box = header;
    for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;

    const btns = Array.from(box.querySelectorAll("div,span,button")).filter(
      (b) => (b.textContent || "").trim() === "分享" && vis(b)
    );
    for (const b of btns) {
      let row = b;
      for (let i = 0; i < 5 && row.parentElement; i++) {
        row = row.parentElement;
        const t2 = (row.innerText || "").replace(/\s+/g, " ").trim();
        if (t2.length < 40 && t2.includes("分享")) {
          if (t2.includes(name)) return b;
          break;
        }
      }
    }
    return null;
  }, t.name);

  const btnEl = btnHandle.asElement();
  if (!btnEl) {
    console.log(`  ${t.name} → 跳过（拿不到可点击的分享按钮元素）`);
    results.push({ to: t.name, result: "skipped", reason: "no_button_handle" });
    continue;
  }

  await btnEl.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await btnEl.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2200);

  // toast 必须精确匹配：之前用 /成功/ 会把评论「最成功的商人」当成系统提示（真实发生过）
  const toast = await page.evaluate(() => {
    const EXACT = new Set(["分享成功", "已分享", "分享失败", "发送失败", "操作过于频繁", "该内容无法分享"]);
    const lines = (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.filter((l) => EXACT.has(l)).slice(0, 4);
  });
  const okToast = toast.includes("分享成功") || toast.includes("已分享");

  sentCount++;
  const entry = {
    ts: new Date().toISOString(),
    channel: "share_panel",
    to: t.name,
    video_id: judgment ? judgment.id : cur.id,
    desc: cur.desc,
    judged: judgment
      ? { id: judgment.id, fingerprint: judgment.fingerprint, verdict: judgment.verdict, note: judgment.note, basis: judgment.chapter ? "chapter" : "comments" }
      : null,
    result: okToast ? "share_success" : "share_unknown",
    toast,
    snapshot: shot,
  };
  appendLog(entry);
  results.push({ to: t.name, result: entry.result, toast });
  console.log(`  ${t.name} → 已点击，提示=${JSON.stringify(toast)}`);

  // 卡片之后补一句现写的附言（默认开，--no-text 关闭）
  if (okToast && !NO_TEXT) {
    console.log(`  ${t.name} → 正在现写一句附言…`);
    const line = await composeLine(judgment, t.name);
    const tpl = line;
    if (tpl) {
      console.log(`  ${t.name} → 附言：${tpl}`);
      const okText = await sendText(t.name, tpl);
      entry.text = tpl;
      entry.textSent = okText;
      appendLog({ ...entry, channel: "share_panel+text", result: okText ? "text_sent" : "text_failed" });
      results.push({ to: t.name, result: okText ? "text_sent" : "text_failed" });
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
}

console.log("\n=== 本轮结果 ===");
results.forEach((r) => console.log(`  ${r.to}: ${r.result}${r.reason ? " (" + r.reason + ")" : ""}`));

await page.screenshot({ path: P("state", "forward-last.png") }).catch(() => {});
  await closeWorkerTab(page, ctx).catch(() => {});
const okCount = results.filter((r) => r.result === "share_success" || r.result === "text_sent").length;
const dupOnly = results.length > 0 && results.every((r) => String(r.reason || "").includes("duplicate"));
if (okCount > 0) process.exit(0);
if (dupOnly) { console.log("[退出码 12] 全是重复（同一条视频发过了）"); process.exit(12); }
console.log("[退出码 1] 一条都没发成功");
process.exit(1);
