// 私信里的视频：拿 id + 读内容。给 autoreply 复用。
// 关键事实（都实测过）：
//  · 点私信卡片后，id 只出现在地址栏的 ?modal_id=<id> 里；在 /chat 里点开只有播放地址，没有 id
//  · 这条路径只在"推荐流页面 + 右侧消息浮窗"里成立
//  · 浮窗里的消息列表是虚拟渲染的：不滚到底就找不到最新卡片（"没有『对方发来的』视频卡片"就是这么来的）
//  · 方向用 isFromMe 类名判断（比左右坐标可靠）
import { douyinPage } from "./cdp.mjs";

const CONV = process.env.DYBOT_CONV || "示例好友";

export function parseId(u) {
  const m = String(u).match(/[?&]modal_id=(\d{6,})/);
  if (m) return m[1];
  const v = String(u).match(/\/video\/(\d{6,})/);
  return v ? v[1] : null;
}

async function clickXY(page, x, y, waitMs = 2500) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(waitMs);
}

/** 安全 evaluate：页面导航打断时返回 null，而不是抛错中断整轮 */
async function safeEval(page, fn, arg) {
  try {
    return arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
  } catch {
    return null;
  }
}

/** 把浮窗消息列表滚到底（虚拟列表，不滚就没有最新卡片） */
async function scrollDrawerToBottom(page, rounds = 3) {
  const box = await safeEval(page, () => {
    const el =
      document.querySelector("#imSaasContainerId") ||
      document.querySelector('[class*="messageList"]') ||
      document.querySelector('[class*="MessageList"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!box) return false;

  await page.mouse.move(box.x, box.y).catch(() => {});
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(650);
  }
  await safeEval(page, () => {
    const el = document.querySelector("#imSaasContainerId");
    if (!el) return;
    const sc = Array.from(el.querySelectorAll("*")).find((x) => x.scrollHeight > x.clientHeight + 40);
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
  await page.waitForTimeout(700);
  return true;
}

/** 统计浮窗里现在能看到几张卡片（区分对方发的 / 我发的） */
async function countCards(page) {
  return await safeEval(page, () => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cards = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer, .MessageBoxContentactiveClickArea, .MessageItemCommentSharecontainer")).filter(v);
    let recv = 0, mine = 0;
    for (const c of cards) {
      let own = c, fromMe = false;
      for (let i = 0; i < 5 && own; i++) {
        if (/isFromMe/.test(String(own.className || ""))) { fromMe = true; break; }
        own = own.parentElement;
      }
      if (fromMe) mine++; else recv++;
    }
    return { total: cards.length, recv, mine };
  });
}

/** 打开"对方发来的最新一条视频卡片"，返回 { id, author } 或 { error }。会离开当前页面。 */
export async function getNewestIncomingCardId(page, convName = CONV) {
  // 重要：用【临时标签页】干活。
  // 实测当前标签页会一直重定向回 /chat（访问 / 、/discover、/?recommend=1 都会被弹回来），
  // 所以在主页面里永远进不了推荐流，也就永远拿不到 modal_id。
  // 新开标签页则正常。顺带好处：主页面完全不动，不用来回导航，风控压力更小。
  const ctxRef0 = page.context();
  try { ctxRef0.setDefaultTimeout(20000); } catch {}
  const tab = await ctxRef0.newPage();
  try {
    return await _getCardIdInTab(tab, convName);
  } finally {
    // 绝不能关掉最后一个标签页：那等于把整个浏览器窗口关掉（看起来就像闪退）
    if (ctxRef0.pages().length > 1) await tab.close().catch(() => {});
    else await tab.goto("about:blank").catch(() => {});
  }
}

async function _getCardIdInTab(page, convName) {
  await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4500);
  const convCount = () =>
    safeEval(page, () => {
      const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).length;
    });

  // 打开浮窗（最多试 3 次）
  for (let attempt = 0; attempt < 3; attempt++) {
    const n = await convCount();
    if (n && n > 0) break;
    const e = await safeEval(page, () => {
      const el = document.querySelector('[data-e2e="im-entry"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (e) await clickXY(page, e.x, e.y, 3200);
    else await page.waitForTimeout(1500);
  }
  const n2 = await convCount();
  if (!n2) return { error: "打不开消息浮窗" };

  // 点会话
  const conv = await safeEval(page, (name) => {
    const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const t = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v).find((e) => (e.innerText || "").includes(name));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, convName);
  if (!conv) return { error: `浮窗里没有会话 ${convName}` };
  await clickXY(page, conv.x, conv.y, 2600);

  // 滚到底，确认卡片渲染
  let counts = await countCards(page);
  for (let round = 0; round < 3; round++) {
    if (counts && counts.recv > 0) break;
    await scrollDrawerToBottom(page, 3);
    counts = await countCards(page);
  }
  if (!counts || counts.recv === 0) {
    return {
      error: `没有『对方发来的』视频卡片（共 ${counts ? counts.total : "?"} 张，我发的 ${counts ? counts.mine : "?"} 张）`,
    };
  }

  // 取最靠下的那张 RECV 卡片 —— 返回元素句柄，用 DOM 点击（坐标点击会点到别的地方，
  // 实测会跳到 /chat，导致"某些视频永远拿不到 id"）
  const { handle, author } = (await (async () => {
    try {
      const h = await page.evaluateHandle(() => {
        const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // 关键：只有"里面有像样封面图"的才算视频卡片。
        // 踩过的坑：带留言时，那条文字消息也带 MessageBoxContentactiveClickArea，
        // 尺寸只有 92×40，被当成"最靠下的卡片"选中 → 点上去毫无反应。
        const list = Array.from(document.querySelectorAll(".MessageItemShareAwemecontainer, .MessageBoxContentactiveClickArea, .MessageItemCommentSharecontainer"))
          .filter(v)
          .map((c) => {
            let own = c, fromMe = false;
            for (let i = 0; i < 5 && own; i++) {
              if (/isFromMe/.test(String(own.className || ""))) { fromMe = true; break; }
              own = own.parentElement;
            }
            const r = c.getBoundingClientRect();
            const a = c.querySelector('[class*="authorName"]');
            const imgs = Array.from(c.querySelectorAll("img"))
              .map((im) => im.getBoundingClientRect())
              .filter((ir) => ir.width >= 60 && ir.height >= 60);
            const cover = imgs.sort((x, y) => y.width * y.height - x.width * x.height)[0] || null;
            return { el: c, fromMe, author: a ? a.textContent.trim() : null, top: r.top, hasCover: !!cover, coverArea: cover ? cover.width * cover.height : 0 };
          })
          .filter((x) => !x.fromMe)
          .sort((a, b) => b.top - a.top);
        // 优先选有真实封面的；一张都没有才退回原来的逻辑
        const withCover = list.filter((x) => x.hasCover);
        const pick = (withCover.length ? withCover : list)[0];
        return pick ? pick.el : null;
      });
      const el = h.asElement();
      if (!el) return { handle: null, author: null };
      const a = await el.evaluate((node) => {
        const n = node.querySelector('[class*="authorName"]');
        if (n) return n.textContent.trim();
        // 新式卡片没有 authorName：用卡片自己的首行文字（可能就是作者/留言）
        return (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20) || null;
      }).catch(() => null);
      // 优先拿里面的封面图当点击目标：新式卡片的外层容器可能不可点
      // 点"最大的那张图"（封面），而不是第一个 img（可能是头像/小图标）
      const imgH = await el.evaluateHandle((node) => {
        const imgs = Array.from(node.querySelectorAll("img"));
        if (!imgs.length) return null;
        return imgs.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        })[0];
      }).catch(() => null);
      const imgEl = imgH && imgH.asElement ? imgH.asElement() : null;
      return { handle: imgEl || el, author: a };
    } catch {
      return { handle: null, author: null };
    }
  })());

  if (!handle) return { error: "定位不到卡片元素" };

  // 常开诊断：万一选错元素，日志里能直接看出它的尺寸和类名
  const cardInfo = await handle.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const imgs = n.querySelectorAll("img").length;
    return { tag: n.tagName, cls: String(n.className || "").slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], imgs };
  }).catch(() => null);
  if (cardInfo) console.log("[卡片] 选中 " + JSON.stringify(cardInfo));


  // 点卡片拿 id：
  //  · 正常情况 → 当前标签页 URL 变成 ?modal_id=xxx
  //  · 有些内容会【另开新标签页】打开 → 必须去新标签页里找 id（这就是"某些视频永远打不开"的原因）
  const ctxRef = page.context();
  const pagesBefore = new Set(ctxRef.pages());
  let id = null;
  let lastUrl = "";
  const urlsSeen = [];

  for (let i = 0; i < 3 && !id; i++) {
    // 关键：先把卡片滚进可见区，再点"可见部分"的中心。
    // 踩过的坑：留言在视频下方时，滚到底会把卡片顶出抽屉可见区，
    // 此时点它的 boundingBox 中心会落到抽屉外/别的元素上 → 永远拿不到 modal_id。
    const point = await handle
      .evaluate((node) => {
        try { node.scrollIntoView({ block: "center", inline: "center" }); } catch {}
        // 找到卡片容器：点中容器里的任何元素（包括播放按钮那个 SVG）都算有效，
        // 因为真实用户点封面中间那个"播放三角"一样能打开视频。
        let box = node;
        for (let i = 0; i < 6 && box.parentElement; i++) {
          box = box.parentElement;
          if (/MessageItemShareAweme|MessageBoxContentactiveClickArea/.test(String(box.className || ""))) break;
        }
        const r = node.getBoundingClientRect();
        const left = Math.max(r.left, 0);
        const top = Math.max(r.top, 0);
        const right = Math.min(r.right, innerWidth);
        const bottom = Math.min(r.bottom, innerHeight);
        const visW = Math.max(0, right - left);
        const visH = Math.max(0, bottom - top);
        const diag = {
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          vis: [Math.round(visW), Math.round(visH)],
          box: String(box.className || "").slice(0, 30),
        };
        if (visW < 20 || visH < 20) return { ok: false, why: "视口内可见区域太小", ...diag };

        const tries = [];
        for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
          for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85, 0.95, 0.05]) {
            const x = Math.round(left + visW * fx);
            const y = Math.round(top + visH * fy);
            const hit = document.elementFromPoint(x, y);
            // 容器内任何元素都算（封面图、播放图标、作者名条都行）
            const inside = !!hit && (hit === node || node.contains(hit) || box.contains(hit));
            if (inside) return { ok: true, x, y, diag, hit: hit.tagName };
            if (tries.length < 4) tries.push({ x, y, at: hit ? hit.tagName + "." + String(hit.className).slice(0, 20) : "null" });
          }
        }
        // 全都不在容器内：不退让了，直接点中心（真实用户就是这么点的）
        return { ok: true, x: Math.round(left + visW / 2), y: Math.round(top + visH / 2), forced: true, diag, tries };
      })
      .catch(() => null);

    if (point) console.log("[卡片] 点击点 " + JSON.stringify({ x: point.x, y: point.y, forced: !!point.forced, vis: point.diag && point.diag.vis }) + (point.ok ? "" : "（未通过校验，走 DOM 点击）"));
    if (point && point.ok) {
      await page.mouse.move(point.x, point.y).catch(() => {});
      await page.waitForTimeout(150);
      await page.mouse.down().catch(() => {});
      await page.mouse.up().catch(() => {});
    } else {
      // 兜底：直接点元素（某些布局用坐标点不到，但 DOM 点击可以）
      await handle.click({ timeout: 6000 }).catch(() => {});
    }

    await page.waitForTimeout(4000);
    lastUrl = page.url();
    urlsSeen.push(lastUrl.slice(0, 100));

    id = parseId(lastUrl);

    // 看看有没有新开的标签页
    if (!id) {
      const fresh = ctxRef.pages().filter((p) => !pagesBefore.has(p));
      for (const np of fresh) {
        await np.waitForLoadState("domcontentloaded").catch(() => {});
        await np.waitForTimeout(1200);
        const u = np.url();
        urlsSeen.push("[新页] " + u.slice(0, 100));
        const got = parseId(u);
        if (got) {
          id = got;
          await np.close().catch(() => {});
          break;
        }
        await np.close().catch(() => {});
      }
    }

    if (!id) {
      if (point && !point.ok) urlsSeen.push("[点击诊断] " + JSON.stringify(point).slice(0, 160));
      await safeEval(page, () => document.querySelectorAll("#pc-im-popup-container").forEach((e) => (e.style.display = "none")));
      await page.waitForTimeout(600);
    }
  }

  if (!id) {
    return {
      error: "三次点击都没拿到 modal_id",
      author: author,
      detail: { lastUrl: lastUrl.slice(0, 100), urlsSeen: urlsSeen.slice(-6), pages: ctxRef.pages().length },
    };
  }
  await handle.dispose().catch(() => {});
  return { id, author: author };
}

/** 读一条视频的文字内容：标题 / 时长 / 章节要点 / 评论。会导航到详情页。 */
export async function readVideoContent(page, id, opts = {}) {
  const readyTimeout = Number(opts.readyTimeoutMs || 15000);
  const maxTries = Number(opts.tries || 2);
  const diag = { url: "", tries: 0, ready: false, reason: "" };

  /** 页面"真的加载好"了吗：标题不是通用标题、且有视频元素或足够正文 */
  const isReady = () =>
    safeEval(page, () => {
      const title = (document.title || "").replace(/\s*-\s*抖音\s*$/, "").trim();
      const generic = !title || /^抖音/.test(title);
      const v = document.querySelector("video");
      const lines = (document.body.innerText || "").split("\n").filter((x) => x.trim()).length;
      return { ok: !generic && (!!v || lines > 80), title: title.slice(0, 30), lines, hasVideo: !!v, href: location.href };
    });

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    diag.tries = attempt;
    await page.goto(`https://www.douyin.com/video/${id}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    // 轮询等"加载好"，最多 readyTimeout 毫秒
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < readyTimeout) {
      await page.waitForTimeout(800);
      st = await isReady();
      diag.url = st.href;
      if (st.ok) break;
    }
    diag.ready = !!(st && st.ok);
    if (diag.ready) break;

    // 没加载好：如果是被重定向到别的页面，下一轮重试
    diag.reason = !st ? "读不到页面" : st.href.includes("/chat") ? "被重定向到 /chat" : st.href.includes("verify") || st.href.includes("captcha") ? "出现验证页" : `未就绪（title=${st.title} 行=${st.lines} 有视频=${st.hasVideo}）`;
    await page.waitForTimeout(1500);
  }

  await page.waitForTimeout(600);
  const before =
    (await safeEval(page, () =>
      (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean)
    )) || [];

  // 章节要点：找到那个按钮/标题点开（找不到就算了，不影响其它字段）
  await safeEval(page, () => {
    const el = Array.from(document.querySelectorAll("div,span,button"))
      .filter((e) => (e.textContent || "").trim() === "章节要点")
      .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (el) el.click();
  });
  await page.waitForTimeout(1800);

  const data = await safeEval(page, (beforeLines) => {
    const lines = (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const beforeSet = new Set(beforeLines);
    const cleanComment = (raw) => {
      let t = String(raw || "").replace(/\s+/g, " ").trim();
      t = t.replace(/\s*\d+\s*(秒|分钟|小时|天|周|月|年)\s*前/g, "");
      t = t.replace(/·[^\s·]{1,8}\s*$/g, "");
      t = t.replace(/\s*\d+\s*分享\s*回复.*$/g, "");
      t = t.replace(/\s*分享\s*回复.*$/g, "");
      t = t.replace(/\s*展开\s*\d*\s*条?回复.*$/g, "");
      t = t.replace(/\s*作者\s*$/g, "");
      return t.replace(/\s+/g, " ").trim();
    };
    const comments = Array.from(document.querySelectorAll('[data-e2e="comment-item"]'))
      .map((e) => cleanComment(e.innerText))
      .filter((t) => t && t.length >= 2)
      .map((t) => t.slice(0, 60))
      .slice(0, 5);
    const added = lines.filter((l) => !beforeSet.has(l) && l.length > 12 && !/^\d{1,2}:\d{2}/.test(l) && !/^\/\s*\d/.test(l));
    if (!comments.length) comments.push(...added.filter((l) => l.length > 10 && l.length < 80).slice(0, 3));
    const v = document.querySelector("video");

    const pick = (sels) => {
      for (const s of sels) {
        try {
          const e = document.querySelector(s);
          const t = e && (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
          if (t) return t.slice(0, 60);
        } catch {}
      }
      return null;
    };
    const num = (t) => {
      if (!t) return null;
      const m = String(t).replace(/[,\s]/g, "").match(/([\d.]+)\s*(万|w|亿|k)?/i);
      if (!m) return null;
      let n = parseFloat(m[1]);
      if (!isFinite(n)) return null;
      const u = (m[2] || "").toLowerCase();
      if (u === "万" || u === "w") n *= 10000;
      else if (u === "亿") n *= 100000000;
      else if (u === "k") n *= 1000;
      return Math.round(n);
    };

    const stats = {
      like: num(pick(['[data-e2e="video-player-digg"]', '[data-e2e="video-like-count"]'])),
      comment: num(pick(['[data-e2e="feed-comment-icon"]', '[data-e2e="video-comment-count"]'])),
      collect: num(pick(['[data-e2e="video-player-collect"]', '[data-e2e="video-collect-count"]'])),
      share: num(pick(['[data-e2e="video-player-share"]', '[data-e2e="video-share-count"]'])),
    };
    const hasAnyStat = Object.values(stats).some((x) => typeof x === "number");

    return {
      title: document.title.replace(/\s*-\s*抖音\s*$/, ""),
      duration: v && isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null,
      chapterLines: added.slice(0, 4),
      comments,
      desc: pick(['[data-e2e="video-desc"]', '[class*="videoDesc"]', '[class*="desc"]']),
      authorName: (() => {
        const cands = ['[data-e2e="video-author-name"]', 'a[href*="/user/"] [class*="name"]', '[class*="authorInfo"] [class*="name"]'];
        for (const sel of cands) {
          try {
            const el = document.querySelector(sel);
            const t = el && (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
            if (t && t.length <= 24) return t;
          } catch {}
        }
        return null;
      })(),
      stats: hasAnyStat ? stats : null,
    };
  }, before);

  const out = data || { title: "", duration: null, chapterLines: [], comments: [], desc: null, authorName: null, stats: null };
  out.diag = diag;
  return out;
}
export function describeVideo({ author, id, title, duration, chapterLines, comments, desc, stats, aiSummary }) {
  const parts = [`他刚发来一条视频${author ? `（作者 ${author}）` : ""}：${title || "无标题"}`];
  if (duration) parts.push(`时长 ${duration} 秒`);
  if (chapterLines && chapterLines.length) parts.push(`平台给的章节要点：${chapterLines.join(" / ")}`);
  if (comments && comments.length) parts.push(`热门评论：${comments.slice(0, 3).map((c) => c.slice(0, 60)).join(" ｜ ")}`);
  if (aiSummary) parts.push(`【抖音AI总结（整片内容，最可靠）】\n${String(aiSummary).slice(0, 1200)}`);
  // 关键：明确告诉她「这些就是你能看到的全部」，否则她会把「只有标题/章节」当成「打不开」（实测）。
  const gotSomething = !!(title && !/^抖音/.test(String(title))) || (chapterLines && chapterLines.length) || (comments && comments.length);
  parts.push("");
  parts.push(gotSomething
    ? "（上面这些就是你能看到的全部：标题、时长、平台章节要点、热门评论。别说「打不开」或「没收到」——这些信息足够接话；拿不准的细节别编，可以直接问他视频里到底啥情况。）"
    : "（这条视频的内容确实没读到。老实说没打开就行，别猜。）");
  return parts.join("\n");
}
