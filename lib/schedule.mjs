// 概率调度：掷骰子 + 安静时段 + 每日计数（持久化，跨重启不重置）
// 设计要点：
//  · 概率不是每 tick 掷（那样 3 秒一次必然命中），而是"距上次检查 ≥ everyMin 分钟"才掷一次
//  · 每日计数按"本地日历日"重置
//  · 安静时段内绝不主动（半夜收到 AI 消息很怪）
import fs from "node:fs";
import { P } from "./paths.mjs";
import path from "node:path";

const STATE = P("state", "schedule.json");

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE, "utf8")) || {}; } catch { s = {}; }
  const k = todayKey();
  if (s.day !== k) {
    s = { day: k, digest: { count: 0, lastCheck: 0 }, proactive: { count: 0, lastCheck: 0, perConv: {} } };
  }
  s.digest = s.digest || { count: 0, lastCheck: 0 };
  s.proactive = s.proactive || { count: 0, lastCheck: 0, perConv: {} };
  s.proactive.perConv = s.proactive.perConv || {};
  return s;
}

export function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8");
}

export function roll(chance) {
  return Math.random() < Number(chance);
}

/** "23-8" 这种区间；跨零点也支持 */
export function inQuietHours(spec, now = new Date()) {
  if (!spec) return false;
  const m = String(spec).match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return false;
  const h = now.getHours();
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  if (from === to) return false;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/**
 * 该不该触发一次"概率动作"
 * 返回 { fire:boolean, reason:string, state }
 * 不 fire 时 reason 说明为什么（给日志/面板用）
 */
export function shouldFire(kind, cfg, { conv = null } = {}) {
  const s = loadState();
  const bucket = s[kind];
  const now = Date.now();
  const everyMin = Number(cfg.everyMin ?? 60);
  const perDayMax = Number(cfg.perDayMax ?? 2);
  const perConvMax = Number(cfg.perConvPerDayMax ?? 1);

  if (cfg.enabled === false) return { fire: false, reason: "disabled", state: s };
  if (inQuietHours(cfg.quietHours)) return { fire: false, reason: "quiet-hours", state: s };
  if (bucket.count >= perDayMax) return { fire: false, reason: "daily-cap", state: s };
  if (now - Number(bucket.lastCheck || 0) < everyMin * 60 * 1000) {
    return { fire: false, reason: "too-soon", state: s };
  }
  // 到了检查点：先记一次检查时间（不管骰子结果），避免每 tick 反复掷
  bucket.lastCheck = now;
  saveState(s);

  if (conv) {
    const used = Number(bucket.perConv[conv] || 0);
    if (used >= perConvMax) return { fire: false, reason: "conv-cap", state: s };
  }
  if (!roll(cfg.chance)) return { fire: false, reason: "dice-miss", state: s };

  return { fire: true, reason: "hit", state: s };
}

/** 记账（真的执行了才调用） */
export function markFired(kind, { conv = null, note = "" } = {}) {
  const s = loadState();
  const bucket = s[kind];
  bucket.count = Number(bucket.count || 0) + 1;
  bucket.lastFired = Date.now();
  bucket.lastNote = note;
  if (conv) bucket.perConv[conv] = Number(bucket.perConv[conv] || 0) + 1;
  saveState(s);
  return s;
}

export function summary() {
  const s = loadState();
  return {
    day: s.day,
    digest: { count: s.digest.count, lastCheck: s.digest.lastCheck, lastFired: s.digest.lastFired || null },
    proactive: { count: s.proactive.count, lastCheck: s.proactive.lastCheck, perConv: s.proactive.perConv },
  };
}
