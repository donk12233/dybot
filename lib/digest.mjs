// 一轮"刷 → 判 → 转"。这是让转发不再依赖 agent 的那一环。
// 用法：
//   node lib/digest.mjs               预演（扫+判，不转发）
//   node lib/digest.mjs --send        真转（会调 forward --yes --click）
//   --max=6  扫几条（默认 6）    --top=1  最多转几条（默认 1）
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";
import { cleanupStrayTabs, closeWorkerTab } from "./tabs.mjs";
import { loadConfig, limits } from "./targets.mjs";
import { evaluate } from "./rules.mjs";
import { scanFeed } from "./feedscan.mjs";
import { judgeVideo, matchFriends } from "./judge.mjs";
import { readVideoContent } from "./video.mjs";
import { fetchAiSummary } from "./videosummary.mjs";
import { emit } from "./events.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const maxArg = argv.find((a) => a.startsWith("--max="));
const topArg = argv.find((a) => a.startsWith("--top="));
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.split("=").slice(1).join("=").trim() : null;
const RELAX = argv.includes("--relax");   // 被对方主动要求时用：不判"有没有意思"，只守硬线
const MAX = maxArg ? parseInt(maxArg.split("=")[1], 10) : 6;
const TOP = topArg ? parseInt(topArg.split("=")[1], 10) : 1;

const cfg = loadConfig();
const LIM = limits(cfg);
const JUDG = P("state", "judgments");

function writeJudgment(rec) {
  fs.mkdirSync(JUDG, { recursive: true });
  const p = path.join(JUDG, rec.id + ".json");
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), "utf8");
  return p;
}

function runForward(id, to) {
  return new Promise((resolve) => {
    const ps = spawn(
      process.execPath,
    [P("lib", "forward.mjs"), `--video=${id}`, "--yes", "--click", `--judged=${id}`, ...((to || ONLY) ? [`--only=${to || ONLY}`] : [])],
      { cwd: P(), stdio: "inherit", windowsHide: true }
    );
    ps.on("exit", (c) => resolve(c));
    ps.on("error", () => resolve(1));
  });
}

import { digestBusy, lockDigest } from "./busy.mjs";

const other = digestBusy();
if (other) {
  console.error("[拒绝] 已经有一个 digest 在跑（pid " + other.pid + "，开始于 " + other.startedAt + "）");
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(12);
}
const releaseLock = lockDigest("digest --max=" + MAX + " top=" + TOP + (ONLY ? " only=" + ONLY : ""));

const { ctx } = await connect();
  // 用【自己的临时标签页】干活：跟 autoreply 共用主标签页会互相打断（实测并发时 digest 会崩）
  const cleared = await cleanupStrayTabs(ctx).catch(() => 0);
  if (cleared) console.log(`  (清掉 ${cleared} 个残留标签页)`);
  const page = await ctx.newPage();
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
console.log(`=== digest｜扫 ${MAX} 条，最多转 ${TOP} 条｜收件人：${ONLY || "白名单全部"}｜模式：${SEND ? "真转" : "预演"} ===`);
console.log(`上限：每日 ${LIM.dailyOutgoingCap}、单视频 ${LIM.maxRecipientsPerVideo} 人、冷却 ${LIM.sameVideoCooldownHours}h\n`);

console.log("--- 1) 扫推荐流 ---");
const cands = await scanFeed(page, MAX);
console.log(`扫到 ${cands.length} 条\n`);

console.log("--- 2) 机械开关先筛（不花模型钱）---");
const survivors = [];
for (const c of cands) {
  const mech = evaluate({ desc: c.desc || "", duration: c.duration, stage: "pre" });
  if (mech.blocked) {
    console.log(`  ✗ ${String(c.desc || "").slice(0, 30)} ← ${mech.reasons.map((r) => r.label).join("、")}`);
  } else {
    console.log(`  ✓ ${String(c.desc || "").slice(0, 30)}`);
    survivors.push(c);
  }
}
console.log(`通过机械层 ${survivors.length} 条\n`);

if (!survivors.length) {
  console.log("没有候选通过机械层，结束。");
  emit("digest", { scanned: cands.length, survivors: 0, sent: 0 });
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(0);
}

console.log("--- 3) 逐条精判（进详情页拿章节要点/评论 + 模型判）---");
const judged = [];
for (const c of survivors.slice(0, Math.max(TOP + 2, 3))) {
  console.log(`\n[${c.id}] ${String(c.desc || "").slice(0, 40)}`);
  const content = await readVideoContent(page, c.id);

  const mech2 = evaluate({
    desc: content.title || c.desc || "",
    duration: content.duration,
    hasChapter: content.chapterLines.length > 0,
    likes: content.stats ? content.stats.like : undefined,
    comments: content.comments,
  });
  if (mech2.blocked) {
    console.log(`  机械层（精判后）拦下：${mech2.reasons.map((r) => r.label + "(" + r.detail + ")").join("、")}`);
    judged.push({ ...c, verdict: "skip", why: "mechanical:" + mech2.reasons.map((r) => r.key).join(",") });
    continue;
  }
  let j;
  if (RELAX) {
    // 主动要求模式：他没指望我挑"有意思"，只要不踩硬线就给一个
    j = { verdict: "send", rule: "relax", reason: "他主动要的，不判有意思", confidence: 1 };
    console.log("  [relax] 主动要求模式：跳过“有没有意思”判定");
  } else {
    j = await judgeVideo({
      title: content.title || c.desc,
      duration: content.duration,
      chapterLines: content.chapterLines,
      desc: content.desc || c.desc,
      authorName: content.authorName || c.author,
      stats: content.stats || null,
      comments: content.comments,
    });
  }
  console.log(`  模型判：${j.verdict}｜${j.rule || "-"}｜置信 ${j.confidence ?? "?"}｜${j.reason || "-"}${j.behind ? "（置信不足→不发）" : ""}`);
  // 第二个环节：评分过关后，逐个对照每个人的记忆，命中就直接发给他
  if (j.verdict === "send" && !RELAX && !ONLY) {
    try {
      const ms = await matchFriends({
        title: content.title || c.desc,
        desc: content.desc || c.desc,
        duration: content.duration,
        chapterLines: content.chapterLines,
        comments: content.comments,
        stats: content.stats || null,
      });
      const hit = ms.find((x) => x.match);
      if (hit) {
        j.to = [hit.name];
        console.log(`  [记忆匹配] → ${hit.name}（fit ${hit.fit}）${hit.why}`);
      } else {
        console.log("  [记忆匹配] 没有一个人对得上 → 走默认挑人");
      }
    } catch (e) {
      console.log("  [记忆匹配] 出错，忽略（不影响发送）：" + String(e.message).slice(0, 60));
    }
  }

  const descPrefix = (content.title || c.desc || "").slice(0, 20);
  const rec = {
    id: c.id,
    ts: new Date().toISOString(),
    verdict: j.verdict,
    mechanical: null,
    duration: content.duration,
    maxDurationSeconds: Number(cfg.rules?.switches?.maxDurationSeconds ?? 300) || null,
    note: `digest:${j.rule || "-"} ${j.reason || ""}`.slice(0, 120),
    to: Array.isArray(j.to) ? j.to : [],
    descPrefix,
    title: content.title,
    chapter: content.chapterLines.join(" "),
    chapterLines: content.chapterLines,
    comments: content.comments,
    hasChapter: content.chapterLines.length > 0,
    fingerprint: crypto.createHash("sha256").update(descPrefix + "|" + content.chapterLines.join(" ")).digest("hex").slice(0, 16),
  };
  writeJudgment(rec);
    judged.push({ ...c, verdict: j.verdict, reason: j.reason, score: j.score, hits: j.hits, cuts: j.cuts, to: j.to, fingerprint: rec.fingerprint });
}

console.log("\n--- 4) 结果 ---");
judged.forEach((j) => console.log(`  ${j.verdict === "send" ? "→ 发" : "  跳过"} ${String(j.score ?? "-").padStart(6)}分  ${String(j.desc || "").slice(0, 26)}  → ${(j.to || []).join("/") || (ONLY ? ONLY : "白名单全部")}  ${j.why || j.reason || ""}`));
const picks = judged.filter((j) => j.verdict === "send").slice(0, TOP);

// 判定给了明确收件人就只发给他（一条视频发给最合适的那一个，不群发）
// 路由方式：fit = 按判定挑的人发（默认）；all = 发给白名单全部
const routeMode = (() => {
  try { return String(JSON.parse(fs.readFileSync(P("config.json"), "utf8")).digest?.route || "fit"); } catch { return "fit"; }
})();
const ROUTE = process.env.DYBOT_ROUTE ? process.env.DYBOT_ROUTE !== "all" : routeMode !== "all";
if (!picks.length) {
  console.log("\n没有要转的（这轮干净收工）。");
  emit("digest", { scanned: cands.length, survivors: survivors.length, sent: 0, picks: 0 });
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(SEND ? 11 : 0);   // 11 = 没有候选（让上层区分"没找到"）
}

  // ---------- 实验室：发送前用 AI 总结复核（只在开关打开时）----------
  {
    let labOn = false;
    try { labOn = JSON.parse(fs.readFileSync(P("config.json"), "utf8")).lab?.aiSummary?.enabled === true; } catch {}
    const recheckOn = (() => {
      try { return JSON.parse(fs.readFileSync(P("config.json"), "utf8")).digest?.summaryRecheck !== false; } catch { return true; }
    })();
    if (labOn && recheckOn && picks.length) {
      const kept = [];
      for (const p of picks) {
        console.log(`\n  [复核] ${p.id} 取 AI 总结…`);
        let sum = null;
        const tab2 = await ctx.newPage();
        try {
          sum = await fetchAiSummary(tab2, p.id, { maxWaitMs: 40000 });
        } catch (e) {
          console.log("  [复核] 取总结出错（按通过处理）：" + String(e.message).slice(0, 60));
        } finally {
          try { if (ctx.pages().length > 1) await tab2.close(); else await tab2.goto("about:blank"); } catch {}
        }
        if (!sum || !sum.ok) {
          console.log(`  [复核] 没拿到总结（${sum ? sum.error : "无"}），保持原判定`);
          kept.push(p);
          continue;
        }
        console.log(`  [复核] 拿到 ${sum.text.length} 字${sum.cached ? "（缓存）" : ""}，重新判一次`);
        const j2 = await judgeVideo({
          title: p.title || p.desc || "",
          desc: p.desc || "",
          duration: p.duration,
          chapterLines: [],
          comments: [],
          stats: null,
          aiSummary: sum.text,
        });
        console.log(`  [复核] 结果：${j2.verdict}｜${j2.score ?? "-"}分｜${String(j2.reason || "").slice(0, 80)}`);
        if (j2.verdict === "send") kept.push({ ...p, aiSummary: sum.text });
        else emit("digest-recheck-drop", { id: p.id, reason: String(j2.reason || "").slice(0, 100) });
      }
      picks.length = 0;
      picks.push(...kept);
      if (!picks.length) {
        console.log("\n复核后没有要发的了。");
        emit("digest", { scanned: cands.length, survivors: survivors.length, sent: 0, picks: 0, droppedAllByRecheck: true });
        await closeWorkerTab(page, ctx).catch(() => {});
        process.exit(SEND ? 11 : 0);
      }
    }
  }

if (!SEND) {
  console.log(`\n预演：会转 ${picks.length} 条 → ${picks.map((p) => p.id).join(", ")}`);
  console.log("加 --send 才真转。");
  emit("digest", { scanned: cands.length, survivors: survivors.length, sent: 0, wouldSend: picks.map((p) => p.id) });
  await closeWorkerTab(page, ctx).catch(() => {});
  process.exit(0);
}
console.log(`\n--- 5) 真转（${picks.length} 条）---`);
let ok = 0;
let firstFail = 0;
for (const p of picks) {
  const to = (ROUTE && !ONLY && Array.isArray(p.to) && p.to.length) ? p.to[0] : null;
  if (to) console.log(`  → 判定挑中：${to}`);
  const code = await runForward(p.id, to);
  if (code === 0) ok++; else if (!firstFail) firstFail = code;
}
console.log(`\n完成：${ok}/${picks.length}`);
emit("digest", { scanned: cands.length, survivors: survivors.length, sent: ok, picks: picks.map((p) => p.id), firstFail });
await closeWorkerTab(page, ctx).catch(() => {});
if (ok > 0) process.exit(0);
const map = { 11: 10, 8: 12, 12: 12, 7: 12 };
const exitCode = map[firstFail] || 1;
console.log(`[退出码 ${exitCode}] 一条都没发出去（forward 原始码 ${firstFail}）`);
process.exit(exitCode);
