// 判据 → 提示词：唯一出口。
// 聊天回复、转发判定 两处都必须从这里取，避免"你改了配置但模型看不到"。
import { scoringTableText, DEFAULT_SCORING } from "./scoring.mjs";

/** 聊天回复用：人设卡（优先）+ 硬约束 + 禁止话题 + 硬禁区 + 关于他的事 */
export function buildChatPrompt(persona = {}, rules = {}) {
  const P = persona;
  const R = rules;
  const knows = (P.knowsAboutMe || []).filter(Boolean);
  const forbidden = (P.forbiddenTopics || []).filter(Boolean);
  const blocked = (R.blocked || []).filter(Boolean);

  // 有完整角色卡就用它；没有就退回三个短字段（老配置仍可用）
  const identity = P.character
    ? P.character
    : [P.selfIntro || "你是一个 AI。", P.tone ? `说话风格：${P.tone}` : "", P.systemNote || ""]
        .filter(Boolean)
        .join("\n");

  return [
    identity,
    "",
    "【这次的硬约束】",
    "默认回 1 条，15~35 字；确实需要时可以回 2~3 条，用换行分隔，每条不超过 25 字。",
    "不要为了短而短。短是节奏，不是敷衍——他要的是有人接话，不是电报。",
    "不要分段、不要列表、不要 Markdown。",
    "你只有文字这一个工具：不能搜索、不能看别人的主页、不能发表情包。",
    "不知道就直说（「没看过」「不知道」），别硬编，也别解释你为什么不知道。",
    forbidden.length ? `不能聊：${forbidden.join("；")}` : "",
    blocked.length ? `不能碰：${blocked.join("；")}` : "",
    "不能替他答应任何事、不能约时间、不能谈钱、不能发链接或手机号、不能替他传话。",
    knows.length ? `你记得关于他的事：${knows.join("；")}` : "他问起别人，你一律说不知道。",
  ]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .join("\n");
}

/**
 * 转发判定用：什么算有意思 / 什么不算 / 硬禁区 + **每个收件人的记忆**
 * friends: [{ name, note, facts: [string] }] —— 记忆参与判定，不是只影响附言
 */
export function buildJudgePrompt(persona = {}, rules = {}, friends = [], recentSent = []) {
  const R = rules;
  const blocked = (R.blocked || []).filter(Boolean);
  const scoring = R.scoring && R.scoring.enabled !== false ? R.scoring : null;

  const friendBlock = (friends || [])
    .filter((f) => f && f.name)
    .map((f) => {
      const bits = [];
      if (f.note) bits.push(`备注：${f.note}`);
      if (f.neverSend) bits.push(`明确不能发：${f.neverSend}`);
      if (f.facts && f.facts.length) bits.push(`记得他：${f.facts.slice(0, 10).join("；")}`);
      if (f.todayN !== undefined) bits.push(`今天已收到 ${f.todayN} 条`);
      return `· ${f.name}${bits.length ? "　—　" + bits.join("　|　") : "　—　（目前不了解他）"}`;
    })
    .join("\n");

  // ---------- 评分制（优先）----------
  if (scoring) {
    return [
      "你在替一个人筛抖音视频：这条要不要转给死党，转给谁。按下面这张评分表打分。",
      "",
      scoringTableText(scoring || DEFAULT_SCORING),
      "",
      "【硬禁区：命中即不发，无论多有意思】",
      blocked.length ? blocked.map((x, i) => `${i + 1}. ${x}`).join("\n") : "（未配置）",
      "",
      "【收件人和你对他们的了解】",
      friendBlock || "（白名单为空）",
      "",
      recentSent && recentSent.length ? "【今天已经发过这些（判断 m14 重复刷屏 / m15 同质化 时参考）】\n" + recentSent.map((x) => "· " + x).join("\n") : "【今天还没发过东西】",
      "",
      "挑人规则（重要，按这个来）：",
      "1. 【所有人默认都可发】。不要因为「记忆里没提到这类内容」就排除某人——一个人不会只喜欢一种视频。",
      "2. 只在两种情况排除某人：a) 他的备注/记忆里明确写了讨厌、不能看、别发这类；b) 视频内容跟他的明确禁忌冲突。",
      "3. 排除掉明确冲突的人之后，剩下的都算合适。多人合适时，优先发给「todayN 最小」的那个（今天收到最少）。",
      "4. 全都冲突就输出空数组（不发）。",
      "5. 发 1 个人就够，不要群发。",
      "",
      "**只报命中的条目 id，不要自己算总分**（分数由系统按表计算，你算错会导致判错）。",
      "**命中【硬禁区】任何一条时不要打分**，直接输出 blocked 字段说明命中哪条——不论它多正能量。",
      "每条最多报 4 个加分项、4 个减分项，没有就空数组。",
      "",
      "只输出一行 JSON，不要解释、不要代码块：",
      '{"hits":["p01","p06"],"minus":["m14"],"reason":"一句话","confidence":0~1,"to":["收件人名字"]}',
      '命中硬禁区时改为：{"blocked":"命中哪条","reason":"一句话"}',
    ].join("\n");
  }

  // 判据只有一套：评分表。旧的"是非制"已删除（它改不了任何东西，只会误导）。
  // 如果配置里没有 scoring（例如刚克隆的旧配置），用内置默认表兜底。
  return [
    "你在替一个人筛抖音视频：这条要不要转给死党，转给谁。按下面这张评分表打分。",
    "",
    scoringTableText(DEFAULT_SCORING),
    "",
    "【硬禁区：命中即不发，无论多有意思】",
    blocked.length ? blocked.map((x, i) => `${i + 1}. ${x}`).join("\n") : "（未配置）",
    "",
    "【收件人和你对他们的了解】",
    friendBlock || "（白名单为空）",
    "",
    "挑人规则（重要，按这个来）：",
    "1. 【所有人默认都可发】。不要因为「记忆里没提到这类内容」就排除某人——一个人不会只喜欢一种视频。",
    "2. 只在两种情况排除某人：a) 他的备注/记忆里明确写了讨厌、不能看、别发这类；b) 视频内容跟他的明确禁忌冲突。",
    "3. 排除掉明确冲突的人之后，剩下的都算合适。多人合适时，优先发给「todayN 最小」的那个（今天收到最少）。",
    "4. 全都冲突就输出空数组（不发）。",
    "5. 发 1 个人就够，不要群发。",
    "",
    "**只报命中的条目 id，不要自己算总分**（分数由系统按表计算，你算错会导致判错）。",
    "**命中【硬禁区】任何一条时不要打分**，直接输出 blocked 字段说明命中哪条——不论它多正能量。",
    "每条最多报 4 个加分项、4 个减分项，没有就空数组。",
    "",
    "只输出一行 JSON，不要解释、不要代码块：",
    '{"hits":["p01","p06"],"minus":["m14"],"reason":"一句话","confidence":0~1,"to":["收件人名字"]}',
    '命中硬禁区时改为：{"blocked":"命中哪条","reason":"一句话"}',
  ].join("\n");
}

/** 第二个环节用：评分过关后，逐个对照每个人的记忆/备注，判断"这条适不适合他" */
export function buildMatchPrompt(friends = []) {
  const block = (friends || [])
    .filter((f) => f && f.name)
    .map((f) => {
      const bits = [];
      if (f.note) bits.push(`备注：${f.note}`);
      if (f.neverSend) bits.push(`明确不能发：${f.neverSend}`);
      if (f.facts && f.facts.length) bits.push(`记得他：${f.facts.slice(0, 12).join("；")}`);
      return `· ${f.name}${bits.length ? "　—　" + bits.join("　|　") : "　—　（还不了解他）"}`;
    })
    .join("\n");

  return [
    "你的任务：判断这条视频**对每个收件人**来说是否值得发给他。",
    "",
    "重要：",
    "1. 一个人不会只喜欢一种视频。没有明确写「讨厌/别发」的领域，都可能喜欢。",
    "2. 只在「记忆/备注里明确对得上他的兴趣」时给高分；只是「不冲突」给中等分，不算匹配。",
    "3. 记忆或备注里明确写了「讨厌/不能看/别发」这类内容的 → match 直接 false。",
    "4. 什么都不了解的人（写着「还不了解他」）→ match 一律 false（宁可走默认逻辑）。",
    "",
    "【收件人】",
    block || "（白名单为空）",
    "",
    "对每个人给一个 fit 分（0~10）和一句话理由；fit >= 6 视为匹配。",
    "只输出一行 JSON，不要解释、不要代码块：",
    '{"people":[{"name":"名字","fit":0,"match":true,"why":"一句话"}]}',
  ].join("\n");
}
