// 轻量记忆：每个会话一份 JSON，只存"值得长期记住"的事实。
// 设计原则：小、可读、可手改、可删。不存整段对话。
import fs from "node:fs";
import { P } from "./paths.mjs";
import path from "node:path";
import { redact } from "./redact.mjs";

const DIR = P("state", "memory");
const MAX_FACTS = 40;          // 单会话最多存多少条
const MAX_FACT_CHARS = 60;     // 单条最长

function fileOf(conv) {
  const safe = String(conv || "default").replace(/[\\/:*?"<>|]/g, "_");
  return path.join(DIR, safe + ".json");
}

export function loadMemory(conv) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(conv), "utf8"));
    return { conv, facts: Array.isArray(j.facts) ? j.facts : [], updatedAt: j.updatedAt || null };
  } catch {
    return { conv, facts: [], updatedAt: null };
  }
}

export function saveMemory(conv, mem) {
  fs.mkdirSync(DIR, { recursive: true });
  const cleaned = {
    conv,
    updatedAt: new Date().toISOString(),
    facts: (mem.facts || [])
      .map((f) => ({ text: redact(String(f.text || "").trim()).slice(0, MAX_FACT_CHARS), ts: f.ts || new Date().toISOString() }))
      .filter((f) => f.text)
      .slice(-MAX_FACTS),
  };
  fs.writeFileSync(fileOf(conv), JSON.stringify(cleaned, null, 2), "utf8");
  return cleaned;
}


// ---------- 存不存：程序层把关（不只靠模型自觉）----------
// 判"这条值不值得长期记住"。标准：**一周后再看它还有用吗**。
const TRANSIENT = /(正在|刚刚?|刚才|准备|打算|今天|今晚|明天|后天|这会儿?|现在|等下|在翻|刷到|发了|看完|听完|一会儿|待会)/;
// 像聊天原句的（有第二人称/语气词/引号），一律不存
const CHATTY = /[你咱]|["“”「」]|^(？|\?|！|!|嗯|哈|草|行|对)/;
const MIN_LEN = 6;
const MAX_LEN = 26;

function looksDurable(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, why: "空" };
  if (t.length < MIN_LEN) return { ok: false, why: "太短" };
  if (t.length > MAX_LEN) return { ok: false, why: "太长" };
  if (!t.startsWith("他")) return { ok: false, why: "不是第三人称事实" };
  if (TRANSIENT.test(t)) return { ok: false, why: "临时状态" };
  if (CHATTY.test(t)) return { ok: false, why: "像聊天原句" };
  return { ok: true };
}

// 近似重复：字面重合度高就不存（"他相册里全是废片" vs "他相册里全是废片，准备发视频"）
function isNearDuplicate(existing, text) {
  const norm = (x) => String(x || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
  const a = norm(text);
  if (!a) return true;
  for (const f of existing) {
    const b = norm(f.text);
    if (!b) continue;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
    // 字符集合重合度
    const sa = new Set(a.split(""));
    const sb = new Set(b.split(""));
    let inter = 0;
    for (const ch of sa) if (sb.has(ch)) inter++;
    const jac = inter / (sa.size + sb.size - inter);
    if (jac >= 0.62) return true;
  }
  return false;
}
export function addFacts(conv, facts, opts = {}) {
  const mem = loadMemory(conv);
  const have = new Set(mem.facts.map((f) => f.text));
  let added = 0;
  const rejected = [];
  for (const t of facts) {
    const text = redact(String(t || "").trim()).slice(0, MAX_FACT_CHARS);
    if (!text || have.has(text)) continue;

    // strict 模式（自动抽取用）：过"值不值得记"和"是不是重复"两道闸
    if (opts.strict) {
      const v = looksDurable(text);
      if (!v.ok) { rejected.push({ text, why: v.why }); continue; }
      if (isNearDuplicate(mem.facts, text)) { rejected.push({ text, why: "重复" }); continue; }
    }

    mem.facts.push({ text, ts: new Date().toISOString() });
    have.add(text);
    added++;
  }
  if (rejected.length) console.log("[记忆] 丢掉 " + rejected.length + " 条：" + rejected.map((r) => r.why + "「" + r.text + "」").join(" / "));
  saveMemory(conv, mem);
  return { added, rejected };
}

/** 给 prompt 用的一段话；没有记忆就返回空串 */
export function memoryBlock(conv, limit = 40) {   // 与 MAX_FACTS 一致，避免"存了却不生效"
  const mem = loadMemory(conv);
  if (!mem.facts.length) return "";
  const recent = mem.facts.slice(-limit).map((f) => `· ${f.text}`);
  return ["你记得关于他的事（长期记忆，别主动复述，只在相关时用）：", ...recent].join("\n");
}
