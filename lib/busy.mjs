// 浏览器占用锁：autoreply 和 digest 共用同一个 Edge 标签页，不能同时操作。
// digest 开工时写 state/digest.lock，收工时删；autoreply 每轮先看这把锁，有人占着就暂停。
import fs from "node:fs";
import { P } from "./paths.mjs";

const LOCK = P("state", "digest.lock");

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function digestBusy() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (!j || !j.pid) return null;
    if (j.pid === process.pid) return null;      // 自己占的不算
    if (!pidAlive(j.pid)) {                       // 僵尸锁，清掉
      try { fs.unlinkSync(LOCK); } catch {}
      return null;
    }
    return j;
  } catch { return null; }
}

export function lockDigest(note = "") {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), note }, null, 2), "utf8");
  const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  return release;
}
