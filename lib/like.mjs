// 给视频点赞（写操作）。默认只"预演"：读状态、判断该不该点，但不真点。
//
// 五条血泪教训（全部来自实测）：
//   1. 点赞按钮只在 ?modal_id= 页面里有；/video/<id> 详情页的 digg 是 0×0 不可见
//   2. 页面上同时有"背景推荐流"和"弹窗视频"，共 4 个点赞按钮 ——
//      必须按祖先里的 video_<id> 选中目标，否则会赞到背景流里的别的视频
//   3. **DOM 点击（el.click()）无效**：抖音忽略非真实点击，界面状态会变"已赞"，
//      但接口里 user_digged 仍是 0（真实事故：控制台显示已点，网页上心没红）
//      → 必须用真实鼠标点击（isTrusted=true）
//   4. 心形按钮中心坐标上往往是 <video>（视频盖在上面）→ 点到视频就暂停。
//      所以点之前先做命中测试；被遮挡就先把它抬到最上层再说
//   5. 点没点上，最可靠的判断是详情接口的 user_digged（0/1），不是 DOM 状态

const DIGG_SELECTORS = [
  '[data-e2e="video-player-digg"]',
  '[data-e2e="like-icon"]',
  '[class*="video-player-digg"]',
];
const MARK = "data-dsh-like";
const API = (id) => `/aweme/v1/web/aweme/detail/?aweme_id=${id}&aid=6383&device_platform=webapp`;

/** 用详情接口查"我有没有赞过这条"，返回值 1/0/null(查不到) */
export async function diggFromApi(page, id) {
  return await page.evaluate(async (awemeId) => {
    try {
      const res = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&device_platform=webapp`, { credentials: "include" });
      const j = await res.json();
      const d = j && j.aweme_detail;
      if (!d) return null;
      return typeof d.user_digged === "number" ? d.user_digged : null;
    } catch { return null; }
  }, String(id)).catch(() => null);
}

/** 找到"属于目标视频"的点赞按钮并打标记；顺便做命中测试 */
async function markDigg(page, wantId) {
  return await page.evaluate(([sels, mark, want]) => {
    const all = [];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        all.push(el);
      });
    }
    const ownerId = (el) => {
      let n = el;
      for (let k = 0; k < 14 && n; k++) {
        const tag = String(n.id || "") + " " + String(n.className || "");
        const m = tag.match(/video_(\d{6,})/);
        if (m) return m[1];
        n = n.parentElement;
      }
      return null;
    };
    const found = all.map((el) => ({ el, owner: ownerId(el) }));
    const hit = found.find((x) => String(x.owner) === String(want));
    if (!hit) return { ok: false, total: all.length, owners: found.map((x) => x.owner) };
    hit.el.setAttribute(mark, String(want));
    return { ok: true, total: all.length, owner: hit.owner };
  }, [DIGG_SELECTORS, MARK, String(wantId)]).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 60) }));
}

/** 读 DOM 状态 + 命中测试；必要时把按钮抬到最上层 */
async function domState(page, lift = false) {
  return await page.evaluate(([mark, doLift]) => {
    const el = document.querySelector(`[${mark}]`);
    if (!el) return { found: false };
    let r = el.getBoundingClientRect();
    let x = Math.round(r.x + r.width / 2);
    let y = Math.round(r.y + r.height / 2);
    let top = document.elementFromPoint(x, y);
    let covered = !top || !(top === el || el.contains(top));
    if (covered && doLift) {
      // 把按钮所在的那一层抬到最上面，让鼠标真的能落到它身上
      try {
        el.style.position = "relative";
        el.style.zIndex = "2147483000";
      } catch {}
      r = el.getBoundingClientRect();
      x = Math.round(r.x + r.width / 2);
      y = Math.round(r.y + r.height / 2);
      top = document.elementFromPoint(x, y);
      covered = !top || !(top === el || el.contains(top));
    }
    const state = el.getAttribute("data-e2e-state") || "";
    return {
      found: true, state, x, y, covered,
      stateActive: /digged$/i.test(state) && !/no-digged$/i.test(state),
      coveredBy: covered && top ? String(top.tagName) : null,
    };
  }, [MARK, lift]).catch(() => ({ found: false }));
}

/**
 * 给一条视频点赞。
 * @param page 专用标签页
 * @param id   video_id
 * @param opts.dryRun 只判断不点（默认 true）
 */
export async function likeVideo(page, id, opts = {}) {
  const dryRun = opts.dryRun !== false;
  if (!id || !/^\d+$/.test(String(id))) return { ok: false, error: "video_id 不合法" };

  await page.goto(`https://www.douyin.com/?modal_id=${id}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2800);

  const pick = await markDigg(page, id);
  if (!pick.ok) {
    return { ok: false, error: `没找到属于这条视频的点赞按钮（共 ${pick.total || 0} 个：${(pick.owners || []).join(",")}），放弃以免点到别的视频`, pick };
  }

  // 权威判断：接口里的 user_digged
  const apiBefore = await diggFromApi(page, id);
  if (apiBefore === 1) return { ok: true, already: true, apiBefore };
  if (apiBefore === null) {
    // 接口查不到就退回 DOM 状态（但结果会标注 verified=false）
    const s = await domState(page);
    if (s.found && s.stateActive) return { ok: true, already: true, domState: s, apiBefore };
  }

  const before = await domState(page, false);
  if (!before.found) return { ok: false, error: "读不到点赞按钮", apiBefore };

  if (dryRun) {
    return { ok: true, dryRun: true, wouldClick: true, covered: before.covered, coveredBy: before.coveredBy, apiBefore, state: before };
  }

  // 被遮挡就抬到最上层（否则点下去会点到视频、把视频暂停）
  let target = before;
  if (before.covered) {
    target = await domState(page, true);
    await page.waitForTimeout(300);
  }
  if (target.covered) {
    return { ok: false, error: `点赞按钮被「${target.coveredBy || "别的元素"}」遮挡且抬不起来，放弃以免点错`, attempted: true, apiBefore, state: target };
  }

  // 真实鼠标点击（DOM 点击无效：抖音忽略非真实事件）
  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.waitForTimeout(220);
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(60);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(2200);

  // 用接口验证（最可靠），接口查不到才看 DOM
  const apiAfter = await diggFromApi(page, id);
  const state = await domState(page);
  const okByApi = apiAfter === 1;
  const okByDom = apiAfter === null && state.found && !target.stateActive && state.stateActive;

  if (okByApi || okByDom) {
    return { ok: true, clicked: true, verified: true, by: okByApi ? "api" : "dom", apiBefore, apiAfter, state };
  }
  return {
    ok: false,
    error: `点了但接口里 user_digged=${apiAfter}（应为 1），没有真正生效`,
    attempted: true, apiBefore, apiAfter, state,
  };
}

export { domState, markDigg };
