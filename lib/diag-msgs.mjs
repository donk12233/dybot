// 探针：会话里所有"最外层消息项"的原始类名（找那张认不出的卡片）
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) process.exit(0);

if (!page.url().includes("/chat")) {
  await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
}
await page.evaluate(() => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));

const conv = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes("示例好友"));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!conv) { console.log("没找到会话"); process.exit(0); }
await page.mouse.move(conv.x, conv.y);
await page.waitForTimeout(150);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 找出所有"像一条消息"的块：有尺寸、含图片或文字、且父节点里没有更多同级消息
  const all = Array.from(document.querySelectorAll("div"))
    .filter(v)
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.height >= 28 && r.height <= 500 && r.width >= 40 && r.width <= 700;
    })
    .filter((e) => /Message|msg|bubble|Bubble|card|Card|emoji|Emoji/.test(String(e.className || "")))
    .map((e) => {
      const r = e.getBoundingClientRect();
      const img = e.querySelector("img");
      const html = (e.outerHTML || "");
      const ids = Array.from(new Set((html.match(/\b\d{19}\b/g) || []))).slice(0, 3);
      return {
        cls: String(e.className || ""),
        text: (e.innerText || "").replace(/\s+/g, " ").slice(0, 34),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        top: Math.round(r.top),
        hasImg: !!img,
        imgSrc: img ? (img.src || "").slice(0, 50) : null,
        ids,
      };
    })
    .sort((a, b) => b.top - a.top);

  // 去重（同类同位置）
  const seen = new Set();
  return all.filter((o) => {
    const k = o.cls + "|" + o.top;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 14);
});

console.log("=== 最靠下的消息块（新→旧）===");
out.forEach((o) => {
  console.log(`  y=${o.top} ${o.size}  ${o.cls}`);
  console.log(`        文本="${o.text}"  img=${o.hasImg}${o.ids.length ? "  id=" + o.ids.join(",") : ""}`);
  if (o.imgSrc) console.log(`        img=${o.imgSrc}`);
});
process.exit(0);
