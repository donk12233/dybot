// 给"只有词、没有意思"的词补上意思：用他当时那句话去问模型。
// 用法：
//   node lib/lexicon-meanings.mjs --dry     只看要补哪些
//   node lib/lexicon-meanings.mjs           真补（每个词一次模型调用）
import { termsNeedingMeaning, setMeaning, listLexicon } from "./lexicon.mjs";
import { generateReply } from "./llm.mjs";

const DRY = process.argv.includes("--dry");
const todo = termsNeedingMeaning();

if (!todo.length) {
  console.log("所有词都有意思了。");
  process.exit(0);
}

console.log(`需要补意思的词 ${todo.length} 个：`);
for (const t of todo) console.log(`  ${t.term}  ← "${String(t.source).slice(0, 40)}"`);

if (DRY) {
  console.log("\n（--dry：没有调用模型）");
  process.exit(0);
}

let ok = 0;
for (const t of todo) {
  try {
    const r = await generateReply({
      system: [
        "给一个网络用语写含义。只输出一行：含义（6~16 字），不要解释、不要引号、不要重复那个词。",
        "如果从上下文看不出确切含义，就输出「（不确定）」。",
      ].join("\n"),
      messages: [
        { role: "user", content: `词：${t.term}\n他当时的原话：${String(t.source || "").slice(0, 80)}` },
      ],
      maxTokens: 60,
    });
    let meaning = String(r.text || "").trim().replace(/^["'「」]+|["'「」]+$/g, "").slice(0, 40);
    // 去掉模型加的"（不确定）"这类注释，只要主体还有内容就采用
    meaning = meaning.replace(/[（(]\s*不确定\s*[)）]/g, "").trim();
    if (!meaning || /^(不确定|NONE|无法判断)$/i.test(meaning)) {
      console.log(`  ${t.term}：没看出意思，跳过（${meaning.slice(0, 10)}）`);
      continue;
    }
    setMeaning(t.term, meaning);
    ok++;
    console.log(`  ${t.term}＝${meaning}`);
  } catch (e) {
    console.log(`  ${t.term}：失败 ${String(e.message || e).slice(0, 50)}`);
  }
}

console.log(`\n补好 ${ok}/${todo.length} 个。现在词库：`);
for (const x of listLexicon().terms) console.log(`  ${x.term}＝${x.meaning || "（空）"}`);
