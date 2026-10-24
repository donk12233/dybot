// 从历史对话里补记忆：读 state/autoreply.jsonl，按会话分段抽取，
// 交给同一套严格过滤（looksDurable + 近似去重）。
//
// 存在的理由：自动抽取每次只看"最近 6 条 + 本次回复"，
// 事实散落在更长历史里就永远抓不到。这个脚本扫一遍历史补上。
import fs from "node:fs";
import { P } from "./paths.mjs";
import { generateReply } from "./llm.mjs";
import { addFacts, loadMemory } from "./memory.mjs";

const LOG = P("state", "autoreply.jsonl");

function readRows() {
  try {
    return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const SYS = [
  "从这段对话里抽取关于「对方」（他）的信息。",
  "【要记】身份职业、长期在做的事、正在学的技能、明确的计划、稳定的喜好或厌恶、生活状况；",
  "他明说或明显暗示的偏好也算（例如「我还是吃小蛋糕吧」→ 他喜欢小蛋糕）。",
  "【绝不记】对某个视频的评价、玩笑原话、对话原句、一次性的动作、临时情绪。",
  "最多 2 条，每条不超过 20 字，用第三人称「他…」开头，一行一条。",
  "没有可记的就只输出 NONE。不要聊天、不要解释。",
].join("\n");

/**
 * @param {{conv?:string, limit?:number, dryRun?:boolean}} opts
 */
export async function backfillMemory(opts = {}) {
  const limit = Number(opts.limit || 60);
  const dry = opts.dryRun === true;
  const rows = readRows().filter((r) => r.incoming && r.draft);
  const byConv = new Map();
  for (const r of rows) {
    if (opts.conv && r.conv !== opts.conv) continue;
    if (!byConv.has(r.conv)) byConv.set(r.conv, []);
    byConv.get(r.conv).push(r);
  }

  const report = [];
  for (const [conv, list] of byConv) {
    const recent = list.slice(-limit);
    const before = (loadMemory(conv).facts || []).length;
    const chunks = [];
    for (let i = 0; i < recent.length; i += 10) chunks.push(recent.slice(i, i + 10));

    const found = [];
    const rejectedAll = [];
    for (const chunk of chunks) {
      const messages = [];
      for (const r of chunk) {
        messages.push({ role: "user", content: String(r.incoming).slice(0, 300) });
        messages.push({ role: "assistant", content: String(r.draft).slice(0, 300) });
      }
      messages.push({ role: "user", content: "按上面的规则抽取关于他的事实。一行一条，没有就只回 NONE。" });
      let text = "";
      try {
        const r = await generateReply({ system: SYS, messages, maxTokens: 120 });
        text = String(r.text || "").trim();
      } catch (e) {
        report.push({ conv, error: String(e.message).slice(0, 100) });
        continue;
      }
      const lines = text.split("\n").map((x) => x.replace(/^[-·•\d.、)\s]+/, "").trim()).filter(Boolean).filter((x) => !/^NONE$/i.test(x));
      for (const l of lines) {
        // 模型偶尔不加"他"，允许补上再过滤
        const t = l.startsWith("他") ? l : "他" + l.replace(/^(喜欢|会|在|有|怕|讨厌)/, "$1");
        if (!dry) {
          const r2 = addFacts(conv, [t], { strict: true });
          if (r2.added) found.push(t);
          else if (r2.rejected) rejectedAll.push(...r2.rejected);
        } else {
          found.push(t);
        }
      }
    }
    const after = dry ? before + found.length : (loadMemory(conv).facts || []).length;
    report.push({ conv, before, after, added: found, rejected: rejectedAll.slice(0, 8), chunks: chunks.length });
  }
  return { ok: true, report };
}

// 命令行直接跑：node lib/memfill.mjs [--conv=名字] [--dry]
if (process.argv[1] && process.argv[1].endsWith("memfill.mjs")) {
  const conv = (process.argv.find((a) => a.startsWith("--conv=")) || "").split("=")[1] || null;
  const dry = process.argv.includes("--dry");
  const r = await backfillMemory({ conv, dryRun: dry });
  for (const x of r.report) {
    if (x.error) { console.log(`${x.conv}: 出错 ${x.error}`); continue; }
    console.log(`${x.conv}: ${x.before} → ${x.after} 条（分 ${x.chunks} 段抽取）`);
    (x.added || []).forEach((t) => console.log(`   + ${t}`));
    (x.rejected || []).forEach((t) => console.log(`   - ${t.text}（${t.why}）`));
  }
  process.exit(0);
}
