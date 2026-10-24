// 实验室：让抖音自带的 AI 总结说出这条视频讲了什么。
// 只用于"别人转发的视频"这个低频场景，不接主流程（默认手动触发）。
//
// 链路（实测出的顺序，别改）：
//   1) 用弹窗形式打开视频：/?modal_id=<id>&recommend=1
//   2) 点右侧栏最上面那个 AI 方形图标（.ai-douyin-entry，且必须未被遮挡）
//   3) 抽屉打开 → 点顶部「AI抖音」页签（页面里有两排同名页签，取靠上的那排）
//   4) 底部输入框「问AI、找答案」→ 打字「视频总结」→ 回车
//   5) 等文字增长（约 10 秒），抓取回复
//   6) 关掉抽屉
import { badSummaryReason } from "./summarycheck.mjs";
import fs from "node:fs";
import { P } from "./paths.mjs";

const LAB_DIR = P("state", "lab");

function ensureDir() {
  try { fs.mkdirSync(LAB_DIR, { recursive: true }); } catch {}
}

/** 每一步都留一张截图，失败时能直接看 */
async function shot(page, tag) {
  ensureDir();
  const f = P("state", "lab", `${tag}.png`);
  try { await page.screenshot({ path: f }); } catch {}
  return f;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);

/** 找"未被遮挡"的元素中心点（同 class 可能有多份，其中一份在别的图层下面） */
function findClickable(page, selector, filterFn = null) {
  return ev(page, ([sel, fstr]) => {
    const filter = fstr ? new Function("el", "r", "return (" + fstr + ")(el, r);") : null;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
      if (filter && !filter(el, r)) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === el || el.contains(top))) return { x: cx, y: cy };
    }
    return null;
  }, [selector, filterFn]);
}

/** 按文字找"未被遮挡"的元素 */
function findClickableByText(page, texts, zone = null) {
  return ev(page, ([ws, z]) => {
    const norm = (x) => String(x || "").replace(/\s+/g, "").trim();
    for (const el of document.querySelectorAll("div,span,li,button,a")) {
      if (!ws.includes(norm(el.innerText))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (z) {
        if (r.top < z.yMin || r.top > z.yMax) continue;
        if (r.left < innerWidth * z.xPct) continue;
      }
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === el || el.contains(top))) return { x: cx, y: cy, text: norm(el.innerText) };
    }
    return null;
  }, [texts, zone]);
}

/** 当前 URL 里的 modal_id */
function modalIdOf(page) {
  return ev(page, () => {
    const m = (location.href.match(/modal_id=(\d+)/) || [])[1];
    return m || null;
  });
}

// ---------- ① 缓存：同一条视频只取一次 ----------
const CACHE_FILE = P("state", "summaries.json");
const CACHE_MAX = 300;

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveCache(c) {
  try {
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (c[a].ts || 0) - (c[b].ts || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c), "utf8");
  } catch {}
}
export function cachedSummary(videoId) {
  const c = loadCache();
  return c[videoId] || null;
}

// ---------- ⑤ 熔断：连续失败就先停一会儿，别每条都白等 ----------
const BREAKER_FILE = P("state", "summary-breaker.json");
const BREAKER_MAX_FAILS = 3;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

function loadBreaker() {
  try { return JSON.parse(fs.readFileSync(BREAKER_FILE, "utf8")) || { fails: 0, until: 0 }; } catch { return { fails: 0, until: 0 }; }
}
function saveBreaker(b) {
  try { fs.writeFileSync(BREAKER_FILE, JSON.stringify(b), "utf8"); } catch {}
}
export function summaryBlocked() {
  const b = loadBreaker();
  return b.until && Date.now() < b.until ? { until: b.until } : null;
}
function recordFailure() {
  const b = loadBreaker();
  b.fails = Number(b.fails || 0) + 1;
  if (b.fails >= BREAKER_MAX_FAILS) {
    b.fails = 0;
    b.until = Date.now() + BREAKER_COOLDOWN_MS;
    console.log(`[AI总结] 连续失败 ${BREAKER_MAX_FAILS} 次，暂停 30 分钟`);
  }
  saveBreaker(b);
}
function recordSuccess() {
  const b = loadBreaker();
  if (b.fails || b.until) saveBreaker({ fails: 0, until: 0 });
}

// ---------- ④ 窗口可见性：最小化就别点，免得白等 ----------
async function windowState(page) {
  let sess = null;
  try {
    sess = await page.context().newCDPSession(page);
    const { windowId } = await sess.send("Browser.getWindowForTarget");
    const { bounds } = await sess.send("Browser.getWindowBounds", { windowId });
    return bounds && bounds.windowState ? bounds.windowState : "normal";
  } catch {
    return null;
  } finally {
    try { if (sess) await sess.detach(); } catch {}
  }
}


/**
 * @returns {{ok:boolean, text?:string, ms?:number, fromHistory?:boolean, error?:string, steps:string[], shots:string[]}}
 */
export async function fetchAiSummary(page, videoId, opts = {}) {
  // 默认问法写具体一点：只问「视频总结」会得到论文腔的模板话（实测 387 字全是"该视频是…核心内容为…"）
  const ask = String(opts.ask || "用三到五句话说清：1) 谁 2) 发生了什么 3) 结局 4) 看点在哪。不要客套，不要罗列标题");
  const maxWait = Number(opts.maxWaitMs || 40000);
  const steps = [];
  const shots = [];
  const onStep = typeof opts.onStep === "function" ? opts.onStep : null;
  const isCancelled = typeof opts.isCancelled === "function" ? opts.isCancelled : () => false;
  const log = (s) => { steps.push(s); if (onStep) { try { onStep(s); } catch {} } };
  const cancelled = () => {
    if (isCancelled()) { log("收到取消指令，停止"); return true; }
    return false;
  };
  if (!/^\d{6,}$/.test(String(videoId || ""))) {
    return { ok: false, error: "videoId 不合法", steps, shots };
  }

  // ① 缓存命中：同一条视频只取一次
  if (opts.useCache !== false) {
    const hit = cachedSummary(videoId);
    if (hit && hit.text) {
      log(`用缓存（${hit.text.length} 字）`);
      return { ok: true, text: hit.text, ms: 0, fromHistory: !!hit.fromHistory, cached: true, steps, shots };
    }
  }

  // ⑤ 熔断中：别白等
  if (opts.ignoreBreaker !== true) {
    const blocked = summaryBlocked();
    if (blocked) {
      const mins = Math.max(1, Math.round((blocked.until - Date.now()) / 60000));
      return { ok: false, error: `连续失败熔断中，还有 ${mins} 分钟恢复`, blocked: true, steps, shots };
    }
  }

  // ④ 窗口最小化就别点（点了也会落空，还白等）
  if (opts.skipWhenHidden !== false) {
    const ws = await windowState(page);
    if (ws === "minimized") {
      return { ok: false, error: "Edge 窗口最小化，跳过取总结", skipped: true, steps, shots };
    }
  }

  try {
    // 1) 弹窗形式打开（详情页没有这个入口）
    await page.goto(`https://www.douyin.com/?modal_id=${videoId}&recommend=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const got = await modalIdOf(page);
    log(`打开弹窗 modal_id=${got}`);
    if (String(got) !== String(videoId)) {
      // 抖音偶尔会播别的视频，必须拦住，否则总结的是别的片子
      shots.push(await shot(page, `mismatch-${videoId}`));
      return { ok: false, error: `视频对不上：期望 ${videoId}，实际 ${got}`, steps, shots };
    }

    if (cancelled()) return { ok: false, error: "已取消", steps, shots };

    // 2) 点 AI 入口（重试 3 次）
    let entry = null;
    for (let i = 1; i <= 3 && !entry; i++) {
      entry = await findClickable(page, ".ai-douyin-entry");
      if (!entry) { log(`第 ${i} 次没找到可点的 AI 入口，等 1.2 秒重试`); await page.waitForTimeout(1200); }
    }
    if (!entry) {
      shots.push(await shot(page, `noentry-${videoId}`));
      return { ok: false, error: "找不到 AI 入口（可能未登录或被遮挡）", steps, shots };
    }
    await page.mouse.click(entry.x, entry.y);
    log(`点 AI 入口 @${entry.x},${entry.y}`);
    await page.waitForTimeout(2800);

    if (cancelled()) return { ok: false, error: "已取消", steps, shots };

    // 3) 点「AI抖音」页签（取靠上的那排，且必须在抽屉区域）
    let tab = null;
    for (let i = 1; i <= 3 && !tab; i++) {
      tab = await findClickableByText(page, ["AI抖音"], { yMin: 0, yMax: 160, xPct: 0.5 });
      if (!tab) { log(`第 ${i} 次没找到 AI抖音 页签，等 1 秒重试`); await page.waitForTimeout(1000); }
    }
    if (!tab) {
      shots.push(await shot(page, `notab-${videoId}`));
      return { ok: false, error: "抽屉里找不到「AI抖音」页签", steps, shots };
    }
    await page.mouse.click(tab.x, tab.y);
    log(`点 AI抖音 页签 @${tab.x},${tab.y}`);
    await page.waitForTimeout(2200);

    if (cancelled()) return { ok: false, error: "已取消", steps, shots };

    // 4) AI 抽屉是一个 iframe（so-landing.douyin.com/search_ai_mobile），
    //    必须在那个 frame 里找输入框，在主页面找永远找不到。
    let frame = null;
    for (let i = 1; i <= 10 && !frame; i++) {
      frame = page.frames().find((f) => /search_ai_mobile|so-landing\.douyin\.com/.test(f.url()));
      if (!frame) { await page.waitForTimeout(800); }
    }
    if (!frame) {
      shots.push(await shot(page, `noframe-${videoId}`));
      return { ok: false, error: "AI 抽屉的 iframe 没出现", steps, shots, frames: page.frames().map((f) => f.url().slice(0, 80)) };
    }
    log(`找到 AI iframe：${frame.url().slice(0, 60)}`);

    // 5) 在 frame 里定位输入框（contenteditable 优先）
    let input = null;
    for (let i = 1; i <= 3 && !input; i++) {
      input = await frame.evaluate(() => {
        const cands = [...document.querySelectorAll("[contenteditable='true'],textarea,input,[role=textbox]")]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, ce: el.getAttribute("contenteditable") || "", x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
          })
          .filter((o) => o.w > 40 && o.h > 12);
        if (!cands.length) return null;
        cands.sort((a, b) => b.w * b.h - a.w * a.h);
        return cands[0];
      });
      if (!input) { await page.waitForTimeout(900); }
    }
    if (!input) {
      shots.push(await shot(page, `noinput-${videoId}`));
      return { ok: false, error: "iframe 里找不到输入框", steps, shots };
    }
    log(`iframe 内输入框：${input.tag} ce=${input.ce} @${Math.round(input.x)},${Math.round(input.y)} ${Math.round(input.w)}x${Math.round(input.h)}`);

    // 6) 点进 frame 的输入框 → 打字 → 回车
    await frame.evaluate(() => {
      const el = [...document.querySelectorAll("[contenteditable='true'],textarea,input,[role=textbox]")]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 12; })
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (el) { el.focus(); if (el.click) el.click(); }
    });
    await page.waitForTimeout(400);
    await page.keyboard.type(ask, { delay: 45 });
    await page.waitForTimeout(300);

    const beforeLen = await frame.evaluate(() => (document.body.innerText || "").length);
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    log(`已在 iframe 内发送「${ask}」`);

    // 7) 等回复
    let grew = 0;
    let waited = 0;
    while (waited < maxWait) {
      await page.waitForTimeout(1000);
      waited += 1000;
      if (isCancelled()) { await page.keyboard.press("Escape").catch(() => {}); return { ok: false, error: "已取消", steps, shots }; }
      const now = await frame.evaluate(() => (document.body.innerText || "").length).catch(() => 0);
      grew = now - beforeLen;
      if (grew > 80) { await page.waitForTimeout(3500); break; }
    }
    const ms = Date.now() - t0;
    const frameText = await frame.evaluate(() => document.body.innerText || "").catch(() => "");
    const text = (() => {
      let t = frameText;
      const i = t.lastIndexOf(ask);
      if (i >= 0) t = t.slice(i + ask.length);
      // 砍掉尾巴上的"猜你想问 / 相关推荐 / 免责声明"等非总结内容
      for (const cut of ["以上结果由问问AI", "以上内容由", "相关内容推荐", "深度思考", "猜你想问"]) {
        const k = t.indexOf(cut);
        if (k > 40) t = t.slice(0, k);
      }
      // 去掉末尾的「推荐问题」区块。
      // 只 pop 问号行不够：AI 常常以「XX的个人资料介绍」这种非问句收尾，
      // 于是前面几条推荐问题就留下来了（实测样本里留了 2 行）。
      const lines2 = t.split("\n").map((x) => x.trim()).filter(Boolean);
      const isSuggest = (x) =>
        /[？?]$/.test(x) ||
        /^[·\-•]/.test(x) ||
        (x.length <= 30 && /(有哪些|是什么|资料|介绍|推荐|怎么|如何|为什么)$/.test(x)) ||
        (x.length <= 30 && /^(推荐|猜你想问|你可能|相关|看看|还想|要不要)/.test(x));
      for (let n = 0; n < 5 && lines2.length > 2 && isSuggest(lines2[lines2.length - 1]); n++) lines2.pop();
      return lines2.join("\n").trim();
    })();
    shots.push(await shot(page, `ok-${videoId}`));

    // AI 有时不给总结，而是"解释失败原因 + 根据标题猜内容"。这种不能当总结用：
    // 以前只看字数（≥20），于是把猜测当"最可靠"喂给模型，判定质量被污染。
    const badReason = badSummaryReason(text);
    if (badReason) {
      log(`回复不能当总结用：${badReason}｜${text.slice(0, 80)}`);
      await page.keyboard.press("Escape").catch(() => {});
      recordFailure();
      return { ok: false, error: `AI 没给出真总结（${badReason}）`, softFail: true, text: text.slice(0, 200), steps, shots };
    }
    if (!text || text.length < 20) {
      return { ok: false, error: `没等到回复（增长 ${grew} 字，等了 ${ms}ms）`, steps, shots };
    }
    const fromHistory = /以上为历史记录/.test(frameText);
    log(`收到回复：${text.length} 字，用时 ${ms}ms${fromHistory ? "（含历史记录标记）" : ""}`);

    // 8) 关抽屉
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);
    // 成功：写缓存 + 重置熔断计数
    try {
      const c = loadCache();
      c[videoId] = { text: text.trim(), ts: Date.now(), ms, fromHistory: !!fromHistory };
      saveCache(c);
    } catch {}
    recordSuccess();
    return { ok: true, text: text.trim(), ms, fromHistory, steps, shots };
  } catch (e) {
    shots.push(await shot(page, `error-${videoId}`));
    return { ok: false, error: String(e.message || e).slice(0, 200), steps, shots };
  }
}
