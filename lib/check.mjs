// 探针：确认 CDP 可用、登录态、当前页面。**不会关闭浏览器**。
import { connect, douyinPage, loginState } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const pages = ctx.pages();
console.log("CDP 已连接，页面数 =", pages.length);
pages.forEach((p, i) => console.log(`  [${i}] ${p.url()}`));

const page = await douyinPage(ctx, { create: false });
if (!page) {
  console.log("!! 没有找到抖音页面");
  process.exit(2);
}

await page.waitForTimeout(1200);
const st = await loginState(page);
console.log("== 登录态 / 页面 ==");
console.log(JSON.stringify(st, null, 2));

// 试探推荐流：统计可能的视频容器，不做假设，只报数量
const feed = await page.evaluate(() => {
  const q = (s) => document.querySelectorAll(s).length;
  return {
    videoTags: q("video"),
    articleTags: q("article"),
    dataE2E: Array.from(document.querySelectorAll("[data-e2e]")).slice(0, 25).map((e) => e.getAttribute("data-e2e")),
    likeCount: q('[data-e2e="video-player-digg"]'),
    commentCount: q('[data-e2e="feed-comment-icon"]'),
    scrollH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
  };
});
console.log("== 推荐流探针 ==");
console.log(JSON.stringify(feed, null, 2));

const shot = P("state", "probe.png");
await page.screenshot({ path: shot }).catch((e) => console.log("截图失败:", e.message));
console.log("截图:", shot);

// 故意不调用 browser.close()：CDP 连接的浏览器是用户的，不能关
process.exit(0);
