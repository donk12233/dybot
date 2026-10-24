// 探针：怎么才能真的进到推荐流（不被重定向到 /chat）
import { connect, douyinPage } from "./cdp.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) process.exit(0);

async function tryUrl(u, tag) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const real = page.url();
  const info = await page.evaluate(() => ({
    hasImEntry: !!document.querySelector('[data-e2e="im-entry"]'),
    hasFeedVideo: !!document.querySelector('[data-e2e-vid]'),
    hasDesc: !!document.querySelector('[data-e2e="video-desc"]'),
  })).catch(() => ({}));
  console.log(`  ${tag}: 实际=${real}`);
  console.log(`      im-entry=${info.hasImEntry} 视频=${info.hasFeedVideo} 描述=${info.hasDesc}`);
  return real;
}

console.log("=== 试不同入口 ===");
await tryUrl("https://www.douyin.com/?recommend=1", "首页?recommend=1");
await tryUrl("https://www.douyin.com/discover", "/discover");
await tryUrl("https://www.douyin.com/", "首页/");

console.log("\n=== 新开一个标签页试 ===");
const np = await ctx.newPage();
await np.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await np.waitForTimeout(4500);
const npInfo = await np.evaluate(() => ({
  hasImEntry: !!document.querySelector('[data-e2e="im-entry"]'),
  hasFeedVideo: !!document.querySelector('[data-e2e-vid]'),
})).catch(() => ({}));
console.log(`  新标签页: 实际=${np.url()}`);
console.log(`      im-entry=${npInfo.hasImEntry} 视频=${npInfo.hasFeedVideo}`);
await np.close().catch(() => {});

process.exit(0);
