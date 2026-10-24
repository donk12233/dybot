// 词库：她自己学的网络热梗 / 黑话 / 方言词，以及你明确禁掉的词。
// 设计原则（按用户要求）：
//   1. 自动入库并生效（A 策略），但学习频率很低：默认每 12 次回复才学一次，一次最多 1 个词
//   2. 有上限：默认 80 条，超出时淘汰"最久没被用过"的
//   3. 每个词都记出处（哪个会话、哪句话），方便回溯和删除
//   4. 你可以在私信里说"以后别说 XX" → 进 banned，优先级高于词库
//   5. 命中硬禁区的词（地域黑/性别对立等）入库但标记 banned，不注入
import fs from "node:fs";
import { P } from "./paths.mjs";

const FILE = P("state", "lexicon.json");
const DEFAULTS = { everyReplies: 12, maxTerms: 80, injectLimit: 12, minUses: 0 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return {
      terms: Array.isArray(j.terms) ? j.terms : [],
      banned: Array.isArray(j.banned) ? j.banned : [],
      counters: j.counters && typeof j.counters === "object" ? j.counters : {},
    };
  } catch {
    return { terms: [], banned: [], counters: {} };
  }
}

function save(db) {
  try {
    fs.mkdirSync(P("state"), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
  } catch {}
}

// 词条归一：去掉首尾标点/空格，全角转半角，小写化（中文不受影响）
export function normalizeTerm(t) {
  return String(t || "")
    .replace(/[\s"'“”‘’「」『』（）()【】\[\]，。！？、,.!?~～…—\-]/g, "")
    .toLowerCase()
    .trim();
}

function similar(a, b) {
  const x = normalizeTerm(a);
  const y = normalizeTerm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 一个是另一个的子串（"破防" vs "破防了"），且长度接近 → 视为同一个词
  if (x.length >= 2 && y.length >= 2 && Math.abs(x.length - y.length) <= 2 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

export function isBanned(term) {
  const db = load();
  return db.banned.some((b) => similar(b.term, term));
}

/**
 * 加一个词。返回 {added:boolean, reason?:string, term?:object}
 * - 已存在（近似）→ 不重复加，只累加 hit
 * - 被禁 → 不加
 */
export function addTerm({ term, meaning, usage, conv, source }) {
  const t = String(term || "").trim();
  if (!t) return { added: false, reason: "空词" };
  if (t.length > 12) return { added: false, reason: "太长" };
  const db = load();
  if (db.banned.some((b) => similar(b.term, t))) return { added: false, reason: "已被你禁用" };

  const exist = db.terms.find((x) => similar(x.term, t));
  if (exist) {
    exist.hits = (exist.hits || 0) + 1;
    exist.lastSeen = Date.now();
    if (!exist.meaning && meaning) exist.meaning = String(meaning).slice(0, 60);
    save(db);
    return { added: false, reason: "已存在，累加 hit", term: exist };
  }

  const row = {
    term: t.slice(0, 12),
    meaning: String(meaning || "").slice(0, 60),
    usage: String(usage || "").slice(0, 40),
    conv: conv || null,
    source: String(source || "").slice(0, 60),
    ts: Date.now(),
    lastSeen: Date.now(),
    hits: 1,
    uses: 0,
    disabled: false,
  };
  db.terms.push(row);
  // 超出上限：淘汰最久没被用过、且用得最少的
  const cap = DEFAULTS.maxTerms;
  if (db.terms.length > cap) {
    db.terms.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    db.terms = db.terms.slice(0, cap);
  }
  save(db);
  return { added: true, term: row };
}

export function banTerm(term, reason) {
  const t = String(term || "").trim();
  if (!t) return { ok: false };
  const db = load();
  if (!db.banned.some((b) => similar(b.term, t))) {
    db.banned.push({ term: t.slice(0, 20), ts: Date.now(), reason: String(reason || "用户要求").slice(0, 60) });
  }
  // 词库里同义的也标停用
  for (const x of db.terms) if (similar(x.term, t)) x.disabled = true;
  save(db);
  return { ok: true };
}

export function unbanTerm(term) {
  const db = load();
  const before = db.banned.length;
  db.banned = db.banned.filter((b) => !similar(b.term, term));
  save(db);
  return { ok: db.banned.length < before };
}

export function deleteTerm(term) {
  const db = load();
  const before = db.terms.length;
  db.terms = db.terms.filter((x) => !similar(x.term, term));
  save(db);
  return { ok: db.terms.length < before };
}

export function toggleTerm(term, disabled) {
  const db = load();
  const hit = db.terms.find((x) => similar(x.term, term));
  if (!hit) return { ok: false };
  hit.disabled = !!disabled;
  save(db);
  return { ok: true, term: hit };
}

export function listLexicon() {
  const db = load();
  return {
    terms: [...db.terms].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)),
    banned: db.banned,
  };
}

// 学词节流：每个会话记一个计数，每 N 次回复才学一次
export function shouldLearnNow(conv, every = DEFAULTS.everyReplies) {
  const db = load();
  db.counters[conv] = (db.counters[conv] || 0) + 1;
  const due = db.counters[conv] % Math.max(1, every) === 0;
  save(db);
  return due;
}

/**
 * 注入到提示词的文本：只给"未停用、未被禁"的词，按 hit 多、最近看过的排前面。
 * 数量限制在 injectLimit 条。
 */
export function lexiconBlock(limit = DEFAULTS.injectLimit, opts = {}) {
  const withTerms = opts.terms !== false;   // 关掉学词时只注入禁用词
  const context = String(opts.context || "");   // 当前对话（最近几条），用来挑「相关」的词
  const db = load();
  if (!db.terms.length && !db.banned.length) return "";

  const banned = db.banned.map((b) => normalizeTerm(b.term));
  let usable = db.terms.filter((x) => !x.disabled && !banned.some((b) => b && similar(b, x.term)));

  // 只挑「和当前话题有关」的词：词本身出现在上下文里，或者出处里有连续 4 字重合。
  // 为什么要这样：以前每轮把所有词都塞进去，模型会觉得「这些词我得用上」，
  // 于是生硬硬塞（用户反馈：新学会的词用得非常刻意）。
  if (context) {
    const ctx = String(context);
    usable = usable.filter((x) => {
      if (ctx.includes(x.term)) return true;
      const src = String(x.source || "");
      for (let i = 0; i + 4 <= src.length; i++) {
        if (ctx.includes(src.slice(i, i + 4))) return true;
      }
      return false;
    });
  }

  usable = usable
    .sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, Math.max(0, Math.min(limit, 2)));   // 最多给 2 个

  const lines = [];
  if (withTerms && usable.length) {
    lines.push("【他最近用过、你也学过的词（不是让你用，是让你听得懂）】");
    for (const x of usable) {
      const mean = x.meaning ? `＝${x.meaning}` : "";
      const use = x.usage ? `（他当时说：${x.usage}）` : "";
      lines.push(`- ${x.term}${mean}${use}`);
    }
    lines.push("");
    lines.push("这些词你自己不用主动说。只有当话题正好是这件事、而且用上去毫不费力时，才最多带一个；");
    lines.push("为了用而用、或者一句话塞两个，都会很假。听不懂就用普通话说。");
  }
  if (db.banned.length) {
    if (lines.length) lines.push("");
    lines.push("【以后不许说这几个词（他明确要求过，优先级最高）】");
    lines.push(db.banned.map((b) => b.term).join("、"));
  }
  return lines.join("\n").trim();
}

export function lexiconStats() {
  const db = load();
  return {
    total: db.terms.length,
    enabled: db.terms.filter((x) => !x.disabled).length,
    banned: db.banned.length,
    file: FILE,
  };
}

// 补意思 / 补用法（学词时没抓到意思的，比如回填出来的词）
export function setMeaning(term, meaning, usage) {
  const db = load();
  const hit = db.terms.find((x) => similar(x.term, term));
  if (!hit) return { ok: false };
  if (meaning) hit.meaning = String(meaning).slice(0, 60);
  if (usage) hit.usage = String(usage).slice(0, 40);
  save(db);
  return { ok: true, term: hit };
}

// 需要补意思的词：没意思，或者只有占位符
export function termsNeedingMeaning() {
  const db = load();
  const placeholder = /^(从聊天里学到的说法)?$/;
  return db.terms.filter((x) => !x.disabled && placeholder.test(String(x.meaning || ""))).map((x) => ({ term: x.term, source: x.source || "", conv: x.conv || "" }));
}