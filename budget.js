// Mississippi beef cattle budgets: the budget math, shared by the page
// (page.html) and the history runner (tools/budget_history.mjs), so a chart of
// past returns uses exactly the arithmetic the page shows. No DOM work here
// except the tiny $ helper; it runs in a browser or in Node's vm.
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let D = null;            // the price file
const P = {};            // prices in use (live unless the user typed one)
// The state whose auction prices, rent and wage the budgets use, and the USDA-ERS cow-calf
// region for vet, overhead, the pasture rental value and the comparison (stage 3). The page
// sets them; REGION_YEARS holds a region's values by year for past years (null: the price file's own).
let STATE = { code: "ms", name: "Mississippi", agency: "Mississippi Department of Agriculture and Commerce", region: "mississippi_portal" };
let REGION = "mississippi_portal", REGION_YEARS = null;

// ---------- formatting ----------
// a result that isn't a finite number (no cows, no years, all the hay lost) shows a dash, never $NaN or $∞
const DASH = "–";
const usd = (v, d = 0) => !Number.isFinite(v) ? DASH : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 0) => !Number.isFinite(v) ? DASH : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fdate = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const fmonth = s => { const [y, m] = s.split("-").map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
const pdate = p => p.when || fdate(p.date);

// ---------- cattle prices ----------
function slide(cls, wt) {           // the state's auction price, $/cwt, at a weight; NaN when it has none (3G)
  const pts = ((D.cattle.slide || {})[cls] || []).filter(p => p && p[1] != null);
  if (!pts.length) return NaN;
  if (wt <= pts[0][0]) return pts[0][1];
  if (wt >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) if (wt <= pts[i][0]) {
    const [w0, p0] = pts[i - 1], [w1, p1] = pts[i];
    return p0 + (p1 - p0) * (wt - w0) / (w1 - w0);
  }
}
const nowMonth = () => Number(D.cattle.slide_dates[1].slice(5, 7)) - 1;
function seasonAdj(cls, wt, toMonth, fromMonth = nowMonth()) {
  const lo = Math.min(800, Math.max(300, Math.floor(wt / 100) * 100));   // 300-400 ... 800-900 lb classes
  const s = D.cattle.season.series[`${cls} ${lo}-${lo + 100}`];
  if (!s) return 1;
  return s[toMonth].index / s[fromMonth].index;
}

// ---------- forage costs (the Forage costs tab) ----------
// One worksheet per practice, from MSU Extension's 2027 forage budgets. Each line
// can be switched off and its quantity changed; prices are the page's current
// ones. The worksheets are shared by every budget, as Market prices are.
const FORAGE_SYS = ["pasture", "hay", "ryegrass", "overseed"];
const EST_RE = /^Prorated establishment/;
// The overseeded ryegrass sheet (MSU table 30, a full-year budget for the overseeded pasture)
// holds what the ryegrass adds over the permanent pasture (table 11): its soil test (shared
// with table 11) starts off, and phosphate and potash start at table 30's rates less table
// 11's (2.0 - 1.0 and 1.5 - 1.0 cwt). Pending forage specialist review (2C2).
const FORAGE_OFF = { overseed: /^Soil testing/ };
const FORAGE_QTY = { overseed: [[/^Phosphate/, 1.0], [/^Potash/, 0.5]] };
const startQty = (sys, it) => { const q = (FORAGE_QTY[sys] || []).find(([re]) => re.test(it.item)); return q ? q[1] : it.qty; };
const startNote = (sys, it) => (FORAGE_QTY[sys] || []).some(([re]) => re.test(it.item)) ? "added over permanent pasture" : "";
const WS = {};                 // per practice: { off: {line: 1}, on: {line: 1}, qty: {line: n}, est: 0 or 1 }
function wsLines(sys) {
  const S = D.forage.systems[sys];
  return S.direct.map(it => ({ ...it, part: "direct" })).concat(S.fixed.map(it => ({ ...it, part: EST_RE.test(it.item) ? "est" : "fixed" })));
}
const wsFresh = () => ({ off: {}, on: {}, qty: {}, est: 0 });
const ws = sys => WS[sys] || (WS[sys] = wsFresh());
const startsOff = (sys, it) => !!(FORAGE_OFF[sys] && FORAGE_OFF[sys].test(it.item));
const lineOn = (sys, it, i, w = ws(sys)) => it.part === "est" ? !!w.est : startsOff(sys, it) ? !!w.on[i] : !w.off[i];
function wsPrinted(sys) {     // still MSU's printed budget (the starting state)
  const w = ws(sys);
  return !w.est && !Object.keys(w.off).length && !Object.keys(w.on).length && !Object.keys(w.qty).length;
}
function linePrice(it) {
  const live = { urea: () => P.urea / 20, dap: () => P.dap / 20, potash: () => P.potash / 20, diesel: () => P.diesel, wage: () => P.wage };
  if (it.price_key) return { price: live[it.price_key](), how: `${D.month_label} average` };
  if (it.index) return { price: it.price * D.ppi[it.index].ratio, how: "2025 price × BLS index" };
  return { price: it.price, how: "MSU 2025 price" };
}
// how: "build" (the worksheet) or "msu" (MSU's printed budget: every line, establishment included)
function forageAcre(sys, how = "build") {
  const S = D.forage.systems[sys], w = how === "build" ? ws(sys) : null;
  const rows = wsLines(sys).map((it, i) => {
    const on = w ? lineOn(sys, it, i, w) : true, p = linePrice(it);
    const qty = on ? (w ? (i in w.qty ? w.qty[i] : startQty(sys, it)) : it.qty) : 0;
    return { i, item: it.item, unit: it.unit, part: it.part, printed: it.qty, start: startQty(sys, it), note: startNote(sys, it),
             qty, on, price: p.price, how: p.how, cost: qty * p.price };
  });
  const sum = parts => rows.filter(r => parts.includes(r.part)).reduce((t, r) => t + r.cost, 0);
  return { name: S.name, table: S.table, rows, direct: rows.filter(r => r.part === "direct"), fixed: rows.filter(r => r.part !== "direct"),
           d: sum(["direct"]), f: sum(["fixed", "est"]), est: sum(["est"]) };
}
// A budget's cost per acre for one forage: the worksheet, MSU's printed budget, or the
// user's own number (an operating cost, held at that number in past years).
const FC_OPTS = [["build", "Build it from what I do (Forage costs tab)"], ["msu", "MSU budget as printed"], ["own", "My own number ($/acre)"]];
// Cow-calf's permanent pasture starts at USDA-ERS grazed feed, "the rental value of pasture"
// (ERR-321): a flat amount per cow that replaces both pasture upkeep and pasture rent (2A).
const FC_ERS = ["ers", "Pasture at its rental value (USDA-ERS regional average), $ per cow"];
function acreCost(v, role, sys) {
  const how = v["fc" + role] || "build";
  if (how === "ers") return { d: 0, f: 0, how, name: FNAME[sys] };
  if (how === "own") { const x = v["fu" + role]; return { d: x, f: 0, how, name: FNAME[sys] }; }
  return { ...forageAcre(sys, how), how };
}
const acreNote = a => a.how === "own" ? "Your number per acre" : a.how === "msu" ? `MSU 2027 budget as printed, ${D.month_label} average prices` : `Forage costs tab, ${D.month_label} average prices`;
const ersYear = () => D.prices.grazed_feed ? D.prices.grazed_feed.when : "";
function fcSrc(v, role, sys) {
  const a = acreCost(v, role, sys);
  if (a.how === "ers") return `USDA-ERS grazed feed, the rental value of pasture: ${usd(P.grazed_feed, 2)} per cow, ${ersYear()}. It replaces pasture upkeep and pasture rent.`;
  if (a.how === "own") return "Counted as an operating cost; past years hold it at this number";
  return `${usd(a.d, 2)}/acre to run, ${usd(a.f, 2)}/acre machinery${a.est ? " and establishment" : ""}. <a href="#forage">Forage costs tab</a>`;
}
// The three permanent pasture questions in Simple view write to the shared worksheet.
const wsIdx = (sys, re) => wsLines(sys).findIndex(it => re.test(it.item));
const N_PER_CWT = 46;                         // lb of nitrogen in a hundredweight of urea (46-0-0)
function wsN() { const i = wsIdx("pasture", /^Nitrogen/), it = wsLines("pasture")[i], w = ws("pasture"); return lineOn("pasture", it, i) ? (i in w.qty ? w.qty[i] : it.qty) * N_PER_CWT : 0; }
function setWsN(lb) {
  if (Math.abs(lb - wsN()) < 0.5) return;       // the rounded number already shown (98 for 98.44 lb) changes nothing (2C4)
  const i = wsIdx("pasture", /^Nitrogen/), w = ws("pasture"); delete w.off[i]; w.qty[i] = Math.max(0, lb) / N_PER_CWT;
}
const PK_RE = /^(Phosphate|Potash)/, WEED_RE = /^(GrazonNext|Surfactant)/;
function wsHas(re) { const L = wsLines("pasture"); return L.some((it, i) => re.test(it.item) && lineOn("pasture", it, i)); }
function wsSet(re, on) { const w = ws("pasture"); wsLines("pasture").forEach((it, i) => { if (re.test(it.item)) { if (on) delete w.off[i]; else w.off[i] = 1; } }); }
// no nitrogen, phosphate or potash: no fertilizer to spread, so the truck spreading goes too (2C3)
const SPREAD_RE = /^Custom spread \(truck\)/;
function spreadRule() { wsSet(SPREAD_RE, !(wsN() === 0 && !wsHas(PK_RE))); }

// ---------- input forms ----------
// A field: [id, label, unit, default, opts]. default may be a function of the
// current values (v) so it follows the market until the user types a number.
const HAY_LABEL = "Hay price (market report; add delivery)";
// The cost-per-acre choice for one forage in a budget, and the user's own number.
function forageFields(role, name, sysOf, show = () => true, ers = false) {
  return [
    ["fc" + role, `${name} cost`, "", ers ? "ers" : "build", { wide: true, html: true, show, select: ers ? [FC_ERS, ...FC_OPTS] : FC_OPTS, src: v => fcSrc(v, role, sysOf(v)) }],
    ["fu" + role, `${name}, your cost`, "$/acre", v => { const a = forageAcre(sysOf(v)); return Math.round((a.d + a.f) * 100) / 100; },
      { step: 1, show: v => show(v) && v["fc" + role] === "own" }],
  ];
}
// The three permanent pasture questions; they write to the Forage costs worksheet.
// Cow-calf asks them in both views once its pasture is built from the worksheet (2B2);
// Stocker asks them in Simple view.
function pastureQuestions(show, simpleOnly = true) {
  return [
    ["wsN", "Nitrogen on permanent pasture", "lb N/acre", () => Math.round(wsN()), { simple: true, simpleOnly, step: 5, show, ws: x => { setWsN(x); spreadRule(); } }],
    ["wsPK", "Phosphate and potash applied to permanent pasture", "", () => wsHas(PK_RE) ? 1 : 0, { simple: true, simpleOnly, check: true, show, ws: x => { wsSet(PK_RE, !!x); spreadRule(); } }],
    ["wsWeed", "Weeds sprayed on permanent pasture", "", () => wsHas(WEED_RE) ? 1 : 0, { simple: true, simpleOnly, check: true, show, ws: x => wsSet(WEED_RE, !!x) }],
  ];
}
// Cow-calf's pasture line in both views: the regional average and the way to build your own (2B)
function pastureCow(v) {
  const a = acreCost(v, "P", v.psys);
  return v.acres * (a.d + a.f) + (v.chrent ? v.acres * v.rent : 0);
}
// At its rental value (ERS) the permanent pasture's cost is a flat amount per cow: its acres and rent don't
// enter the budget, so those inputs show only once the pasture is built, or rent has other ground to cover.
const ccErs = v => (v.fcP || "ers") === "ers";
const ccRentUsed = v => !ccErs(v) || v.haysrc === "raise" || (v.wacres > 0 && v.wsys === "ryegrass");
function pastureBox(v) {
  const avg = `${usd(P.grazed_feed, 2)} per cow`;
  if ((v.fcP || "ers") === "ers")
    return `Regional average: ${avg} (USDA-ERS, ${ersYear()}). Not your farm. <button type="button" class="btn" data-build-pasture>Build my pasture cost</button>`;
  return `Yours: ${usd(pastureCow(v), 2)} per cow. Regional average: ${usd(P.grazed_feed, 2)}. <a href="#forage">Forage costs tab</a>`;
}
const FEEDS = [["soyhulls", "Soybean hull pellets"], ["cottonseed", "Whole cottonseed"], ["cgf", "Corn gluten feed pellets"], ["corn", "Shelled corn"], ["csm", "Cottonseed meal (41%)"]];
const SYSTEMS = { pasture: "Permanent pasture (bahia, bermuda)", ryegrass: "Ryegrass, no-till", overseed: "Ryegrass overseeded on bermuda/bahia" };

const CC = [
  { g: "Herd", open: true, f: [
    ["cover", "Costs the cattle must cover", "", "all", { show: () => false, select: [["all", "All costs, including fixed"], ["op", "Operating costs only"]] }],   // set by the switch above the results
    ["cows", "Cows", "head", 50, { simple: true, step: 1 }],
    ["bulls", "Bulls", "head", 2, { step: 1 }],
    ["wean", "Calves weaned per cow exposed", "%", 85, { simple: true, step: 1 }],
    ["cull", "Cows culled and sold each year", "%", 12, { step: 1 }],
    ["death", "Cow death loss", "%", 1.5, { step: .5 }],
    ["_repl", "calc", v => `Keeps ${num(v.cows * (v.cull + v.death) / 100, 1)} heifers a year to replace culled and dead cows; sells ${num(Math.max(0, v.cows * v.wean / 200 - v.cows * (v.cull + v.death) / 100), 1)} heifers and ${num(v.cows * v.wean / 200, 1)} steers.`, { simple: true }],
  ]},
  { g: "Calf and cull prices", open: true, f: [
    ["swt", "Steer calf sale weight", "lb", 540, { simple: true, step: 10 }],
    ["hwt", "Heifer calf sale weight", "lb", 510, { simple: true, step: 10 }],
    ["month", "Month calves sell", "", 9, { simple: true, select: MONTHS_LONG.map((m, i) => [i, m]) }],   // October: a typical fall sale, so the cash flow year starts in November
    ["season", "Adjust prices for the usual seasonal pattern", "", 1, { check: true }],
    ["sp", "Steer calf price", "$/cwt", v => slide("Steers", v.swt) * (v.season ? seasonAdj("Steers", v.swt, v.month) : 1), { simple: true, step: 1, src: v => calfSrc("Steers", v.swt, v) }],
    ["hp", "Heifer calf price", "$/cwt", v => slide("Heifers", v.hwt) * (v.season ? seasonAdj("Heifers", v.hwt, v.month) : 1), { simple: true, step: 1, src: v => calfSrc("Heifers", v.hwt, v) }],
    ["cgrade", "Cull cow grade", "", () => D.cattle.cows["Boner 80-85%"] ? "Boner 80-85%" : (Object.keys(D.cattle.cows)[0] || ""),
      { select: () => Object.keys(D.cattle.cows).length ? Object.keys(D.cattle.cows).map(k => [k, k]) : [["", "No cull cow price this month"]] }],
    ["cwt_", "Cull cow weight", "lb", v => (D.cattle.cows[v.cgrade] || {}).weight ?? 1200, { step: 10, src: () => { const f = borrowedFrom("cows"); return `Average weight sold at ${f ? andList(f) : STATE.name} auctions`; } }],
    ["cp", "Cull cow price", "$/cwt", v => (D.cattle.cows[v.cgrade] || {}).price ?? NaN, { step: 1,
      src: v => !D.cattle.cows[v.cgrade] ? `No ${STATE.name} cull cow price for ${D.month_label}` : borrowedFrom("cows") ? `${borrowNote(borrowedFrom("cows"))} ${v.cgrade}.` : `${STATE.name} auctions, ${v.cgrade}, ${cattleWeeks()}` }],
    ["byears", "Years each bull is used", "years", 4, { step: 1 }],
    ["bwt", "Cull bull weight", "lb", 1800, { step: 50 }],
    ["bp", "Cull bull price", "$/cwt", () => D.cattle.bulls.price ?? NaN, { step: 1,
      src: () => D.cattle.bulls.price == null ? `No ${STATE.name} slaughter bull price for ${D.month_label}` : borrowedFrom("bulls") ? borrowNote(borrowedFrom("bulls")) : `${STATE.name} auctions, slaughter bulls, ${cattleWeeks()}` }],
  ]},
  { g: "Pasture and hay", open: true, f: [
    ["acres", "Pasture acres per cow", "acres", 2.5, { simple: true, step: .1, show: v => !ccErs(v), src: () => "Includes ground for bulls and replacement heifers" }],
    ["psys", "Pasture", "", "pasture", { wide: true, select: () => [["pasture", SYSTEMS.pasture]] }],
    ["wacres", "Winter annual pasture per cow", "acres", 0, { step: .1 }],
    ["wsys", "Winter annual", "", "overseed", { wide: true, show: v => v.wacres > 0, select: () => [["overseed", SYSTEMS.overseed], ["ryegrass", SYSTEMS.ryegrass]] }],
    ...forageFields("P", "Permanent pasture", v => v.psys, () => true, true),
    ["_pasture", "calc", v => pastureBox(v), { simple: true, html: true }],
    ...pastureQuestions(v => v.fcP === "build", false),
    ...forageFields("W", "Winter annual", v => v.wsys, v => v.wacres > 0),
    ["hayday", "Hay fed per cow per day", "lb", 28, { step: 1 }],
    ["haydays", "Days hay is fed", "days", 110, { simple: true, step: 5 }],
    ["waste", "Hay lost to storage and feeding", "%", 15, { step: 1 }],
    ["haysrc", "Hay", "", "buy", { simple: true, select: [["raise", "Raise my own"], ["buy", "Buy it"]] }],
    ["hyield", "Hay yield", "tons/acre", 3, { step: .25, show: v => v.haysrc === "raise" }],
    ...forageFields("H", "Hay ground", () => "hay", v => v.haysrc === "raise"),
    ["hayp", HAY_LABEL, "$/ton", () => P.hay_market, { simple: true, step: 1, show: v => v.haysrc === "buy", src: () => priceSrc("hay_market") }],
    ["chrent", "Charge rent on pasture and hay ground", "", 1, { simple: true, check: true, show: ccRentUsed }],
    ["rent", "Pasture rent you pay", "$/acre", () => P.rent, { simple: true, step: 1, show: v => ccRentUsed(v) && v.chrent, src: () => priceSrc("rent") }],
  ]},
  { g: "Feed and mineral", f: [
    ["feed", "Supplement", "", "soyhulls", { wide: true, select: () => FEEDS.filter(([k]) => P[k] != null).map(([k, n]) => [k, n]) }],
    ["handling", "Delivery and handling", "$/ton", 40, { step: 5, src: v => feedSrc(v.feed) }],
    ["clb", "Cows: lb per day", "lb", 3, { step: .5 }], ["cdays", "Cows: days fed", "days", 90, { step: 5 }],
    ["hlb", "Replacement heifers: lb per day", "lb", 4, { step: .5 }], ["hdays", "Replacement heifers: days fed", "days", 180, { step: 5 }],
    ["blb", "Bulls: lb per day", "lb", 6, { step: .5 }], ["bdays", "Bulls: days fed", "days", 75, { step: 5 }],
    ["creep", "Creep feed per calf", "lb", 0, { step: 25 }],
    ["minoz", "Mineral per animal per day", "oz", 4, { step: .5 }],
    ["minp", "Mineral price", "$/lb", 0.56, { step: .01, src: () => "Starting guess ($28 a 50-lb bag); no public price series" }],
  ]},
  { g: "Health, labor and other operating", f: [
    ["vet", "Vet and medicine per cow", "$", () => P.vet_cow, { step: 1, src: () => priceSrc("vet_cow") }],
    ["ai", "Breeding costs per cow (AI, semen, tests)", "$", 0, { step: 5 }],
    ["hrs", "Hired labor per cow", "hours", 1.5, { step: .5, src: () => "Labor you pay for. Your own time is what the net return pays for" }],
    ["wage", "Labor rate", "$/hour", () => P.wage, { step: .25, src: () => priceSrc("wage") }],
    ["gal", "Truck and feeding fuel per cow", "gal", 8, { step: 1, src: () => `Diesel at ${usd(P.diesel, 2)}/gal` }],
    ["repairs", "Fence, water, truck and equipment repairs per cow", "$", 45, { step: 5 }],
    ["comm", "Sale commission", "% of sales", 3, { step: .25 }],
    ["haul", "Hauling to the sale", "$/head", 6, { step: 1 }],
    ["imonths", "Months operating money is borrowed", "months", 6, { step: 1 }],
    ["rate", "Interest rate", "%", () => P.op_rate, { step: .05, src: () => rateSrc() }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, chute, fence, water, trailer per cow", "$/year", 125, { step: 5, src: () => "A starting guess. Alabama Extension's cow-calf cost studies report $109 to $277 a cow in depreciation." }],
    ["bullcost", "Price of a replacement bull", "$", 7000, { step: 250 }],
    ["bkeep", "Yearly cost to keep a bull", "$", v => bullKeep(v), { step: 10, src: () => "1.4 times a cow's pasture, hay, supplement, mineral and vet costs. Used by Purchase payoff; already counted in the lines above." }],
    ["ovh", "Overhead, property taxes and insurance per cow", "$", () => P.overhead_cow, { step: 1, src: () => priceSrc("overhead_cow") }],
    ["cowint", "Charge interest on money tied up in cows", "", 0, { check: true }],
    ["cowval", "Value of a bred cow", "$", 3000, { step: 100, show: v => v.cowint }],
  ]},
  { g: "When cash comes and goes", cash: true, f: [   // cash flow timing (Full view); starting guesses
    ["cfstart", "Cash flow year starts", "", "after", { show: () => false, select: () => [["after", "The month after calves sell"]].concat(MONTH_OPTS) }],
    ["tcull", "Cull cows and bulls sell", "", v => v.month, { select: () => MONTH_OPTS }],
    ["tpast", "Pasture fertilizer and spraying paid", "", 3, { select: () => MONTH_OPTS }],
    ["twin", "Winter annual seed and fertilizer paid", "", 8, { select: () => MONTH_OPTS, show: v => v.wacres > 0 }],
    ["thay", "Hay paid for", "", 6, { select: () => MONTH_OPTS, src: () => "When hay is bought or made" }],
    ["tsupp", "Supplement feeding starts", "", 10, { select: () => MONTH_OPTS, src: v => `Spread over the ${num(v.cdays)} days cows are fed` }],
    ["tvet", "Spring vet work", "", 2, { select: () => MONTH_OPTS, src: () => "Half the vet costs then, half at weaning" }],
    ["trent", "Rent paid", "", 0, { select: () => MONTH_OPTS }],
    ["tovh", "Property taxes and insurance paid", "", 11, { select: () => MONTH_OPTS }],
  ]},
];

const ST = [
  { g: "Cattle", open: true, f: [
    ["cover", "Costs the cattle must cover", "", "all", { show: () => false, select: [["all", "All costs, including fixed"], ["op", "Operating costs only"]] }],   // set by the switch above the results
    ["head", "Head bought", "head", 60, { simple: true, step: 1 }],
    ["cls", "Steers or heifers", "", "Steers", { simple: true, select: [["Steers", "Steers"], ["Heifers", "Heifers"]] }],
    ["bmonth", "Month bought", "", 10, { simple: true, select: MONTHS_LONG.map((m, i) => [i, m]) }],   // November: ryegrass is ready; 180 days sells them in May, after the spring growth
    ["season", "Adjust prices for the usual seasonal pattern", "", 1, { check: true }],
    ["w0", "Purchase weight", "lb", 450, { simple: true, step: 10 }],
    ["p0", "Purchase price", "$/cwt", v => slide(v.cls, v.w0) * (v.season ? seasonAdj(v.cls, v.w0, v.bmonth) : 1), { simple: true, step: 1, src: v => calfSrc(v.cls, v.w0, v, v.bmonth) }],
    ["days", "Days owned", "days", 180, { simple: true, step: 5 }],
    ["adg", "Average daily gain", "lb/day", 2, { simple: true, step: .1 }],
    ["sshrink", "Sale shrink", "%", 2, { step: .5, src: () => "Pay weight is the weight on pasture less this shrink" }],
    ["death", "Death loss", "%", 2, { step: .5 }],
    ["_sale", "calc", v => `Sells at ${num(stSaleWt(v))} lb pay weight in ${MONTHS_LONG[(v.bmonth + Math.round(v.days / 30.4)) % 12]}.`, { simple: true }],
    ["p1", "Sale price", "$/cwt", v => { const w1 = stSaleWt(v), m = (v.bmonth + Math.round(v.days / 30.4)) % 12; return slide(v.cls, w1) * (v.season ? seasonAdj(v.cls, w1, m) : 1); },
      { simple: true, step: 1, src: v => calfSrc(v.cls, stSaleWt(v), v, (v.bmonth + Math.round(v.days / 30.4)) % 12) }],
  ]},
  { g: "Grazing, hay and feed", open: true, f: [
    ["sys", "Grazing", "", "ryegrass", { simple: true, wide: true, select: () => [["ryegrass", SYSTEMS.ryegrass], ["overseed", SYSTEMS.overseed], ["pasture", SYSTEMS.pasture], ["custom", "Pay for grazing by the day"]] }],
    ["stock", "Head per acre", "head", 1.5, { simple: true, step: .1, show: v => v.sys !== "custom" }],
    ...forageFields("G", "Grazing", v => v.sys, v => v.sys !== "custom"),
    ...pastureQuestions(v => v.sys === "pasture" && (v.fcG || "build") === "build"),
    ["gday", "Grazing charge", "$/head/day", 0.75, { simple: true, step: .05, show: v => v.sys === "custom" }],
    ["hayt", "Hay per head", "tons", 0.2, { step: .05 }],
    ["hayp", HAY_LABEL, "$/ton", () => P.hay_market, { step: 1, src: () => priceSrc("hay_market") }],
    ["feed", "Supplement", "", "soyhulls", { wide: true, select: () => FEEDS.filter(([k]) => P[k] != null).map(([k, n]) => [k, n]) }],
    ["handling", "Delivery and handling", "$/ton", 40, { step: 5, src: v => feedSrc(v.feed) }],
    ["rlb", "Receiving feed per head per day", "lb", 5, { step: .5, src: () => "The supplement, at its price plus delivery and handling" }],
    ["rdays", "Receiving feed days", "days", 21, { step: 1 }],
    ["slb", "Supplement per head per day", "lb", 1, { step: .5 }],
    ["minoz", "Mineral per head per day", "oz", 3, { step: .5 }],
    ["minp", "Mineral price", "$/lb", 0.56, { step: .01, src: () => "Starting guess; no public price series" }],
    ["chrent", "Charge rent on grazing ground", "", 1, { simple: true, check: true, show: v => v.sys !== "custom" }],
    ["rent", "Pasture rent (charged for the days owned)", "$/acre/year", () => P.rent, { simple: true, step: 1, show: v => v.sys !== "custom" && v.chrent, src: () => priceSrc("rent") }],
  ]},
  { g: "Health, labor and other operating", f: [
    ["vet", "Processing, vaccines and treatment", "$/head", 28, { step: 1, src: () => "A starting guess; enter your own" }],
    ["freight", "Freight in", "$/head", 10, { step: 1 }],
    ["hrs", "Hired labor per head", "hours", 1, { step: .5, src: () => "Labor you pay for. Your own time is what the net return pays for" }],
    ["wage", "Labor rate", "$/hour", () => P.wage, { step: .25, src: () => priceSrc("wage") }],
    ["gal", "Truck and feeding fuel per head", "gal", 3, { step: .5, src: () => `Diesel at ${usd(P.diesel, 2)}/gal` }],
    ["comm", "Sale commission", "% of sales", 3, { step: .25 }],
    ["haul", "Hauling to the sale", "$/head", 6, { step: 1 }],
    ["rate", "Interest rate", "%", () => P.op_rate, { step: .05, src: () => rateSrc() }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, chute, fence, water, trailer", "$/head", 25, { step: 1, src: () => "Depreciation and interest for the time owned; a starting guess" }],
    ["ovh", "Overhead and insurance", "$/head", 10, { step: 1 }],
  ]},
  { g: "When cash comes and goes", cash: true, f: [   // cash flow timing (Full view); starting guesses
    ["tplant", "Pasture planting and fertilizer paid", "", v => (v.bmonth + 11) % 12, { select: () => MONTH_OPTS,
      show: v => v.sys === "ryegrass" || v.sys === "overseed", src: () => "Usually the month before the calves arrive" }],
  ]},
];

// ---------- retained ownership ----------
const MONTH_OPTS = MONTHS_LONG.map((m, i) => [i, m]);
const isBuild = v => v.cogmode === "build";
const RO = [
  { g: "Calves", open: true, f: [
    ["head", "Calves retained", "head", 40, { step: 1 }],
    ["cls", "Steers or heifers", "", "Steers", { select: [["Steers", "Steers"], ["Heifers", "Heifers"]] }],
    ["wmonth", "Month calves are weaned", "", () => typeof CCF !== "undefined" && CCF ? CCF.v.month : 9, { select: MONTH_OPTS, src: () => "Follows the sale month on your Cow-calf budget" }],
    ["season", "Adjust the weaning price for the usual seasonal pattern", "", 1, { check: true }],
    ["ww", "Weaning weight", "lb", v => v.cls === "Steers" ? 550 : 520, { step: 10 }],
    ["wp", "Calf price at weaning", "$/cwt", v => slide(v.cls, v.ww) * (v.season ? seasonAdj(v.cls, v.ww, v.wmonth) : 1), { step: 1, src: v => calfSrc(v.cls, v.ww, v, v.wmonth) }],
    ["comm", "Commission if sold at weaning", "% of sales", 3, { step: .25 }],
    ["haul", "Hauling to the sale at weaning", "$/head", 6, { step: 1 }],
    ["_wean", "calc", v => `Selling at weaning would net ${usd(weanNet(v), 2)} a head after commission, hauling and the $1 checkoff. The budget charges each calf this much.`],
  ]},
  { g: "Feedlot", open: true, f: [
    ["freight", "Trucking to the feedlot", "$/head", 45, { step: 1, src: () => "A starting guess" }],
    ["shrink", "Shrink on the trip", "%", 6, { step: .5 }],
    ["adg", "Average daily gain", "lb/day", v => v.cls === "Steers" ? 3.5 : 3.2, { step: .1 }],
    ["outwt", "Sale weight (pay weight)", "lb", v => v.cls === "Steers" ? 1400 : 1275, { step: 10 }],
    ["death", "Death loss", "%", 2, { step: .25 }],
    ["_dof", "calc", v => { const r = roDates(v); return `On feed at ${num(r.inW)} lb, gains ${num(r.gain)} lb in ${num(r.dof)} days, and sells in ${MONTHS_LONG[r.sm]} ${r.sy}.`; }],
    ["cogmode", "Feedlot costs", "", "build", { wide: true, select: [["build", "Figure them from feed, yardage and health"], ["quote", "Use the feedlot's quoted cost of gain"]] }],
    ["fc", "Feed conversion", "lb feed/lb gain", v => v.cls === "Steers" ? 6.0 : 6.3, { step: .1, show: isBuild, src: () => "Pounds of dry matter per pound of gain" }],
    ["ration", "Ration cost", "$/ton dry", () => cornDM() + 60, { step: 1, show: isBuild, src: () => `Omaha corn ${usd(P.corn_omaha, 2)}/bu (${usd(cornDM())}/ton dry matter) plus $60 for roughage, supplement and the feedlot's markup; a starting guess` }],
    ["yard", "Yardage", "$/head/day", 0.5, { step: .05, show: isBuild, src: () => "A starting guess" }],
    ["fvet", "Processing and health at the feedlot", "$/head", 30, { step: 1, show: isBuild, src: () => "A starting guess" }],
    ["cogq", "Quoted cost of gain", "$/cwt gain", v => buildCog(v), { step: 1, show: v => !isBuild(v), src: () => "Feed, yardage and health per 100 lb of gain; interest is charged below" }],
  ]},
  { g: "Sale price", open: true, f: [
    ["fut", "Live cattle futures for the sale month", "$/cwt", v => roFut(v).settle, { step: .25, src: v => futSrc(v) }],
    ["basis", "Basis (cash minus futures)", "$/cwt", v => D.fed.basis[roDates(v).sm].basis, { step: .25, neg: true, src: v => basisSrc(v) }],
    ["sp", "Expected sale price", "$/cwt", v => v.fut + v.basis, { step: .25, src: () => `Futures plus basis. The 5-area cash price for fed steers averaged ${usd(P.fed_live, 2)}/cwt in ${pdate(D.prices.fed_live)}` }],
    ["lrp", "Price insurance (LRP premium)", "$/head", 0, { step: 1, src: () => "Your share of the premium if you buy Livestock Risk Protection" }],
    ["fees", "Checkoff and sale fees", "$/head", 3, { step: .5, src: () => "$1 beef checkoff plus brand inspection and other fees; a starting guess" }],
  ]},
  { g: "Interest", f: [
    ["rate", "Interest rate", "%", () => P.op_rate, { step: .05, src: () => rateSrc() }],
  ]},
];
const stSaleWt = v => (v.w0 + v.adg * v.days) * (1 - (v.sshrink || 0) / 100);   // pay weight after the sale shrink
const cornDM = () => P.corn_omaha / 56 * 2000 / 0.85;          // $/ton of dry matter (85% dry)
const curYear = () => Number(D.generated.slice(0, 4));
function roDates(v) {
  const inW = v.ww * (1 - v.shrink / 100), gain = Math.max(v.outwt - inW, 0), dof = v.adg > 0 ? gain / v.adg : 0;
  const wy = v.wmonth >= nowMonth() ? curYear() : curYear() + 1;
  const tot = v.wmonth + Math.round(dof / 30.4);
  return { inW, gain, dof, wy, sm: tot % 12, sy: wy + Math.floor(tot / 12) };
}
function roFut(v) {        // first contract in or after the sale month
  const { sm, sy } = roDates(v), F = D.fed.futures;
  const f = F.find(c => c.year > sy || (c.year === sy && c.month >= sm));
  return f ? { ...f, far: false } : { ...F[F.length - 1], far: true };
}
function futSrc(v) {
  const f = roFut(v);
  return `CME ${MONTHS[f.month]} ${f.year} contract, settle ${fdate(f.date)}${f.far ? "; the sale is past the last contract in the data, so this is the farthest one" : ""}`;
}
function basisSrc(v) {
  const m = roDates(v).sm, b = D.fed.basis[m], [y0, y1] = D.fed.basis_years;
  return `${MONTHS_LONG[m]} average, ${y0}–${y1}: 5-area live steer price minus nearby futures (${usd(b.lo, 2)} to ${usd(b.hi, 2)})`;
}
const weanNet = v => v.ww * v.wp / 100 * (1 - v.comm / 100) - v.haul - 1;
function buildCog(v) {
  const r = roDates(v);
  if (!(r.gain > 0)) return 0;
  return v.fc * v.ration / 2000 * 100 + v.yard * r.dof / r.gain * 100 + v.fvet / r.gain * 100;
}

// ---------- freezer beef ----------
const isGrain = v => v.sys === "grain";
const FB = [
  { g: "Cattle", open: true, f: [
    ["cover", "Costs the cattle must cover", "", "all", { show: () => false, select: [["all", "All costs, including fixed"], ["op", "Operating costs only"]] }],   // set by the switch above the results
    ["head", "Head finished", "head", 4, { step: 1 }],
    ["sys", "How they're finished", "", "grain", { wide: true, show: () => false, select: [["grain", "Grain-fed"], ["grass", "Grass-fed"]] }],   // set by the switch above the tiles
    ["cls", "Steers or heifers", "", "Steers", { select: [["Steers", "Steers"], ["Heifers", "Heifers"]] }],
    ["smonth", "Month finishing starts", "", 10, { select: MONTH_OPTS }],   // November: a 650-lb calf finishes on grain around May
    ["season", "Adjust the calf price for the usual seasonal pattern", "", 1, { check: true }],
    ["w0", "Starting weight", "lb", v => isGrain(v) ? 650 : 550, { step: 10 }],
    ["p0", "Calf value at the start", "$/cwt", v => slide(v.cls, v.w0) * (v.season ? seasonAdj(v.cls, v.w0, v.smonth) : 1), { step: 1, src: v => calfSrc(v.cls, v.w0, v, v.smonth) }],
    ["comm", "Commission if sold as calves", "% of sales", 3, { step: .25 }],
    ["haul", "Hauling to the sale", "$/head", 6, { step: 1 }],
    ["_calf", "calc", v => `Selling at the start would net ${usd(fbCalfNet(v), 2)} a head after commission, hauling and the $1 checkoff. The budget charges each calf this much.`],
    ["w1", "Finished live weight", "lb", v => isGrain(v) ? 1250 : 1150, { step: 10 }],
    ["adg", "Average daily gain", "lb/day", v => isGrain(v) ? 2.6 : 1.6, { step: .1 }],
    ["death", "Death loss", "%", 1, { step: .5 }],
    ["_days", "calc", v => { const d = fbDays(v); return `Finishes in ${num(d)} days, in ${MONTHS_LONG[(v.smonth + Math.round(d / 30.4)) % 12]}.`; }],
  ]},
  { g: "Feed and pasture", open: true, f: [
    ["conc", "Grain mix fed", "% of body wt", v => isGrain(v) ? 1.8 : 0, { step: .1, src: () => "Average a day over the feeding period; full feed is about 2 to 2.5%" }],
    ["mcorn", "Mix: shelled corn", "%", 60, { step: 5, show: v => v.conc > 0 }],
    ["msoy", "Mix: soybean hull pellets", "%", 25, { step: 5, show: v => v.conc > 0 }],
    ["mcgf", "Mix: corn gluten feed", "%", 10, { step: 5, show: v => v.conc > 0 }],
    ["mcsm", "Mix: cottonseed meal", "%", 5, { step: 5, show: v => v.conc > 0 }],
    ["handling", "Delivery, mixing and handling", "$/ton", 40, { step: 5, show: v => v.conc > 0 }],
    ["_mix", "calc", v => { if (!(v.conc > 0)) return "No grain fed."; const m = mix(v); return `The mix costs ${usd(m.price + v.handling, 2)}/ton delivered (${m.parts}); about ${num((v.w0 + v.w1) / 2 * v.conc / 100, 1)} lb a head a day.${Math.abs(m.sum - 100) > .01 ? ` The parts add to ${num(m.sum)}%, so they're scaled to 100%.` : ""}`; }],
    ["hayday", "Hay per head per day", "lb", v => isGrain(v) ? 6 : 12, { step: 1, src: () => "As fed, including waste" }],
    ["hayp", HAY_LABEL, "$/ton", () => P.hay_market, { step: 1, src: () => priceSrc("hay_market") }],
    ["pacres", "Permanent pasture per head", "acres", v => isGrain(v) ? 0.5 : 1.5, { step: .1, src: () => "Charged for the days on feed" }],
    ...forageFields("P", "Permanent pasture", () => "pasture", v => v.pacres > 0),
    ["wacres", "Winter annual per head", "acres", v => isGrain(v) ? 0 : 1, { step: .1, src: () => "Charged for one season" }],
    ["wsys", "Winter annual", "", "overseed", { wide: true, select: () => [["overseed", SYSTEMS.overseed], ["ryegrass", SYSTEMS.ryegrass]], show: v => v.wacres > 0 }],
    ...forageFields("W", "Winter annual", v => v.wsys, v => v.wacres > 0),
    ["minoz", "Mineral per head per day", "oz", 3, { step: .5 }],
    ["minp", "Mineral price", "$/lb", 0.56, { step: .01, src: () => "Starting guess; no public price series" }],
  ]},
  { g: "Processing and sale", open: true, f: [
    ["pay", "Who pays the processor", "", "buyer", { wide: true, select: [["buyer", "Buyers pay the processor"], ["you", "I pay and include it in my price"]] }],
    ["dress", "Dressing percentage", "% of live wt", v => isGrain(v) ? 61 : 57, { step: .5, src: () => "Hanging (carcass) weight as a share of live weight" }],
    ["kill", "Harvest (kill) fee", "$/head", 100, { step: 5, src: () => "A starting guess" }],
    ["cw", "Cut, wrap and freeze", "$/lb hanging", 1.1, { step: .05, src: () => "A starting guess" }],
    ["yield", "Packaged beef", "% of hanging", 62, { step: 1, src: () => "What's left after bone, fat, trim and drying during aging; used for buyers' cost per pound" }],
    ["shw", "Sold as wholes", "% of the beef", 10, { step: 5 }],
    ["shh", "Sold as halves", "% of the beef", 60, { step: 5 }],
    ["shq", "Sold as quarters", "% of the beef", 30, { step: 5 }],
    ["_wh", "calc", v => { const s = shares(v); return s.raw === 100 ? "Wholes, halves and quarters add to 100%." : `These add to ${num(s.raw)}%, so each is scaled to its share of 100%.`; }],
    ["ph", "Price, halves", "$/lb hanging", v => fbPrice(v, "half"), { step: .05, src: v => fbPriceSrc(v, "half") }],
    ["pq", "Price, quarters", "$/lb hanging", v => fbPrice(v, "quarter"), { step: .05, src: v => fbPriceSrc(v, "quarter") }],
    ["pw", "Price, wholes", "$/lb hanging", v => fbPrice(v, "whole"), { step: .05, src: v => fbPriceSrc(v, "whole") }],
  ]},
  { g: "Health, labor and other operating", f: [
    ["vet", "Vet and medicine", "$/head", 30, { step: 1, src: () => "A starting guess" }],
    ["hrs", "Hired labor per head", "hours", 0, { step: .5 }],
    ["ownhrs", "Your own hours per head", "hours", 10, { step: .5, src: () => "Not charged; the net return pays for this time" }],
    ["wage", "Labor rate", "$/hour", () => P.wage, { step: .25, src: () => priceSrc("wage") }],
    ["gal", "Truck and feeding fuel per head", "gal", 6, { step: .5, src: () => `Diesel at ${usd(P.diesel, 2)}/gal` }],
    ["haulp", "Hauling to the processor", "$/head", 25, { step: 1, src: () => "A starting guess" }],
    ["mktg", "Advertising, insurance and permits", "$/head", 35, { step: 5, src: () => "A starting guess: website or ads, liability insurance, any permits" }],
    ["rate", "Interest rate", "%", () => P.op_rate, { step: .05, src: () => rateSrc() }],
    ["chrent", "Charge rent on pasture", "", 1, { check: true }],
    ["rent", "Pasture rent", "$/acre/year", () => P.rent, { step: 1, show: v => v.chrent, src: () => priceSrc("rent") }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, feeders, waterers, trailer", "$/head", 25, { step: 1, src: () => "Depreciation and interest for the time owned; a starting guess" }],
    ["ovh", "Overhead", "$/head", 10, { step: 1 }],
  ]},
];
const fbDays = v => v.adg > 0 ? Math.max(v.w1 - v.w0, 0) / v.adg : 0;
// Grain-fed prices are starting guesses; grass-fed start from USDA-AMS's National Grass Fed
// Beef Report (direct to consumer, processing not included) and follow it each quarter.
const FB_GRAIN = { half: 5.00, quarter: 5.50, whole: 4.75 }, FB_GRASS = { half: 6.00, quarter: 6.50, whole: 5.75 };
const fbPrice = (v, k) => (isGrain(v) ? FB_GRAIN[k] : (P["grass_" + k] ?? FB_GRASS[k])) + procAdd(v);
function fbPriceSrc(v, k) {
  const g = D.prices["grass_" + k], proc = v.pay === "you" ? " Processing added." : "";
  if (!isGrain(v)) return g ? `USDA-AMS National Grass Fed Beef Report, ${g.when}, direct to consumer, processing not included.${proc}` : `A starting guess.${proc}`;
  const gh = D.prices.grass_half;
  return `A starting guess.${gh ? ` USDA reports grass-fed halves at ${usd(P.grass_half, 2)} (${gh.when}).` : ""}${proc}`;
}
const fbCalfNet = v => v.w0 * v.p0 / 100 * (1 - v.comm / 100) - v.haul - 1;
const procAdd = v => v.pay === "you" ? v.cw + v.kill / Math.max(v.w1 * v.dress / 100, 1) : 0;
function mix(v) {
  const parts = [["corn", v.mcorn], ["soyhulls", v.msoy], ["cgf", v.mcgf], ["csm", v.mcsm]].filter(([k, s]) => s > 0 && P[k] != null);
  const sum = parts.reduce((t, [, s]) => t + s, 0);
  const price = sum > 0 ? parts.reduce((t, [k, s]) => t + P[k] * s, 0) / sum : 0;
  return { sum, price, parts: parts.map(([k]) => `${FEEDS.find(f => f[0] === k)[1].toLowerCase()} ${usd(P[k])}`).join(", ") };
}
function shares(v) {     // percent of the beef sold as halves, quarters and wholes, scaled to 100
  const h = Math.max(0, v.shh), q = Math.max(0, v.shq), w = Math.max(0, v.shw ?? 0), raw = h + q + w;
  if (raw <= 0) return { h: 100, q: 0, w: 0, raw };
  return { h: h / raw * 100, q: q / raw * 100, w: w / raw * 100, raw };
}

// Market prices shown in each budget's Full view; shared by every budget.
const FERT_FUEL = ["urea", "dap", "potash", "diesel"], FEED_KEYS = ["soyhulls", "cottonseed", "cgf", "corn", "csm"];
CC.push({ g: "Market prices", prices: [...FERT_FUEL, ...FEED_KEYS] });
ST.push({ g: "Market prices", prices: [...FERT_FUEL, ...FEED_KEYS] });
RO.push({ g: "Market prices", prices: ["corn_omaha", "fed_live"] });
FB.push({ g: "Market prices", prices: ["corn", "soyhulls", "cgf", "csm", ...FERT_FUEL, "grass_half", "grass_quarter", "grass_whole", "fed_live", "fed_dressed", "retail_choice"] });
const FNAME = { pasture: "Permanent pasture", hay: "Hay ground", ryegrass: "No-till ryegrass", overseed: "Overseeded ryegrass" };

function cattleWeeks() { return `${D.month_label} average`; }   // the month the page's prices cover
// A price the state has none of for the month is the average of its bordering states (tools/export_budget.py,
// borrow()). borrowedFrom gives the states averaged, or null: what is "Steers", "Heifers", "cows" or "bulls";
// for a class, wt picks the classes the price at that weight is read from.
function borrowedFrom(what, wt) {
  const b = (D.cattle.borrowed || {})[what]; if (!b) return null;
  if (wt != null && b.classes) { const w = Math.min(850, Math.max(350, wt)); if (!b.classes.some(lo => Math.abs(w - (lo + 50)) < 100)) return null; }
  return b.from;
}
const andList = a => a.length < 3 ? a.join(" and ") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
const borrowNote = from => `No ${STATE.name} price for ${D.month_label}; average of ${andList(from)}.`;
function calfSrc(cls, wt, v, month) {
  const m = month == null ? v.month : month;
  if (!Number.isFinite(slide(cls, wt))) return `No ${STATE.name} auction price for ${cls.toLowerCase()} in ${D.month_label}`;   // 3G
  const from = borrowedFrom(cls, wt), adj = v.season && m !== nowMonth() ? seasonAdj(cls, wt, m) : null;
  const pct = a => `${a >= 1 ? "+" : "−"}${num(Math.abs(a - 1) * 100, 1)}% for ${MONTHS_LONG[m]} (5-year seasonal pattern)`;
  if (from) return borrowNote(from) + (adj != null ? ` ${pct(adj)}.` : "");
  let s = `${STATE.name} auctions, ${cls.toLowerCase()} at ${num(wt)} lb: ${usd(slide(cls, wt), 2)}/cwt, ${cattleWeeks()}`;
  if (adj != null) s += `; ${pct(adj)}`;
  if (wt < 350 || wt > 850) s += `. Outside the weights ${STATE.name} auctions report; price held at the nearest class`;
  return s + thinNote(cls, wt);
}
// A class with fewer than 50 head that month is estimated from its neighbors (tools/budget_history.py).
function thinNote(cls, wt) {
  const thin = ((D.cattle.thin || {})[cls] || []).filter(t => Math.abs(wt - (t.lo + 50)) < 100);
  return thin.map(t => `. The ${t.lo}–${t.lo + 100} lb class had ${num(t.head)} head in ${D.month_label}, so its price is estimated from the neighboring classes`).join("");
}
const SHORT = { hay_market: "Alabama hay report", wage: "Mississippi beef cattle ranch wage", rent: "Mississippi average",
  op_rate: "Average new operating loan", cattle_rate: "Average new feeder cattle loan", vet_cow: "Mississippi Portal average, carried forward",
  overhead_cow: "Mississippi Portal average", fed_live: "5-area negotiated cash", fed_dressed: "5-area negotiated cash", corn_omaha: "Omaha",
  urea: "North Carolina and Oklahoma average", dap: "North Carolina and Oklahoma average", potash: "North Carolina and Oklahoma average",
  diesel: "North Carolina and Oklahoma average", soyhulls: "Alabama wholesale", cottonseed: "Alabama wholesale", cgf: "Alabama wholesale",
  csm: "Memphis wholesale", corn: "Mississippi Delta elevator bid", retail_choice: "Grocery average, all cuts",
  grass_half: "National Grass Fed Beef Report", grass_quarter: "National Grass Fed Beef Report", grass_whole: "National Grass Fed Beef Report" };
function priceSrc(k) {
  const p = D.prices[k]; if (!p) return "";
  if (P[k] !== p.value) return "Your price (Market prices, in the Full view)";
  return `${SHORT[k] ? SHORT[k] + ": " : ""}${p.source}, ${pdate(p)}`;
}
const rateSrc = () => P.op_rate !== D.prices.op_rate.value ? priceSrc("op_rate") : `${SHORT.op_rate}, ${D.prices.op_rate.source}, ${pdate(D.prices.op_rate)}. Enter your lender's rate.`;
const feedSrc = k => `${FEEDS.find(f => f[0] === k)[1]} ${usd(P[k], 2)}/ton wholesale (${priceSrc(k)}); add delivery and handling`;

// ---------- state ----------
function makeForm(spec, key) {
  const st = { spec, key, v: {}, typed: {}, mode: null };   // mode: "simple" | "full" where the budget has both
  const all = spec.flatMap(g => g.f || []).filter(f => f[1] !== "calc");
  st.fields = all;
  st.reset = () => { st.typed = {}; st.v = {}; all.forEach(f => st.v[f[0]] = undefined); fill(st); };
  st.reset();
  return st;
}
function fill(st) {      // set every value the user hasn't typed from its default, in order
  st.fields.forEach(([id, , , def]) => {
    if (id in st.typed) { st.v[id] = st.typed[id]; return; }
    st.v[id] = typeof def === "function" ? def(st.v) : def;
  });
}
function withoutTyped(st, id) { const t = { ...st.typed }; delete t[id]; const s = { ...st, typed: t, v: {} }; fill(s); return s.v; }
function roundFor(v, step) {   // whole numbers stay whole; others get the step's decimals (at least 2 for prices)
  if (v == null || isNaN(v)) return "";
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  const d = step && step < 1 ? String(step).split(".")[1].length : 2;
  return String(Number(v.toFixed(d)));
}

// ---------- cow-calf budget ----------
function cowCalf(v) {
  const N = v.cows, B = v.bulls;
  const weaned = N * v.wean / 100, steers = weaned / 2, repl = N * (v.cull + v.death) / 100;
  const heifers = Math.max(0, weaned / 2 - repl), culls = N * v.cull / 100, cbulls = B / v.byears;
  const units = N + 1.4 * B + 0.7 * repl;                 // pasture and hay animal units
  const rows = [], add = (sec, item, qty, unit, price, total, note) => (qty === 0 && total === 0) || rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  add(R, "Steer calves", steers, "head", v.swt * v.sp / 100, steers * v.swt * v.sp / 100, `${num(v.swt)} lb at ${usd(v.sp, 2)}/cwt`);
  add(R, "Heifer calves", heifers, "head", v.hwt * v.hp / 100, heifers * v.hwt * v.hp / 100, `${num(v.hwt)} lb at ${usd(v.hp, 2)}/cwt`);
  add(R, "Cull cows", culls, "head", v.cwt_ * v.cp / 100, culls * v.cwt_ * v.cp / 100, `${num(v.cwt_)} lb at ${usd(v.cp, 2)}/cwt`);
  // Cull bulls aren't income: bull depreciation is already the bull's price less his salvage value.
  // Their sale still pays commission, hauling and the checkoff (Marketing).
  const income = rows.reduce((t, r) => t + r.total, 0), bullSale = cbulls * v.bwt * v.bp / 100, sold = steers + heifers + culls + cbulls;

  const pa = acreCost(v, "P", v.psys), wa = acreCost(v, "W", v.wsys), ha = acreCost(v, "H", "hay");
  const pAcres = N * v.acres, wAcres = N * v.wacres, ers = pa.how === "ers";
  if (ers) add(O, "Pasture, regional average", N, "cows", P.grazed_feed, N * P.grazed_feed,
               `USDA-ERS grazed feed (the rental value of pasture), ${ersYear()}; replaces pasture upkeep and rent`);
  else add(O, "Pasture upkeep", pAcres, "acres", pa.d, pAcres * pa.d, acreNote(pa));
  if (wAcres > 0) add(O, "Winter annual pasture", wAcres, "acres", wa.d, wAcres * wa.d, `${FNAME[v.wsys]}; ${acreNote(wa)}`);
  const tons = units * v.hayday * v.haydays / 2000 / (1 - v.waste / 100);
  let hAcres = 0;
  if (v.haysrc === "raise") {
    hAcres = tons / v.hyield;
    add(O, "Hay, raised", tons, "tons", ha.d / v.hyield, hAcres * ha.d, `${num(hAcres, 1)} acres at ${num(v.hyield, 2)} tons/acre; hay ground: ${acreNote(ha)}`);
  } else add(O, "Hay, bought", tons, "tons", v.hayp, tons * v.hayp);
  const flb = N * v.clb * v.cdays + repl * v.hlb * v.hdays + B * v.blb * v.bdays + weaned * v.creep;
  const fp = P[v.feed] + v.handling;
  add(O, "Supplement", flb / 2000, "tons", fp, flb / 2000 * fp, `${FEEDS.find(f => f[0] === v.feed)[1].toLowerCase()} for cows, replacement heifers, bulls${v.creep ? " and calves" : ""}`);
  const mlb = units * v.minoz / 16 * 365;
  add(O, "Salt and mineral", mlb, "lb", v.minp, mlb * v.minp);
  add(O, "Vet and medicine", N, "cows", v.vet, N * v.vet);
  if (v.ai) add(O, "Breeding", N, "cows", v.ai, N * v.ai);
  add(O, "Labor", N * v.hrs, "hours", v.wage, N * v.hrs * v.wage);
  add(O, "Fuel", N * v.gal, "gal", P.diesel, N * v.gal * P.diesel);
  add(O, "Repairs", N, "cows", v.repairs, N * v.repairs);
  const mkt = (income + bullSale) * v.comm / 100 + sold * (v.haul + 1);
  add(O, "Marketing", sold, "head", mkt / sold, mkt, `${num(v.comm, 2)}% commission, hauling and the $1 beef checkoff, cull bulls included`);
  // overseeded ryegrass grows on the permanent pasture, so it pays no rent of its own; at its
  // rental value (ERS) the permanent pasture's rent is already in its cost (2A2)
  const acresAll = pAcres + wAcres + hAcres, rentAcres = (ers ? 0 : pAcres) + (v.wsys === "ryegrass" ? wAcres : 0) + hAcres;
  if (v.chrent) add(O, "Land rent", rentAcres, "acres", v.rent, rentAcres * v.rent);
  const opBefore = rows.filter(r => r.sec === O).reduce((t, r) => t + r.total, 0);
  const interest = opBefore * v.rate / 100 * v.imonths / 12;
  add(O, "Interest on operating money", opBefore, "$", v.rate, interest, `${num(v.rate, 2)}% for ${num(v.imonths)} months`);
  const op = opBefore + interest;

  const machinery = pAcres * pa.f + wAcres * wa.f + hAcres * ha.f;
  if (machinery) add(F, "Forage machinery and establishment", acresAll, "acres", machinery / Math.max(acresAll, 1e-9), machinery, "Forage costs: machinery carried forward from 2025 by the BLS machinery index");
  add(F, "Facilities and equipment", N, "cows", v.fac, N * v.fac);
  const salvage = v.bwt * v.bp / 100, bdep = B * Math.max(0, v.bullcost - salvage) / v.byears;
  add(F, "Bull depreciation", B, "bulls", bdep / Math.max(B, 1e-9), bdep, `${usd(v.bullcost)} bull, ${usd(salvage)} salvage, ${num(v.byears)} years`);
  add(F, "Overhead, taxes and insurance", N, "cows", v.ovh, N * v.ovh);
  if (v.cowint) add(F, "Interest on cow investment", N, "cows", v.cowval * v.rate / 100, N * v.cowval * v.rate / 100);
  const own = rows.filter(r => r.sec === F).reduce((t, r) => t + r.total, 0);

  const calfLb = steers * v.swt + heifers * v.hwt;
  const other = rows.filter(r => /Cull/.test(r.item)).reduce((t, r) => t + r.total, 0);
  // The commission and the operating interest charged on it move with the calf
  // price; everything else in the costs doesn't.
  const c = v.comm / 100 * (1 + v.rate / 100 * v.imonths / 12);
  const be = cost => calfLb > 0 ? ((cost - income * c) / (1 - c) - other) / calfLb * 100 : NaN;
  return { rows, income, op, own, total: op + own, net: income - op - own, N, calfLb, sold, bullSale, bullBuy: cbulls * v.bullcost,
           beOp: be(op), beAll: be(op + own), per: N, unit: "cow", tons, units };
}
// A4: what a bull costs to keep a year: 1.4 times a cow's pasture, hay, supplement,
// mineral and vet (the budget counts a bull as 1.4 cows); no labor, overhead or facilities.
function bullKeep(v) {
  const r = cowCalf(v);
  return 1.4 * r.rows.filter(x => /^(Pasture upkeep|Pasture, regional average|Winter annual|Hay|Supplement|Salt and mineral|Vet)/.test(x.item)).reduce((t, x) => t + x.total, 0) / r.N;
}

// ---------- stocker budget ----------
function stocker(v) {
  const H = v.head, w1 = stSaleWt(v), sold = H * (1 - v.death / 100);
  const rows = [], add = (sec, item, qty, unit, price, total, note) => (qty === 0 && total === 0) || rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  const income = sold * w1 * v.p1 / 100;
  add(R, `Feeder ${v.cls.toLowerCase()} sold`, sold, "head", w1 * v.p1 / 100, income, `${num(w1)} lb at ${usd(v.p1, 2)}/cwt after ${num(v.death, 1)}% death loss`);
  const buy = H * v.w0 * v.p0 / 100;
  add(O, "Calves bought", H, "head", v.w0 * v.p0 / 100, buy, `${num(v.w0)} lb at ${usd(v.p0, 2)}/cwt`);
  add(O, "Freight in", H, "head", v.freight, H * v.freight);
  let acres = 0, fa = null;
  if (v.sys === "custom") add(O, "Grazing", H * v.days, "head-days", v.gday, H * v.days * v.gday);
  else { fa = acreCost(v, "G", v.sys); acres = H / v.stock; add(O, "Grazing", acres, "acres", fa.d, acres * fa.d, `${FNAME[v.sys]}; ${acreNote(fa)}`); }
  add(O, "Hay", H * v.hayt, "tons", v.hayp, H * v.hayt * v.hayp);
  const fp = P[v.feed] + v.handling, ft = H * v.slb * v.days / 2000, rt = H * v.rlb * v.rdays / 2000;
  if (rt > 0) add(O, "Receiving feed", rt, "tons", fp, rt * fp, `${num(v.rlb, 1)} lb a head a day for ${num(v.rdays)} days`);
  add(O, "Supplement", ft, "tons", fp, ft * fp, FEEDS.find(f => f[0] === v.feed)[1]);
  const ml = H * v.minoz / 16 * v.days;
  add(O, "Salt and mineral", ml, "lb", v.minp, ml * v.minp);
  add(O, "Processing and health", H, "head", v.vet, H * v.vet);
  add(O, "Labor", H * v.hrs, "hours", v.wage, H * v.hrs * v.wage);
  add(O, "Fuel", H * v.gal, "gal", P.diesel, H * v.gal * P.diesel);
  const mkt = income * v.comm / 100 + sold * (v.haul + 1);
  add(O, "Marketing", sold, "head", mkt / sold, mkt, `${num(v.comm, 2)}% commission, hauling and the $1 beef checkoff`);
  if (v.sys !== "custom" && v.chrent) add(O, "Land rent", acres, "acres", v.rent * v.days / 365, acres * v.rent * v.days / 365, `${usd(v.rent)}/acre/year for ${num(v.days)} days`);
  const t = v.days / 365;
  const cattleInt = buy * v.rate / 100 * t;
  add(O, "Interest on cattle", buy, "$", v.rate, cattleInt, `${num(v.rate, 2)}% for ${num(v.days)} days`);
  const otherOp = rows.filter(r => r.sec === O && !/Calves bought|Interest/.test(r.item)).reduce((s, r) => s + r.total, 0);
  const opInt = otherOp * v.rate / 100 * t / 2;
  add(O, "Interest on other costs", otherOp, "$", v.rate, opInt, "Half the costs borrowed for the whole time");
  const op = rows.filter(r => r.sec === O).reduce((s, r) => s + r.total, 0);
  if (fa && fa.f) add(F, "Forage machinery and establishment", acres, "acres", fa.f * t, acres * fa.f * t, "Share of the yearly cost for the days owned");
  add(F, "Facilities and equipment", H, "head", v.fac, H * v.fac);
  add(F, "Overhead and insurance", H, "head", v.ovh, H * v.ovh);
  const own = rows.filter(r => r.sec === F).reduce((s, r) => s + r.total, 0);
  // the commission, and the interest on it, move with the sale price
  const total = op + own, c = v.comm / 100 * (1 + v.rate / 100 * t / 2), saleLb = sold * w1;
  const be = cost => (cost - income * c) / (1 - c) / saleLb * 100;
  const gain = saleLb - H * v.w0;
  return { rows, income, op, own, total, net: income - total, N: H, sold, w1,
           beSale: be(total), beOp: be(op), cog: (total - buy - cattleInt) / gain * 100, per: H, unit: "head" };
}
// "Operating costs only" leaves out ownership (fixed) costs: depreciation,
// facilities, overhead, taxes and insurance. "All costs" is the default.
const coverOp = v => v.cover === "op";
const netFor = (r, v) => coverOp(v) ? r.income - r.op : r.net;
function maxBuy(v) {   // purchase price that breaks even: net is linear in it
  const a = netFor(stocker({ ...v, p0: 0 }), v), b = netFor(stocker({ ...v, p0: 100 }), v);
  return a / (a - b) * 100;
}

// ---------- retained ownership budget ----------
function retained(v) {
  const H = v.head, r = roDates(v), sold = H * (1 - v.death / 100), t = r.dof / 365;
  const rows = [], add = (sec, item, qty, unit, price, total, note) => (qty === 0 && total === 0) || rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs";
  const income = sold * v.outwt * v.sp / 100;
  add(R, `Fed ${v.cls.toLowerCase()} sold`, sold, "head", v.outwt * v.sp / 100, income, `${num(v.outwt)} lb at ${usd(v.sp, 2)}/cwt after ${num(v.death, 2)}% death loss`);
  const wn = weanNet(v), calves = H * wn;
  add(O, "Calves at their weaning value", H, "head", wn, calves, `What they would have netted at a ${STATE.name} auction in ${MONTHS_LONG[v.wmonth]}: ${num(v.ww)} lb at ${usd(v.wp, 2)}/cwt`);
  add(O, "Trucking to the feedlot", H, "head", v.freight, H * v.freight, `${num(v.shrink, 1)}% shrink; on feed at ${num(r.inW)} lb`);
  const first = rows.length;
  if (isBuild(v)) {
    const tons = H * v.fc * r.gain / 2000;
    add(O, "Feed", tons, "tons", v.ration, tons * v.ration, `${num(v.fc, 1)} lb of dry feed per lb of gain, ${num(r.gain)} lb gained`);
    add(O, "Yardage", H * r.dof, "head-days", v.yard, H * r.dof * v.yard);
    add(O, "Processing and health", H, "head", v.fvet, H * v.fvet);
  } else {
    add(O, "Feedlot cost of gain", H * r.gain / 100, "cwt", v.cogq, H * r.gain / 100 * v.cogq, `${num(r.gain)} lb gained a head, as quoted`);
  }
  const feedlot = rows.slice(first).reduce((s, x) => s + x.total, 0);
  if (v.lrp) add(O, "Price insurance (LRP)", H, "head", v.lrp, H * v.lrp);
  add(O, "Checkoff and sale fees", sold, "head", v.fees, sold * v.fees);
  const cBase = calves + H * v.freight, cInt = cBase * v.rate / 100 * t;
  add(O, "Interest on the calves", cBase, "$", v.rate, cInt, `${num(v.rate, 2)}% for ${num(r.dof)} days, on the calves and trucking`);
  const fInt = feedlot * v.rate / 100 * t / 2;
  add(O, "Interest on feedlot bills", feedlot, "$", v.rate, fInt, "Billed monthly, so about half is borrowed for the whole time");
  const op = rows.filter(x => x.sec === O).reduce((s, x) => s + x.total, 0);
  const saleLb = sold * v.outwt;
  return { rows, income, op, own: 0, total: op, net: income - op, N: H, per: H, unit: "head", sold, saleLb,
           gain: r.gain, dof: r.dof, sm: r.sm, sy: r.sy, wn, calves,
           cog: H * r.gain > 0 ? (feedlot + fInt) / (H * r.gain) * 100 : NaN,
           beSale: saleLb > 0 ? op / saleLb * 100 : NaN };
}

// ---------- freezer beef budget ----------
function freezer(v) {
  const H = v.head, days = fbDays(v), t = days / 365, sold = H * (1 - v.death / 100);
  const hang = v.w1 * v.dress / 100, lbs = sold * hang, s = shares(v);
  const rows = [], add = (sec, item, qty, unit, price, total, note) => (qty === 0 && total === 0) || rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  [["halves", s.h, v.ph, 2], ["quarters", s.q, v.pq, 4], ["wholes", s.w, v.pw, 1]].forEach(([name, sh, pr, n]) => {
    if (sh <= 0) return;
    const l = lbs * sh / 100;
    const count = sold * sh / 100 * n;      // a count only when it's whole; otherwise pounds
    add(R, `Beef sold as ${name}`, l, "lb", pr, l * pr, Math.abs(count - Math.round(count)) < 1e-6 ? `${num(Math.round(count))} ${Math.round(count) === 1 ? { halves: "half", quarters: "quarter", wholes: "whole" }[name] : name} of about ${num(hang / n)} lb hanging` : `${num(l)} lb hanging`);
  });
  const income = rows.reduce((x, r) => x + r.total, 0);
  const cn = fbCalfNet(v), cattle = H * cn;
  add(O, "Calves at their auction value", H, "head", cn, cattle, `${num(v.w0)} lb at ${usd(v.p0, 2)}/cwt, less commission, hauling and the $1 checkoff`);
  const avgW = (v.w0 + v.w1) / 2;
  if (v.conc > 0) {
    const m = mix(v), tons = H * avgW * v.conc / 100 * days / 2000;
    add(O, "Grain mix", tons, "tons", m.price + v.handling, tons * (m.price + v.handling), `${num(avgW * v.conc / 100, 1)} lb a head a day for ${num(days)} days`);
  }
  const ht = H * v.hayday * days / 2000;
  if (ht > 0) add(O, "Hay", ht, "tons", v.hayp, ht * v.hayp);
  const pa = acreCost(v, "P", "pasture"), wa = acreCost(v, "W", v.wsys);
  const pAc = H * v.pacres, wAc = H * v.wacres, pShare = Math.min(1, t);
  if (pAc > 0) add(O, "Permanent pasture", pAc, "acres", pa.d * pShare, pAc * pa.d * pShare, `${acreNote(pa)}; for ${num(days)} days`);
  if (wAc > 0) add(O, "Winter annual pasture", wAc, "acres", wa.d, wAc * wa.d, `${FNAME[v.wsys]}; ${acreNote(wa)}; one season`);
  const ml = H * v.minoz / 16 * days;
  add(O, "Salt and mineral", ml, "lb", v.minp, ml * v.minp);
  add(O, "Vet and medicine", H, "head", v.vet, H * v.vet);
  add(O, "Hired labor", H * v.hrs, "hours", v.wage, H * v.hrs * v.wage);
  add(O, "Fuel", H * v.gal, "gal", P.diesel, H * v.gal * P.diesel);
  add(O, "Hauling to the processor", sold, "head", v.haulp, sold * v.haulp);
  if (v.pay === "you") add(O, "Processing", sold, "head", v.kill + v.cw * hang, sold * (v.kill + v.cw * hang), `${usd(v.kill)} harvest fee and ${usd(v.cw, 2)}/lb hanging to cut, wrap and freeze`);
  add(O, "Advertising, insurance and permits", H, "head", v.mktg, H * v.mktg);
  const rentAc = pAc + (v.wsys === "ryegrass" ? wAc : 0);
  if (v.chrent && rentAc > 0) add(O, "Land rent", rentAc, "acres", v.rent * pShare, rentAc * v.rent * pShare, `${usd(v.rent)}/acre/year for ${num(days)} days`);
  const cInt = cattle * v.rate / 100 * t;
  add(O, "Interest on cattle", cattle, "$", v.rate, cInt, `${num(v.rate, 2)}% for ${num(days)} days`);
  const other = rows.filter(r => r.sec === O && !/Calves at|Interest|Processing|to the processor/.test(r.item)).reduce((x, r) => x + r.total, 0);   // feeding costs
  add(O, "Interest on other costs", other, "$", v.rate, other * v.rate / 100 * t / 2, "Half the feeding costs borrowed for the whole time; processing and hauling are paid at the end");
  const op = rows.filter(r => r.sec === O).reduce((x, r) => x + r.total, 0);
  const mach = (pAc * pa.f + wAc * wa.f) * pShare;
  if (mach > 0) add(F, "Forage machinery and establishment", pAc + wAc, "acres", mach / (pAc + wAc), mach, "Share of the yearly cost for the days on feed");
  add(F, "Pens, feeders, waterers, trailer", H, "head", v.fac, H * v.fac);
  add(F, "Overhead", H, "head", v.ovh, H * v.ovh);
  const own = rows.filter(r => r.sec === F).reduce((x, r) => x + r.total, 0), total = op + own;
  return { rows, income, op, own, total, net: income - total, N: H, per: H, unit: "head", sold, hang, lbs, days,
           avgPrice: lbs > 0 ? income / lbs : NaN, beHang: lbs > 0 ? total / lbs : NaN };
}

// ---------- history ----------
// Run a budget over past months. D.history (budget/data/history.json, built by
// tools/budget_history.py) holds each month's prices in the price file's shape.
// Inputs that are market prices take that month's values; everything else the
// user set (herd, weights, feeding, labor hours) carries over. Sale prices are
// what was actually paid: the calf price in the sale month, the 5-area fed price
// in the month retained cattle would have sold. Costs are averaged over the
// months they are spent. Each run returns one row per year.
const HIST_MARKET = {
  cc: ["sp", "hp", "cp", "bp", "hayp", "vet", "wage", "rate", "rent", "ovh"],
  st: ["p0", "p1", "hayp", "wage", "rate", "rent"],
  ro: ["wp", "ration", "fut", "basis", "sp", "cogq", "rate"],
  fb: ["p0", "hayp", "wage", "rate", "rent", "ph", "pq", "pw"],
};
const ym = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
const shiftMonth = (y, m, n) => { const t = y * 12 + m + n; return [Math.floor(t / 12), ((t % 12) + 12) % 12]; };
function histIndex() {
  if (!D.history || !D.history.months) return null;
  if (!D.history._by) { D.history._by = {}; D.history.months.forEach(r => { D.history._by[r.m] = r; }); }
  return D.history._by;
}
function histYears() { const M = D.history.months; return [Number(M[0].m.slice(0, 4)), Number(M[M.length - 1].m.slice(0, 4))]; }
function histWindow(by, y, m, from, to) {      // records for months y-m+from .. y-m+to that exist
  const out = [];
  for (let i = from; i <= to; i++) { const [yy, mm] = shiftMonth(y, m, i); if (by[ym(yy, mm)]) out.push(by[ym(yy, mm)]); }
  return out;
}
function histAverage(recs, cattleRec) {         // costs averaged over recs; cattle prices from cattleRec
  const mean = pick => { const o = {}, n = {};
    recs.forEach(r => Object.entries(pick(r) || {}).forEach(([k, x]) => { if (x != null) { o[k] = (o[k] || 0) + x; n[k] = (n[k] || 0) + 1; } }));
    Object.keys(o).forEach(k => { o[k] /= n[k]; }); return o; };
  return { m: cattleRec.m, P: mean(r => r.P), ppi: mean(r => r.ppi), slide: cattleRec.slide, cow: cattleRec.cow, bull: cattleRec.bull };
}
function withHist(rec, fn) {                     // run fn with that month's prices in D and P
  const saveD = D, saveP = { ...P };
  const today = D.cattle.cows || {}, base = today["Boner 80-85%"] || Object.values(today)[0];
  const cows = {};
  Object.entries(today).forEach(([g, c]) => { cows[g] = { ...c, price: rec.cow * c.price / base.price }; });
  const ppi = { ...D.ppi };
  Object.entries(rec.ppi).forEach(([k, r]) => { ppi[k] = { ...ppi[k], ratio: r }; });
  D = { ...D, ppi, counties: [], cattle: { ...D.cattle, slide: rec.slide, slide_dates: [`${rec.m}-01`, `${rec.m}-28`], cows, bulls: { price: rec.bull } } };
  Object.assign(P, rec.P);
  if (REGION_YEARS) {          // another ERS region: its vet, overhead and pasture rental value for that year (or the latest before)
    const y = Number(rec.m.slice(0, 4)), have = Object.keys(REGION_YEARS).map(Number).filter(x => x <= y);
    const r = have.length ? REGION_YEARS[String(Math.max(...have))] : null;
    if (r) { if (r.vet != null) P.vet_cow = r.vet; if (r.ovh != null) P.overhead_cow = r.ovh; if (r.grazed_feed != null) P.grazed_feed = r.grazed_feed; }
  }
  try { return fn(); }
  finally { D = saveD; Object.keys(P).forEach(k => delete P[k]); Object.assign(P, saveP); }
}
function histValues(st, extra = {}) {           // the form's values under the current (historical) prices
  const typed = { ...st.typed, season: 0, ...extra };
  (HIST_MARKET[st.key] || []).forEach(k => { if (!(k in extra)) delete typed[k]; });
  const s = { ...st, typed, v: {} }; fill(s); return s.v;
}
function historyRows(st) {
  const by = histIndex(); if (!by) return [];
  const [y0, y1] = histYears(), v0 = st.v, out = [];
  for (let y = y0; y <= y1; y++) {
    let row = null;
    if (st.key === "cc") {               // calves sold in the sale month; costs over the 12 months before
      const sale = by[ym(y, v0.month)], win = histWindow(by, y, v0.month, -11, 0);
      if (!sale || !sale.slide.Steers || !sale.cow || win.length < 10) continue;
      row = withHist(histAverage(win, sale), () => { const v = histValues(st); const r = cowCalf(v);
        return { net: r.net / r.N, netOp: (r.income - r.op) / r.N, beOp: r.beOp, beAll: r.beAll, price: v.sp, op: r.op / r.N, income: r.income / r.N }; });
    } else if (st.key === "st") {        // bought in the purchase month, sold days later at that month's price
      const buy = by[ym(y, v0.bmonth)], n = Math.round(v0.days / 30.4);
      const [sy, sm] = shiftMonth(y, v0.bmonth, n), sale = by[ym(sy, sm)];
      const win = histWindow(by, y, v0.bmonth, 0, Math.max(n - 1, 0));
      if (!buy || !sale || !buy.slide[v0.cls] || !sale.slide[v0.cls]) continue;
      const w1 = stSaleWt(v0), p1 = withHist(sale, () => slide(v0.cls, w1));
      row = withHist(histAverage(win, buy), () => { const v = histValues(st, { p1 }); const r = stocker(v);
        return { net: r.net / r.N, netOp: (r.income - r.op) / r.N, be: r.beSale, buy: v.p0, price: v.p1, cog: r.cog }; });
    } else if (st.key === "ro") {        // weaned, fed out, sold at that month's 5-area fed price
      const wean = by[ym(y, v0.wmonth)], d = roDates(v0), n = Math.round(d.dof / 30.4);
      const [sy, sm] = shiftMonth(y, v0.wmonth, n), sale = by[ym(sy, sm)];
      const win = histWindow(by, y, v0.wmonth, 0, Math.max(n - 1, 0));
      if (!wean || !sale || !wean.slide[v0.cls] || sale.P.fed_live == null) continue;
      row = withHist(histAverage(win, wean), () => { const v = histValues(st, { sp: sale.P.fed_live, fut: sale.P.fed_live, basis: 0 });
        const r = retained(v); return { net: r.net / r.N, be: r.beSale, price: v.sp, wean: v.wp, cog: r.cog, sold: `${MONTHS[sm]} ${sy}` }; });
    } else if (st.key === "fb") {        // cost per pound of hanging weight to finish your own calf
      const start = by[ym(y, v0.smonth)], n = Math.round(fbDays(v0) / 30.4);
      const win = histWindow(by, y, v0.smonth, 0, Math.max(n - 1, 0));
      if (!start || !start.slide[v0.cls] || win.length < Math.max(1, n - 1)) continue;
      row = withHist(histAverage(win, start), () => { const v = histValues(st); const r = freezer(v);
        return { be: r.beHang, beOp: r.lbs > 0 ? r.op / r.lbs : NaN, calf: v.p0 }; });
    }
    if (row) out.push({ year: y, ...row });
  }
  return out;
}

// ---------- purchase payoff ----------
// Buying bred cows, bred heifers or a bull: what they pay back over their years
// in the herd. Calf weight, calf price, weaning rate and yearly costs start from
// the user's cow-calf budget (CCF on the page; a fresh one elsewhere). Purchase
// prices are the user's: the starting numbers are placeholders.
const isBull = v => v.kind === "bull", isFemale = v => v.kind !== "bull";
const KIND_NAME = { cow: "Bred cow", heifer: "Bred heifer", bull: "Bull" };
function ccBase() {
  const v = typeof CCF !== "undefined" && CCF ? CCF.v : makeForm(CC, "cc").v, r = cowCalf(v);
  const line = re => r.rows.filter(x => re.test(x.item)).reduce((t, x) => t + x.total, 0);
  // the payoff discounts the purchase itself, so the cow-calf budget's interest on the cow investment stays out
  const mkt = line(/^Marketing/), cowInt = line(/^Interest on cow investment/);
  return { v, r, costPerCow: (r.total - mkt - cowInt) / r.N, opPerCow: (r.op - mkt) / r.N,
           cwt: (v.swt + v.hwt) / 2, price: (v.sp + v.hp) / 2 };
}
function calfPriceHist(weight, month, n = 10) {   // the average calf price in that month over the last n years
  const by = histIndex(); if (!by) return null;
  const [, last] = histYears(), vals = [];
  for (let y = last; y >= last - n && vals.length < n; y--) {
    const rec = by[ym(y, month)];
    if (rec && rec.slide.Steers && rec.slide.Heifers) vals.push([y, withHist(rec, () => (slide("Steers", weight) + slide("Heifers", weight)) / 2)]);
  }
  return vals.length ? { avg: vals.reduce((t, x) => t + x[1], 0) / vals.length, y0: vals[vals.length - 1][0], y1: vals[0][0] } : null;
}
function calfPriceSrc(v) {
  const b = ccBase(), h = calfPriceHist(v.cwt, b.v.month);
  return `${D.month_label} average ${usd(b.price, 2)}/cwt from your Cow-calf budget` +
    (h ? `. Calves this weight averaged ${usd(h.avg, 2)}/cwt in ${MONTHS_LONG[b.v.month]} over ${h.y0}–${h.y1}` : "");
}
const PP = [
  { g: "Purchase", open: true, f: [
    ["cover", "Costs the cattle must cover", "", "all", { show: () => false, select: [["all", "All costs, including fixed"], ["op", "Operating costs only"]] }],   // set by the switch above the results
    ["kind", "What you're buying", "", "cow", { wide: true, show: () => false, select: [["cow", "Bred cow"], ["heifer", "Bred heifer"], ["bull", "Bull"]] }],
    ["head", "Head bought", "head", v => isBull(v) ? 1 : 10, { step: 1 }],
    ["price", "Purchase price", "$/head", v => ({ cow: 2750, heifer: 3500, bull: 7000 })[v.kind], { step: 25, src: () => "A placeholder, not a market price" }],
    ["extra", "Trucking, testing and other purchase costs", "$/head", 25, { step: 5, src: () => "A starting guess" }],
    ["years", "Years in your herd", "years", v => ({ cow: 5, heifer: 8, bull: 4 })[v.kind], { step: 1,
      src: v => ({ cow: "A bred cow bought at 4 to 6 years old, kept to about 10", heifer: "Calves at 2, kept to about 10", bull: "Years of service" })[v.kind] }],
    ["death", "Death loss per year", "%", v => isBull(v) ? 3 : 1.5, { step: .5, src: v => isBull(v) ? "Injury and death; a starting guess" : "" }],
    ["rate", "Interest rate (your cost of money)", "%", () => P.op_rate, { step: .05, src: () => rateSrc() }],
  ]},
  { g: "Calves", open: true, f: [
    ["cows", "Cows he breeds each year", "cows", 25, { step: 1, show: isBull }],
    ["wean", "Calves weaned per cow exposed", "%", () => ccBase().v.wean, { step: 1, src: () => "From your Cow-calf budget" }],
    ["wean1", "First calf weaned", "%", v => Math.max(0, v.wean - 5), { step: 1, show: v => v.kind === "heifer", src: () => "First-calf heifers often wean a few percent fewer" }],
    ["cwt", "Calf sale weight", "lb", () => Math.round(ccBase().cwt / 5) * 5, { step: 10, src: () => "Average of your Cow-calf steer and heifer weights" }],
    ["cp", "Calf price you expect over these years", "$/cwt", () => ccBase().price, { step: 1, src: v => calfPriceSrc(v) }],
    ["epd", "Weaning weight EPD advantage over your current bulls", "lb", 0, { step: 5, neg: true, show: isBull, src: () => "Extra weaning weight per calf; 0 leaves genetics out" }],
    ["comm", "Commission when calves and culls sell", "%", 3, { step: .25 }],
    ["haul", "Hauling and checkoff per head sold", "$/head", 7, { step: 1 }],
  ]},
  { g: "Yearly costs", open: true, f: [
    ["cost", "Yearly cost to keep a cow", "$/cow", v => coverOp(v) ? ccBase().opPerCow : ccBase().costPerCow, { step: 10, show: isFemale,
      src: v => `Your Cow-calf budget's ${coverOp(v) ? "operating costs" : "costs"} per cow, without marketing` }],
    ["bcost", "Yearly cost to keep the bull", "$/bull", () => ccBase().v.bkeep, { step: 10, show: isBull, src: () => "From your Cow-calf budget (Full view, Ownership costs)" }],
  ]},
  { g: "When culled", f: [
    ["cullwt", "Weight when culled", "lb", v => isBull(v) ? ccBase().v.bwt : ccBase().v.cwt_, { step: 25 }],
    ["cullp", "Cull price", "$/cwt", v => isBull(v) ? ccBase().v.bp : ccBase().v.cp, { step: 1, src: v => `${D.month_label} average ${isBull(v) ? "slaughter bull" : "cull cow"} price from your Cow-calf budget` }],
  ]},
];
function payoff(v) {
  const H = v.head, L = Math.max(1, Math.round(v.years)), s = 1 - v.death / 100, r = v.rate / 100, c = v.comm / 100;
  const disc = t => Math.pow(1 + r, -t), bull = isBull(v);
  const calfNet = v.cwt / 100 * v.cp * (1 - c) - v.haul, cullNet = v.cullwt / 100 * v.cullp * (1 - c) - v.haul;
  const buy = v.price + v.extra, years = [];
  let alive = 1, pv = 0, cum = -buy, payback = null, calves = 0, inc = 0, cost = 0, years0 = 0, salv = 0, dcp = 0, pvCost = 0, pvInc = 0;
  for (let t = 1; t <= L; t++) {
    const start = alive, w = (t === 1 && v.kind === "heifer" ? v.wean1 : v.wean) / 100;
    const calvesT = bull ? start * v.cows * w : start * w;
    const incT = bull ? calvesT * v.epd / 100 * v.cp * (1 - c) : calvesT * calfNet;
    const costT = start * (bull ? v.bcost : v.cost);
    alive = start * s;
    const salvT = t === L ? alive * cullNet : 0, net = incT - costT + salvT;
    const prev = cum; cum += net; pv += net * disc(t);
    if (payback === null && cum >= 0) payback = net > 0 ? t - 1 + (-prev) / net : t;
    if (!bull) dcp += start * w * v.cwt / 100 * (1 - c) * disc(t);
    pvCost += costT * disc(t); pvInc += incT * disc(t);
    calves += calvesT; inc += incT; cost += costT; years0 += start; salv += salvT;
    years.push({ t, alive: start, calves: calvesT, income: incT, cost: costT, salvage: salvT, net, cum });
  }
  const npv = pv - buy, interest = (cum - npv);
  const rows = [], add = (sec, item, qty, unit, price, total, note) => (qty === 0 && total === 0) || rows.push({ sec, item, qty, unit, price, total: total * H, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs", label = bull ? "bull" : "cow";
  if (bull) { if (v.epd) add(R, "Extra calf value from his genetics", calves * H, "calves", v.epd / 100 * v.cp * (1 - c), inc, `${num(v.epd)} lb per calf at ${usd(v.cp, 2)}/cwt`); }
  else add(R, "Calves sold", calves * H, "calves", calfNet, inc, `${num(v.cwt)} lb at ${usd(v.cp, 2)}/cwt over ${L} years, less commission and hauling`);
  add(R, "Cull value at the end", alive * H, "head", cullNet, salv, `${num(v.cullwt)} lb at ${usd(v.cullp, 2)}/cwt after ${num(v.death, 1)}% death loss a year`);
  add(O, bull ? "Yearly upkeep" : "Yearly costs", years0 * H, `${label}-years`, bull ? v.bcost : v.cost, cost);
  add(F, "Purchase price", H, "head", v.price, v.price);
  if (v.extra) add(F, "Trucking, testing and other purchase costs", H, "head", v.extra, v.extra);
  if (!bull) rows.push({ sec: F, item: "Interest (your cost of money)", qty: buy * H, unit: "$", price: v.rate, total: interest * H,
              note: `${num(v.rate, 2)}% a year over ${L} years: the gap between the cash totals and their value today` });
  const sum = sec => rows.filter(x => x.sec === sec).reduce((t, x) => t + x.total, 0);
  const income = sum(R), op = sum(O), own = sum(F);
  let irr = null;                                     // rate that makes the purchase break even
  const npvAt = rr => years.reduce((t, y) => t + y.net / Math.pow(1 + rr, y.t), -buy);
  if (npvAt(-0.5) > 0 && npvAt(1) < 0) { let lo = -0.5, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (npvAt(m) > 0) lo = m; else hi = m; } irr = (lo + hi) / 2; }
  const crf = r > 0 ? r / (1 - Math.pow(1 + r, -L)) : 1 / L;
  const pvSalv = salv * disc(L), annualCost = (buy + pvCost - pvSalv) * crf;
  const perYearCalves = bull ? v.cows * v.wean / 100 : v.wean / 100;
  return { rows, income, op, own, total: op + own, net: income - op - own, N: H, per: H, bull, unit: bull ? "bull" : KIND_NAME[v.kind].toLowerCase().replace("bred ", ""),
    years, npv, maxPay: pv - v.extra, payback, irr, L, aliveEnd: alive, calves,
    cpBE: !bull && dcp > 0 ? v.cp - npv / dcp : null, costPerCalf: !bull && calves > 0 ? (buy + cost - salv) / calves : null,
    annualCost, bullPerCalf: bull ? annualCost / Math.max(perYearCalves, 1e-9) : null, bullPerCow: bull ? annualCost / Math.max(v.cows, 1e-9) : null,
    lbToPay: bull ? annualCost / Math.max(perYearCalves, 1e-9) / (v.cp / 100) : null, epdWorth: bull ? pvInc : null };
}

// ---------- cash flow ----------
// When each line of the cow-calf or stocker budget is paid or received, month
// by month, from the same budget rows (so the totals match the budget). Cash
// only: depreciation and other ownership costs that aren't paid out are left
// out and reported. Cow-calf covers 12 months from the start the user picks;
// stocker covers its production period, from the first cash out to the sale.
const NONCASH = /^(Forage machinery and establishment|Facilities and equipment|Pens, |Bull depreciation|Interest on cow investment)/;
function cashFlow(key, v) {
  const r = key === "cc" ? cowCalf(v) : stocker(v);
  let months, place;                                    // months: calendar month of each column
  if (key === "cc") {
    const start = v.cfstart === "after" || v.cfstart == null ? (v.month + 1) % 12 : Number(v.cfstart);
    months = Array.from({ length: 12 }, (_, i) => (start + i) % 12);
    const col = m => months.indexOf(((m % 12) + 12) % 12);
    const at = m => [[col(m), 1]];
    const even = () => months.map((_, i) => [i, 1 / 12]);
    const run = (m, n) => Array.from({ length: n }, (_, i) => [col(m + i), 1 / n]);
    place = row => {
      const it = row.item;
      if (/^(Steer|Heifer) calves|^Marketing|^Interest on operating/.test(it)) return at(v.month);
      if (/^Cull (cows|bulls)|^Replacement bulls/.test(it)) return at(v.tcull);
      if (/^Pasture upkeep/.test(it)) return at(v.tpast);
      if (/^Winter annual/.test(it)) return at(v.twin);
      if (/^Hay/.test(it)) return at(v.thay);
      if (/^Supplement/.test(it)) return run(v.tsupp, Math.max(1, Math.round(v.cdays / 30.4)));
      if (/^Vet/.test(it)) return [[col(v.tvet), .5], [col(v.month), .5]];
      if (/^Breeding/.test(it)) return at(v.tvet + 2);
      if (/^Land rent|^Pasture, regional average/.test(it)) return at(v.trent);
      if (/^Overhead/.test(it)) return at(v.tovh);
      return even();                                      // mineral, labor, fuel, repairs
    };
  } else {
    const n = Math.max(1, Math.round(v.days / 30.4));     // months owned; the sale is in month n
    const annual = v.sys === "ryegrass" || v.sys === "overseed";
    const plant = annual ? -(((v.bmonth - v.tplant) % 12 + 12) % 12) : 0;   // months before the purchase
    const first = Math.min(plant, 0);
    months = Array.from({ length: n - first + 1 }, (_, i) => ((v.bmonth + first + i) % 12 + 12) % 12);
    const col = off => off - first;
    const at = off => [[col(off), 1]];
    const owned = () => Array.from({ length: n }, (_, i) => [col(i), 1 / n]);
    place = row => {
      const it = row.item;
      if (/^Calves bought|^Freight in|^Processing|^Receiving feed/.test(it)) return at(0);
      if (/^Grazing/.test(it)) return annual ? at(plant) : owned();
      if (/sold$|^Marketing|^Interest/.test(it)) return at(n);
      return owned();                                     // hay, supplement, mineral, labor, fuel, rent, overhead
    };
  }
  const lines = [], nonCash = [], rows = r.rows.slice();
  if (key === "cc" && v.bulls > 0) {      // bull depreciation is non-cash; the bull bought and the cull bull sold are cash
    rows.push({ sec: "Income", item: "Cull bulls sold", total: r.bullSale });
    rows.push({ sec: "Operating costs", item: "Replacement bulls bought", total: r.bullBuy });
  }
  rows.forEach(row => {
    if (row.sec === "Ownership costs" && NONCASH.test(row.item)) { nonCash.push(row); return; }
    const sign = row.sec === "Income" ? 1 : -1, cells = months.map(() => 0);
    place(row).forEach(([i, share]) => { if (i >= 0) cells[i] += sign * row.total * share; });
    lines.push({ item: row.item, sec: row.sec, cells });
  });
  const inflow = months.map((_, i) => lines.reduce((t, l) => t + Math.max(l.cells[i], 0), 0));
  const outflow = months.map((_, i) => lines.reduce((t, l) => t + Math.min(l.cells[i], 0), 0));
  let bal = 0, low = 0, lowAt = 0;
  const balance = months.map((_, i) => { bal += inflow[i] + outflow[i]; if (bal < low) { low = bal; lowAt = i; } return bal; });
  return { r, months, lines, inflow, outflow, balance, low, lowAt, end: bal,
           belowZero: balance.filter(b => b < 0).length, nonCash: nonCash.reduce((t, x) => t + x.total, 0) };
}
