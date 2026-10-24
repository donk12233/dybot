// 脱敏：写日志/存记忆前调用。目的不是"绝对安全"，而是"别把手机号银行卡直接落盘/上屏"。
// 注意：脱敏只影响本地日志与记忆文件，发给模型的内容用的是原文（否则它看不懂上下文）。

const RULES = [
  // 11 位手机号
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号]"],
  // 18 位身份证（末位可能是 X）
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "[身份证]"],
  // 银行卡 16-19 位
  [/(?<!\d)\d{16,19}(?!\d)/g, "[卡号]"],
  // 邮箱
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[邮箱]"],
  // 链接
  [/https?:\/\/\S+/gi, "[链接]"],
  // 微信/QQ 号常见引导
  [/(微信|QQ|qq)\s*[:：]?\s*[\w-]{5,}/g, "[联系方式]"],
];

export function redact(text) {
  let s = String(text ?? "");
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

/** 用于日志里较长的正文：截断 + 脱敏 */
export function redactShort(text, max = 120) {
  const s = redact(text);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
