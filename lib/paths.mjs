// 路径唯一来源：所有文件路径都从项目根算，不再写死 E:\ai\dybot。
// 开源后别人 clone 到任何目录都能跑；需要时可用环境变量 DYBOT_ROOT 覆盖。
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.DYBOT_ROOT
  ? path.resolve(process.env.DYBOT_ROOT)
  : path.resolve(here, "..");

/** 拼一个项目内路径：P("state", "events.jsonl") */
export function P(...parts) {
  return path.join(ROOT, ...parts);
}
