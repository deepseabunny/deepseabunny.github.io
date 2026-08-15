// roomScraper.mjs
// Booking.com scraper: initial continuous scroll for 10 seconds on page load, then capture data.
// - Collects up to MAX_PROPERTIES unique properties (default 100)
// - Initial continuous scroll for 10 seconds to force lazy-loading on page load
// - Then uses controlled scroll passes (max MAX_SCROLL_PASSES) with DOM+network idle detection
// - Deduplicates by hotelId, href, normalized name
// - Uses network JSON capture + small worker pool fallback for missing prices
// - Streams unique results to mesa_prices.jsonl and writes mesa_prices_summary.json
// - State notifications included; supports HEADFUL=1, KEEP_OPEN=1, IGNORE_CHECKPOINT=1
//
// Usage:
//   npm install playwright
//   npx playwright install
//   MAX_PROPERTIES=100 CONCURRENCY=4 HEADFUL=1 node roomScraper.mjs

import fs from "fs";
import { chromium } from "playwright";

/* ===== Config ===== */
const MAX_PROPERTIES = Number(process.env.MAX_PROPERTIES || 100);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));
const CITY = process.env.CITY || "Mesa, Arizona";
const KEEP_OPEN = !!process.env.KEEP_OPEN;
const IGNORE_CHECKPOINT = !!process.env.IGNORE_CHECKPOINT;
const HEADFUL = !!process.env.HEADFUL;
const MAX_SCROLL_PASSES = Number(process.env.MAX_SCROLL_PASSES || 5);

/* ===== Helpers ===== */
function isoDateString(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeName(name) {
  if (!name) return "";
  return name.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s-]/g, "").trim();
}
function parsePriceToNumber(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^0-9.,]/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.includes(",") && cleaned.includes(".")) return Number(cleaned.replace(/,/g, ""));
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    const parts = cleaned.split(",");
    if (parts[1] && parts[1].length === 2) return Number(cleaned.replace(",", "."));
    return Number(cleaned.replace(/,/g, ""));
  }
  return Number(cleaned);
}
function computeStats(numbers) {
  const n = numbers.length;
  if (n === 0) return null;
  const sum = numbers.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const sorted = [...numbers].sort((a, b) => a - b);
  const median = (n % 2 === 1) ? sorted[(n - 1) / 2] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const below = numbers.filter(x => x < avg).length;
  const above = numbers.filter(x => x > avg).length;
  return { count: n, sum, average: avg, median, min, max, below, above };
}

/* ===== Navigation helper with debug artifacts ===== */
async function safeNavigate(page, url, opts = {}) {
  const maxAttempts = opts.retries ?? 3;
  const baseTimeout = opts.timeout ?? 30000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`STATE: navigating (attempt ${attempt}) -> ${url}`);
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: baseTimeout * attempt });
      if (response) console.log(`STATE: navigation response ${response.status()}`);
      return response;
    } catch (err) {
      console.warn(`STATE: navigation attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxAttempts) {
        try {
          const stamp = Date.now();
          await page.screenshot({ path: `debug_nav_failed_${stamp}.png`, fullPage: true }).catch(()=>{});
          const html = await page.content().catch(()=>null);
          if (html) fs.writeFileSync(`debug_nav_failed_${stamp}.html`, html);
          console.error("STATE: saved debug artifacts for failed navigation");
        } catch (e) {}
        throw err;
      }
      const backoff = 500 * attempt + Math.random() * 300;
      console.log(`STATE: retrying in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
}

/* ===== DOM + Network idle watcher =====
   Waits until DOM mutations and network activity are both idle for short windows.
*/
async function waitForDomAndNetworkIdle(page, {
  domIdleMs = 800,
  networkIdleMs = 800,
  maxWait = 12000
} = {}) {
  const start = Date.now();
  let inflight = 0;
  let lastNetworkActivity = Date.now();

  const onRequest = () => { inflight++; lastNetworkActivity = Date.now(); };
  const onRequestFinished = () => { inflight = Math.max(0, inflight - 1); lastNetworkActivity = Date.now(); };

  page.on('request', onRequest);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFinished);

  // set up a MutationObserver in page context to update window.__lastDomChange
  await page.evaluate(() => {
    window.__lastDomChange = Date.now();
    if (window.__domObserver) window.__domObserver.disconnect();
    window.__domObserver = new MutationObserver(() => { window.__lastDomChange = Date.now(); });
    window.__domObserver.observe(document, { childList: true, subtree: true });
  });

  try {
    while (Date.now() - start < maxWait) {
      const pageLastDom = await page.evaluate(() => window.__lastDomChange).catch(() => Date.now());
      const domIdle = (Date.now() - pageLastDom) >= domIdleMs;
      const networkIdle = (Date.now() - lastNetworkActivity) >= networkIdleMs && inflight === 0;

      if (domIdle && networkIdle) {
        await page.waitForTimeout(150);
        return true;
      }
      await page.waitForTimeout(150);
    }
    return false;
  } finally {
    page.removeListener('request', onRequest);
    page.removeListener('requestfinished', onRequestFinished);
    page.removeListener('requestfailed', onRequestFinished);
    await page.evaluate(() => { try { if (window.__domObserver) { window.__domObserver.disconnect(); window.__domObserver = null; } } catch(e){} });
  }
}

/* ===== Scroll-to-last-card and click load-more if present ===== */
async function expandResults(page, cardSelector) {
  // scroll to last visible card to trigger lazy load
  try {
    const lastCard = await page.$(`${cardSelector}:last-of-type`);
    if (lastCard) {
      await lastCard.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    } else {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(300);
    }
  } catch (e) {}

  // try common "load more" controls
  const loadMoreSelectors = [
    'button:has-text("Show more")',
    'button:has-text("Load more")',
    'a:has-text("Show more")',
    'a:has-text("Load more")',
    'button[aria-label*="Show more"]',
    'button[aria-label*="Load more"]'
  ];
  for (const sel of loadMoreSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log('STATE: clicking load-more button', sel);
        await Promise.all([
          page.waitForResponse(r => r.status() === 200, { timeout: 5000 }).catch(()=>null),
          btn.click().catch(()=>null)
        ]);
        await page.waitForTimeout(300);
        break;
      }
    } catch (e) {}
  }
}

/* ===== Initial continuous scroll helper =====
   Scrolls down repeatedly for a fixed duration (ms) to force initial lazy-loading.
*/
async function continuousScroll(page, durationMs = 10000, step = 800, interval = 200) {
  const start = Date.now();
  console.log(`STATE: starting continuous scroll for ${Math.round(durationMs/1000)}s`);
  while (Date.now() - start < durationMs) {
    await page.evaluate((s) => window.scrollBy(0, s), step).catch(()=>null);
    await page.waitForTimeout(interval);
  }
  // small pause and return to top for stable extraction
  await page.waitForTimeout(300);
  console.log("STATE: continuous scroll complete");
}

/* ===== Main ===== */
async function run() {
  console.log(`STATE: starting scraper (target ${MAX_PROPERTIES} unique properties)`);
  const launchOptions = { headless: !HEADFUL, args: ["--no-sandbox", "--disable-setuid-sandbox"] };
  if (HEADFUL) launchOptions.slowMo = Number(process.env.SLOWMO || 60);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });
  await context.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  globalThis._debugPage = page;

  // priceMap: hotelId or href -> price string (populated from network JSON)
  const priceMap = new Map();

  // capture JSON responses that may contain price info
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("booking.com")) return;
      const headers = response.headers();
      const ct = headers["content-type"] || headers["Content-Type"] || "";
      if (!ct.includes("application/json")) return;
      const text = await response.text().catch(() => null);
      if (!text) return;
      if (!text.includes('"price"') && !text.includes('"min_price"') && !text.includes('"offers"')) return;
      let obj;
      try { obj = JSON.parse(text); } catch (e) { return; }
      const lists = obj.results || obj.result || obj.properties || obj.hotels || obj.items;
      if (Array.isArray(lists)) {
        for (const it of lists) {
          const id = it.hotel_id || it.id || it.property_id || it.hotelId || it.hotel_id_raw;
          const href = it.url || it.hotel_url || it.link;
          const price = it.price || it.min_price || it.price_with_currency || (it.offers && it.offers[0] && it.offers[0].price);
          if (id && price) priceMap.set(String(id), String(price));
          if (href && price) priceMap.set(String(href), String(price));
        }
      } else {
        if (obj.offers && Array.isArray(obj.offers)) {
          for (const o of obj.offers) {
            if (o.price && o.url) priceMap.set(String(o.url), String(o.price));
          }
        }
      }
    } catch (e) {}
  });

  console.log("STATE: opening Booking homepage");
  await page.goto("https://www.booking.com/", { waitUntil: "domcontentloaded" }).catch(()=>null);
  try {
    const accept = page.locator('button:has-text("Accept")');
    if (await accept.isVisible({ timeout: 3000 })) {
      await accept.click();
      console.log("STATE: accepted cookies");
    }
  } catch (e) {}

  // outputs and checkpoint
  const outStream = fs.createWriteStream("mesa_prices.jsonl", { flags: "a" });
  const checkpointFile = "checkpoint.json";
  let checkpoint = { collected: 0, scrollPosition: 0 };
  if (fs.existsSync(checkpointFile) && !IGNORE_CHECKPOINT) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      console.log("STATE: resuming from checkpoint", checkpoint);
    } catch (e) {
      console.log("STATE: failed to read checkpoint — starting fresh");
      checkpoint = { collected: 0, scrollPosition: 0 };
    }
  } else if (IGNORE_CHECKPOINT && fs.existsSync(checkpointFile)) {
    console.log("STATE: IGNORE_CHECKPOINT set — ignoring existing checkpoint");
    checkpoint = { collected: 0, scrollPosition: 0 };
  } else {
    console.log("STATE: starting fresh (no checkpoint)");
  }

  // ensure collected is defined before loop
  let collected = checkpoint && typeof checkpoint.collected === "number" ? checkpoint.collected : 0;
  const results = [];
  const seenKeys = new Set();

  // worker pool for fallback navigation (used by fallbackFetchPrice)
  const workers = [];
  const workerCount = Math.max(1, Math.min(CONCURRENCY, 6));
  for (let i = 0; i < workerCount; i++) {
    const wpage = await context.newPage();
    wpage.setDefaultNavigationTimeout(45000);
    workers.push({ page: wpage, id: i });
  }
  let nextWorker = 0;

  // fallbackFetchPrice uses worker pages to open property pages and extract price
  async function fallbackFetchPrice(href) {
    const w = workers[nextWorker];
    nextWorker = (nextWorker + 1) % workers.length;
    try {
      console.log(`STATE: fallback fetch price -> ${href}`);
      await safeNavigate(w.page, href, { retries: 2, timeout: 20000 }).catch(()=>null);
      const selectors = [
        '.bui-price-display__value',
        '.hp__hotel-price .prco-valign-middle-helper',
        '.hprt-price-price-standard',
        '.prco-inline-block-maker-helper',
        '.roomstable .price'
      ];
      for (const s of selectors) {
        try {
          const el = await w.page.waitForSelector(s, { timeout: 3000 });
          if (el) {
            const txt = (await el.innerText()).trim();
            if (txt) {
              console.log("STATE: fallback price found via selector");
              return txt;
            }
          }
        } catch (e) {}
      }
      try {
        const jsonld = await w.page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.innerText));
        for (const j of jsonld) {
          try {
            const obj = JSON.parse(j);
            if (obj && obj.offers && obj.offers.price) {
              console.log("STATE: fallback price found via JSON-LD");
              return `${obj.offers.price} ${obj.offers.priceCurrency || ""}`;
            }
          } catch (e) {}
        }
      } catch (e) {}
      console.log("STATE: fallback price not found");
      return null;
    } catch (e) {
      console.warn("STATE: fallback fetch error", e.message);
      return null;
    }
  }

  // selectors to find property cards
  const resultsSelectors = [
    '[data-testid="property-card"]',
    '.sr_property_block',
    '.sr_item',
    '.sr_item_content'
  ];
  let chosenSelector = null;

  // Navigate to search results page (no offset)
  const CHECKIN = isoDateString(new Date());
  const CHECKOUT = isoDateString(addDays(new Date(), 1));
  const searchUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(CITY)}&checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=2`;
  await safeNavigate(page, searchUrl, { retries: 3, timeout: 30000 }).catch(()=>null);

  // accept cookies again if needed
  try {
    const accept = page.locator('button:has-text("Accept")');
    if (await accept.isVisible({ timeout: 2000 })) {
      await accept.click();
    }
  } catch (e) {}

  console.log("STATE: beginning initial continuous scroll (10s) to force lazy-loading");
  // initial continuous scroll for 10 seconds as requested
  await continuousScroll(page, 10000, 900, 180);

  // find a working card selector
  for (const sel of resultsSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      chosenSelector = sel;
      break;
    } catch (e) {}
  }
  if (!chosenSelector) {
    console.warn("STATE: no property card selector matched after initial scroll; aborting.");
    for (const w of workers) try { await w.page.close(); } catch (e) {}
    await browser.close();
    process.exit(1);
  }
  console.log(`STATE: using card selector: ${chosenSelector}`);

  console.log("STATE: beginning controlled scroll passes (post-initial-scroll)");
  // Scroll passes until we collect enough unique properties or reach safety caps
  let totalScrollPasses = 0;
  while (collected < MAX_PROPERTIES && totalScrollPasses < MAX_SCROLL_PASSES) {
    totalScrollPasses++;
    console.log(`STATE: scroll pass ${totalScrollPasses} (collected ${collected}/${MAX_PROPERTIES})`);

    // expand results (scroll to last card and click load-more if present)
    await expandResults(page, chosenSelector);

    // wait for DOM + network to settle
    const settled = await waitForDomAndNetworkIdle(page, { domIdleMs: 900, networkIdleMs: 900, maxWait: 12000 });
    if (!settled) {
      console.log('STATE: page did not settle within timeout; continuing to next pass');
    }

    // re-evaluate visible cards and process them
    const cards = await page.$$(chosenSelector);
    console.log(`STATE: found ${cards.length} visible cards after pass ${totalScrollPasses}`);

    // parse cards in chunks
    for (let i = 0; i < cards.length && collected < MAX_PROPERTIES; i += CONCURRENCY) {
      const chunk = cards.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (card) => {
        const info = await card.evaluate((c) => {
          const nameSel = ['[data-testid="title"]', '.sr-hotel__name', '.fcab3ed991', 'h3, h2'];
          const priceSel = ['[data-testid="price-and-discounted-price"]', '.bui-price-display__value', '.prco-inline-block-maker-helper', '.price, .price_total, .sr_price', '.fcab3ed991'];
          let name = "Unknown";
          for (const s of nameSel) {
            const el = c.querySelector(s);
            if (el && el.innerText.trim()) { name = el.innerText.trim(); break; }
          }
          let price = null;
          for (const s of priceSel) {
            const el = c.querySelector(s);
            if (el && el.innerText.trim()) { price = el.innerText.trim(); break; }
          }
          const linkEl = c.querySelector('a[href*="/hotel/"], a[href*="booking.com/"]');
          const href = linkEl ? linkEl.href : null;
          const hotelId = c.getAttribute && (c.getAttribute('data-hotelid') || c.getAttribute('data-hotel-id') || (c.dataset && c.dataset.hotelId));
          return { name, price, href, hotelId };
        });

        // build dedupe key
        const keyCandidates = [];
        if (info.hotelId) keyCandidates.push(String(info.hotelId));
        if (info.href) keyCandidates.push(String(info.href));
        if (info.name) keyCandidates.push(normalizeName(info.name));
        const key = keyCandidates.find(k => k && k.length > 0) || null;
        if (!key) return;

        if (seenKeys.has(key)) return;

        // resolve price: network map -> card -> fallback
        let price = null;
        if (info.hotelId && priceMap.has(String(info.hotelId))) price = priceMap.get(String(info.hotelId));
        if (!price && info.href && priceMap.has(String(info.href))) price = priceMap.get(String(info.href));
        if (!price && info.price && info.price !== "N/A") price = info.price;
        if (!price && info.href) {
          price = await fallbackFetchPrice(info.href);
        }

        // record unique
        seenKeys.add(key);
        const out = {
          index: results.length + 1,
          name: info.name,
          price: price || "N/A",
          source: price ? "network" : (info.price ? "card" : (info.href ? "property" : "no-link")),
          href: info.href || null,
          dedupeKey: key
        };

        outStream.write(JSON.stringify(out) + "\n");
        results.push(out);
        collected++;
        console.log(`STATE: recorded unique property #${out.index} (${out.name})`);
      }));
      await sleep(30 + Math.random() * 120);
    }

    // checkpoint: save collected count and current scroll position
    const scrollY = await page.evaluate(() => window.scrollY).catch(()=>0);
    fs.writeFileSync(checkpointFile, JSON.stringify({ collected, scrollPosition: scrollY }, null, 2));
    console.log(`STATE: checkpoint saved (collected=${collected}, scrollY=${scrollY})`);

    // small delay before next scroll pass
    await sleep(300 + Math.random() * 400);
  } // end scroll loop

  // close worker pages
  for (const w of workers) {
    try { await w.page.close(); } catch (e) {}
  }

  outStream.end();
  fs.writeFileSync(checkpointFile, JSON.stringify({ collected, scrollPosition: await page.evaluate(() => window.scrollY).catch(()=>0) }, null, 2));
  console.log("STATE: fetch phase complete");

  // presentation phase
  results.sort((a, b) => a.index - b.index);
  console.log("\n=== Scraped Properties (unique) ===\n");
  for (const r of results) {
    console.log(`${r.index}. ${r.name} — ${r.price} — source: ${r.source}`);
  }

  const numericPrices = results
    .map(r => ({ ...r, numeric: parsePriceToNumber(r.price) }))
    .filter(r => typeof r.numeric === "number" && !Number.isNaN(r.numeric));
  const numbers = numericPrices.map(r => r.numeric);
  const stats = computeStats(numbers);

  if (stats) {
    console.log("\n=== Statistics ===");
    console.log(`Count: ${stats.count}  Sum: $${Math.round(stats.sum)}  Average: $${Math.round(stats.average*100)/100}  Median: $${Math.round(stats.median*100)/100}  Min: $${stats.min}  Max: $${stats.max}`);
    console.log(`Below average: ${stats.below}  Above average: ${stats.above}`);
  } else {
    console.log("\nNo numeric prices found to compute statistics.");
  }

  fs.writeFileSync("mesa_prices_summary.json", JSON.stringify({
    city: CITY,
    checkin: isoDateString(new Date()),
    checkout: isoDateString(addDays(new Date(), 1)),
    collected,
    stats: stats ? {
      count: stats.count,
      sum: Math.round(stats.sum),
      average: Math.round(stats.average*100)/100,
      median: Math.round(stats.median*100)/100,
      min: stats.min,
      max: stats.max,
      below: stats.below,
      above: stats.above
    } : null
  }, null, 2));
  console.log("\nSTATE: saved mesa_prices_summary.json and mesa_prices.jsonl");

  if (KEEP_OPEN || HEADFUL) {
    console.log("STATE: KEEP_OPEN or HEADFUL set — leaving browser open for inspection.");
    return browser;
  }

  await browser.close();
  console.log("STATE: scraper finished");
  return null;
}

run().catch(err => {
  console.error("STATE: fatal error:", err && err.stack ? err.stack : err);
  process.exit(1);
});
