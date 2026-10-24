// 扫推荐流 N 条，记录 (video_id / 文案 / 作者)，供后续精判
// 用法：node lib/scan.mjs [--count=10]
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";
import fs from "node:fs";

const argv = process.argv.slice(2);
const countArg = argv.find((a) => a.startsWith("--count="));
const COUNT = countArg ? parseInt(countArg.split("=")[1], 10) : 10;

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!/[?&]recommend=1/.test(page.url())) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
}

const readCurrent = () =>
  page.evaluate(() => {
    const d = document.querySelector('[data-e2e="video-desc"]');
    const vid = document.querySelector("[data-e2e-vid]");
    const author = document.querySelector('[data-e2e="feed-video-nickname"]');
    const v = document.querySelector("video");
    return {
      id: vid ? vid.getAttribute("data-e2e-vid") : null,
      desc: d ? d.innerText.replace(/\s+/g, " ").trim() : null,
      author: author ? (author.innerText || "").trim().slice(0, 24) : null,
      duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    };
  });

const out = [];
const seen = new Set();

for (let i = 0; i < COUNT + 4 && out.length < COUNT; i++) {
  const cur = await readCurrent();
  if (cur.id && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push({ ...cur, seq: out.length + 1 });
    console.log(`[${out.length}] ${cur.id}  ${cur.duration ?? "?"}s  @${cur.author ?? "?"}\n     ${(cur.desc || "").slice(0, 70)}`);
  }
  if (out.length >= COUNT) break;

  // 切下一条：滚轮优先，无效则按 ArrowDown
  const before = cur.id;
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(2600);
  let now = await readCurrent();
  if (!now.id || now.id === before) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(2600);
    now = await readCurrent();
  }
  if (!now.id || now.id === before) {
    console.log("!! 切换失败，停在", before);
    break;
  }
}

fs.writeFileSync(P("state", "candidates.json"), JSON.stringify(out, null, 2), "utf8");
console.log(`\n共扫到 ${out.length} 条 → state/candidates.json`);
process.exit(0);
