// 扫推荐流 N 条，给 digest 复用。
// 踩过的坑：
//  · 详情页 URL 也带 recommend=1（?modal_id=xxx&recommend=1），只判断 recommend=1 会以为在推荐流里，
//    结果反复读到同一条，滑动判定"没变化"就 break —— 表现就是"要 10 条只出 1 条"。
//  · 一次滑不动就放弃太脆（视频加载慢、焦点不在页面上都会失败），改成连续失败 3 次才收工。
export async function scanFeed(page, count = 8) {
  const onFeed = () => {
    const u = page.url();
    return /[?&]recommend=1/.test(u) && !/\/video\//.test(u) && !/[?&]modal_id=/.test(u) && !/\/chat/.test(u);
  };

  const readCurrent = () =>
    page.evaluate(() => {
      const d = document.querySelector('[data-e2e="video-desc"]');
      const vid = document.querySelector("[data-e2e-vid]");
      const author = document.querySelector('[data-e2e="feed-video-nickname"]');
      const v = document.querySelector("video");
      return {
        id: vid ? vid.getAttribute("data-e2e-vid") : null,
        desc: d ? d.innerText.replace(/\s+/g, " ").trim() : null,
        author: author ? (author.innerText || "").trim().slice(0, 24) : null,
        duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
      };
    });

  if (!onFeed()) {
    console.log("  (先回到推荐流)");
    await page.goto("https://www.douyin.com/?recommend=1", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
  }

  const out = [];
  const seen = new Set();
  let fails = 0;
  let guard = 0;

  while (out.length < count && fails < 3 && guard < count * 4 + 10) {
    guard++;
    const cur = await readCurrent();

    if (cur.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      fails = 0;
      console.log(`  [${out.length}] ${cur.id}  ${cur.duration ?? "?"}s  @${cur.author ?? "?"}  ${(cur.desc || "").slice(0, 50)}`);
      if (out.length >= count) break;
    } else if (!cur.id) {
      // 还没加载出来，给它一次机会
      await page.waitForTimeout(1500);
      const again = await readCurrent();
      if (!again.id) { fails++; continue; }
    }

    const before = cur.id;
    // 三种翻页方式依次试：滚轮 → 方向键下 → 再滚轮
    for (const act of ["wheel", "arrow", "wheel"]) {
      if (act === "wheel") {
        await page.mouse.move(640, 400).catch(() => {});
        await page.mouse.wheel(0, 900).catch(() => {});
      } else {
        await page.keyboard.press("ArrowDown").catch(() => {});
      }
      await page.waitForTimeout(2600);
      const now = await readCurrent();
      if (now.id && now.id !== before) break;
    }

    const after = await readCurrent();
    if (!after.id || after.id === before) {
      fails++;
    } else {
      fails = 0;
    }
  }

  if (out.length < count) {
    console.log(`  （只扫到 ${out.length}/${count} 条：连续 ${fails} 次没能翻到下一条，可能在推荐流末尾或页面被占用）`);
  }
  return out;
}
