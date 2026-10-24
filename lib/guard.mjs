// 风控守卫：识别人机验证（滑块/拼图）。
// 原则：宁可漏判，不可误判——误判一次会白停 30 分钟。
// 所以只认"强特征"：明确的验证 URL、明确的验证容器、明确的验证文案。

const VERIFY_URL_RE = /captcha|verify|\/secsdk/i;

// 明确的验证容器（不要用 [class*="verify"] 这种宽匹配，正常页面也会命中）
const VERIFY_DOM_SEL = [
  "#captcha_container",
  "#captcha_container_id",
  ".captcha_verify_container",
  ".captcha-verify-container",
  '[class*="captcha_verify"]',
  '[class*="captcha-verify"]',
  '[class*="secsdk-captcha"]',
  'iframe[src*="captcha"]',
  '[id*="captcha_container"]',
].join(",");

// 明确的验证文案（必须是"验证流程"才有的句子）
const VERIFY_TEXTS = [
  "拖动滑块",
  "滑动验证",
  "请完成下列验证",
  "验证码中间页",
  "向右滑动完成验证",
  "拖动下方滑块",
  "按住左边按钮拖动",
];

/** 页面上是否出现了人机验证 → { yes, why, sample? } */
export async function verifyPresent(page) {
  try {
    const u = page.url();
    if (VERIFY_URL_RE.test(u)) return { yes: true, why: "url", sample: u.slice(0, 80) };

    const r = await page.evaluate((sel, texts) => {
      const el = document.querySelector(sel);
      // 容器必须可见，才算真的弹出来了
      let dom = false;
      if (el) {
        const rect = el.getBoundingClientRect();
        dom = rect.width > 40 && rect.height > 40;
      }
      const body = (document.body.innerText || "").slice(0, 6000);
      const hit = texts.find((t) => body.includes(t));
      return { dom, hit: hit || null, sample: body.replace(/\s+/g, " ").slice(0, 80) };
    }, VERIFY_DOM_SEL, VERIFY_TEXTS);

    if (r && r.dom) return { yes: true, why: "captcha-dom", sample: r.sample };
    if (r && r.hit) return { yes: true, why: "captcha-text:" + r.hit, sample: r.sample };
    return { yes: false };
  } catch {
    return { yes: false };
  }
}
