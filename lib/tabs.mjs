// 临时标签页管理：digest / forward / 读视频都用"自己的标签页"，但必须关干净。
// 踩过两个坑：
//  1. process.on("exit", () => page.close()) 无效——close 是异步的，进程退出时还没执行完。
//  2. 清理残留时如果只剩最后一个标签页，关掉它 = 关掉整个浏览器窗口
//     （实测：唯一标签页是 /video/... 时被关，用户看到的就是"点启动浏览器就没了"）。

const BOT_URL_RE = /recommend=1|modal_id=|\/video\/|about:blank/;
const MAIN_URL = "https://www.douyin.com/chat";

/**
 * 关掉"像是我们开出来的"多余标签页，只保留主页面。
 * 关键保护：永远至少留一个标签页；唯一页面不是主页面时，导航回 /chat 而不是关掉。
 */
export async function cleanupStrayTabs(ctx, keepUrlPart = "/chat") {
  let closed = 0;
  const pages = ctx.pages();
  if (!pages.length) return 0;

  for (const p of pages) {
    let u = "";
    try { u = p.url(); } catch { continue; }
    if (u.includes(keepUrlPart)) continue;      // 主页面，留
    if (!BOT_URL_RE.test(u)) continue;          // 不认识的页面（你自己开的），不碰

    // 最后一个标签页：绝不能关，导航回私信页
    if (ctx.pages().length <= 1) {
      try { await p.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch {}
      continue;
    }
    try { await p.close(); closed++; } catch {}
  }
  return closed;
}

/** 开一个工作标签页 */
export async function openWorkerTab(ctx) {
  return await ctx.newPage();
}

/** 用完显式关掉（await，别放 exit 回调里） */
export async function closeWorkerTab(page, ctx) {
  try {
    if (!page || page.isClosed()) return;
    const alive = ctx ? ctx.pages().length : 2;
    if (alive > 1) await page.close();
    else await page.goto("about:blank");   // 绝不能关掉最后一个标签页
  } catch {}
}
