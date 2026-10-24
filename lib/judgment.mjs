// 精判记录：把"我判断过依据是什么"落成文件，发送时必须拿它来对账
import fs from "node:fs";
import { P } from "./paths.mjs";
import path from "node:path";

export const JUDGMENT_DIR = P("state", "judgments");

export function judgmentPath(id) {
  return path.join(JUDGMENT_DIR, String(id) + ".json");
}

export function loadJudgment(id) {
  const p = judgmentPath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * 发送前对账。三条都要过：
 *  1. 记录存在且 verdict === "send"
 *  2. 记录里有判断依据（章节要点或评论至少一项）
 *  3. 当前屏幕上的文案以记录的 descPrefix 开头（防止判断完视频滑走了）
 */
export function verifyJudgment({ id, currentDesc }) {
  if (!id) return { ok: false, reason: "no_judgment_id" };
  const j = loadJudgment(id);
  if (!j) return { ok: false, reason: "judgment_not_found" };
  if (j.verdict !== "send") return { ok: false, reason: "verdict_not_send", verdict: j.verdict };
  const hasBasis = (j.chapter && j.chapter.trim()) || (j.comments && j.comments.length);
  if (!hasBasis) return { ok: false, reason: "no_evidence_in_judgment" };
  const cur = String(currentDesc || "").trim();
  if (!cur.startsWith(j.descPrefix)) {
    return { ok: false, reason: "content_changed", expect: j.descPrefix, got: cur.slice(0, 40) };
  }
  return { ok: true, judgment: j };
}
