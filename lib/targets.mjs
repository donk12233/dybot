// 目标授权：唯一真相源是 config.json 的 friends。
// 设计原则：目标"从配置派生"，不接受任何能扩大范围的输入；
// 名单为空、未验证、同名歧义，一律拒绝执行，而不是猜。
import fs from "node:fs";
import { P } from "./paths.mjs";
import path from "node:path";

export const ROOT = P();
export const CONFIG = path.join(ROOT, "config.json");

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

export function die(msg, code = 10) {
  console.error("\n[拒绝执行] " + msg + "\n");
  process.exit(code);
}

// 真发动作必须显式声明"我已经确认过这一轮的目标是人"
export function requireYes(argv, actionName) {
  if (!argv.includes("--yes")) {
    die(
      `这是真发动作（${actionName}），必须带 --yes。\n` +
        `  --yes 的语义不是"用户逐条确认"，而是"执行者显式声明本轮目标已核对"。\n` +
        `  没有这个 flag，"发给谁"就由默认值/列表位置决定——那正是要防的洞。`
    );
  }
}

/**
 * 派生出本轮允许的目标名单。
 * 规则：
 *  1. friends 里 name 非空
 *  2. verified === true（你在控制台勾过）
 *  3. 若传了 --only=X，X 必须已经在上面的集合里（只能缩小，不能扩大）
 *  4. 结果为空 → 拒绝执行
 */
export function resolveTargets(argv, cfg = loadConfig()) {
  const all = (cfg.friends || []).filter((f) => String(f.name || "").trim());

  if (all.length === 0) {
    die("白名单为空（config.json → friends）。没有任何可发送对象，拒绝执行。");
  }

  const verified = all.filter((f) => f.verified === true);
  if (verified.length === 0) {
    die(
      `白名单里有 ${all.length} 个名字，但没有一个 verified=true。\n` +
        `  请先在控制台（http://127.0.0.1:3200 → 白名单）勾选"已验证"，再跑。\n` +
        `  这一道是为了防止"随手往 config 里加个名字就开跑"。`
    );
  }

  const onlyArg = argv.find((a) => a.startsWith("--only=") || a.startsWith("--to="));
  if (onlyArg) {
    const only = onlyArg.slice(onlyArg.indexOf("=") + 1).trim();
    const hit = verified.find((f) => f.name === only);
    if (!hit) {
      die(
        `--only/--to=${only} 不在已验证白名单里。\n` +
          `  允许的值只有：${verified.map((f) => f.name).join(" / ")}\n` +
          `  这个参数只能缩小范围，不能指定一个名单外的人。`
      );
    }
    return [hit];
  }

  return verified;
}

/**
 * 在候选行里按昵称匹配，必须恰好一个。
 * 返回 { ok, target, rows } —— 不 ok 时 target 为 null，调用方应跳过而不是猜。
 */
export function matchExactlyOne(rows, name) {
  const hits = (rows || []).filter((r) => r && r.name === name);
  if (hits.length === 1) return { ok: true, target: hits[0], reason: "unique" };
  if (hits.length === 0) return { ok: false, target: null, reason: "not_found", rows };
  return { ok: false, target: null, reason: "ambiguous", rows, count: hits.length };
}

/** 追加一条记录到 sent.jsonl */
export function appendLog(entry) {
  fs.appendFileSync(path.join(ROOT, "sent.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

export function limits(cfg = loadConfig()) {
  const L = cfg.limits || {};
  return {
    dailyOutgoingCap: Number(L.dailyOutgoingCap ?? 3),
    maxRecipientsPerVideo: Number(L.maxRecipientsPerVideo ?? 3),
    sameVideoCooldownHours: Number(L.sameVideoCooldownHours ?? 24),
  };
}
