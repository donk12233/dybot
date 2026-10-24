// 模型通道适配器：默认 OpenAI 兼容（DeepSeek 官方也用这个形状）
// 没有 key 时进入 dry 模式，返回占位文本，整条链路仍可端到端跑通。
import fs from "node:fs";
import { P } from "./paths.mjs";
import path from "node:path";

const CONF = P("state", "llm.json");

export function loadLlm() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { file = {}; }
  const apiKey = process.env.DYBOT_LLM_KEY || file.apiKey || "";
  return {
    baseUrl: process.env.DYBOT_LLM_BASE || file.baseUrl || "https://api.deepseek.com",
    model: process.env.DYBOT_LLM_MODEL || file.model || "deepseek-chat",
    apiKey,
    dry: file.dry === true || !apiKey,
  };
}

export function saveLlm(cfg) {
  fs.mkdirSync(path.dirname(CONF), { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2), "utf8");
  return CONF;
}

/**
 * system: 人设与约束；messages: [{role:'user'|'assistant', content}]
 * 返回 { text, mode, model }
 */
export async function generateReply({ system, messages, maxTokens = 200, temperature = 0.8 }) {
  const c = loadLlm();
  if (c.dry) {
    return {
      text: "[dry] 收到。我现在是干跑模式（还没配模型 key），这条不会真的发出去。",
      mode: "dry",
      model: null,
      usage: null,
    };
  }
  const base = c.baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const text = (j?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("LLM 返回空内容");
  return { text, mode: "api", model: c.model, usage: j.usage || null };
}

// 自检：node lib/llm.mjs --test
// 用最小的请求验证 key 可用（1 句话，花很少的钱），并打印通道信息
if (process.argv[1] && process.argv[1].endsWith("llm.mjs") && process.argv.includes("--test")) {
  const c = loadLlm();
  console.log("baseUrl   =", c.baseUrl);
  console.log("model     =", c.model);
  console.log("apiKey    =", c.apiKey ? c.apiKey.slice(0, 6) + "…" + c.apiKey.slice(-4) + `（长度 ${c.apiKey.length}）` : "（空）");
  console.log("模式      =", c.dry ? "dry（没有 key，不会真调）" : "api（会真调）");
  if (c.dry) {
    console.log("\n还没配 key。把 key 写进 state/llm.json 或设环境变量 DYBOT_LLM_KEY。");
    process.exit(1);
  }
  const t0 = Date.now();
  try {
    const r = await generateReply({
      system: "你是连通性测试。只回两个字：收到。",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    console.log(`\n✅ 调用成功，耗时 ${Date.now() - t0}ms`);
    console.log("回复：", JSON.stringify(r.text));
    process.exit(0);
  } catch (e) {
    console.log(`\n❌ 调用失败（${Date.now() - t0}ms）：${e.message}`);
    process.exit(2);
  }
}
