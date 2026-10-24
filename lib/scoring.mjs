// 评分制判据：把"加分项 / 减分项"变成可计算的总分。
// 模型只负责"命中哪些条目"（id），**分数由代码按表算**——避免模型自己乱加数。
// 表存在 config.json → rules.scoring，控制台可改。

export const DEFAULT_PLUS = [
  // 情绪价值
  { id: "p01", cat: "情绪价值", item: "强笑点", pts: [8, 10], how: "前3秒有反差/包袱，评论区也认" },
  { id: "p02", cat: "情绪价值", item: "强共鸣", pts: [6, 8], how: "打中年轻人痛点：通勤、租房、加班、恋爱、社交" },
  { id: "p03", cat: "情绪价值", item: "治愈放松", pts: [4, 6], how: "萌宠、风景、手工、白噪音、慢生活，不腻" },
  { id: "p04", cat: "情绪价值", item: "爽点/解压", pts: [5, 7], how: "清理、修复、逆袭、打脸但不引战" },
  { id: "p05", cat: "情绪价值", item: "真实不演", pts: [5, 7], how: "素人感、生活流、有瑕疵但真诚" },
  // 社交货币
  { id: "p06", cat: "社交货币", item: "可@朋友", pts: [8, 10], how: "有明显「这像你」「转给他看」的标签" },
  { id: "p07", cat: "社交货币", item: "有梗/金句", pts: [6, 8], how: "可复用、可评论接梗、不过时" },
  { id: "p08", cat: "社交货币", item: "话题性强", pts: [5, 8], how: "能引发轻松讨论，不是对立吵架" },
  { id: "p09", cat: "社交货币", item: "挑战/模板", pts: [5, 7], how: "可模仿、可合拍、可跟拍" },
  { id: "p10", cat: "社交货币", item: "身份表达", pts: [5, 7], how: "转发表明「我是二次元/健身人/打工人」" },
  // 用户匹配
  { id: "p11", cat: "用户匹配", item: "年轻人语境", pts: [6, 8], how: "懂梗但不烂梗，不爹味不油腻" },
  { id: "p12", cat: "用户匹配", item: "学生/初职场相关", pts: [6, 8], how: "考试、实习、租房、面试、省钱、副业避坑" },
  { id: "p13", cat: "用户匹配", item: "圈层匹配", pts: [5, 8], how: "游戏、动漫、音乐、舞蹈、AI、数码、旅行、美食、健身、穿搭" },
  // 实用信息
  { id: "p14", cat: "实用信息", item: "干货教程", pts: [7, 10], how: "步骤清晰、可复现、非卖课引流" },
  { id: "p15", cat: "实用信息", item: "避坑省钱", pts: [7, 9], how: "租房/购物/旅游/求职/数码避坑，信息可验证" },
  { id: "p16", cat: "实用信息", item: "AI/效率工具", pts: [6, 8], how: "新工具、新方法、真演示，不夸大" },
  { id: "p17", cat: "实用信息", item: "冷知识", pts: [4, 6], how: "反常识但有依据，一句话能讲清" },
  // 视觉节奏
  { id: "p18", cat: "视觉节奏", item: "前3秒抓人", pts: [6, 8], how: "画面/文案/冲突立即出现" },
  { id: "p19", cat: "视觉节奏", item: "节奏紧凑", pts: [5, 7], how: "15—60秒，无冗长铺垫，完播潜力高" },
  { id: "p20", cat: "视觉节奏", item: "字幕清晰", pts: [3, 5], how: "有字幕、重点突出、静音可看" },
  { id: "p21", cat: "视觉节奏", item: "画面稳定审美在线", pts: [3, 5], how: "构图干净、不晃、不脏乱" },
  // 新鲜度
  { id: "p22", cat: "新鲜度", item: "新梗/新形式", pts: [5, 7], how: "近期出现但未烂大街" },
  { id: "p23", cat: "新鲜度", item: "信息新鲜", pts: [5, 7], how: "新政策、新工具、新玩法，时效未过" },
  // 账号调性
  { id: "p24", cat: "账号调性", item: "符合人设", pts: [5, 8], how: "转后不破坏账号风格" },
  { id: "p25", cat: "账号调性", item: "安全得体", pts: [5, 8], how: "公开转发不尴尬、不冒犯、不侵权" },
  // 评论区 / 私信
  { id: "p26", cat: "评论区质量", item: "神评论/二创空间", pts: [3, 5], how: "评论区有梗、有补充信息" },
  { id: "p27", cat: "私信场景", item: "好友标签强匹配", pts: [5, 8], how: "明确适合某类好友，私信更可放宽" },
];

export const DEFAULT_MINUS = [
  { id: "m01", cat: "硬伤", item: "硬广卖课", pts: [20, 30], how: "二维码、私信领资料、夸张承诺", veto: true },
  { id: "m02", cat: "硬伤", item: "标题党严重", pts: [15, 20], how: "标题与内容不符、故意制造悬念" },
  { id: "m03", cat: "硬伤", item: "引战争议", pts: [20, 30], how: "挑动对立、评论区乌烟瘴气", veto: true },
  { id: "m04", cat: "硬伤", item: "焦虑贩卖", pts: [15, 20], how: "不转就落后、制造恐慌" },
  { id: "m05", cat: "硬伤", item: "炫富拜金", pts: [15, 20], how: "炫车炫包、贬低普通人" },
  { id: "m06", cat: "硬伤", item: "低质搬运", pts: [15, 20], how: "去水印、拼接、无信息增量" },
  { id: "m07", cat: "硬伤", item: "伪科学/错误信息", pts: [20, 30], how: "养生谣言、错误教程", veto: true },
  { id: "m08", cat: "硬伤", item: "隐私暴露", pts: [20, 30], how: "路人正脸、住址、车牌、学校", veto: true },
  { id: "m09", cat: "硬伤", item: "萌娃/宠物敏感暴露", pts: [15, 25], how: "隐私、危险动作、消费儿童" },
  { id: "m10", cat: "硬伤", item: "过度擦边", pts: [20, 30], how: "暗示性动作、镜头、文案", veto: true },
  { id: "m11", cat: "观感", item: "老梗烂梗", pts: [8, 12], how: "已刷屏、无新意" },
  { id: "m12", cat: "观感", item: "爹味说教", pts: [8, 12], how: "居高临下、教育年轻人" },
  { id: "m13", cat: "观感", item: "油腻尴尬", pts: [8, 12], how: "硬挠尬笑、土味过度" },
  { id: "m14", cat: "观感", item: "重复刷屏", pts: [10, 15], how: "同作者/同话题近期已转" },
  { id: "m15", cat: "观感", item: "同质化严重", pts: [8, 12], how: "与已转内容高度相似" },
  { id: "m16", cat: "观感", item: "过长无字幕", pts: [8, 12], how: "超90秒且无重点、静音不可看" },
  { id: "m17", cat: "观感", item: "画面脏乱晃", pts: [5, 8], how: "影响观看" },
  { id: "m18", cat: "观感", item: "信息不可验证", pts: [8, 12], how: "数据来源不明" },
  { id: "m19", cat: "观感", item: "评论区负面", pts: [10, 15], how: "大量骂战、举报、质疑" },
  { id: "m20", cat: "观感", item: "强引流", pts: [10, 15], how: "引导私信、加群、站外交易" },
];

export const DEFAULT_SCORING = {
  enabled: true,
  sendAt: 18,          // 总分达到多少才发
  minPlus: 1,          // 至少要有几个加分项（防止只靠"不扣分"混过去）
  plus: DEFAULT_PLUS,
  minus: DEFAULT_MINUS,
};

/** 取分值：区间取中值（模型只报命中，不报具体分，避免它自己乱算） */
export function ptsOf(item) {
  const a = Number(item?.pts?.[0] ?? 0);
  const b = Number(item?.pts?.[1] ?? a);
  return (a + b) / 2;
}

/** 按命中的 id 列表算总分 */
export function computeScore(scoring, plusIds = [], minusIds = []) {
  const s = scoring || DEFAULT_SCORING;
  const plusMap = new Map((s.plus || []).map((x) => [x.id, x]));
  const minusMap = new Map((s.minus || []).map((x) => [x.id, x]));

  const hits = [];
  let total = 0;
  for (const id of plusIds) {
    const it = plusMap.get(id);
    if (!it) continue;
    const p = ptsOf(it);
    total += p;
    hits.push({ id, item: it.item, pts: p });
  }
  const cuts = [];
  let veto = null;
  for (const id of minusIds) {
    const it = minusMap.get(id);
    if (!it) continue;
    const p = ptsOf(it);
    total -= p;
    cuts.push({ id, item: it.item, pts: p });
    if (it.veto) veto = it.item;
  }
  return { total: Math.round(total * 10) / 10, hits, cuts, veto };
}

/** 判定结论：是否发 */
export function decide(scoring, result) {
  const s = scoring || DEFAULT_SCORING;
  if (result.veto) return { send: false, why: `硬伤：${result.veto}` };
  if ((result.hits || []).length < Number(s.minPlus ?? 1)) {
    return { send: false, why: "没有一个明确的加分项" };
  }
  if (result.total < Number(s.sendAt ?? 18)) {
    return { send: false, why: `总分 ${result.total} < 门槛 ${s.sendAt}` };
  }
  return { send: true, why: `总分 ${result.total} ≥ 门槛 ${s.sendAt}` };
}

/** 给模型看的评分表（分组） */
export function scoringTableText(scoring) {
  const s = scoring || DEFAULT_SCORING;
  const group = (list) => {
    const byCat = new Map();
    for (const it of list) {
      if (!byCat.has(it.cat)) byCat.set(it.cat, []);
      byCat.get(it.cat).push(`  ${it.id} ${it.item}（${it.pts[0]}~${it.pts[1]}分）：${it.how}`);
    }
    return [...byCat.entries()].map(([cat, rows]) => `【${cat}】\n${rows.join("\n")}`).join("\n");
  };
  return [
    "=== 加分项（命中就报 id）===",
    group(s.plus || []),
    "",
    "=== 减分项（命中就报 id）===",
    group(s.minus || []),
    "",
    "注意：标了「硬伤」且属于绝对红线的条目（硬广卖课 / 引战争议 / 伪科学 / 隐私暴露 / 过度擦边）命中即不发。",
  ].join("\n");
}
