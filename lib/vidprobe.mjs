// 抓 data-e2e-vid（推荐流里携带视频 id 的元素）
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
const r = await page.evaluate(() => {
  const els = [...document.querySelectorAll("[data-e2e-vid]")];
  const descEl = document.querySelector('[data-e2e="video-desc"]');
  return {
    count: els.length,
    vals: els.slice(0, 8).map((e) => ({
      vid: e.getAttribute("data-e2e-vid"),
      e2e: e.getAttribute("data-e2e"),
      cls: String(e.className || "").slice(0, 40),
    })),
    desc: descEl ? descEl.innerText.slice(0, 40) : null,
    url: location.href,
  };
});

console.log(JSON.stringify(r, null, 2));
process.exit(0);
