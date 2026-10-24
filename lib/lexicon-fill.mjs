// 从历史聊天里补词：把他说过的"教你个新词/管X叫Y/X是…的外号"捞出来入库。
// 用法：
//   node lib/lexicon-fill.mjs --dry      只看会加什么
//   node lib/lexicon-fill.mjs            真写入
import fs from "node:fs";
import { P } from "./paths.mjs";
import { addTerm, listLexicon } from "./lexicon.mjs";

const DRY = process.argv.includes("--dry");
const FILE = P("state", "autoreply.jsonl");

const m1 = /(?:教你(?:个|一个)?(?:新)?词|教一下|记住|记一下|记着|学一下|学学|学着点)\s*(?:这个词|这词|一个词)?\s*[：:「“"]?\s*([^\s，。！？,.!?」”"]{1,12})/;
const m2 = /([^\s，。！？,.!?「」“”"]{2,12})\s*(?:的意思|意思是|就是说|指的是)\s*(.{2,40})/;
const m3 = /(?:管|把|称)[^，。！？,.!?]{0,8}叫\s*([^\s，。！？,.!?「」“”"]{2,8})/;
const m4 = /([^\s，。！？,.!?「」“”"]{2,8})\s*(?:是|就是|变成|成了|算是|叫)[^，。！？,.!?]{0,10}(?:外号|梗|黑话|说法|叫法)/;

const clean = (t) => {
  let s = String(t || "").trim();
  s = s.replace(/^(所以|那|这|然后|就|是|而且|但是|不过)/, "");   // 去掉前导连接词
  s = s.replace(/(或者|和|与|、|\/).*$/, "");                    // 只取第一个词
  s = s.replace(/[就的]$/, "");                                   // 去掉尾部的 就/的（"老吴就"→"老吴"），但只在长度>=3 时
  return s.trim();
};

if (!fs.existsSync(FILE)) {
  console.log("没有 autoreply.jsonl");
  process.exit(0);
}

const rows = fs
  .readFileSync(FILE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const found = [];
for (const r of rows) {
  const t = String(r.incoming || "");
  if (!t || t.length > 200) continue;
  const m = t.match(m1) || t.match(m2) || t.match(m3) || t.match(m4);
  if (!m || !m[1]) continue;
  const term = clean(m[1]);
  if (!term || term.length < 2) continue;
  found.push({ term, meaning: m[2] ? String(m[2]).slice(0, 40) : "", conv: r.conv || "", source: t.slice(0, 40), ts: r.ts });
  console.log(`  [命中] ${term}  ← "${t.slice(0, 40).replace(/\n/g, " ")}"`);
}

// 去重
const seen = new Set();
const uniq = [];
for (const f of found) {
  const k = f.term.toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(f);
}

console.log(`从 ${rows.length} 条历史里找到 ${uniq.length} 个候选词：`);
for (const f of uniq) console.log(`  ${f.term}${f.meaning ? "＝" + f.meaning : ""}  · ${f.conv} · ${f.ts}`);

if (DRY) {
  console.log("\n（--dry：没有写盘）");
  process.exit(0);
}

let added = 0;
for (const f of uniq) {
  const r = addTerm({ term: f.term, meaning: f.meaning, conv: f.conv, source: f.source });
  if (r.added) added++;
}
console.log(`\n实际新增 ${added} 个（其余是已存在或被禁用）`);
const after = listLexicon();
console.log("现在词库: " + after.terms.map((x) => x.term).join(", "));
