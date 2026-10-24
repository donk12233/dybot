// 读卡片：优先 data-aweme-id / [href*="/video/"]
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
const cards = await page.evaluate(() => {
  const nodes = new Set();
  document.querySelectorAll("[data-aweme-id]").forEach((e) => nodes.add(e));
  document.querySelectorAll('[href*="/video/"]').forEach((e) => nodes.add(e));

  const out = [];
  const seen = new Set();
  nodes.forEach((el) => {
    let id = el.getAttribute("data-aweme-id") || "";
    if (!id) {
      const h = el.getAttribute("href") || "";
      const m = h.match(/\/video\/(\d+)/);
      if (m) id = m[1];
    }
    if (!id || seen.has(id)) return;
    seen.add(id);

    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    const img = el.querySelector("img");
    const like = (txt.match(/(\d+(?:\.\d+)?\s*万)/) || txt.match(/^\s*(\d{3,})\s/) || [])[1] || null;
    const dur = (txt.match(/\b(\d{1,2}:\d{2})\b/) || [])[1] || null;
    const author = (txt.match(/@([^\s·]+)/) || [])[1] || null;
    // 去掉开头的点赞数和时长，剩下的近似「文案 + 话题 + @作者 + 日期」
    const desc = txt.replace(/^[\d.]+\s*万?\s*/, "").replace(/^\d{1,2}:\d{2}\s*/, "");

    out.push({
      video_id: id,
      like,
      duration: dur,
      author,
      desc: desc.slice(0, 200),
      cover_alt: img ? (img.alt || "").slice(0, 120) : null,
    });
  });
  return out;
});

console.log("卡片数 =", cards.length);
cards.slice(0, 8).forEach((c, i) => {
  console.log(`\n[${i + 1}] id=${c.video_id}  点赞=${c.like}  时长=${c.duration}  @${c.author}`);
  console.log("   ", c.desc);
});

const fs = await import("node:fs");
fs.writeFileSync(P("state", "cards.json"), JSON.stringify(cards, null, 2), "utf8");
console.log("\n→ state/cards.json");
process.exit(0);
