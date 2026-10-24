// 开关自检：用固定样例 + 固定开关集，证明"代码逻辑"，不依赖可变配置
import { evaluate, rulesOf } from "./rules.mjs";

// 单测固定开关集：全开，长视频 300s
const SW = {
  blockCommercial: true,
  blockRepost: true,
  blockMusicOnly: true,
  blockNoTags: false,
  requireChapter: false,
  blockKeywords: [],
  maxDurationSeconds: 300,
  minLikes: 0,
};

const CASES = [
  { name: "正常教程", expect: "放行", v: { desc: "第1集：学会用点线面去引导视线和构建画面 #摄影 #构图 #摄影入门", duration: 180 } },
  { name: "超时长 1183s", expect: "拦下", v: { desc: "第402集：天下第一商人：吕不韦的一生 #历史 #历史人物", duration: 1183 } },
  { name: "带货话术", expect: "拦下", v: { desc: "这个真的绝了，点击左下小黄车直接拍 #好物推荐", duration: 45 } },
  { name: "搬运痕迹", expect: "拦下", v: { desc: "素材来源于@某某 如有侵权请联系 #影视 #剪辑", duration: 200 } },
  { name: "纯音乐卡点（短+音乐话题）", expect: "拦下", v: { desc: "#戴上耳机 #音乐 #卡点", duration: 30 } },
  { name: "文案过短且无章节无评论", expect: "拦下", v: { desc: "哈哈", duration: 20 } },
  { name: "纯标签但有章节要点（MC 那条）", expect: "放行", v: { desc: "#mc #minecraft #我的世界 #我的世界科技", duration: 12, hasChapter: true } },
  {
    name: "纯标签但评论有实质",
    expect: "放行",
    v: {
      desc: "#mc #minecraft #我的世界",
      duration: 12,
      hasChapter: false,
      comments: ["小伙更新了红石陷阱，将压力板改成按钮，殊不知小白将箭矢射到按钮上，这下小伙可惨了"],
    },
  },
  { name: "无标签（默认不拦）", expect: "放行", v: { desc: "今天给大家讲一个真实的历史故事，非常离谱，听完你会笑出来", duration: 240 } },
];

console.log("【固定开关集】", JSON.stringify(SW));
console.log("【当前 config 实际开关】", JSON.stringify(rulesOf()));
console.log("（下面测的是固定开关集，不受上面影响）\n");

let bad = 0;
for (const c of CASES) {
  const r = evaluate(c.v, SW);
  const got = r.blocked ? "拦下" : "放行";
  const ok = got === c.expect;
  if (!ok) bad++;
  console.log(`[${ok ? "OK " : "!! "}] ${got}（期望 ${c.expect}）  ${c.name}`);
  r.reasons.forEach((x) => console.log(`        · ${x.key} —— ${x.detail}`));
}

console.log(`\n${CASES.length - bad}/${CASES.length} 通过${bad ? `，${bad} 条不符合预期` : ""}`);
process.exit(bad ? 1 : 0);
