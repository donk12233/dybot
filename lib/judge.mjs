import fs from "node:fs";
// 让模型判"这条值不值得转给死党"。判据全部来自 config.json（rules.interesting 等）。
import { loadConfig } from "./targets.mjs";
import { buildJudgePrompt, buildMatchPrompt } from "./prompt.mjs";
import { loadMemory } from "./memory.mjs";
import { P } from "./paths.mjs";
import { computeScore, decide, DEFAULT_SCORING } from "./scoring.mjs";
import { generateReply } from "./llm.mjs";

function parseJsonLoose(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * meta = { title, duration, chapterLines, comments }
 * 返回 { verdict:'send'|'skip', rule, reason, confidence, behind }
 */
export async function judgeVideo(meta, opts = {}) {
  const cfg = loadConfig();
  // 把每个收件人的记忆一起喂给判定 —— 记忆参与"挑什么"，不只是"附言写什么"
  // 今天每人已经收到几条（用来在"都合适"时做均衡，避免总推给同一个人）
  const todayN = (() => {
    const out = {};
    const key = (t) => { const d = new Date(t); return isNaN(d) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const today = key(new Date());
    try {
      for (const l of fs.readFileSync(P("sent.jsonl"), "utf8").split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          if (e.result === "share_success" && key(e.ts) === today && e.to) out[e.to] = (out[e.to] || 0) + 1;
        } catch {}
      }
    } catch {}
    return out;
  })();

  // 今天已经发过什么（让"重复刷屏/同质化"这两条减分项可判）
  const recentSent = (() => {
    const out = [];
    const key = (t) => { const d = new Date(t); return isNaN(d) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const today = key(new Date());
    try {
      for (const l of fs.readFileSync(P("sent.jsonl"), "utf8").split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          if (e.result === "share_success" && key(e.ts) === today && e.desc) out.push(String(e.desc).slice(0, 40));
        } catch {}
      }
    } catch {}
    return out.slice(-8);
  })();
  const friends = (cfg.friends || [])
    .filter((f) => f.verified === true && String(f.name || "").trim())
    .map((f) => {
      let facts = [];
      try { facts = (loadMemory(f.name).facts || []).map((x) => x.text).slice(-10); } catch {}
      return {
        name: String(f.name).trim(),
        note: String(f.note || "").trim(),
        neverSend: String(f.neverSend || "").trim(),
        facts,
        todayN: todayN[String(f.name).trim()] || 0,
      };
    });
  const sys = buildJudgePrompt(cfg.persona, cfg.rules, friends, recentSent);

  const user = [
    `文案：${meta.title || "（无）"}`,
    meta.duration ? `时长：${meta.duration} 秒` : "",
    meta.desc ? `文案：${String(meta.desc).slice(0, 160)}` : "",
    meta.aiSummary ? `【抖音AI总结（整片内容）】\n${String(meta.aiSummary).slice(0, 1200)}` : "",
    meta.authorName ? `作者：${String(meta.authorName).slice(0, 24)}` : "",
    meta.stats
      ? `互动数据：赞 ${meta.stats.like ?? "?"} / 评 ${meta.stats.comment ?? "?"} / 藏 ${meta.stats.collect ?? "?"} / 转 ${meta.stats.share ?? "?"}`
      : "",
    meta.chapterLines && meta.chapterLines.length ? `章节要点：${meta.chapterLines.join(" / ")}` : "章节要点：（平台没给）",
    meta.comments && meta.comments.length ? `热评：${meta.comments.slice(0, 4).map((c) => c.slice(0, 60)).join(" ｜ ")}` : "热评：（无）",
    meta.comments === null ? "" : "",
  ].filter(Boolean).join("\n");

  // 模型偶尔会加解释、包代码块 → 抽第一个 {...} 兜底；还不行就重试一次
  const looseJson = (txt) => {
    const t = String(txt || "").replace(/```[a-z]*|```/gi, "").trim();
    let j = parseJsonLoose(t);
    if (j) return j;
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    }
    return null;
  };

  if (process.env.DYBOT_DEBUG_JUDGE) {
    console.log("\n----- 判定输入（DYBOT_DEBUG_JUDGE） -----");
    console.log(user);
    console.log("----- 提示词长度 " + sys.length + " 字符 -----\n");
  }
  let r = await generateReply({ system: sys, messages: [{ role: "user", content: user }], maxTokens: 160 });
  let j = looseJson(r.text);
  if (!j) {
    // 重试一次，明确要求只要 JSON
    r = await generateReply({
      system: sys,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: String(r.text || "").slice(0, 400) },
        { role: "user", content: "只输出那一行 JSON，不要任何解释、不要代码块、不要前后缀。" },
      ],
      maxTokens: 160,
    });
    j = looseJson(r.text);
  }
  if (!j) return { verdict: "skip", reason: "模型两次都没给出 JSON，保守不发", confidence: 0, raw: String(r.text || "").slice(0, 120), behind: true };

  const conf = Number(j.confidence);
  const to = Array.isArray(j.to) ? j.to.map((x) => String(x).trim()).filter(Boolean).slice(0, 2) : [];
  // 硬禁区是一票否决，跟分数无关
  if (j.blocked || j.veto) {
    return {
      verdict: "skip", rule: "blocked", reason: (`硬禁区：` + (j.blocked || j.veto)).slice(0, 160),
      score: 0, hits: [], cuts: [], confidence: Number.isFinite(conf) ? conf : null, to: [], behind: false,
      raw: String(r.text || "").slice(0, 200),
    };
  }
  // opts.scoring 允许调用方覆盖评分配置（例如点赞用更高的门槛）
  const scoring = opts.scoring || cfg.rules?.scoring;

  // 评分制：模型只报命中的 id，分数和结论都由代码算
  if (scoring && scoring.enabled !== false && (Array.isArray(j.hits) || Array.isArray(j.minus))) {
    const score = computeScore(scoring, j.hits || [], j.minus || []);
    const d = decide(scoring, score);
    const hitsTxt = score.hits.map((h) => `${h.item}+${h.pts}`).join(" ");
    const cutsTxt = score.cuts.map((c) => `${c.item}-${c.pts}`).join(" ");
    return {
      verdict: d.send ? "send" : "skip",
      rule: (j.hits || []).join(",") || (j.minus || []).join(",") || null,
      reason: `${score.total}分 ${hitsTxt}${cutsTxt ? " | " + cutsTxt : ""} | ${d.why} | ${j.reason || ""}`.slice(0, 180),
      score: score.total,
      hits: score.hits,
      cuts: score.cuts,
      confidence: Number.isFinite(conf) ? conf : null,
      to,
      behind: !d.send && score.total > 0,
      raw: r.text.slice(0, 200),
    };
  }

  // 判据只有评分表一套。配置里没有 scoring 时用内置默认表兜底（不再有"是非制"）。
  const effective = (scoring && scoring.enabled !== false) ? scoring : DEFAULT_SCORING;
  const score2 = computeScore(effective, Array.isArray(j.hits) ? j.hits : [], Array.isArray(j.minus) ? j.minus : []);
  const d2 = decide(effective, score2);
  return {
    verdict: d2.send ? "send" : "skip",
    rule: (Array.isArray(j.hits) ? j.hits.join(",") : null) || null,
    reason: `${score2.total}分 | ${d2.why} | ${j.reason || ""}`.slice(0, 180),
    score: score2.total,
    hits: score2.hits,
    cuts: score2.cuts,
    confidence: Number.isFinite(conf) ? conf : null,
    to,
    behind: !d2.send && score2.total > 0,
    raw: r.text.slice(0, 200),
  };
}

/**
 * 第二环节：评分过关后，逐个对照每个人的记忆判断"这条适不适合他"。
 * 返回 [{ name, fit, match, why }]，按 fit 降序。
 * 一个人都不匹配时返回空数组 → 上层走回默认挑人逻辑。
 */
export async function matchFriends(meta) {
  const cfg = loadConfig();
  const friends = (cfg.friends || [])
    .filter((f) => f.verified === true && String(f.name || "").trim())
    .map((f) => {
      let facts = [];
      try { facts = (loadMemory(f.name).facts || []).map((x) => x.text).slice(-12); } catch {}
      return {
        name: String(f.name).trim(),
        note: String(f.note || "").trim(),
        neverSend: String(f.neverSend || "").trim(),
        facts,
      };
    });
  if (!friends.length) return [];

  const sys = buildMatchPrompt(friends);
  const user = [
    meta.title ? `标题：${String(meta.title).slice(0, 100)}` : "",
    meta.desc ? `文案：${String(meta.desc).slice(0, 160)}` : "",
    meta.aiSummary ? `【抖音AI总结（整片内容）】\n${String(meta.aiSummary).slice(0, 1200)}` : "",
    meta.duration ? `时长：${meta.duration} 秒` : "",
    meta.stats ? `互动：赞 ${meta.stats.like ?? "?"} / 评 ${meta.stats.comment ?? "?"} / 藏 ${meta.stats.collect ?? "?"}` : "",
    meta.chapterLines && meta.chapterLines.length ? `章节要点：${meta.chapterLines.join(" / ")}` : "",
    meta.comments && meta.comments.length ? `热评：${meta.comments.slice(0, 3).map((c) => c.slice(0, 50)).join(" ｜ ")}` : "",
  ].filter(Boolean).join("\n");

  if (process.env.DYBOT_DEBUG_JUDGE) {
    console.log("\n----- 记忆匹配输入 -----");
    console.log(user);
    console.log("------------------------\n");
  }

  let r = await generateReply({ system: sys, messages: [{ role: "user", content: user }], maxTokens: 200 });
  let j = null;
  for (const attempt of [0, 1]) {
    const t = String(r.text || "").replace(/```[a-z]*|```/gi, "").trim();
    try { j = JSON.parse(t); } catch {
      const a = t.indexOf("{");
      const b = t.lastIndexOf("}");
      if (a >= 0 && b > a) { try { j = JSON.parse(t.slice(a, b + 1)); } catch {} }
    }
    if (j && Array.isArray(j.people)) break;
    if (attempt === 0) {
      r = await generateReply({
        system: sys,
        messages: [
          { role: "user", content: user },
          { role: "assistant", content: String(r.text || "").slice(0, 300) },
          { role: "user", content: "只输出那一行 JSON。" },
        ],
        maxTokens: 200,
      });
    }
  }
  if (!j || !Array.isArray(j.people)) return [];

  const known = new Set(friends.map((f) => f.name));
  return j.people
    .filter((x) => x && known.has(String(x.name || "").trim()))
    .map((x) => ({
      name: String(x.name).trim(),
      fit: Number.isFinite(Number(x.fit)) ? Number(x.fit) : 0,
      match: x.match === true || Number(x.fit) >= 6,
      why: String(x.why || "").slice(0, 80),
    }))
    .sort((a, b) => b.fit - a.fit);
}
