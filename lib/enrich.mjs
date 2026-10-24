// 把一条视频"文字化"：章节要点（抖音自带 AI 摘要）+ 评论区前若干条
// 用法：node lib/enrich.mjs <video_id> [--verdict=send|skip] [--write] [--note="理由"]
// 输出：屏幕上的判据材料；加 --write 会落一份"精判记录"到 state/judgments/<id>.json
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";
import { loadConfig } from "./targets.mjs";
import { evaluate, rulesOf, SWITCH_CATALOG } from "./rules.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);

// --from-url：不传 id，直接从当前浏览器地址栏里取。
// 抖音点开视频后 URL 会变成 https://www.douyin.com/?modal_id=<id>&recommend=1
// —— 借这个参数，你手动点开、我来读，绕开"合成点击打不开"的问题。
const fromUrl = argv.includes("--from-url");

async function idFromCurrentUrl(page) {
  const u = page.url();
  const m = u.match(/[?&]modal_id=(\d{6,})/) || u.match(/\/video\/(\d{6,})/);
  return { id: m ? m[1] : null, url: u };
}

let id = argv.find((a) => /^\d{6,}$/.test(a)) || null;
if (!id && !fromUrl) {
  console.error("用法: node lib/enrich.mjs <video_id> [--verdict=send|skip] [--write]");
  console.error("   或: node lib/enrich.mjs --from-url   （读当前浏览器地址栏里的 modal_id）");
  process.exit(1);
}

const verdictArg = argv.find((a) => a.startsWith("--verdict="));
const noteArg = argv.find((a) => a.startsWith("--note="));
const WRITE = argv.includes("--write");

// ---- 每次都把当前判据读出来，作为判定的强制输入（不许凭记忆判）----
const cfg = loadConfig();
const R = cfg.rules || {};
const SW = rulesOf(cfg);
const MAX_DUR = Number(SW.maxDurationSeconds ?? 0); // 0 = 不限
console.log("=== 当前生效的判据（来自 config.json，判定必须基于它）===");
console.log("硬禁区（命中即不发）:");
(R.blocked || []).forEach((x) => console.log("  ✗ " + x));
console.log("明确不算有意思:");
(R.notInteresting || []).forEach((x) => console.log("  - " + x));
console.log("机器开关（勾了的就是代码在拦）:");
SWITCH_CATALOG.forEach((s) => {
  const v = SW[s.key];
  const on = s.type === "bool" ? v === true : s.type === "list" ? (v || []).length > 0 : Number(v) > 0;
  console.log(`  ${on ? "☑" : "☐"} ${s.label}${s.type === "bool" ? "" : " = " + JSON.stringify(v)}`);
});
console.log("");

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!id) {
  const got = await idFromCurrentUrl(page);
  console.log("当前 URL:", got.url);
  if (!got.id) {
    console.error("[停止] 当前地址栏里既没有 modal_id 也没有 /video/{id}。请先在浏览器里点开那条视频。");
    process.exit(3);
  }
  id = got.id;
  console.log("从地址栏取到 id:", id);
}

await page.goto(`https://www.douyin.com/video/${id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

// 点「章节要点」前，先把整页文本拍个快照
const before = await page.evaluate(() =>
  (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean)
);

// 点「章节要点」（不保证每个视频都有）
const clicked = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("div,span,button"))
    .filter((e) => (e.textContent || "").trim() === "章节要点")
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) return false;
  el.click();
  return true;
});
await page.waitForTimeout(2200);

const data = await page.evaluate((beforeLines) => {
  const lines = (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const beforeSet = new Set(beforeLines);
  // 只取"点开后才出现"的新文本 —— 这样才不会把右侧相关推荐标题当成章节要点
  const added = lines.filter(
    (l) =>
      !beforeSet.has(l) &&
      l.length > 12 &&
      !/^\d{1,2}:\d{2}/.test(l) &&      // 剔除 00:04 / 19:43 这类进度码
      !/^\/\s*\d/.test(l) &&
      !/^(分享|回复|展开|收起)$/.test(l)
  );
  const comments = Array.from(document.querySelectorAll('[data-e2e="comment-item"]'))
    .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  const title = document.title.replace(/\s*-\s*抖音\s*$/, "");
  const v = document.querySelector("video");
  const duration = v && isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;
  return { title, chapterLines: added.slice(0, 6), addedCount: added.length, comments, duration, url: location.href };
}, before);


const chapter = data.chapterLines.join(" ");
const descPrefix = data.title.slice(0, 20);

console.log("=== 视频 " + id + " ===");
console.log("时长:", data.duration ? `${data.duration}s（${(data.duration / 60).toFixed(1)} 分钟）` : "未知");
console.log("标题/文案:", data.title.slice(0, 90));
console.log("章节要点", clicked ? "(已展开)" : "(没有这个按钮/点不开)", ":");
data.chapterLines.forEach((l) => console.log("  · " + l.slice(0, 160)));
console.log("\n评论前 " + data.comments.length + " 条:");
data.comments.forEach((c, i) => console.log(`  ${i + 1}. ${c.slice(0, 110)}`));

const fingerprint = crypto.createHash("sha256").update(descPrefix + "|" + chapter).digest("hex").slice(0, 16);
console.log("\n指纹:", fingerprint, " 文案前缀:", JSON.stringify(descPrefix));

// ---- 机器判定：所有"能被代码执行"的开关都在这里生效，不许由我"觉得"来判 ----
let verdict = verdictArg ? verdictArg.split("=")[1] : null;
const mech = evaluate({
  desc: data.title,
  duration: data.duration,
  hasChapter: data.chapterLines.length > 0,
  comments: data.comments,
});
let mechanical = null;
if (mech.blocked) {
  mechanical = mech.reasons.map((r) => `${r.key}(${r.detail})`).join("; ");
  console.log("");
  mech.reasons.forEach((r) => console.log(`[机械拦截] ${r.label} —— ${r.detail}`));
  if (verdict === "send") console.log("  你给的 verdict=send 被强制改为 skip");
  verdict = "skip";
}

if (WRITE) {
  const dir = P("state", "judgments");
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    id,
    ts: new Date().toISOString(),
    verdict,
    mechanical,
    duration: data.duration,
    maxDurationSeconds: MAX_DUR || null,
    note: noteArg ? noteArg.split("=").slice(1).join("=") : null,
    descPrefix,
    title: data.title,
    chapter,
    chapterLines: data.chapterLines,
    comments: data.comments,
    fingerprint,
    hasChapter: data.chapterLines.length > 0,
  };
  const p = path.join(dir, id + ".json");
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), "utf8");
  console.log("已写精判记录:", p, " verdict =", JSON.stringify(rec.verdict));
  if (!rec.verdict) console.log("!! 注意：没给 --verdict，这份记录不能用于发送");
}
process.exit(0);
