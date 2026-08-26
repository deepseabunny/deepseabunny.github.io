// roomScraper.mjs
// Usage:
//   node roomScraper.mjs
//   CITY="New York" MAX_PROPERTIES=50 node roomScraper.mjs
//   HEADFUL=1 CITY="Las Vegas" node roomScraper.mjs
//
// Dependencies:
//   npm install playwright cli-table3 chalk ora

import { chromium }  from "playwright";
import Table         from "cli-table3";
import chalk         from "chalk";
import ora           from "ora";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const CFG = {
  city:       process.env.CITY                          || "Mesa, Arizona",
  maxProps:   Number(process.env.MAX_PROPERTIES         || 100),
  concurrent: Math.max(1, Number(process.env.CONCURRENCY || 4)),
  pageSize:   Number(process.env.PAGE_SIZE              || 25),
  headful:    !!process.env.HEADFUL,
  keepOpen:   !!process.env.KEEP_OPEN,
  slowMo:     Number(process.env.SLOWMO                 || 60),
  retries:    Number(process.env.RETRIES                || 3),
  navTimeout: Number(process.env.NAV_TIMEOUT            || 45_000),
  checkin:    process.env.CHECKIN                       || isoToday(),
  checkout:   process.env.CHECKOUT                      || isoTomorrow(),
};

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function isoTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parsePrice(raw) {
  if (!raw) return null;
  const s = raw.replace(/[^0-9.,]/g, "").trim();
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot   = s.includes(".");

  if (hasComma && hasDot) {
    return s.lastIndexOf(",") > s.lastIndexOf(".")
      ? Number(s.replace(/\./g, "").replace(",", "."))  // 1.299,00 → 1299.00
      : Number(s.replace(/,/g, ""));                     // 1,299.00 → 1299.00
  }
  if (hasComma) {
    const p = s.split(",");
    return p.length === 2 && p[1].length === 2
      ? Number(s.replace(",", "."))   // 89,50 → 89.50
      : Number(s.replace(/,/g, ""));  // 1,200 → 1200
  }
  if (hasDot) {
    const p = s.split(".");
    return p.length === 2 && p[1].length === 2
      ? Number(s)                     // 89.50 → 89.50
      : Number(s.replace(/\./g, "")); // 1.200 → 1200
  }
  return Number(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

function calcStats(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum    = nums.reduce((a, b) => a + b, 0);
  const avg    = sum / nums.length;
  const mid    = Math.floor(sorted.length / 2);
  const med    = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: nums.length,
    avg,
    med,
    min:   sorted[0],
    max:   sorted[sorted.length - 1],
    below: nums.filter(x => x < avg).length,
    above: nums.filter(x => x > avg).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TERMINAL UI
// ═══════════════════════════════════════════════════════════════════════════════

const UI = (() => {

  const spinner = ora({ spinner: "dots2", color: "cyan" });

  // ── divider ──────────────────────────────────────────────────────────────────
  function divider(label = "", width = 72) {
    if (label) {
      const pad   = Math.max(0, width - label.length - 4);
      const left  = Math.floor(pad / 2);
      const right = pad - left;
      console.log(
        chalk.gray("─".repeat(left + 2)) +
        " " + chalk.bold.white(label) + " " +
        chalk.gray("─".repeat(right + 2))
      );
    } else {
      console.log(chalk.gray("─".repeat(width)));
    }
  }

  // ── banner ───────────────────────────────────────────────────────────────────
  function banner() {
    console.clear();
    console.log();
    console.log(chalk.bold.blueBright("  ╔══════════════════════════════════════════╗"));
    console.log(chalk.bold.blueBright("  ║") + chalk.bold.white("        🏨  Room Scraper  v2.0            ") + chalk.bold.blueBright("║"));
    console.log(chalk.bold.blueBright("  ╚══════════════════════════════════════════╝"));
    console.log();
    console.log(`  ${chalk.gray("City    :")} ${chalk.cyan(CFG.city)}`);
    console.log(`  ${chalk.gray("Dates   :")} ${chalk.cyan(CFG.checkin)} ${chalk.gray("→")} ${chalk.cyan(CFG.checkout)}`);
    console.log(`  ${chalk.gray("Target  :")} ${chalk.cyan(CFG.maxProps + " properties")}`);
    console.log(`  ${chalk.gray("Workers :")} ${chalk.cyan(CFG.concurrent)}`);
    console.log();
  }

  // ── spinner progress ─────────────────────────────────────────────────────────
  function progress(collected, total, page, extra = "") {
    const pct  = Math.min(100, Math.round((collected / total) * 100));
    const done = Math.round(pct / 5);
    const bar  =
      chalk.green("█".repeat(done)) +
      chalk.gray("░".repeat(20 - done));
    spinner.text =
      `${bar} ${chalk.bold.white(pct + "%")}  ` +
      `${chalk.cyan(collected + "/" + total)} properties  ` +
      `${chalk.gray("page " + page)}` +
      (extra ? "  " + chalk.gray(extra) : "");
  }

  // ── rating badge ─────────────────────────────────────────────────────────────
  function formatRating(raw) {
    const n = parseFloat(raw);
    if (isNaN(n))  return chalk.gray("  N/A  ");
    if (n >= 9.0)  return chalk.bold.green(`  ${n.toFixed(1)}  `);
    if (n >= 8.0)  return chalk.green(`  ${n.toFixed(1)}  `);
    if (n >= 7.0)  return chalk.yellow(`  ${n.toFixed(1)}  `);
    if (n >= 6.0)  return chalk.yellowBright(`  ${n.toFixed(1)}  `);
    return           chalk.red(`  ${n.toFixed(1)}  `);
  }

  // ── source badge ─────────────────────────────────────────────────────────────
  function formatSrc(src) {
    switch (src) {
      case "network-json": return chalk.bold.cyan("net-json");
      case "card-dom":     return chalk.cyan("card-dom");
      case "fallback-nav": return chalk.yellow("fallback");
      default:             return chalk.gray("unknown ");
    }
  }

  // ── results table ─────────────────────────────────────────────────────────────
  function resultsTable(results, stats) {
    console.log();
    divider("RESULTS");
    console.log();

    const table = new Table({
      head: [
        chalk.bold.blueBright("#"),
        chalk.bold.blueBright("Hotel / Property"),
        chalk.bold.blueBright("Rating"),
        chalk.bold.blueBright("Price / Night"),
        chalk.bold.blueBright("Source"),
      ],
      colWidths:  [5, 46, 10, 16, 12],
      colAligns:  ["right", "left", "center", "right", "center"],
      style:      { head: [], border: ["gray"] },
      chars: {
        top:           "─", "top-mid":    "┬", "top-left":  "┌", "top-right":  "┐",
        bottom:        "─", "bottom-mid": "┴", "bottom-left":"└", "bottom-right":"┘",
        left:          "│", "left-mid":   "├", mid:         "─", "mid-mid":    "┼",
        right:         "│", "right-mid":  "┤", middle:      "│",
      },
    });

    for (const r of results) {
      const isMin = stats && typeof r.parsed === "number" && r.parsed === stats.min;
      const isMax = stats && typeof r.parsed === "number" && r.parsed === stats.max;

      const idxCell = isMin
        ? chalk.bold.green(String(r.index))
        : isMax
          ? chalk.bold.red(String(r.index))
          : chalk.gray(String(r.index));

      const rawName  = r.name.length > 43 ? r.name.slice(0, 40) + "…" : r.name;
      const nameCell = isMin
        ? chalk.bold.green(rawName)
        : isMax
          ? chalk.bold.red(rawName)
          : chalk.white(rawName);

      const priceStr  = r.parsed != null ? `$${r.parsed.toFixed(2)}` : r.price;
      const priceCell = isMin
        ? chalk.bold.green(priceStr)
        : isMax
          ? chalk.bold.red(priceStr)
          : typeof r.parsed === "number"
            ? chalk.yellowBright(priceStr)
            : chalk.gray(priceStr);

      table.push([
        idxCell,
        nameCell,
        formatRating(r.rating),
        priceCell,
        formatSrc(r.src),
      ]);
    }

    console.log(table.toString());
  }

  // ── stats panel ──────────────────────────────────────────────────────────────
  function statsPanel(stats) {
    if (!stats) {
      console.log(chalk.yellow("  No numeric prices found."));
      return;
    }

    console.log();
    divider("STATISTICS");
    console.log();

    const rows = [
      ["Properties found", chalk.cyan(String(stats.count))],
      ["Average price",    chalk.yellowBright(`$${stats.avg.toFixed(2)}`)],
      ["Median price",     chalk.yellowBright(`$${stats.med.toFixed(2)}`)],
      ["Lowest price",     chalk.bold.green(`$${stats.min.toFixed(2)}`)],
      ["Highest price",    chalk.bold.red(`$${stats.max.toFixed(2)}`)],
      ["Below average",    chalk.gray(`${stats.below} properties`)],
      ["Above average",    chalk.gray(`${stats.above} properties`)],
    ];

    for (const [label, value] of rows) {
      console.log(`  ${chalk.gray((label + " ").padEnd(22, "·"))} ${value}`);
    }
  }

  // ── histogram ────────────────────────────────────────────────────────────────
  function histogram(results, stats) {
    if (!stats || stats.max === stats.min) return;

    console.log();
    divider("PRICE DISTRIBUTION");
    console.log();

    const BUCKETS    = 8;
    const BAR_W      = 24;
    const bucketSize = (stats.max - stats.min) / BUCKETS;
    const counts     = new Array(BUCKETS).fill(0);

    for (const r of results) {
      if (typeof r.parsed !== "number") continue;
      const i = Math.min(BUCKETS - 1, Math.floor((r.parsed - stats.min) / bucketSize));
      counts[i]++;
    }

    const maxCount = Math.max(...counts);

    for (let i = 0; i < BUCKETS; i++) {
      const lo    = (stats.min + i * bucketSize).toFixed(0);
      const hi    = (stats.min + (i + 1) * bucketSize).toFixed(0);
      const fill  = maxCount ? Math.round((counts[i] / maxCount) * BAR_W) : 0;
      const bar   = chalk.blueBright("█".repeat(fill)) + chalk.gray("░".repeat(BAR_W - fill));
      const label = `$${lo.padStart(6)} – $${hi.padStart(6)}`;
      const count = chalk.gray(String(counts[i]).padStart(3) + " hotels");
      console.log(`  ${chalk.gray(label)}  ${bar}  ${count}`);
    }
  }

  // ── footer ───────────────────────────────────────────────────────────────────
  function footer(elapsed) {
    console.log();
    divider();
    console.log(`  ${chalk.gray("Completed in")} ${chalk.cyan(elapsed)}`);
    console.log(`  ${chalk.dim("Legend:")}  ${chalk.bold.green("██ lowest price")}   ${chalk.bold.red("██ highest price")}   ${chalk.yellow("██ normal")}`);
    console.log();
  }

  return {
    spinner,
    divider,
    banner,
    progress,
    resultsTable,
    statsPanel,
    histogram,
    footer,
  };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT BUS
// ═══════════════════════════════════════════════════════════════════════════════

function makeEmit(state) {
  return function emit(event, data) {
    switch (event) {

      case "log":
        if (!UI.spinner.isSpinning)
          console.log(`  ${chalk.gray(new Date().toLocaleTimeString())}  ${chalk.cyan("ℹ")}  ${chalk.white(data)}`);
        break;

      case "warn":
        if (!UI.spinner.isSpinning)
          console.log(`  ${chalk.gray(new Date().toLocaleTimeString())}  ${chalk.yellow("⚠")}  ${chalk.yellow(data)}`);
        break;

      case "error":
        console.log(`  ${chalk.gray(new Date().toLocaleTimeString())}  ${chalk.red("✖")}  ${chalk.red(data)}`);
        break;

      case "scroll":
        if (UI.spinner.isSpinning)
          UI.progress(state.collected, CFG.maxProps, state.page, `scrolling ${data}`);
        break;

      case "item":
        state.collected = data.index;
        if (UI.spinner.isSpinning)
          UI.progress(
            state.collected,
            CFG.maxProps,
            state.page,
            chalk.gray(data.name.slice(0, 30) + (data.name.length > 30 ? "…" : ""))
          );
        break;

      case "page":
        state.page = data;
        if (UI.spinner.isSpinning)
          UI.progress(state.collected, CFG.maxProps, state.page);
        break;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildUrl(city, checkin, checkout, offset = 0) {
  return (
    "https://www.booking.com/searchresults.html?" +
    new URLSearchParams({
      ss:           city,
      checkin,
      checkout,
      group_adults: "2",
      order:        "price",
      offset:       String(offset),
    })
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COOKIE CONSENT
// ═══════════════════════════════════════════════════════════════════════════════

let _cookiesDone = false;
async function acceptCookies(page) {
  if (_cookiesDone) return;
  try {
    const btn = page.locator('button:has-text("Accept")');
    if (await btn.isVisible({ timeout: 2_000 })) {
      await btn.click();
      _cookiesDone = true;
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

async function nav(page, url, emit, opts = {}) {
  const retries = opts.retries ?? CFG.retries;
  const timeout = opts.timeout ?? 30_000;

  for (let i = 1; i <= retries; i++) {
    try {
      emit("log", `Navigating (attempt ${i}) → ${url}`);
      const res = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout:   timeout * i,
      });
      if (page.url().includes("chal_t")) {
        emit("warn", "Bot challenge — waiting for redirect…");
        await page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {});
      }
      return res;
    } catch (err) {
      emit("warn", `Attempt ${i} failed: ${err.message}`);
      if (i === retries) throw err;
      await sleep(500 * i + Math.random() * 300);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK IDLE
// ═══════════════════════════════════════════════════════════════════════════════

function waitIdle(page, opts = {}) {
  const netMs = opts.netMs ?? 600;
  const maxMs = opts.maxMs ?? 8_000;

  return Promise.race([
    new Promise(resolve => {
      let inflight = 0;
      let timer    = null;
      let settled  = false;

      const done  = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        page.removeListener("request",         onReq);
        page.removeListener("requestfinished", onEnd);
        page.removeListener("requestfailed",   onEnd);
        resolve(true);
      };
      const reset = () => { clearTimeout(timer); timer = setTimeout(() => { if (!inflight) done(); }, netMs); };
      const onReq = () => { inflight++; reset(); };
      const onEnd = () => { inflight = Math.max(0, inflight - 1); reset(); };

      page.on("request",         onReq);
      page.on("requestfinished", onEnd);
      page.on("requestfailed",   onEnd);
      reset();
    }),
    sleep(maxMs).then(() => false),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART SCROLL
// ═══════════════════════════════════════════════════════════════════════════════

async function smartScroll(page, sel, emit, opts = {}) {
  const maxMs    = opts.maxMs    ?? 15_000;
  const step     = opts.step     ?? 600;
  const stableMs = opts.stableMs ?? 3_000;
  const tick     = opts.tick     ?? 200;

  const t0 = Date.now();
  let lastCount   = 0;
  let stableSince = Date.now();
  let atBottom    = false;

  while (Date.now() - t0 < maxMs) {
    const pos = await page
      .evaluate(s => {
        window.scrollBy(0, s);
        return {
          scrollY: window.scrollY,
          innerH:  window.innerHeight,
          scrollH: document.documentElement.scrollHeight,
        };
      }, step)
      .catch(() => null);

    await sleep(tick);

    const count = await page.$$eval(sel, els => els.length).catch(() => lastCount);

    if (count > lastCount) {
      lastCount   = count;
      stableSince = Date.now();
      atBottom    = false;
      emit("scroll", `${count} cards`);
    }

    if (pos && pos.scrollY + pos.innerH >= pos.scrollH - 50) {
      if (!atBottom) {
        atBottom = true;
        await sleep(stableMs);
        const fin = await page.$$eval(sel, els => els.length).catch(() => lastCount);
        if (fin > lastCount) {
          lastCount = fin; stableSince = Date.now(); atBottom = false; continue;
        }
        break;
      }
    }

    if (Date.now() - stableSince >= stableMs && !atBottom) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
      await sleep(stableMs);
      const after = await page.$$eval(sel, els => els.length).catch(() => lastCount);
      if (after > lastCount) { lastCount = after; stableSince = Date.now(); }
      else break;
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return lastCount;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD MORE
// ═══════════════════════════════════════════════════════════════════════════════

async function clickLoadMore(page, sel, emit) {
  const candidates = [
    'button:has-text("Show more")',
    'button:has-text("Load more")',
    'a:has-text("Show more")',
    'a:has-text("Load more")',
  ];
  for (const loc of candidates) {
    try {
      const btn = await page.$(loc);
      if (!btn) continue;
      const before = await page.$$eval(sel, els => els.length).catch(() => 0);
      emit("log", `Clicking load-more: ${loc}`);
      await btn.click().catch(() => {});
      await page
        .waitForFunction(
          ([s, n]) => document.querySelectorAll(s).length > n,
          [sel, before],
          { timeout: 8_000 }
        )
        .catch(() => {});
      await smartScroll(page, sel, emit, { maxMs: 10_000, stableMs: 2_000 });
      return true;
    } catch (_) {}
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAZY PAGE POOL
// ═══════════════════════════════════════════════════════════════════════════════

class LazyPool {
  constructor(ctx, maxSize) {
    this._ctx   = ctx;
    this._max   = maxSize;
    this._free  = [];
    this._queue = [];
    this._total = 0;
  }

  async get() {
    if (this._free.length) return this._free.shift();
    if (this._total < this._max) {
      this._total++;
      const pg = await this._ctx.newPage();
      pg.setDefaultNavigationTimeout(CFG.navTimeout);
      await pg.route(
        /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot|mp4|mp3)(\?.*)?$/i,
        r => r.abort()
      );
      return pg;
    }
    return new Promise(res => this._queue.push(res));
  }

  put(pg) {
    if (this._queue.length) this._queue.shift()(pg);
    else this._free.push(pg);
  }

  async run(fn) {
    const pg = await this.get();
    try   { return await fn(pg); }
    finally { this.put(pg); }
  }

  async closeAll() {
    for (const pg of this._free) await pg.close().catch(() => {});
    this._free = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH CARD EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

async function batchCardInfo(page, sel) {
  return page
    .$$eval(sel, cards =>
      cards.map(el => {
        const pick = (root, sels) => {
          for (const s of sels) {
            const n = root.querySelector(s);
            if (n?.innerText?.trim()) return n.innerText.trim();
          }
          return null;
        };

        const name = pick(el, [
          '[data-testid="title"]',
          ".sr-hotel__name",
          ".fcab3ed991",
          "h3", "h2",
        ]) || "Unknown";

        const price = pick(el, [
          '[data-testid="price-and-discounted-price"]',
          ".bui-price-display__value",
          ".prco-inline-block-maker-helper",
          ".price_total", ".sr_price", ".price",
        ]);

        // ── rating — try every selector Booking.com has used ─────────────────
        const ratingSelectors = [
          '[data-testid="review-score"]',
          ".bui-review-score__badge",
          ".bui-review-score__score",
          '[aria-label*="Scored"]',
          '[aria-label*="scored"]',
          ".review-score-badge",
        ];
        let rating = null;
        for (const rs of ratingSelectors) {
          const rEl = el.querySelector(rs);
          if (!rEl) continue;
          const txt = rEl.innerText?.trim() || rEl.getAttribute("aria-label") || "";
          const m   = txt.match(/\d[.,]\d/);
          if (m) { rating = m[0].replace(",", "."); break; }
          if (/^\d(\.\d)?$/.test(txt.slice(0, 3))) { rating = txt.slice(0, 3); break; }
        }

        const linkEl  = el.querySelector('a[href*="/hotel/"],a[href*="booking.com/"]');
        const href    = linkEl?.href ?? null;
        const hotelId =
          el.getAttribute("data-hotelid") ||
          el.getAttribute("data-hotel-id") ||
          el.dataset?.hotelId ||
          null;

        return { name, price, rating, href, hotelId };
      })
    )
    .catch(() => []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK PRICE
// ═══════════════════════════════════════════════════════════════════════════════

function makeFallback(pool, emit) {
  const cache = new Map();

  return async function fallback(href) {
    if (cache.has(href)) return cache.get(href);

    const result = await pool.run(async pg => {
      try {
        await nav(pg, href, emit, { retries: 2, timeout: 20_000 }).catch(() => {});

        const selectors = [
          ".bui-price-display__value",
          ".hp__hotel-price .prco-valign-middle-helper",
          ".hprt-price-price-standard",
          ".prco-inline-block-maker-helper",
          ".roomstable .price",
        ];

        for (const s of selectors) {
          try {
            const el  = await pg.waitForSelector(s, { timeout: 3_000 });
            const txt = (await el.innerText()).trim();
            if (txt) return txt;
          } catch (_) {}
        }

        // JSON-LD last resort
        const blocks = await pg
          .$$eval('script[type="application/ld+json"]', ns => ns.map(n => n.innerText))
          .catch(() => []);

        for (const block of blocks) {
          try {
            const obj = JSON.parse(block);
            if (obj?.offers?.price)
              return `${obj.offers.price} ${obj.offers.priceCurrency ?? ""}`.trim();
          } catch (_) {}
        }

        return null;
      } catch (err) {
        emit("warn", `Fallback error: ${err.message}`);
        return null;
      }
    });

    cache.set(href, result);
    return result;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUP + APPLY
// ═══════════════════════════════════════════════════════════════════════════════

function applyItem(item, seenKeys, results) {
  for (const k of item.keys) if (seenKeys.has(k)) return false;
  for (const k of item.keys) seenKeys.add(k);

  results.push({
    index:  results.length + 1,
    name:   item.info.name,
    rating: item.info.rating ?? null,
    price:  item.price || "N/A",
    parsed: parsePrice(item.price),
    src:    item.src,
    href:   item.info.href ?? null,
    key:    item.keys[0],
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS CARDS
// ═══════════════════════════════════════════════════════════════════════════════

async function processCards({ page, sel, priceMap, seenKeys, results, collected, fallback, emit }) {
  const infos = await batchCardInfo(page, sel);
  emit("log", `Extracted ${infos.length} cards from DOM`);

  const instant = [];
  const slow    = [];

  for (const info of infos) {
    if (collected >= CFG.maxProps) break;
    if (!info) continue;

    const keys = [
      info.hotelId && String(info.hotelId),
      info.href    && String(info.href),
      info.name    && normName(info.name),
    ].filter(Boolean);

    if (!keys.length) continue;
    if (keys.some(k => seenKeys.has(k))) continue;

    let price = null;
    let src   = "not-found";

    if (info.hotelId && priceMap.has(String(info.hotelId))) {
      price = priceMap.get(String(info.hotelId)); src = "network-json";
    } else if (info.href && priceMap.has(String(info.href))) {
      price = priceMap.get(String(info.href));    src = "network-json";
    } else if (info.price) {
      price = info.price; src = "card-dom";
    }

    const item = { keys, info, price, src };
    if (src === "not-found" && info.href) slow.push(item);
    else instant.push(item);
  }

  for (const item of instant) {
    if (collected >= CFG.maxProps) break;
    if (applyItem(item, seenKeys, results)) {
      collected++;
      emit("item", results[results.length - 1]);
    }
  }

  if (slow.length) {
    await Promise.all(
      slow.map(async item => {
        item.price = await fallback(item.info.href);
        item.src   = item.price ? "fallback-nav" : "not-found";
      })
    );
    for (const item of slow) {
      if (collected >= CFG.maxProps) break;
      if (applyItem(item, seenKeys, results)) {
        collected++;
        emit("item", results[results.length - 1]);
      }
    }
  }

  return collected;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const state     = { collected: 0, page: 0 };
  const emit      = makeEmit(state);

  UI.banner();
  UI.divider("SCAN LOG");
  console.log();

  // ── browser ──────────────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: !CFG.headful,
    args:     ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(CFG.headful ? { slowMo: CFG.slowMo } : {}),
  });

  const shutdown = async reason => {
    UI.spinner.stop();
    emit("log", `${reason} — shutting down`);
    await browser.close().catch(() => {});
  };

  process.on("SIGINT",  () => shutdown("SIGINT").then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

  // ── context ──────────────────────────────────────────────────────────────────
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport:  { width: 1280, height: 900 },
  });
  await ctx.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

  // ── main page ─────────────────────────────────────────────────────────────────
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(CFG.navTimeout);

  await page.route(
    /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot|mp4|mp3)(\?.*)?$/i,
    r => r.abort()
  );

  // ── network price intercept ───────────────────────────────────────────────────
  const priceMap = new Map();
  page.on("response", async res => {
    try {
      if (!res.url().includes("booking.com")) return;
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      const txt = await res.text().catch(() => null);
      if (!txt) return;
      if (!txt.includes('"price"') && !txt.includes('"min_price"') && !txt.includes('"offers"')) return;
      let obj;
      try { obj = JSON.parse(txt); } catch (_) { return; }
      const list = obj.results || obj.result || obj.properties || obj.hotels || obj.items;
      if (Array.isArray(list)) {
        for (const it of list) {
          const id    = it.hotel_id || it.id || it.property_id || it.hotelId;
          const href  = it.url || it.hotel_url || it.link;
          const price = it.price || it.min_price ||
                        (it.offers?.[0]?.price);
          if (id    && price) priceMap.set(String(id),   String(price));
          if (href  && price) priceMap.set(String(href), String(price));
        }
      } else if (Array.isArray(obj.offers)) {
        for (const o of obj.offers) {
          if (o.price && o.url) priceMap.set(String(o.url), String(o.price));
        }
      }
    } catch (_) {}
  });

  // ── session init ──────────────────────────────────────────────────────────────
  emit("log", "Opening Booking.com homepage…");
  await page.goto("https://www.booking.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await acceptCookies(page);
  await sleep(1000 + Math.random() * 500);

  // ── pool + fallback ───────────────────────────────────────────────────────────
  const pool     = new LazyPool(ctx, Math.min(CFG.concurrent, 6));
  const fallback = makeFallback(pool, emit);

  // ── selector probe ────────────────────────────────────────────────────────────
  const SELECTORS = [
    '[data-testid="property-card"]',
    ".sr_property_block",
    ".sr_item",
    ".sr_item_content",
  ];

  // ── first page ────────────────────────────────────────────────────────────────
  await nav(page, buildUrl(CFG.city, CFG.checkin, CFG.checkout, 0), emit, { retries: 3 }).catch(() => {});
  await acceptCookies(page);

  let sel = null;
  for (const s of SELECTORS) {
    try {
      await page.waitForSelector(s, { timeout: 15_000 });
      sel = s;
      break;
    } catch (_) {}
  }

  if (!sel) {
    emit("error", "No card selector matched — aborting.");
    emit("error", `Current URL: ${page.url()}`);
    await page.screenshot({ path: "debug.png", fullPage: false }).catch(() => {});
    emit("error", "Screenshot saved → debug.png");
    await pool.closeAll();
    await browser.close();
    process.exit(1);
  }

  emit("log", `Card selector: ${sel}`);

  // ── start spinner ─────────────────────────────────────────────────────────────
  UI.spinner.start();
  UI.progress(0, CFG.maxProps, 0, "initialising…");

  await smartScroll(page, sel, emit, { maxMs: 15_000, stableMs: 3_000 });
  const loadedMore = await clickLoadMore(page, sel, emit);
  await waitIdle(page, { maxMs: 6_000 });

  // ── pagination loop ───────────────────────────────────────────────────────────
  let collected   = 0;
  let offset      = 0;
  let pageNum     = 0;
  let emptyStreak = 0;
  const results   = [];
  const seenKeys  = new Set();

  while (collected < CFG.maxProps) {
    pageNum++;
    emit("page", pageNum);

    if (pageNum > 1) {
      await nav(page, buildUrl(CFG.city, CFG.checkin, CFG.checkout, offset), emit, { retries: 3 }).catch(() => {});
      await acceptCookies(page);
      await smartScroll(page, sel, emit, { maxMs: 12_000, stableMs: 3_000 });
      await clickLoadMore(page, sel, emit);
      await waitIdle(page, { maxMs: 6_000 });
    }

    const before = collected;
    collected = await processCards({
      page, sel, priceMap, seenKeys,
      results, collected, fallback, emit,
    });

    const added = collected - before;
    emit("log", `Page ${pageNum} → +${added} properties (total ${collected})`);

    if (pageNum === 1 && loadedMore && added > CFG.pageSize) {
      emit("log", "Load-more captured full market — skipping pagination");
      break;
    }

    if (added === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) {
        emit("log", "Market exhausted — stopping");
        break;
      }
    } else {
      emptyStreak = 0;
    }

    offset += CFG.pageSize;
    await sleep(300 + Math.random() * 300);
  }

  // ── stop spinner ──────────────────────────────────────────────────────────────
  UI.spinner.stop();

  await pool.closeAll();
  if (!CFG.keepOpen && !CFG.headful) await browser.close();

  // ── sort by price ascending ───────────────────────────────────────────────────
  results.sort((a, b) => {
    const ap = typeof a.parsed === "number" && !isNaN(a.parsed) ? a.parsed : Infinity;
    const bp = typeof b.parsed === "number" && !isNaN(b.parsed) ? b.parsed : Infinity;
    return ap !== bp ? ap - bp : a.index - b.index;
  });
  results.forEach((r, i) => { r.index = i + 1; });

  // ── stats ─────────────────────────────────────────────────────────────────────
  const nums  = results.filter(r => typeof r.parsed === "number" && !isNaN(r.parsed)).map(r => r.parsed);
  const stats = calcStats(nums);

  // ── render ────────────────────────────────────────────────────────────────────
  UI.resultsTable(results, stats);
  UI.statsPanel(stats);
  UI.histogram(results, stats);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
  UI.footer(elapsed);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

main().catch(err => {
  UI.spinner.stop();
  console.error(chalk.red("\n  ✖ Fatal: " + (err?.stack ?? String(err))));
  process.exit(1);
});
