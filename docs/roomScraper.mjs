// roomScraper.mjs
import { chromium } from "playwright";
import readline from "readline";

// ── ANSI ──────────────────────────────────────────────────────────────────────
var A = {
  reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m",
  red:"\x1b[31m",  green:"\x1b[32m", yellow:"\x1b[33m",
  blue:"\x1b[34m", cyan:"\x1b[36m",  white:"\x1b[37m", gray:"\x1b[90m"
};
function col(txt, code) { return code + txt + A.reset; }
function bld(txt)       { return A.bold + txt + A.reset; }
function dim(txt)       { return A.dim  + txt + A.reset; }
function repeat(ch, n)  { var s = ""; for (var i = 0; i < n; i++) s += ch; return s; }

// ── Spinner ───────────────────────────────────────────────────────────────────
var FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
var _si = 0, _st = null;
function spinStart(lbl) {
  if (_st) return;
  _st = setInterval(function() {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(col(FRAMES[_si++ % FRAMES.length], A.cyan) + " " + lbl);
  }, 80);
}
function spinStop() {
  if (!_st) return;
  clearInterval(_st); _st = null;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}

// ── Config ────────────────────────────────────────────────────────────────────
var MAX_PROPS   = Number(process.env.MAX_PROPERTIES || 500);
var CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));
var CITY        = process.env.CITY || "Phoenix, Arizona";
var KEEP_OPEN   = !!process.env.KEEP_OPEN;
var HEADFUL     = !!process.env.HEADFUL;
var SLOWMO      = Number(process.env.SLOWMO || 60);
var PAGE_SIZE   = Number(process.env.PAGE_SIZE || 25);

// ── Pure helpers ──────────────────────────────────────────────────────────────
function sleep(ms)    { return new Promise(function(r){ setTimeout(r, ms); }); }
function isoDate(d)   { return d.toISOString().slice(0, 10); }
function addDays(d,n) { var x = new Date(d); x.setDate(x.getDate()+n); return x; }
function normName(s) {
  return (s||"").toLowerCase().replace(/\s+/g," ").replace(/[^\w\s-]/g,"").trim();
}

function parsePrice(raw) {
  if (!raw) return null;
  var s = raw.replace(/[^0-9.,]/g,"").trim();
  if (!s) return null;
  var hasC = s.indexOf(",") !== -1;
  var hasD = s.indexOf(".") !== -1;
  if (hasC && hasD) {
    return s.lastIndexOf(",") > s.lastIndexOf(".")
      ? Number(s.replace(/\./g,"").replace(",","."))
      : Number(s.replace(/,/g,""));
  }
  if (hasC) {
    var p = s.split(",");
    return (p.length === 2 && p[1].length === 2)
      ? Number(s.replace(",","."))
      : Number(s.replace(/,/g,""));
  }
  if (hasD) {
    var p2 = s.split(".");
    return (p2.length === 2 && p2[1].length === 2)
      ? Number(s)
      : Number(s.replace(/\./g,""));
  }
  return Number(s);
}

function calcStats(nums) {
  var n = nums.length;
  if (!n) return null;
  var sum = nums.reduce(function(a,b){ return a+b; }, 0);
  var avg = sum / n;
  var sorted = nums.slice().sort(function(a,b){ return a-b; });
  var med = n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2;
  return {
    count: n, sum: sum, avg: avg, med: med,
    min: sorted[0], max: sorted[n-1],
    below: nums.filter(function(x){ return x < avg; }).length,
    above: nums.filter(function(x){ return x > avg; }).length
  };
}

// ── Cookie consent ────────────────────────────────────────────────────────────
async function acceptCookies(page) {
  try {
    var btn = page.locator("button:has-text(\"Accept\")");
    if (await btn.isVisible({ timeout: 2500 })) {
      await btn.click();
      console.log("STATE: accepted cookies");
    }
  } catch(e) {}
}

// ── Safe navigation ───────────────────────────────────────────────────────────
async function nav(page, url, opts) {
  var retries = (opts && opts.retries) || 3;
  var timeout = (opts && opts.timeout) || 30000;
  for (var i = 1; i <= retries; i++) {
    try {
      console.log(col("STATE: navigating (attempt " + i + ") -> " + url, A.gray));
      var res = await page.goto(url, { waitUntil:"networkidle", timeout: timeout * i });
      console.log(col("STATE: navigation response " + (res ? res.status() : "?"), A.gray));
      return res;
    } catch(err) {
      console.warn(col("STATE: attempt " + i + " failed: " + err.message, A.yellow));
      if (i === retries) throw err;
      var wait = 500 * i + Math.random() * 300;
      console.log(col("STATE: retrying in " + Math.round(wait) + "ms", A.dim));
      await sleep(wait);
    }
  }
}

// ── DOM + network idle ────────────────────────────────────────────────────────
async function waitIdle(page, opts) {
  var domMs = (opts && opts.domMs) || 800;
  var netMs = (opts && opts.netMs) || 800;
  var maxMs = (opts && opts.maxMs) || 12000;
  var t0 = Date.now(), inflight = 0, lastNet = Date.now();
  function onReq()  { inflight++; lastNet = Date.now(); }
  function onDone() { inflight = Math.max(0, inflight-1); lastNet = Date.now(); }
  page.on("request",         onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed",   onDone);
  await page.evaluate(function() {
    window.__ldc = Date.now();
    if (window.__mobs) window.__mobs.disconnect();
    window.__mobs = new MutationObserver(function(){ window.__ldc = Date.now(); });
    window.__mobs.observe(document, { childList:true, subtree:true });
  });
  try {
    while (Date.now()-t0 < maxMs) {
      var ldc = await page.evaluate(function(){ return window.__ldc; }).catch(function(){ return Date.now(); });
      if ((Date.now()-ldc) >= domMs && (Date.now()-lastNet) >= netMs && inflight === 0) {
        await page.waitForTimeout(150);
        return true;
      }
      await page.waitForTimeout(150);
    }
    return false;
  } finally {
    page.removeListener("request",         onReq);
    page.removeListener("requestfinished", onDone);
    page.removeListener("requestfailed",   onDone);
    await page.evaluate(function() {
      try { if (window.__mobs) { window.__mobs.disconnect(); window.__mobs = null; } } catch(e) {}
    }).catch(function(){});
  }
}

// ── Continuous scroll ─────────────────────────────────────────────────────────
async function continuousScroll(page, ms, step, tick) {
  ms   = ms   || 10000;
  step = step || 900;
  tick = tick || 180;
  var t0 = Date.now();
  console.log("STATE: continuous scroll starting (" + Math.round(ms/1000) + "s)");
  spinStart(col("scrolling...", A.cyan));
  while (Date.now()-t0 < ms) {
    await page.evaluate(function(s){ window.scrollBy(0,s); }, step).catch(function(){});
    await page.waitForTimeout(tick);
  }
  spinStop();
  await page.waitForTimeout(300);
  await page.evaluate(function(){ window.scrollTo(0,0); }).catch(function(){});
  console.log("STATE: continuous scroll done — reset to top");
}

// ── Scroll page + click load-more ─────────────────────────────────────────────
async function scrollPage(page) {
  for (var i = 0; i < 5; i++) {
    await page.evaluate(function(){ window.scrollBy(0, window.innerHeight * 1.5); });
    await page.waitForTimeout(350);
  }
  var btns = [
    "button:has-text(\"Show more\")", "button:has-text(\"Load more\")",
    "a:has-text(\"Show more\")",      "a:has-text(\"Load more\")"
  ];
  for (var j = 0; j < btns.length; j++) {
    try {
      var btn = await page.$(btns[j]);
      if (btn) {
        console.log(col("STATE: clicking load-more: " + btns[j], A.dim));
        await Promise.all([
          page.waitForResponse(function(r){ return r.status()===200; }, { timeout:5000 }).catch(function(){ return null; }),
          btn.click().catch(function(){ return null; })
        ]);
        await page.waitForTimeout(400);
        break;
      }
    } catch(e) {}
  }
}

// ── Worker pool ───────────────────────────────────────────────────────────────
function Pool(pages) {
  this._free = pages.slice();
  this._q    = [];
}
Pool.prototype.get = function() {
  var self = this;
  return new Promise(function(res) {
    if (self._free.length) res(self._free.shift());
    else self._q.push(res);
  });
};
Pool.prototype.put = function(pg) {
  if (this._q.length) this._q.shift()(pg);
  else this._free.push(pg);
};
Pool.prototype.run = async function(fn) {
  var pg = await this.get();
  try   { return await fn(pg); }
  finally { this.put(pg); }
};
Pool.prototype.closeAll = async function() {
  for (var i = 0; i < this._free.length; i++) {
    await this._free[i].close().catch(function(){});
  }
};

// ── Extract card info ─────────────────────────────────────────────────────────
async function cardInfo(card) {
  try {
    return await card.evaluate(function(el) {
      function pick(root, sels) {
        for (var i = 0; i < sels.length; i++) {
          var n = root.querySelector(sels[i]);
          if (n && n.innerText && n.innerText.trim()) return n.innerText.trim();
        }
        return null;
      }
      var name = pick(el, [
        "[data-testid=\"title\"]", ".sr-hotel__name", ".fcab3ed991", "h3", "h2"
      ]) || "Unknown";
      var price = pick(el, [
        "[data-testid=\"price-and-discounted-price\"]",
        ".bui-price-display__value",
        ".prco-inline-block-maker-helper",
        ".price_total", ".sr_price", ".price"
      ]);
      var linkEl  = el.querySelector("a[href*=\"/hotel/\"],a[href*=\"booking.com/\"]");
      var href    = linkEl ? linkEl.href : null;
      var hotelId = el.getAttribute("data-hotelid")
                 || el.getAttribute("data-hotel-id")
                 || (el.dataset && el.dataset.hotelId)
                 || null;
      return { name:name, price:price, href:href, hotelId:hotelId };
    });
  } catch(e) { return null; }
}

// ── Fallback price ────────────────────────────────────────────────────────────
function makeFallback(pool) {
  return async function fallback(href) {
    return pool.run(async function(pg) {
      try {
        console.log("STATE: fallback fetch -> " + href);
        await nav(pg, href, { retries:2, timeout:20000 }).catch(function(){});
        var doms = [
          ".bui-price-display__value",
          ".hp__hotel-price .prco-valign-middle-helper",
          ".hprt-price-price-standard",
          ".prco-inline-block-maker-helper",
          ".roomstable .price"
        ];
        for (var i = 0; i < doms.length; i++) {
          try {
            var el  = await pg.waitForSelector(doms[i], { timeout:3000 });
            var txt = (await el.innerText()).trim();
            if (txt) { console.log("STATE: fallback price via selector"); return txt; }
          } catch(e) {}
        }
        var blocks = await pg.$$eval(
          "script[type=\"application/ld+json\"]",
          function(ns){ return ns.map(function(n){ return n.innerText; }); }
        ).catch(function(){ return []; });
        for (var j = 0; j < blocks.length; j++) {
          try {
            var obj = JSON.parse(blocks[j]);
            if (obj && obj.offers && obj.offers.price) {
              return (obj.offers.price + " " + (obj.offers.priceCurrency || "")).trim();
            }
          } catch(e) {}
        }
        return null;
      } catch(e) {
        console.warn("STATE: fallback error: " + e.message);
        return null;
      }
    });
  };
}

// ── Process visible cards ─────────────────────────────────────────────────────
async function processCards(opts) {
  var page      = opts.page;
  var sel       = opts.sel;
  var priceMap  = opts.priceMap;
  var seenKeys  = opts.seenKeys;
  var results   = opts.results;
  var collected = opts.collected;
  var fallback  = opts.fallback;

  var cards = await page.$$(sel);
  console.log("STATE: found " + cards.length + " visible cards");

  for (var i = 0; i < cards.length; i += CONCURRENCY) {
    if (collected >= MAX_PROPS) break;

    var chunk = cards.slice(i, i + CONCURRENCY);
    var batch = await Promise.all(chunk.map(async function(card) {
      if (collected >= MAX_PROPS) return null;
      var info = await cardInfo(card);
      if (!info) return null;

      var keys = [];
      if (info.hotelId) keys.push(String(info.hotelId));
      if (info.href)    keys.push(String(info.href));
      if (info.name)    keys.push(normName(info.name));
      keys = keys.filter(function(k){ return !!k; });

      if (!keys.length) return null;
      for (var ki = 0; ki < keys.length; ki++) {
        if (seenKeys.has(keys[ki])) return null;
      }

      var price = null, src = "not-found";
      if (info.hotelId && priceMap.has(String(info.hotelId))) {
        price = priceMap.get(String(info.hotelId)); src = "network-json";
      } else if (info.href && priceMap.has(String(info.href))) {
        price = priceMap.get(String(info.href)); src = "network-json";
      } else if (info.price && info.price !== "N/A") {
        price = info.price; src = "card-dom";
      } else if (info.href) {
        price = await fallback(info.href);
        src   = price ? "fallback-nav" : "not-found";
      }

      return { keys:keys, info:info, price:price, src:src };
    }));

    for (var bi = 0; bi < batch.length; bi++) {
      var item = batch[bi];
      if (!item || collected >= MAX_PROPS) continue;
      var dup = false;
      for (var ki2 = 0; ki2 < item.keys.length; ki2++) {
        if (seenKeys.has(item.keys[ki2])) { dup = true; break; }
      }
      if (dup) continue;

      for (var ki3 = 0; ki3 < item.keys.length; ki3++) seenKeys.add(item.keys[ki3]);

      var row = {
        index: results.length + 1,
        name:  item.info.name,
        price: item.price || "N/A",
        src:   item.src,
        href:  item.info.href || null,
        key:   item.keys[0]
      };
      results.push(row);
      collected++;
      console.log("STATE: #" + row.index + " " + row.name + " [" + row.src + "]");
    }

    await sleep(30 + Math.random() * 100);
  }
  return collected;
}

// ── Build search URL ──────────────────────────────────────────────────────────
function buildUrl(city, checkin, checkout, offset) {
  return "https://www.booking.com/searchresults.html?" +
    new URLSearchParams({
      ss: city, checkin: checkin, checkout: checkout,
      group_adults: "2", offset: String(offset || 0)
    }).toString();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("STATE: scraper starting — target " + MAX_PROPS + " properties");

  var launchOpts = { headless: !HEADFUL, args:["--no-sandbox","--disable-setuid-sandbox"] };
  if (HEADFUL) launchOpts.slowMo = SLOWMO;

  var browser = await chromium.launch(launchOpts);
  var ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport:  { width:1280, height:900 }
  });
  await ctx.setExtraHTTPHeaders({ "accept-language":"en-US,en;q=0.9" });

  var page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60000);

  // Network price capture
  var priceMap = new Map();
  page.on("response", async function(res) {
    try {
      if (res.url().indexOf("booking.com") === -1) return;
      var ct = res.headers()["content-type"] || "";
      if (ct.indexOf("application/json") === -1) return;
      var txt = await res.text().catch(function(){ return null; });
      if (!txt) return;
      if (txt.indexOf('"price"') === -1 && txt.indexOf('"min_price"') === -1 && txt.indexOf('"offers"') === -1) return;
      var obj; try { obj = JSON.parse(txt); } catch(e) { return; }
      var list = obj.results || obj.result || obj.properties || obj.hotels || obj.items;
      if (Array.isArray(list)) {
        list.forEach(function(it) {
          var id    = it.hotel_id || it.id || it.property_id || it.hotelId;
          var href  = it.url || it.hotel_url || it.link;
          var price = it.price || it.min_price || it.price_with_currency ||
                      (it.offers && it.offers[0] && it.offers[0].price);
          if (id    && price) priceMap.set(String(id),   String(price));
          if (href  && price) priceMap.set(String(href), String(price));
        });
      } else if (Array.isArray(obj.offers)) {
        obj.offers.forEach(function(o) {
          if (o.price && o.url) priceMap.set(String(o.url), String(o.price));
        });
      }
    } catch(e) {}
  });

  // Homepage
  console.log("STATE: opening Booking.com homepage");
  await page.goto("https://www.booking.com/", { waitUntil:"domcontentloaded" }).catch(function(){});
  await acceptCookies(page);

  var collected = 0;
  var offset    = 0;
  var results   = [];
  var seenKeys  = new Set();

  // Worker pool
  var workerPages = [];
  var wCount = Math.min(CONCURRENCY, 6);
  for (var wi = 0; wi < wCount; wi++) {
    var wp = await ctx.newPage();
    wp.setDefaultNavigationTimeout(45000);
    workerPages.push(wp);
  }
  var pool     = new Pool(workerPages);
  var fallback = makeFallback(pool);

  // Card selectors
  var SELECTORS = [
    "[data-testid=\"property-card\"]",
    ".sr_property_block", ".sr_item", ".sr_item_content"
  ];

  var CHECKIN  = isoDate(new Date());
  var CHECKOUT = isoDate(addDays(new Date(), 1));

  // First page
  await nav(page, buildUrl(CITY, CHECKIN, CHECKOUT, offset), { retries:3, timeout:30000 }).catch(function(){});
  await acceptCookies(page);

  console.log("STATE: initial 10s continuous scroll to trigger lazy-loading");
  await continuousScroll(page, 10000, 900, 180);

  var sel = null;
  for (var si = 0; si < SELECTORS.length; si++) {
    try { await page.waitForSelector(SELECTORS[si], { timeout:5000 }); sel = SELECTORS[si]; break; }
    catch(e) {}
  }
  if (!sel) {
    console.error(col("STATE: no card selector found — aborting", A.red));
    await pool.closeAll(); await browser.close(); process.exit(1);
  }
  console.log("STATE: card selector: " + sel);

  // Pagination loop
  var pageNum     = 0;
  var emptyStreak = 0;

  while (collected < MAX_PROPS) {
    pageNum++;
    console.log("STATE: page " + pageNum + " | offset " + offset + " | collected " + collected + "/" + MAX_PROPS);

    if (pageNum > 1) {
      await nav(page, buildUrl(CITY, CHECKIN, CHECKOUT, offset), { retries:3 }).catch(function(){});
      await acceptCookies(page);
      await waitIdle(page);
    }

    await scrollPage(page);
    await waitIdle(page, { domMs:800, netMs:800, maxMs:10000 });

    var before = collected;
    collected = await processCards({
      page:page, sel:sel, priceMap:priceMap, seenKeys:seenKeys,
      results:results, collected:collected, fallback:fallback
    });
    var added = collected - before;

    console.log("STATE: page " + pageNum + " added " + added + " new properties");

    if (added === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) { console.log("STATE: 2 empty pages in a row — stopping"); break; }
    } else {
      emptyStreak = 0;
    }

    offset += PAGE_SIZE;
    await sleep(500 + Math.random() * 500);
  }

  // Teardown
  await pool.closeAll();
  console.log("STATE: fetch complete");

  // ── Display results ───────────────────────────────────────────────────────
  results.sort(function(a,b){ return a.index - b.index; });

  var nums = [];
  for (var ri = 0; ri < results.length; ri++) {
    var n = parsePrice(results[ri].price);
    if (typeof n === "number" && !isNaN(n)) nums.push(n);
  }
  var st   = calcStats(nums);
  var minP = st ? st.min : null;
  var maxP = st ? st.max : null;

  var maxNameLen = 0;
  for (var ri2 = 0; ri2 < results.length; ri2++) {
    if (results[ri2].name.length > maxNameLen) maxNameLen = results[ri2].name.length;
  }
  var divider = col(repeat("\u2500", maxNameLen + 18), A.gray);

  console.log("\n" + bld(col("  Hotel / Motel", A.blue)) + repeat(" ", maxNameLen - 14) + bld(col("| Price / Night", A.blue)));
  console.log(divider);

  for (var ri3 = 0; ri3 < results.length; ri3++) {
    var r    = results[ri3];
    var n2   = parsePrice(r.price);
    var pad  = repeat(" ", maxNameLen - r.name.length + 2);
    var pnum = r.price.replace(/[^0-9.]/g, "");
    var raw  = "  " + r.index + ". " + r.name + pad + "| $" + pnum
    var line;
    if (typeof n2 === "number" && !isNaN(n2)) {
      if      (minP !== null && n2 === minP) line = col(bld(raw), A.green);
      else if (maxP !== null && n2 === maxP) line = col(bld(raw), A.red);
      else                                   line = col(raw, A.white);
    } else {
      line = col(raw, A.white);
    }
    console.log(line);
  }

  console.log(divider);

  if (st) {
    console.log(col(
      "  Average: \$" + st.avg.toFixed(2) +
      "   Median: \$" + st.med.toFixed(2) +
      "   Min: \$"    + st.min +
      "   Max: \$"    + st.max +
      "   Count: "   + st.count,
      A.cyan
    ));
    console.log(dim("  Legend: ") + col("lowest price", A.green) + dim("   ") + col("highest price", A.red));
  } else {
    console.log(col("  No numeric prices found.", A.yellow));
  }

  if (KEEP_OPEN || HEADFUL) { console.log("STATE: leaving browser open"); return; }
  await browser.close();
  console.log("STATE: done");
}

main().catch(function(err) {
  spinStop();
  console.error("STATE: fatal: " + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
