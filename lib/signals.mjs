// 探针：我到底能从一条视频里拿到哪些信号
import { connect, douyinPage } from "./cdp.mjs";
import { P } from "./paths.mjs";

const { ctx } = await connect();
const page = await douyinPage(ctx, { create: false });
if (!page) { console.error("[退出 2] 没有抖音页面（请在 Edge 里打开 douyin.com）"); process.exit(2); }
if (!/[?&]recommend=1/.test(page.url())) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
}

const sig = await page.evaluate(() => {
  const d = document.querySelector('[data-e2e="video-desc"]');
  const v = document.querySelector("video");
  const dm = document.querySelector('[data-e2e="danmaku-container"]');
  const author = document.querySelector('[data-e2e="feed-video-nickname"]') || document.querySelector('[data-e2e="video-avatar"]');

  const dmLines = dm ? dm.innerText.split("\n").map((s) => s.trim()).filter(Boolean) : [];

  return {
    desc: d ? d.innerText.trim() : null,
    author: author ? (author.innerText || "").trim().slice(0, 30) : null,
    duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    currentTime: v ? Math.round(v.currentTime) : null,
    paused: v ? v.paused : null,
    muted: v ? v.muted : null,
    poster: v ? (v.poster || "").slice(0, 80) : null,
    hasAudioTrack: v ? (typeof v.webkitAudioDecodedByteCount !== "undefined" || typeof v.mozHasAudio !== "undefined") : null,
    danmakuContainer: !!dm,
    danmakuLines: dmLines.slice(0, 10),
    danmakuCount: dmLines.length,
    // 有没有字幕/章节（AI 抖音功能可能给文字）
    chapter: !!document.querySelector('[data-e2e="chapter-container"]'),
    chapterText: (document.querySelector('[data-e2e="chapter-container"]') || {}).innerText?.slice(0, 200) || null,
  };
});

console.log(JSON.stringify(sig, null, 2));

// 单独截视频区域，看看"一帧"能给我什么
const box = await page.locator("video").first().boundingBox().catch(() => null);
if (box) {
  await page.screenshot({
    path: P("state", "one-frame.png"),
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  }).catch(() => {});
  console.log("已截取视频区域: state/one-frame.png", JSON.stringify({ w: Math.round(box.width), h: Math.round(box.height) }));
}
process.exit(0);
