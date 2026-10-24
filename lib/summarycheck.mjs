// 判断 AI 回答是不是"真总结"，还是"失败说明 + 猜测"
// 返回 null = 看起来是真总结；返回字符串 = 不要用的原因
export function badSummaryReason(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "空内容";
  if (t.length < 40) return `太短（${t.length} 字）`;

  const patterns = [
    { re: /^(抱歉|不好意思|很抱歉|对不起)/, why: "以道歉开头" },
    { re: /(无法|不能|没办法|暂时无法|暂时不能)(为你|帮你|为您|给您)?(总结|分析|提取|识别|查看|看清|看懂|获取|播放|加载)/, why: "明确说无法总结" },
    { re: /(视频|内容|画面).{0,8}(无法|不能|没法)(播放|加载|获取|访问|打开)/, why: "说视频无法加载" },
    { re: /(我|系统)?.{0,4}(没有|没)(拿到|获取到|收到).{0,6}(视频|字幕|音频|画面)/, why: "说没拿到视频内容" },
    { re: /(建议你|建议您|请)(自己|手动)?(观看|看看|看一眼)/, why: "让你自己去看" },
    { re: /(总结失败|解析失败|提取失败|正在学习|暂不支持)/, why: "明说失败/不支持" },
  ];
  for (const p of patterns) if (p.re.test(t)) return p.why;

  // "猜内容"特征：短、且大量出现推测词
  const guessWords = (t.match(/推测|猜测|大概|应该是|可能是|估计|似乎|以.{0,3}(标题|文案)来看/g) || []).length;
  if (guessWords >= 2 && t.length < 160) return "通篇在猜（推测词 ≥2 且很短）";

  return null;
}
