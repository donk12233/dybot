// 接管一个「真实 Edge」窗口（CDP），而不是另开一个自动化浏览器。
// 为什么这么做：抖音对 headless/Playwright 自启的 Chromium 会直接弹拼图验证；
// 已被实测复现（2026-10）。真实 Edge + 真实 profile 才不会在第一步就被判。
import { createRequire } from "node:module";

const DSH_MODULES = "C:/Users/HP/.dsh/profiles/web/node_modules/";
const require = createRequire(DSH_MODULES);

export const CDP_URL = process.env.DYBOT_CDP || "http://127.0.0.1:9222";

export async function connect() {
  const { chromium } = require("playwright");
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 20000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("CDP 连上了但没有浏览器上下文");
  return { browser, ctx };
}

// 找出抖音那一页；没有就新开
export async function douyinPage(ctx, { create = true } = {}) {
  const isDy = (u) => /(^|\/\/)(www\.)?douyin\.com(\/|$)/.test(u);
  let page = ctx.pages().find((p) => isDy(p.url()));
  if (!page && create) {
    page = await ctx.newPage();
    await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  return page || null;
}

// 判断登录态：抖音未登录会显示「登录」按钮；已登录有头像/消息入口
export async function loginState(page) {
  return await page.evaluate(() => {
    const t = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => (e.textContent || "").trim());
    const bodyText = document.body ? document.body.innerText.slice(0, 4000) : "";
    const hasLoginBtn = t('button, a, div').some((x) => x === "登录" || x === "立即登录");
    const hasAvatar = !!document.querySelector('img[src*="aweme-avatar"], .avatar, [class*="avatar"]');
    const hasChat = /消息|私信/.test(bodyText);
    return {
      url: location.href,
      title: document.title,
      hasLoginBtn,
      hasAvatar,
      hasChat,
      bodyHead: bodyText.slice(0, 300).replace(/\s+/g, " "),
    };
  });
}
