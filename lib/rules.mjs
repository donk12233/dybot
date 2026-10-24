// 判据里"能被代码执行"的那一半。
// 原则：自然语言是给我的备忘，开关才是给系统的规则。每个开关都必须对应一段真代码。
import { loadConfig } from "./targets.mjs";

export const SWITCH_CATALOG = [
  {
    key: "blockCommercial",
    type: "bool",
    label: "排除带货 / 引流",
    hint: "文案里出现小黄车、微信、QQ、加我、领资料、口令、橱窗、团购、优惠券、扫码等 → 不发",
    default: true,
  },
  {
    key: "blockRepost",
    type: "bool",
    label: "排除搬运 / 二创",
    hint: "文案里出现「素材来源于」「搬运」「二创」「转载」等痕迹 → 不发",
    default: true,
  },
  {
    key: "blockMusicOnly",
    type: "bool",
    label: "排除纯音乐 / 卡点",
    hint:
      "两条独立判据：① 时长 ≤60 秒且话题含 #音乐/#卡点/#戴上耳机 → 不发；" +
      "② 文案纯文字 <15 字，**且**没有章节要点，**且**评论没有实质内容 → 不发（游戏/整活区文案常只有标签，不能只因文案短就杀）",
    default: true,
  },
  {
    key: "blockNoTags",
    type: "bool",
    label: "排除无话题标签的",
    hint: "文案里一个 # 都没有 → 视为信息量不足，不发",
    default: false,
  },
  {
    key: "requireChapter",
    type: "bool",
    label: "必须有「章节要点」",
    hint: "抖音没给这条视频生成 AI 摘要 → 不发（等于要求我看过内容）",
    default: false,
  },
  {
    key: "blockKeywords",
    type: "list",
    label: "自定义黑名单词",
    hint: "文案命中任意一个词 → 不发",
    default: [],
  },
  {
    key: "maxDurationSeconds",
    type: "number",
    label: "最长时长（秒）",
    hint: "超过就不发；0 = 不限。默认 300 = 5 分钟",
    default: 300,
  },
  {
    key: "minLikes",
    type: "number",
    label: "最低点赞数",
    hint: "低于这个数视为没经过检验 → 不发；0 = 不限",
    default: 0,
  },
  {
    key: "shortCaptionMinChars",
    type: "number",
    label: "「文案过短」判定：纯文字少于几个字",
    hint: "去掉 #话题 和空格后少于这个数才算可疑。默认 15",
    default: 15,
  },
  {
    key: "shortCaptionMinCommentChars",
    type: "number",
    label: "豁免：评论总字数达到多少算有依据",
    hint: "评论加起来超过这个字数，就不算「信息量不足」。默认 40",
    default: 40,
  },
  {
    key: "shortCaptionMinLikes",
    type: "number",
    label: "豁免：点赞达到多少算「有人认」",
    hint: "点赞 ≥ 这个值就交给评分去判，不拦；0 = 关掉这个豁免。默认 1000",
    default: 1000,
  },
  {
    key: "musicMaxDurationSeconds",
    type: "number",
    label: "「纯音乐/卡点」的时长上限（秒）",
    hint: "只有时长 ≤ 这个值、且话题含音乐标签时才当纯音乐丢。默认 60",
    default: 60,
  },
  {
    key: "commercialRe",
    type: "text",
    label: "带货/引流 正则",
    hint: "留空用内置规则；写坏了自动退回内置",
    default: "",
  },
  {
    key: "repostRe",
    type: "text",
    label: "搬运/二创 正则",
    hint: "留空用内置规则",
    default: "",
  },
  {
    key: "musicRe",
    type: "text",
    label: "音乐类话题 正则",
    hint: "留空用内置规则",
    default: "",
  },
];

const RE_COMMERCIAL = /小黄车|橱窗|团购|优惠券|领资料|私信领|加我|扫码|微信|QQ|口令|秒杀|下单|直播间[见买]|点击左下|同款链接/;
const RE_REPOST = /素材来源于|素材来自|搬运|二创|转载|侵删|原作[:：@]/;
const RE_MUSIC = /#(音乐|卡点|戴上耳机|DJ|翻唱|伴奏|纯音乐)/;

export function rulesOf(cfg = loadConfig()) {
  const r = cfg.rules || {};
  const sw = r.switches || {};
  const out = {};
  for (const item of SWITCH_CATALOG) {
    const v = sw[item.key];
    out[item.key] = v === undefined ? item.default : v;
  }
  return out;
}

/**
 * 机器判定。返回 { blocked, reasons: [{key,label,detail}] }
 * 只用可得信号：文案、时长、章节要点有无、点赞数、评论内容。
 * swOverride：测试时注入固定开关集，避免单测依赖可变的 config.json。
 */
export function evaluate({ desc, duration, hasChapter, likes, comments, stage }, swOverride) {
  const sw = swOverride ? { ...rulesOf(), ...swOverride } : rulesOf();
  const text = String(desc || "");
  const reasons = [];
  const mkRe = (src, fallback) => { try { return src ? new RegExp(String(src)) : fallback; } catch { return fallback; } };
  const commercialRe = mkRe(sw.commercialRe, RE_COMMERCIAL);
  const repostRe = mkRe(sw.repostRe, RE_REPOST);
  const musicRe = mkRe(sw.musicRe, RE_MUSIC);

  if (Number(sw.maxDurationSeconds) > 0 && duration && duration > Number(sw.maxDurationSeconds)) {
    reasons.push({ key: "maxDurationSeconds", label: "超过最长时长", detail: `${duration}s > ${sw.maxDurationSeconds}s` });
  }
  if (sw.blockCommercial && commercialRe.test(text)) {
    reasons.push({ key: "blockCommercial", label: "疑似带货/引流", detail: text.match(commercialRe)?.[0] });
  }
  if (sw.blockRepost && repostRe.test(text)) {
    reasons.push({ key: "blockRepost", label: "疑似搬运/二创", detail: text.match(repostRe)?.[0] });
  }
  if (sw.blockMusicOnly) {
    const plain = text.replace(/#[^\s#]+/g, "").replace(/\s+/g, "");
    const commentChars = Array.isArray(comments) ? comments.join(" ").length : 0;
    const minChar = Number(sw.shortCaptionMinChars ?? 15);
    const minComment = Number(sw.shortCaptionMinCommentChars ?? 40);
    const minLike = Number(sw.shortCaptionMinLikes ?? 1000);
    const musicMaxDur = Number(sw.musicMaxDurationSeconds ?? 60);
    const hasSubstance = !!hasChapter || commentChars >= minComment;
    const hasEngagement = minLike > 0 && Number.isFinite(likes) && likes >= minLike;

    if (duration && duration <= musicMaxDur && musicRe.test(text)) {
      // 真·音乐信号：短 + 音乐类话题，独立成立
      reasons.push({ key: "blockMusicOnly", label: "疑似纯音乐/卡点", detail: "≤60s 且含音乐类话题" });
    } else if (stage !== "pre" && plain.length < minChar && !hasSubstance && !hasEngagement) {
      // 文案短只是"信息量可疑"。只有连互动数据都没有时才丢；
      // 点赞 ≥1000 说明有人认，交给评分去判（这条以前误杀过鹦鹉、摄影合集）。
      reasons.push({
        key: "blockShortCaption",
        label: "文案过短且无任何依据",
        detail: `纯文字 ${plain.length} 字、无章节、评论 ${commentChars} 字、赞 ${likes ?? "?"}`,
      });
    }
  }
  if (sw.blockNoTags && !/#/.test(text)) {
    reasons.push({ key: "blockNoTags", label: "无话题标签", detail: "文案里没有 #" });
  }
  if (sw.requireChapter && !hasChapter) {
    reasons.push({ key: "requireChapter", label: "没有章节要点", detail: "平台未生成 AI 摘要" });
  }
  if (Number(sw.minLikes) > 0 && typeof likes === "number" && likes < Number(sw.minLikes)) {
    reasons.push({ key: "minLikes", label: "点赞数不足", detail: `${likes} < ${sw.minLikes}` });
  }
  const kw = Array.isArray(sw.blockKeywords) ? sw.blockKeywords.filter(Boolean) : [];
  const hitKw = kw.find((k) => text.includes(k));
  if (hitKw) reasons.push({ key: "blockKeywords", label: "命中自定义黑名单", detail: hitKw });

  return { blocked: reasons.length > 0, reasons };
}
