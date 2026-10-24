// 探针：这个 id 到底是不是普通视频（还是图文/合集/直播）
import { connect, douyinPage } from "./cdp.mjs";

const ID = (process.argv[2] || "").trim();
if (!/^\d{6,}$/.test(ID)) {
  console.log("用法: node lib/diag-vtype.mjs <视频id>   （从 /video/<id> 里取）");
  process.exit(0);
}
const { ctx } = await connect();
const main = await douyinPage(ctx, { create: false });

// 用临时标签页，不动主页面
const tab = await ctx.newPage();
await tab.goto(`https://www.douyin.com/video/${ID}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await tab.waitForTimeout(4500);

const info = await tab.evaluate(() => {
  const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (document.body.innerText || "").slice(0, 1500);
  return {
    url: location.href,
    title: document.title.slice(0, 80),
    hasVideoTag: !!document.querySelector("video"),
    hasChapterBtn: Array.from(document.querySelectorAll("div,span,button")).some((e) => (e.textContent || "").trim() === "章节要点" && v(e)),
    imgs: Array.from(document.querySelectorAll("img")).filter(v).filter((e) => e.getBoundingClientRect().height > 200).length,
    textHead: txt.replace(/\s+/g, " ").slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 2));

await tab.close().catch(() => {});
process.exit(0);
