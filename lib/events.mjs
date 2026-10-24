// 事件流：给控制台面板看的"它干了什么"
import fs from "node:fs";
import { P } from "./paths.mjs";
import { redact } from "./redact.mjs";
import path from "node:path";

export const EVENTS = P("state", "events.jsonl");
export const RUNNER = P("state", "runner.json");

export function emit(type, data = {}) {
  fs.mkdirSync(path.dirname(EVENTS), { recursive: true });
  // 落盘前脱敏：手机号/身份证/银行卡/邮箱/链接一律打码
  const safe = {};
  // id / videoId 这类字段是标识符，不参与脱敏（否则 19 位视频 id 会被当成卡号打码）
  const NO_REDACT = new Set(["id", "videoId", "pid", "conv"]);
  for (const [k, v] of Object.entries(data)) {
    safe[k] = typeof v === "string" && !NO_REDACT.has(k) ? redact(v) : v;
  }
  fs.appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), type, ...safe }) + "\n", "utf8");
}

export function tailEvents(limit = 60) {
  if (!fs.existsSync(EVENTS)) return [];
  const lines = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function writeRunner(info) {
  fs.mkdirSync(path.dirname(RUNNER), { recursive: true });
  fs.writeFileSync(RUNNER, JSON.stringify(info, null, 2), "utf8");
}

export function readRunner() {
  try { return JSON.parse(fs.readFileSync(RUNNER, "utf8")); } catch { return null; }
}

export function clearRunner() {
  try { fs.unlinkSync(RUNNER); } catch {}
}

export function runnerAlive() {
  // 三种判据，命中任一即视为在跑：
  //   a) pid 能探到（正常情况）
  //   b) runner.json 里有新鲜心跳（进程自己写的，10 秒一次）
  //   c) 锁文件有新鲜心跳（runner.json 被清掉时的兜底）
  const aliveByPid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const FRESH = 30000;

  const r = readRunner();
  if (r && r.pid) {
    if (aliveByPid(r.pid)) return r;
    if (r.ts && Date.now() - Number(r.ts) < FRESH) return { ...r, aliveBy: "heartbeat" };
  }
  try {
    const lock = JSON.parse(fs.readFileSync(P("state", "runner.lock.json"), "utf8"));
    if (lock && lock.pid) {
      if (aliveByPid(lock.pid)) return { ...lock, aliveBy: "lock" };
      if (lock.ts && Date.now() - Number(lock.ts) < FRESH) return { ...lock, aliveBy: "lock-heartbeat" };
    }
  } catch {}
  return null;
}
export function sumUsageToday() {
  const t = tailEvents(2000).filter((e) => e.type === "reply" && e.usage);
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = t.filter((e) => {
    const x = new Date(e.ts);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}` === key;
  });
  return {
    calls: today.length,
    promptTokens: today.reduce((a, e) => a + (e.usage.prompt_tokens || 0), 0),
    completionTokens: today.reduce((a, e) => a + (e.usage.completion_tokens || 0), 0),
    sent: today.filter((e) => e.sent).length,
  };
}
