// 极简本地控制台：零依赖（Node 内置模块），只读写同目录上层的 config.json
// 启动：node console/server.mjs   （或双击 start-console.bat）
// 仅监听 127.0.0.1，不对外。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { SWITCH_CATALOG, rulesOf } from "../lib/rules.mjs";
import { tailEvents, runnerAlive, sumUsageToday, emit, clearRunner, writeRunner } from "../lib/events.mjs";
import { summary as scheduleSummary } from "../lib/schedule.mjs";
import { addFacts, loadMemory, saveMemory } from "../lib/memory.mjs";
import { backfillMemory } from "../lib/memfill.mjs";
import { buildChatPrompt } from "../lib/prompt.mjs";
import { generateReply } from "../lib/llm.mjs";
import { checkReply } from "../lib/checkreply.mjs";
import { memoryBlock } from "../lib/memory.mjs";
import { connect, loginState } from "../lib/cdp.mjs";
import { fetchAiSummary } from "../lib/videosummary.mjs";
import { verifyPresent } from "../lib/guard.mjs";
import { DEFAULT_CHARACTER } from "../lib/persona-card.mjs";
import { listLexicon, addTerm, banTerm, unbanTerm, deleteTerm, toggleTerm, lexiconStats, setMeaning } from "../lib/lexicon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(ROOT, "config.json");
const HTML = path.join(__dirname, "index.html");
const DIGEST_LOG = path.join(ROOT, "state", "digest.log");
const DIGEST_RUN = path.join(ROOT, "state", "digest.json");

// ---------- 控制台鉴权 ----------
// 只要 loopback 还不够：本机别的网页也能 POST 到 127.0.0.1（CSRF）。
// 所以写操作（POST）必须带 x-console-token，token 在服务端生成、注入页面。
const TOKEN_FILE = path.join(ROOT, "state", "console.token");
function consoleToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + "\n", "utf8");
  return t;
}
const TOKEN = consoleToken();

function requireToken(req, res) {
  const got = req.headers["x-console-token"];
  if (got && got === TOKEN) return true;
  send(res, 403, "application/json; charset=utf-8", JSON.stringify({
    ok: false, error: "缺少或错误的 x-console-token（写操作被拒绝）",
  }));
  return false;
}

function digestRunning() {
  try {
    const r = JSON.parse(fs.readFileSync(DIGEST_RUN, "utf8"));
    if (!r || !r.pid) return null;
    process.kill(r.pid, 0);
    return r;
  } catch {
    return null;
  }
}
const PORT = Number(process.env.CONSOLE_PORT || 3200);
const HOST = "127.0.0.1";
const MAX_BODY = 512 * 1024;

function send(res, code, type, body) {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG, "utf8");
  return { raw, data: JSON.parse(raw) };
}

// 极简结构校验：宁可拒绝写入，也不要把坏配置留给 agent 读
function validate(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== "object") return ["配置必须是对象"];
  const need = ["persona", "rules", "friends", "limits"];
  for (const k of need) if (!(k in cfg)) errs.push(`缺少字段：${k}`);

  if (cfg.rules) {
    if (!Array.isArray(cfg.rules.blocked)) errs.push("rules.blocked 必须是数组");
    if ("maxDurationSeconds" in cfg.rules) {
      const d = cfg.rules.maxDurationSeconds;
      if (typeof d !== "number" || d < 0) errs.push("rules.maxDurationSeconds 必须是非负数字（0 = 不限）");
    }
    // 硬禁区锁定：不允许被改成空数组或删除（防误操作）
    if (cfg.rules.blockedLocked !== true) errs.push("rules.blockedLocked 必须为 true（硬禁区不可解锁）");
    if (Array.isArray(cfg.rules.blocked) && cfg.rules.blocked.length === 0) errs.push("rules.blocked 不能为空");
  }

  if (Array.isArray(cfg.friends)) {
    if (cfg.friends.length > 5) errs.push("白名单最多 5 人");
    if (cfg.lab && cfg.lab.autoLike) {
      const c = Number(cfg.lab.autoLike.dailyCap ?? 10);
      if (!Number.isFinite(c) || c < 0 || c > 20) errs.push("点赞每日上限必须在 0~20 之间");
      const m = Number(cfg.lab.autoLike.minScore ?? 24);
      if (!Number.isFinite(m) || m < 0 || m > 100) errs.push("点赞门槛必须在 0~100 之间");
    }
    cfg.friends.forEach((f, i) => {
      if (!f || typeof f !== "object") { errs.push(`friends[${i}] 必须是对象`); return; }
      if (!String(f.name || "").trim()) errs.push(`friends[${i}] 缺少名字`);
      if ("verified" in f && typeof f.verified !== "boolean") errs.push(`friends[${i}].verified 必须是 true/false`);
    });
  } else errs.push("friends 必须是数组");

  if (cfg.limits) {
    const L = cfg.limits;
    const ints = ["maxRecipientsPerVideo", "sameVideoCooldownHours", "dailyOutgoingCap", "dailyReplyCap", "sessionMinutesMax"];
    for (const k of ints) {
      if (typeof L[k] !== "number" || L[k] < 0) errs.push(`limits.${k} 必须是非负数字`);
    }
    if (L.sessionMinutesMax > 20) errs.push("limits.sessionMinutesMax 不能超过 20（绕过风控的 30 分钟线是刻意的）");
  } else errs.push("缺少 limits");

  return errs;
}

let labJob = null;   // 实验室任务（同一时间只允许一个）

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(HTML, "utf8").replace("__CONSOLE_TOKEN__", TOKEN);
      return send(res, 200, "text/html; charset=utf-8", html);
    } catch (e) {
      return send(res, 500, "text/plain; charset=utf-8", "找不到 console/index.html");
    }
  }

  // ---------- 实验室：AI 视频总结（任务式，可看进度、可取消）----------
  if (req.method === "POST" && url.pathname === "/api/lab/summary") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "";
      try { id = String(JSON.parse(body || "{}").id || "").trim(); } catch {}
      if (!/^\d{6,}$/.test(id)) {
        return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "需要合法的视频 id（数字）" }));
      }
      if (labJob && !labJob.done) {
        return send(res, 409, "application/json", JSON.stringify({ ok: false, error: "上一次还没跑完" }));
      }
      labJob = { id, phase: "running", steps: [], startedAt: Date.now(), cancel: false, done: false, result: null };
      const job = labJob;
      (async () => {
        let ctx = null, page = null;
        try {
          const c = await connect();
          ctx = c.ctx;
          page = await ctx.newPage();
          const r = await fetchAiSummary(page, id, {
            maxWaitMs: 45000,
            onStep: (s) => { if (job === labJob) job.steps.push(s); },
            isCancelled: () => job.cancel,
          });
          job.phase = "done";
          job.result = { ok: r.ok, text: r.text || "", ms: r.ms || null, fromHistory: !!r.fromHistory, error: r.error || null, shots: r.shots || [] };
          emit("lab-summary", { id, ok: r.ok, ms: r.ms || null, chars: r.text ? r.text.length : 0, error: r.error || null });
        } catch (e) {
          job.phase = "error";
          job.result = { ok: false, error: String(e.message || e).slice(0, 200) };
        } finally {
          job.done = true;
          try { if (page && !page.isClosed()) await page.close(); } catch {}
        }
      })();
      return send(res, 200, "application/json", JSON.stringify({ ok: true, started: true, id }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lab/status") {
    if (!labJob) return send(res, 200, "application/json", JSON.stringify({ ok: true, job: null }));
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      ok: true,
      job: {
        id: labJob.id, phase: labJob.phase, done: labJob.done,
        elapsedMs: Date.now() - labJob.startedAt,
        steps: labJob.steps, result: labJob.result,
      },
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/lab/cancel") {
    if (!requireToken(req, res)) return;
    if (labJob && !labJob.done) labJob.cancel = true;
    return send(res, 200, "application/json", JSON.stringify({ ok: true }));
  }
  // ---------- 初筛开关（机械层）----------
  if (req.method === "GET" && url.pathname === "/api/switches") {
    try {
      const cat = SWITCH_CATALOG;
      const cur = rulesOf();
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, catalog: cat, values: cur }));
    } catch (e) {
      return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ---------- 模型通道（API Key 设置）----------
  if (req.method === "GET" && url.pathname === "/api/llm") {
    const LLM_FILE = path.join(ROOT, "state", "llm.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(LLM_FILE, "utf8")); } catch {}
    const key = String(process.env.DYBOT_LLM_KEY || cfg.apiKey || "");
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      ok: true,
      baseUrl: process.env.DYBOT_LLM_BASE || cfg.baseUrl || "https://api.deepseek.com",
      model: process.env.DYBOT_LLM_MODEL || cfg.model || "deepseek-chat",
      hasKey: !!key,
      keyMasked: key ? key.slice(0, 6) + "…" + key.slice(-4) : "",
      fromEnv: !!process.env.DYBOT_LLM_KEY,
      file: LLM_FILE,
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/llm") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let p = {};
      try { p = JSON.parse(body || "{}"); } catch {}
      const LLM_FILE = path.join(ROOT, "state", "llm.json");
      try {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(LLM_FILE, "utf8")); } catch {}
        if (typeof p.apiKey === "string" && p.apiKey.trim()) cfg.apiKey = p.apiKey.trim();
        if (typeof p.baseUrl === "string" && p.baseUrl.trim()) cfg.baseUrl = p.baseUrl.trim();
        if (typeof p.model === "string" && p.model.trim()) cfg.model = p.model.trim();
        if (!cfg.note) cfg.note = "本文件含密钥，不要提交到任何仓库、不要贴到群里。吊销在 platform.deepseek.com → API keys。";
        fs.mkdirSync(path.dirname(LLM_FILE), { recursive: true });
        fs.writeFileSync(LLM_FILE, JSON.stringify(cfg, null, 2), "utf8");
        try { fs.chmodSync(LLM_FILE, 0o600); } catch {}
        emit("llm-saved", { model: cfg.model || null, baseUrl: cfg.baseUrl || null });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/llm/test") {
    if (!requireToken(req, res)) return;
    try {
      const r = await generateReply({ system: "只回两个字：收到", messages: [{ role: "user", content: "测试" }], maxTokens: 10 });
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        ok: true, mode: r.mode, model: r.model, text: String(r.text || "").slice(0, 40), usage: r.usage || null,
      }));
    } catch (e) {
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
    }
  }

  // ---------- 人设试聊：用当前配置生成一条草稿，不发送 ----------
  if (req.method === "POST" && url.pathname === "/api/try") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let text = "", conv = "", withMemory = true, history = [];
      try {
        const p = JSON.parse(body || "{}");
        text = String(p.text || "").trim();
        conv = String(p.conv || "").trim();
        withMemory = p.memory !== false;
        if (Array.isArray(p.history)) history = p.history.slice(-6);
      } catch {}
      if (!text) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "写一句要说的话" }));
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
        const sys = [buildChatPrompt(cfg.persona || {}, cfg.rules || {}), withMemory && conv ? memoryBlock(conv) : ""]
          .filter(Boolean)
          .join("\n\n");
        const msgs = history.length
          ? [...history, { role: "user", content: text }]
          : [{ role: "user", content: text }];
        const r = await generateReply({ system: sys, messages: msgs });
        const lines = String(r.text || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
        const checked = lines.map((l) => ({ text: l, gate: checkReply(l) }));
        emit("try", { text: text.slice(0, 60), conv: conv || null, lines: lines.length });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
          ok: true,
          draft: lines,
          checked,
          sysLen: sys.length,
          hasMemory: !!(withMemory && conv && memoryBlock(conv)),
          usage: r.usage || null,
          mode: r.mode,
        }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---------- 体检：CDP / 登录 / 验证 / 标签页 / 配置 ----------
  if (req.method === "GET" && url.pathname === "/api/health") {
    const out = { ok: true, checks: [] };
    const add = (name, status, detail) => out.checks.push({ name, status, detail: detail || null });

    // 1) 配置能解析
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); add("配置文件", "ok", "可解析"); }
    catch (e) { add("配置文件", "bad", e.message); }

    // 2) CDP 端口
    let ctx = null, page = null;
    try {
      const c = await connect();
      ctx = c.ctx;
      add("浏览器调试端口", "ok", "9222 已连接");
    } catch (e) {
      add("浏览器调试端口", "bad", /ECONNREFUSED/.test(String(e.message)) ? "9222 未监听：先跑 start-edge.bat" : String(e.message).slice(0, 80));
    }

    if (ctx) {
      // 3) 标签页
      try {
        const pages = ctx.pages();
        add("标签页数", pages.length > 3 ? "warn" : "ok", pages.length + " 个" + (pages.length > 3 ? "（偏多，可能在堆积）" : ""));
        page = pages.find((p) => p.url().includes("/chat")) || pages[0] || null;
      } catch {}

      // 4) 登录态
      if (page) {
        try {
          const ls = await loginState(page);
          if (!ls) add("登录态", "bad", "读不到页面");
          else if (ls.hasLoginBtn) add("登录态", "bad", "未登录（页面有登录按钮）");
          else add("登录态", "ok", ls.title ? ls.title.slice(0, 30) : "已登录");
        } catch (e) { add("登录态", "warn", String(e.message).slice(0, 60)); }

        // 5) 人机验证
        try {
          const vp = await verifyPresent(page);
          add("人机验证", vp.yes ? "bad" : "ok", vp.yes ? ("弹出来了：" + (vp.why || "")) : "无");
        } catch {}

        // 6) 白名单可达性（只读，不点击）
        if (cfg && Array.isArray(cfg.friends)) {
          try {
            const rows = await page.evaluate(() => {
              const v = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
              return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(v)
                .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim());
            });
            const miss = [];
            for (const f of cfg.friends) {
              const n = String(f.name || "").trim();
              if (!n || f.verified !== true) continue;
              if (!rows.some((t) => t.includes(n))) miss.push(n);
            }
            add("白名单可达", miss.length ? "warn" : "ok", miss.length ? ("列表里找不到：" + miss.join("、") + "（可能未互关或昵称不一致）") : "全部可见");
          } catch (e) { add("白名单可达", "warn", String(e.message).slice(0, 60)); }
        }
      }
    }

    // 7) 运行态
    try {
      const alive = runnerAlive();
      add("自动回复进程", alive ? "ok" : "warn", alive ? ("运行中 pid " + alive.pid) : "未运行");
      const dg = digestRunning();
      add("转发进程", dg ? "warn" : "ok", dg ? ("正在跑 pid " + dg.pid) : "空闲");
    } catch {}

    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(out));
  }

  // ---------- 日志导出 ----------
  if (req.method === "GET" && url.pathname === "/api/export") {
    const which = url.searchParams.get("which") || "events";
    const map = {
      events: path.join(ROOT, "state", "events.jsonl"),
      autoreply: path.join(ROOT, "state", "autoreply.jsonl"),
      sent: path.join(ROOT, "sent.jsonl"),
      digest: path.join(ROOT, "state", "digest.log"),
      runner: path.join(ROOT, "state", "autoreply.log"),
    };
    const f = map[which];
    if (!f || !fs.existsSync(f)) return send(res, 404, "text/plain; charset=utf-8", "没有这个日志：" + which);
    const data = fs.readFileSync(f, "utf8");
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${which}-${stamp}.log"`,
    });
    return res.end(data);
  }

  // ---------- 记忆：改 / 删 单条 ----------
  if (req.method === "POST" && url.pathname === "/api/memory/edit") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let conv = "", from = "", to = null;
      try {
        const p = JSON.parse(body || "{}");
        conv = String(p.conv || "").trim();
        from = String(p.from || "").trim();
        to = p.to === undefined ? null : String(p.to).trim();
      } catch {}
      if (!conv || !from) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "需要 conv 和 from" }));
      try {
        const mem = loadMemory(conv);
        const i = mem.facts.findIndex((f) => f.text === from);
        if (i < 0) return send(res, 404, "application/json", JSON.stringify({ ok: false, error: "没找到这条记忆" }));
        if (to === null) {
          mem.facts.splice(i, 1);
          saveMemory(conv, mem);
          emit("memory-edit", { conv, action: "delete", text: from });
          return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, action: "delete", total: mem.facts.length }));
        }
        mem.facts[i] = { text: to.slice(0, 60), ts: new Date().toISOString() };
        saveMemory(conv, mem);
        emit("memory-edit", { conv, action: "update", from, to });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, action: "update", total: mem.facts.length }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---------- 从历史对话补记忆 ----------
  if (req.method === "POST" && url.pathname === "/api/memory/backfill") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let conv = null, dry = false;
      try {
        const b = JSON.parse(body || "{}");
        conv = b.conv ? String(b.conv).trim() : null;
        dry = b.dry === true;
      } catch {}
      try {
        const r = await backfillMemory({ conv, dryRun: dry, limit: 80 });
        const added = (r.report || []).flatMap((x) => (x.added || []).map((t) => x.conv + "：" + t));
        emit("memory-backfill", { conv: conv || "all", added: added.length, dry });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, dry, added, report: r.report }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
      }
    });
    return;
  }
  // ---------- 手动添加记忆 ----------
  if (req.method === "POST" && url.pathname === "/api/memory") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let conv = "", text = "";
      try {
        const p = JSON.parse(body || "{}");
        conv = String(p.conv || "").trim();
        text = String(p.text || "").trim();
      } catch {}
      if (!conv || !text) {
        return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "需要 conv 和 text" }));
      }
      if (text.length > 60) text = text.slice(0, 60);
      try {
        const r = addFacts(conv, [text]);          // 手动添加不过滤，只脱敏+去重
        const mem = loadMemory(conv);
        emit("memory-manual", { conv, text });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, added: r.added, total: mem.facts.length }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---------- 默认角色卡 ----------
  if (req.method === "GET" && url.pathname === "/api/character/default") {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, text: DEFAULT_CHARACTER }));
  }

  // ---------- 自动（概率转发 / 主动聊天）：状态与重置 ----------
  // ---------- 词库（她自己学的热梗/黑话 + 你禁的词）----------
  if (req.method === "GET" && url.pathname === "/api/lexicon") {
    const db = listLexicon();
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, ...db, stats: lexiconStats() }));
  }
  if (req.method === "POST" && url.pathname === "/api/lexicon") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let o = {};
      try { o = JSON.parse(body || "{}"); } catch {}
      const action = String(o.action || "").trim();
      const term = String(o.term || "").trim();
      let r = { ok: false, error: "未知操作" };
      try {
        if (action === "delete") r = { ok: deleteTerm(term).ok };
        else if (action === "toggle") r = toggleTerm(term, o.disabled !== false);
        else if (action === "ban") r = banTerm(term, "控制台手动");
        else if (action === "unban") r = unbanTerm(term);
        else if (action === "add") r = addTerm({ term, meaning: o.meaning, usage: o.usage, conv: "手动" });
        else if (action === "meaning") r = setMeaning(term, String(o.meaning || ""), String(o.usage || ""));
      } catch (e) {
        r = { ok: false, error: String(e.message || e) };
      }
      emit("lexicon-edit", { action, term });
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(r));
    });
    return;
  }

  // ---------- 点赞记录（laboratory）----------
  if (req.method === "GET" && url.pathname === "/api/likes") {
    let rows = [];
    try {
      const f = path.join(ROOT, "state", "likes.jsonl");
      if (fs.existsSync(f)) {
        rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean).slice(-30);
      }
    } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const todayClicked = rows.filter((r) => r.clicked && String(r.ts || "").slice(0, 10) === today).length;
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, todayClicked, recent: rows.slice(-12).reverse() }));
  }

  if (req.method === "GET" && url.pathname === "/api/schedule") {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
    let memList = [];
    try {
      const dir = path.join(ROOT, "state", "memory");
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const convName = f.replace(/\.json$/, "");
        let facts = [];
        try { facts = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).facts || []; } catch {}
        // 不要在这里截断：前端按 5 条折叠、可展开看全部（以前 slice(-5) 导致"展开"永远没有内容）
        memList.push({ conv: convName, count: facts.length, facts: facts.slice(-200).map((x) => x.text) });
      }
    } catch {}
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      ok: true,
      schedule: scheduleSummary(),
      digest: cfg.digest || {},
      proactive: cfg.proactive || {},
      memory: memList,
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let what = "";
      try { what = JSON.parse(body || "{}").what || ""; } catch {}
      const done = [];
      try {
        if (what === "schedule") {
          const p = path.join(ROOT, "state", "schedule.json");
          if (fs.existsSync(p)) { fs.unlinkSync(p); done.push("已清零今日计数与检查时间"); }
          else done.push("本来就没有状态文件");
        } else if (what === "memory") {
          const dir = path.join(ROOT, "state", "memory");
          let n = 0;
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              if (f.endsWith(".json")) { fs.unlinkSync(path.join(dir, f)); n++; }
            }
          }
          done.push("已清空 " + n + " 个会话的记忆");
        } else if (what.indexOf("memory:") === 0) {
          const convName = what.slice("memory:".length);
          const safe = String(convName).replace(/[\\/:*?"<>|]/g, "_");
          const p = path.join(ROOT, "state", "memory", safe + ".json");
          if (fs.existsSync(p)) { fs.unlinkSync(p); done.push("已清空「" + convName + "」的记忆"); }
          else done.push("「" + convName + "」没有记忆文件");
        } else if (what === "events") {
          const p = path.join(ROOT, "state", "events.jsonl");
          if (fs.existsSync(p)) {
            const sz = fs.statSync(p).size;
            fs.writeFileSync(p, "");
            done.push("已清空事件流（原 " + Math.round(sz / 1024) + " KB）");
          } else done.push("本来就没有事件流");
        } else if (what === "sent-today") {
          // 重置"今日已发"计数：转发日上限读 sent.jsonl，回复日上限读 state/autoreply.jsonl
          const dayKey = (iso) => {
            const d = new Date(iso);
            if (isNaN(d)) return "";
            return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
          };
          const today = dayKey(new Date().toISOString());

          let removedShare = 0, keptShare = 0;
          const ps = path.join(ROOT, "sent.jsonl");
          if (fs.existsSync(ps)) {
            const lines = fs.readFileSync(ps, "utf8").split("\n").filter(Boolean);
            const keep = [];
            for (const l of lines) {
              let e = null;
              try { e = JSON.parse(l); } catch { keep.push(l); continue; }
              const counted = e.result === "share_success" || e.result === "text_sent";
              if (counted && dayKey(e.ts) === today) { removedShare++; continue; }
              keptShare++;
              keep.push(l);
            }
            fs.writeFileSync(ps, keep.join("\n") + (keep.length ? "\n" : ""), "utf8");
          }

          let removedReply = 0;
          const pr = path.join(ROOT, "state", "autoreply.jsonl");
          if (fs.existsSync(pr)) {
            const lines = fs.readFileSync(pr, "utf8").split("\n").filter(Boolean);
            const keep = [];
            for (const l of lines) {
              let e = null;
              try { e = JSON.parse(l); } catch { keep.push(l); continue; }
              if (e.sent === true && dayKey(e.ts) === today) { removedReply++; continue; }
              keep.push(l);
            }
            fs.writeFileSync(pr, keep.join("\n") + (keep.length ? "\n" : ""), "utf8");
          }

          done.push("已清掉今日发送记录 " + removedShare + " 条（保留历史 " + keptShare + " 条）");
          done.push("已清掉今日回复记录 " + removedReply + " 条");
          done.push("提醒：今日的同视频去重也一起清了，同一条视频可能被重复发");
        } else if (what === "digestlog") {
          const p = path.join(ROOT, "state", "digest.log");
          if (fs.existsSync(p)) { fs.writeFileSync(p, ""); done.push("已清空转发日志"); }
          else done.push("没有转发日志");
        } else {
          return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "未知的重置目标：" + what }));
        }
        emit("reset", { what });
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, done }));
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---------- 转发（digest）----------
  if (req.method === "GET" && url.pathname === "/api/digest/status") {
    const run = digestRunning();
    let log = "";
    try {
      const all = fs.readFileSync(DIGEST_LOG, "utf8").split("\n");
      log = all.slice(-160).join("\n");
    } catch { log = ""; }
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, running: run, log }));
  }

  if (req.method === "POST" && url.pathname === "/api/digest") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let p = {};
      try { p = JSON.parse(body || "{}"); } catch {}
      if (digestRunning()) return send(res, 409, "application/json", JSON.stringify({ ok: false, error: "上一轮还在跑" }));

      const args = [path.join(ROOT, "lib", "digest.mjs")];
      args.push(`--max=${Math.max(1, Math.min(30, parseInt(p.max, 10) || 6))}`);
      args.push(`--top=${Math.max(1, Math.min(5, parseInt(p.top, 10) || 1))}`);
      if (p.only) args.push(`--only=${p.only}`);
      if (p.send === true) args.push("--send");

      try { fs.writeFileSync(DIGEST_LOG, ""); } catch {}
      const out = fs.openSync(DIGEST_LOG, "a");
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        windowsHide: true,
      });
      child.unref();
      fs.writeFileSync(DIGEST_RUN, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), params: { max: p.max, top: p.top, only: p.only || null, send: p.send === true } }, null, 2));
      emit("digest-start", { pid: child.pid, params: { max: p.max, top: p.top, only: p.only || null, send: p.send === true } });
      return send(res, 200, "application/json", JSON.stringify({ ok: true, pid: child.pid }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    let llm = { model: null, dry: true };
    try {
      const f = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "llm.json"), "utf8"));
      llm = { model: f.model || null, dry: !f.apiKey };
    } catch {}
    return send(
      res,
      200,
      "application/json; charset=utf-8",
      JSON.stringify({
        ok: true,
        runner: runnerAlive(),
        // 代码最后修改时间：用来提示"改了代码但没重启进程"
        codeMtime: (() => {
          try {
            let max = 0;
            for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
              if (!f.endsWith(".mjs")) continue;
              const t = fs.statSync(path.join(ROOT, "lib", f)).mtimeMs;
              if (t > max) max = t;
            }
            return max ? new Date(max).toISOString() : null;
          } catch { return null; }
        })(),
        runner: runnerAlive(),
    quota: (() => {
      const dayKey = (t) => { const d = new Date(t); return isNaN(d) ? "" : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
      const today = dayKey(new Date());
      let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
      let shareToday = 0, replyToday = 0;
      try {
        for (const l of fs.readFileSync(path.join(ROOT, "sent.jsonl"), "utf8").split("\n").filter(Boolean)) {
          try { const e = JSON.parse(l); if (e.result === "share_success" && dayKey(e.ts) === today) shareToday++; } catch {}
        }
      } catch {}
      try {
        for (const l of fs.readFileSync(path.join(ROOT, "state", "autoreply.jsonl"), "utf8").split("\n").filter(Boolean)) {
          try { const e = JSON.parse(l); if (e.sent === true && dayKey(e.ts) === today) replyToday++; } catch {}
        }
      } catch {}
      let digestToday = 0;
      try { digestToday = Number(JSON.parse(fs.readFileSync(path.join(ROOT, "state", "schedule.json"), "utf8")).digest?.count || 0); } catch {}
      return {
        share: { used: shareToday, cap: Number(cfg.limits?.dailyOutgoingCap ?? 0) },
        reply: { used: replyToday, cap: Number(cfg.limits?.dailyReplyCap ?? 0) },
        digest: { used: digestToday, cap: Number(cfg.digest?.perDayMax ?? 0) },
      };
    })(),
    lastExit: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "state", "runner-exit.json"), "utf8")); } catch { return null; } })(),
    runnerLogTail: (() => {
      try {
        const t = fs.readFileSync(path.join(ROOT, "state", "autoreply.log"), "utf8").split("\n").filter(Boolean);
        return t.slice(-12);
      } catch { return []; }
    })(),
        llm,
        usage: sumUsageToday(),
        events: (() => {
      // 默认只显示"有意义"的事件，心跳（idle/proactive-skip）会把窗口刷满
      const NOISE = new Set(["idle", "proactive-skip", "digest-skip"]);
      const all = tailEvents(600);
      const ranked = all.filter((e) => !NOISE.has(e.type));
      return ranked.slice(-200);
    })(),
        now: new Date().toISOString(),
      })
    );
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "80", 10));
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, events: tailEvents(limit) }));
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    if (!requireToken(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let action = "start";
      let wantSend = true;
      try {
        const j = JSON.parse(body || "{}");
        action = j.action || action;
        if (j.send === false) wantSend = false;
      } catch {}

      const alive = runnerAlive();
      if (action === "stop") {
        // 兜底：即使 pid 丢了（runner.json 被删），也让它自己看到旗标退出
        try { fs.writeFileSync(path.join(ROOT, "state", "stop.flag"), new Date().toISOString(), "utf8"); } catch {}
        if (!alive) return send(res, 200, "application/json", JSON.stringify({ ok: true, note: "本来就没在跑" }));
        try {
          process.kill(alive.pid);
          clearRunner();
          try { fs.unlinkSync(path.join(ROOT, "state", "runner.lock.json")); } catch {}   // 防心跳兜底误判
          emit("stop", { by: "console" });
          return send(res, 200, "application/json", JSON.stringify({ ok: true, stopped: alive.pid }));
        } catch (e) {
          return send(res, 500, "application/json", JSON.stringify({ ok: false, error: e.message }));
        }
      }

      // 启动前清掉上次"停止"留下的旗标：否则停止后 2 分钟内再启动，
      // 子进程一读到 stop.flag 就立刻退出（表现为"启动后马上自动停止"，uptime=0）
      try { fs.unlinkSync(path.join(ROOT, "state", "stop.flag")); } catch {}

      if (alive) return send(res, 409, "application/json", JSON.stringify({ ok: false, error: "已经在跑了", runner: alive }));


      // 用配置里的轮询间隔（原来写死 3 秒，改配置不生效）
    let pollSec = 8;
    try { pollSec = Number(JSON.parse(fs.readFileSync(CONFIG, "utf8")).limits?.pollSeconds ?? 8); } catch {}
    const args = [path.join(ROOT, "lib", "autoreply.mjs"), `--interval=${pollSec}`];
      if (wantSend) args.push("--send");
      // 输出重定向到 state/autoreply.log —— 否则"自动停止"永远查不到原因
    const LOGP = path.join(ROOT, "state", "autoreply.log");
    let logFd = "ignore";
    try { logFd = fs.openSync(LOGP, "a"); } catch {}
    try { fs.appendFileSync(LOGP, "\n===== " + new Date().toLocaleString() + " 启动 interval=" + pollSec + "s send=" + wantSend + " =====\n", "utf8"); } catch {}
    const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
      // 立刻登记 runner：否则要等子进程自己写（1~3 秒），控制台会一直显示"已停止"
      try {
        let convs0 = [];
        try { convs0 = (JSON.parse(fs.readFileSync(CONFIG, "utf8")).friends || []).filter((f) => f.verified === true).map((f) => f.name); } catch {}
        writeRunner({ pid: child.pid, startedAt: new Date().toISOString(), interval: pollSec, send: wantSend, convs: convs0, pending: true });
      } catch {}
      child.unref();
      return send(res, 200, "application/json", JSON.stringify({ ok: true, started: child.pid, send: wantSend }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    try {
      const { data } = readConfig();
      return send(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ ok: true, config: data, catalog: SWITCH_CATALOG })
      );
    } catch (e) {
      return send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "读取 config.json 失败：" + e.message }));
    }
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    if (!requireToken(req, res)) return;
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "提交内容过大" }));
      let cfg;
      try { cfg = JSON.parse(body); }
      catch (e) { return send(res, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "不是合法 JSON：" + e.message })); }

      const errs = validate(cfg);
      if (errs.length) return send(res, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "校验未通过", detail: errs }));

      try {
        // 每次写入前留一份备份，改错了可以手动回滚
        if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, CONFIG + ".bak");
        const tmp = CONFIG + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, CONFIG);
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, savedAt: new Date().toISOString() }));
      } catch (e) {
        return send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "写入失败：" + e.message }));
      }
    });
    return;
  }

  send(res, 404, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`控制台已启动：http://${HOST}:${PORT}`);
  console.log(`正在编辑：${CONFIG}`);
  console.log("关闭这个窗口即停止（配置已写盘，不会丢）");
});
