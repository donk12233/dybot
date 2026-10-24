// 回复安检：唯一来源。autoreply（真实发送前）和 console 的"试聊"都用这一份，
// 避免"控制台说通过、实际发送被拦"这种不一致。

const MAX_REPLY_CHARS = 60;

// ---------- 回复安检 ----------
// 谈钱：没必要把"钱"当禁忌（谁会找 AI 要钱）。
// 唯一要挡的是：她被人用话术带着，自己承诺给钱/转账/发红包。
// 其他一律放行：多少钱 / 价格 / 没钱 / 不花钱 / 红包 都正常聊。
const MONEY_SELF_PROMISE = /我\s*(给|帮|替)?\s*(你|您)?\s*(转|打钱|付|出|请客|发.{0,2}红包|垫|借给你)\s*.{0,8}(钱|红包|[一二三四五六七八九十两百千万\d]{2,})?/;
// 否定/假设句豁免：我不给你钱 / 我要是有钱就…（后者靠人读，机器只豁免明确否定）
const MONEY_NEG = /(不|没|不用|才不会|要是|如果)(给|帮|替|转|打|付|出|发|借)/g;

const FORBIDDEN = [
  [/我(答应|保证|承诺)/, "答应/保证/承诺"],
  [/(https?:\/\/|www\.)/i, "链接"],
  [/\d{6,}/, "长串数字（手机号等）"],
  [/(他最近|他在忙|他跟我说|他让我)/, "传话/透露我的事"],
];

// 时间承诺是重灾区：中文数字（三点）、双层时间（明天下午）都会漏，所以拆成两条组合判据
const TIME_WORD = /(明天|后天|今晚|明早|周末|待会|一会儿|稍后|下班后|晚点)/;
const COMMIT_VERB = /(我\s*(来|去|到|叫|提醒|安排|接|帮)|包在我身上)/;
const CLOCK = /([一二三四五六七八九十两\d]{1,3})\s*点/;
const MEET_VERB = /(见|叫|来接|过来|碰面)/;

function checkReply(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, why: "空回复" };
  if (t.length > MAX_REPLY_CHARS) return { ok: false, why: `太长（${t.length}>${MAX_REPLY_CHARS}）` };
  for (const [re, why] of FORBIDDEN) {
    if (re.test(t)) return { ok: false, why: `命中禁忌：${why}（${re}）` };
  }
  const tMoney = t.replace(MONEY_NEG, "");
  const moneyNegated = /我\s*(不|没|不会|才不会|要是有|如果|假如)/.test(t);
  if (!moneyNegated && MONEY_SELF_PROMISE.test(tMoney)) {
    return { ok: false, why: "命中禁忌：她承诺给钱/转账（被话术带着时最容易发生）" };
  }
  if (TIME_WORD.test(t) && COMMIT_VERB.test(t)) return { ok: false, why: "时间承诺：时间词 + 承诺动词" };
  if (CLOCK.test(t) && MEET_VERB.test(t)) return { ok: false, why: "时间承诺：钟点 + 见面动词" };
  return { ok: true };
}

export { checkReply };
