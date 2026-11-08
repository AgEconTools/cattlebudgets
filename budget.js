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

// ---------- formatting ----------
const usd = (v, d = 0) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fdate = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const fmonth = s => { const [y, m] = s.split("-").map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
const pdate = p => p.when || fdate(p.date);

// ---------- cattle prices ----------
function slide(cls, wt) {           // Mississippi auction price, $/cwt, at a weight
  const pts = D.cattle.slide[cls];
  if (wt <= pts[0][0]) return pts[0][1];
  if (wt >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) if (wt <= pts[i][0]) {
    const [w0, p0] = pts[i - 1], [w1, p1] = pts[i];
    return p0 + (p1 - p0) * (wt - w0) / (w1 - w0);
  }
}
const nowMonth = () => Number(D.cattle.slide_dates[1].slice(5, 7)) - 1;
function seasonAdj(cls, wt, toMonth, fromMonth = nowMonth()) {
  const lo = Math.min(700, Math.max(300, Math.floor(wt / 100) * 100));
  const s = D.cattle.season.series[`${cls} ${lo}-${lo + 100}`];
  if (!s) return 1;
  return s[toMonth].index / s[fromMonth].index;
}

// ---------- pasture and hay cost per acre ----------
function forageAcre(sys, fertPct = 100) {
  const S = D.forage.systems[sys];
  const keyPrice = { urea: () => P.urea / 20, dap: () => P.dap / 20, potash: () => P.potash / 20, diesel: () => P.diesel, wage: () => P.wage };
  const fert = new Set(["urea", "dap", "potash"]);
  const row = it => {
    let price = it.price, how = "MSU 2025 price";
    if (it.price_key) { price = keyPrice[it.price_key](); how = "today's price"; }
    else if (it.index) { price = it.price * D.ppi[it.index].ratio; how = "2025 price × PPI"; }
    // fertilizer, and the custom spreading that goes with it, scale with the rate
    const qty = fert.has(it.price_key) || /Custom spread \(truck\)/.test(it.item) ? it.qty * fertPct / 100 : it.qty;
    return { item: it.item, unit: it.unit, qty, price, cost: qty * price, how };
  };
  const direct = S.direct.map(row), fixed = S.fixed.map(row);
  const sum = a => a.reduce((t, r) => t + r.cost, 0);
  return { name: S.name, table: S.table, direct, fixed, d: sum(direct), f: sum(fixed),
           fert: direct.filter(r => /Nitrogen|Phosphate|Potash/.test(r.item)).reduce((t, r) => t + r.cost, 0) };
}

// ---------- input forms ----------
// A field: [id, label, unit, default, opts]. default may be a function of the
// current values (v) so it follows the market until the user types a number.
const FEEDS = [["soyhulls", "Soybean hull pellets"], ["cottonseed", "Whole cottonseed"], ["cgf", "Corn gluten feed pellets"], ["corn", "Shelled corn"], ["csm", "Cottonseed meal (41%)"]];
const SYSTEMS = { pasture: "Permanent pasture (bahia, bermuda)", ryegrass: "Ryegrass, no-till", overseed: "Ryegrass overseeded on bermuda/bahia" };

const CC = [
  { g: "Herd", open: true, f: [
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
    ["cgrade", "Cull cow grade", "", "Boner 80-85%", { select: () => Object.keys(D.cattle.cows).map(k => [k, k]) }],
    ["cwt_", "Cull cow weight", "lb", v => D.cattle.cows[v.cgrade].weight, { step: 10, src: () => "Average weight sold at Mississippi auctions" }],
    ["cp", "Cull cow price", "$/cwt", v => D.cattle.cows[v.cgrade].price, { step: 1, src: v => `Mississippi auctions, ${v.cgrade}, ${cattleWeeks()}` }],
    ["byears", "Years each bull is used", "years", 4, { step: 1 }],
    ["bwt", "Cull bull weight", "lb", 1800, { step: 50 }],
    ["bp", "Cull bull price", "$/cwt", () => D.cattle.bulls.price, { step: 1, src: () => `Mississippi auctions, slaughter bulls, ${cattleWeeks()}` }],
  ]},
  { g: "Pasture and hay", open: true, f: [
    ["acres", "Pasture acres per cow", "acres", 2.5, { simple: true, step: .1, src: () => "Includes ground for bulls and replacement heifers" }],
    ["psys", "Pasture", "", "pasture", { wide: true, select: () => [["pasture", SYSTEMS.pasture]] }],
    ["wacres", "Winter annual pasture per cow", "acres", 0, { step: .1 }],
    ["wsys", "Winter annual", "", "overseed", { wide: true, show: v => v.wacres > 0, select: () => [["overseed", SYSTEMS.overseed], ["ryegrass", SYSTEMS.ryegrass]] }],
    ["fert", "Pasture and hay fertilizer", "% of MSU", 25, { step: 5, src: () => "Share of the MSU forage budgets' N, P and K rates. 25% is a typical Mississippi herd's starting guess; 100% is MSU's full recommendation; 0 if you don't fertilize" }],
    ["hayday", "Hay fed per cow per day", "lb", 28, { step: 1 }],
    ["haydays", "Days hay is fed", "days", 110, { simple: true, step: 5 }],
    ["waste", "Hay lost to storage and feeding", "%", 15, { step: 1 }],
    ["haysrc", "Hay", "", "buy", { simple: true, select: [["raise", "Raise my own"], ["buy", "Buy it"]] }],
    ["hyield", "Hay yield", "tons/acre", 3, { step: .25, show: v => v.haysrc === "raise" }],
    ["hayp", "Hay price, delivered", "$/ton", () => P.hay_market, { simple: true, step: 1, show: v => v.haysrc === "buy", src: () => priceSrc("hay_market") }],
    ["chrent", "Charge rent on pasture and hay ground", "", 1, { simple: true, check: true }],
    ["county", "Rent from", "", "", { simple: true, wide: true, select: () => [["", `Mississippi average (${usd(P.rent)}/acre, ${D.prices.rent.when})`]].concat(D.counties.map(c => [c.name, `${c.name} County (${usd(c.value, c.value % 1 ? 2 : 0)}, ${c.year})`])), show: v => v.chrent }],
    ["rent", "Pasture rent", "$/acre", v => v.county ? D.counties.find(c => c.name === v.county).value : P.rent, { simple: true, step: 1, show: v => v.chrent, src: v => v.county ? `USDA-NASS county cash rent, ${D.counties.find(c => c.name === v.county).year}` : priceSrc("rent") }],
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
    ["rate", "Operating interest rate", "%", () => P.op_rate, { step: .05, src: () => priceSrc("op_rate") }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, chute, fence, water, trailer per cow", "$/year", 60, { step: 5, src: () => "Yearly depreciation and interest; a starting guess" }],
    ["bullcost", "Price of a replacement bull", "$", 6500, { step: 250 }],
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
    ["head", "Head bought", "head", 60, { simple: true, step: 1 }],
    ["cls", "Steers or heifers", "", "Steers", { simple: true, select: [["Steers", "Steers"], ["Heifers", "Heifers"]] }],
    ["bmonth", "Month bought", "", 10, { simple: true, select: MONTHS_LONG.map((m, i) => [i, m]) }],   // November: ryegrass is ready; 140 days sells them in early April
    ["season", "Adjust prices for the usual seasonal pattern", "", 1, { check: true }],
    ["w0", "Purchase weight", "lb", 450, { simple: true, step: 10 }],
    ["p0", "Purchase price", "$/cwt", v => slide(v.cls, v.w0) * (v.season ? seasonAdj(v.cls, v.w0, v.bmonth) : 1), { simple: true, step: 1, src: v => calfSrc(v.cls, v.w0, v, v.bmonth) }],
    ["days", "Days owned", "days", 140, { simple: true, step: 5 }],
    ["adg", "Average daily gain", "lb/day", 2, { simple: true, step: .1 }],
    ["death", "Death loss", "%", 2, { step: .5 }],
    ["_sale", "calc", v => `Sells at ${num(v.w0 + v.adg * v.days)} lb in ${MONTHS_LONG[(v.bmonth + Math.round(v.days / 30.4)) % 12]}.`, { simple: true }],
    ["p1", "Sale price", "$/cwt", v => { const w1 = v.w0 + v.adg * v.days, m = (v.bmonth + Math.round(v.days / 30.4)) % 12; return slide(v.cls, w1) * (v.season ? seasonAdj(v.cls, w1, m) : 1); },
      { simple: true, step: 1, src: v => calfSrc(v.cls, v.w0 + v.adg * v.days, v, (v.bmonth + Math.round(v.days / 30.4)) % 12) }],
  ]},
  { g: "Grazing, hay and feed", open: true, f: [
    ["sys", "Grazing", "", "ryegrass", { simple: true, wide: true, select: () => [["ryegrass", SYSTEMS.ryegrass], ["overseed", SYSTEMS.overseed], ["pasture", SYSTEMS.pasture], ["custom", "Pay for grazing by the day"]] }],
    ["stock", "Head per acre", "head", 2, { simple: true, step: .1, show: v => v.sys !== "custom" }],
    ["fert", "Fertilizer rate", "% of MSU", 60, { step: 5, show: v => v.sys !== "custom", src: () => "Share of the MSU forage budget's N, P and K rates. 60% is a typical Mississippi starting guess; 100% is MSU's full recommendation" }],
    ["gday", "Grazing charge", "$/head/day", 0.75, { simple: true, step: .05, show: v => v.sys === "custom" }],
    ["hayt", "Hay per head", "tons", 0.2, { step: .05 }],
    ["hayp", "Hay price, delivered", "$/ton", () => P.hay_market, { step: 1, src: () => priceSrc("hay_market") }],
    ["feed", "Supplement", "", "soyhulls", { wide: true, select: () => FEEDS.filter(([k]) => P[k] != null).map(([k, n]) => [k, n]) }],
    ["handling", "Delivery and handling", "$/ton", 40, { step: 5, src: v => feedSrc(v.feed) }],
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
    ["crate", "Interest rate on cattle", "%", () => P.cattle_rate, { step: .05, src: () => priceSrc("cattle_rate") }],
    ["rate", "Interest rate on other costs", "%", () => P.op_rate, { step: .05, src: () => priceSrc("op_rate") }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, chute, fence, water, trailer", "$/head", 12, { step: 1, src: () => "Depreciation and interest for the time owned; a starting guess" }],
    ["ovh", "Overhead and insurance", "$/head", 8, { step: 1 }],
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
    ["freight", "Trucking to the feedlot", "$/head", 45, { step: 1, src: () => "A starting guess for a load from Mississippi to the Plains" }],
    ["shrink", "Shrink on the trip", "%", 4, { step: .5 }],
    ["adg", "Average daily gain", "lb/day", v => v.cls === "Steers" ? 3.5 : 3.2, { step: .1 }],
    ["outwt", "Sale weight (pay weight)", "lb", v => v.cls === "Steers" ? 1400 : 1275, { step: 10 }],
    ["death", "Death loss", "%", 1.5, { step: .25 }],
    ["_dof", "calc", v => { const r = roDates(v); return `On feed at ${num(r.inW)} lb, gains ${num(r.gain)} lb in ${num(r.dof)} days, and sells in ${MONTHS_LONG[r.sm]} ${r.sy}.`; }],
    ["cogmode", "Feedlot costs", "", "build", { wide: true, select: [["build", "Figure them from feed, yardage and health"], ["quote", "Use the feedlot's quoted cost of gain"]] }],
    ["fc", "Feed conversion", "lb feed/lb gain", v => v.cls === "Steers" ? 6.0 : 6.3, { step: .1, show: isBuild, src: () => "Pounds of dry matter per pound of gain" }],
    ["ration", "Ration cost", "$/ton dry", () => cornDM() + 60, { step: 1, show: isBuild, src: () => `Omaha corn ${usd(P.corn_omaha, 2)}/bu (${usd(cornDM())}/ton dry matter) plus $60 for roughage, supplement and the feedlot's markup; a starting guess` }],
    ["yard", "Yardage", "$/head/day", 0.5, { step: .05, show: isBuild, src: () => "A starting guess; ask your feedlot" }],
    ["fvet", "Processing and health at the feedlot", "$/head", 30, { step: 1, show: isBuild, src: () => "A starting guess" }],
    ["cogq", "Quoted cost of gain", "$/cwt gain", v => buildCog(v), { step: 1, show: v => !isBuild(v), src: () => "Feed, yardage and health per 100 lb of gain; interest is charged below" }],
  ]},
  { g: "Sale price", open: true, f: [
    ["fut", "Live cattle futures for the sale month", "$/cwt", v => roFut(v).settle, { step: .25, src: v => futSrc(v) }],
    ["basis", "Basis (cash minus futures)", "$/cwt", v => D.fed.basis[roDates(v).sm].basis, { step: .25, src: v => basisSrc(v) }],
    ["sp", "Expected sale price", "$/cwt", v => v.fut + v.basis, { step: .25, src: () => `Futures plus basis. The 5-area cash price for fed steers averaged ${usd(P.fed_live, 2)}/cwt in ${pdate(D.prices.fed_live)}` }],
    ["lrp", "Price insurance (LRP premium)", "$/head", 0, { step: 1, src: () => "Your share of the premium if you buy Livestock Risk Protection" }],
    ["fees", "Checkoff and sale fees", "$/head", 3, { step: .5, src: () => "$1 beef checkoff plus brand inspection and other fees; a starting guess" }],
  ]},
  { g: "Interest", f: [
    ["crate", "Interest rate on the calves", "%", () => P.cattle_rate, { step: .05, src: () => priceSrc("cattle_rate") }],
    ["rate", "Interest rate on feedlot bills", "%", () => P.op_rate, { step: .05, src: () => priceSrc("op_rate") }],
  ]},
];
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
    ["head", "Head finished", "head", 4, { step: 1 }],
    ["sys", "How they're finished", "", "grain", { wide: true, show: () => false, select: [["grain", "Grain-fed"], ["grass", "Grass-fed"]] }],   // set by the switch above the tiles
    ["cls", "Steers or heifers", "", "Steers", { select: [["Steers", "Steers"], ["Heifers", "Heifers"]] }],
    ["smonth", "Month finishing starts", "", 10, { select: MONTH_OPTS }],   // November: a 650-lb calf finishes on grain around May
    ["season", "Adjust the calf price for the usual seasonal pattern", "", 1, { check: true }],
    ["w0", "Starting weight", "lb", v => isGrain(v) ? 650 : 550, { step: 10 }],
    ["p0", "Calf value at the start", "$/cwt", v => slide(v.cls, v.w0) * (v.season ? seasonAdj(v.cls, v.w0, v.smonth) : 1), { step: 1, src: v => calfSrc(v.cls, v.w0, v, v.smonth) }],
    ["w1", "Finished live weight", "lb", v => isGrain(v) ? 1150 : 1050, { step: 10 }],
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
    ["hayp", "Hay price, delivered", "$/ton", () => P.hay_market, { step: 1, src: () => priceSrc("hay_market") }],
    ["pacres", "Permanent pasture per head", "acres", v => isGrain(v) ? 0.5 : 1.5, { step: .1, src: () => "Charged for the days on feed" }],
    ["wacres", "Winter annual per head", "acres", v => isGrain(v) ? 0 : 1, { step: .1, src: () => "Charged for one season" }],
    ["wsys", "Winter annual", "", "overseed", { wide: true, select: () => [["overseed", SYSTEMS.overseed], ["ryegrass", SYSTEMS.ryegrass]], show: v => v.wacres > 0 }],
    ["fert", "Fertilizer rate", "% of MSU", 100, { step: 10 }],
    ["minoz", "Mineral per head per day", "oz", 3, { step: .5 }],
    ["minp", "Mineral price", "$/lb", 0.56, { step: .01, src: () => "Starting guess; no public price series" }],
  ]},
  { g: "Processing and sale", open: true, f: [
    ["pay", "Who pays the processor", "", "buyer", { wide: true, select: [["buyer", "Buyers pay the processor"], ["you", "I pay and include it in my price"]] }],
    ["dress", "Dressing percentage", "% of live wt", v => isGrain(v) ? 61 : 57, { step: .5, src: () => "Hanging (carcass) weight as a share of live weight" }],
    ["kill", "Harvest (kill) fee", "$/head", 100, { step: 5, src: () => "A starting guess; ask your processor" }],
    ["cw", "Cut, wrap and freeze", "$/lb hanging", 1.1, { step: .05, src: () => "A starting guess; ask your processor" }],
    ["yield", "Packaged beef", "% of hanging", 62, { step: 1, src: () => "What's left after bone, fat, trim and drying during aging; used for buyers' cost per pound" }],
    ["shh", "Sold as halves", "% of the beef", 70, { step: 5 }],
    ["shq", "Sold as quarters", "% of the beef", 30, { step: 5 }],
    ["_wh", "calc", v => { const s = shares(v); return s.over ? "Halves and quarters add to more than 100%, so they're scaled down." : `${num(s.w)}% sold as wholes.`; }],
    ["ph", "Price, halves", "$/lb hanging", v => (isGrain(v) ? 5.00 : 6.00) + procAdd(v), { step: .05, src: v => `A starting guess${v.pay === "you" ? " plus processing" : ""}; no public price series. Packers paid ${usd(P.fed_dressed / 100, 2)}/lb hanging weight for fed steers (5-area, week ending ${pdate(D.prices.fed_dressed)})` }],
    ["pq", "Price, quarters", "$/lb hanging", v => (isGrain(v) ? 5.50 : 6.50) + procAdd(v), { step: .05, src: v => `A starting guess${v.pay === "you" ? " plus processing" : ""}` }],
    ["pw", "Price, wholes", "$/lb hanging", v => (isGrain(v) ? 4.75 : 5.75) + procAdd(v), { step: .05, src: v => `A starting guess${v.pay === "you" ? " plus processing" : ""}` }],
  ]},
  { g: "Health, labor and other operating", f: [
    ["vet", "Vet and medicine", "$/head", 30, { step: 1, src: () => "A starting guess" }],
    ["hrs", "Labor per head", "hours", 10, { step: .5 }],
    ["wage", "Labor rate", "$/hour", () => P.wage, { step: .25, src: () => priceSrc("wage") }],
    ["gal", "Truck and feeding fuel per head", "gal", 6, { step: .5, src: () => `Diesel at ${usd(P.diesel, 2)}/gal` }],
    ["haulp", "Hauling to the processor", "$/head", 25, { step: 1, src: () => "A starting guess" }],
    ["mktg", "Advertising, insurance and permits", "$/head", 35, { step: 5, src: () => "A starting guess: website or ads, liability insurance, any permits" }],
    ["crate", "Interest rate on cattle", "%", () => P.cattle_rate, { step: .05, src: () => priceSrc("cattle_rate") }],
    ["rate", "Interest rate on other costs", "%", () => P.op_rate, { step: .05, src: () => priceSrc("op_rate") }],
    ["chrent", "Charge rent on pasture", "", 1, { check: true }],
    ["rent", "Pasture rent", "$/acre/year", () => P.rent, { step: 1, show: v => v.chrent, src: () => priceSrc("rent") }],
  ]},
  { g: "Ownership costs", f: [
    ["fac", "Pens, feeders, waterers, trailer", "$/head", 25, { step: 1, src: () => "Depreciation and interest for the time owned; a starting guess" }],
    ["ovh", "Overhead", "$/head", 10, { step: 1 }],
  ]},
];
const fbDays = v => v.adg > 0 ? Math.max(v.w1 - v.w0, 0) / v.adg : 0;
const procAdd = v => v.pay === "you" ? v.cw + v.kill / Math.max(v.w1 * v.dress / 100, 1) : 0;
function mix(v) {
  const parts = [["corn", v.mcorn], ["soyhulls", v.msoy], ["cgf", v.mcgf], ["csm", v.mcsm]].filter(([k, s]) => s > 0 && P[k] != null);
  const sum = parts.reduce((t, [, s]) => t + s, 0);
  const price = sum > 0 ? parts.reduce((t, [k, s]) => t + P[k] * s, 0) / sum : 0;
  return { sum, price, parts: parts.map(([k]) => `${FEEDS.find(f => f[0] === k)[1].toLowerCase()} ${usd(P[k])}`).join(", ") };
}
function shares(v) {
  const h = Math.max(0, v.shh), q = Math.max(0, v.shq), w = Math.max(0, 100 - h - q), sum = h + q + w;
  return { h: h / sum * 100, q: q / sum * 100, w: w / sum * 100, over: h + q > 100 };
}

// Market prices shown in each budget's Full view; shared by every budget.
const FERT_FUEL = ["urea", "dap", "potash", "diesel"], FEED_KEYS = ["soyhulls", "cottonseed", "cgf", "corn", "csm"];
CC.push({ g: "Market prices", prices: [...FERT_FUEL, ...FEED_KEYS], forage: v => ["pasture", ...(v.wacres > 0 ? [v.wsys] : []), ...(v.haysrc === "raise" ? ["hay"] : [])] });
ST.push({ g: "Market prices", prices: [...FERT_FUEL, ...FEED_KEYS], forage: v => v.sys === "custom" ? [] : [v.sys] });
RO.push({ g: "Market prices", prices: ["corn_omaha", "fed_live"] });
FB.push({ g: "Market prices", prices: ["corn", "soyhulls", "cgf", "csm", ...FERT_FUEL, "fed_live", "fed_dressed", "retail_choice"], forage: v => ["pasture", ...(v.wacres > 0 ? [v.wsys] : [])] });
const FNAME = { pasture: "Permanent pasture", hay: "Hay ground", ryegrass: "No-till ryegrass", overseed: "Overseeded ryegrass" };

function cattleWeeks() { return `${D.month_label} average`; }   // the month the page's prices cover
function calfSrc(cls, wt, v, month) {
  const m = month == null ? v.month : month;
  const base = `Mississippi auctions, ${cls.toLowerCase()} at ${num(wt)} lb: ${usd(slide(cls, wt), 2)}/cwt, ${cattleWeeks()}`;
  if (!v.season || m === nowMonth()) return base;
  const a = seasonAdj(cls, wt, m);
  return `${base}; ${a >= 1 ? "+" : "−"}${num(Math.abs(a - 1) * 100, 1)}% for ${MONTHS_LONG[m]} (5-year seasonal pattern)`;
}
const SHORT = { hay_market: "Alabama hay report", wage: "Mississippi beef cattle ranch wage", rent: "Mississippi average",
  op_rate: "Average new operating loan", cattle_rate: "Average new feeder cattle loan", vet_cow: "Mississippi Portal average, carried forward",
  overhead_cow: "Mississippi Portal average", fed_live: "5-area negotiated cash", fed_dressed: "5-area negotiated cash", corn_omaha: "Omaha",
  urea: "North Carolina and Oklahoma average", dap: "North Carolina and Oklahoma average", potash: "North Carolina and Oklahoma average",
  diesel: "North Carolina and Oklahoma average", soyhulls: "Alabama wholesale", cottonseed: "Alabama wholesale", cgf: "Alabama wholesale",
  csm: "Memphis wholesale", corn: "Mississippi Delta elevator bid", retail_choice: "Grocery average, all cuts" };
function priceSrc(k) {
  const p = D.prices[k]; if (!p) return "";
  if (P[k] !== p.value) return "Your price (Market prices, in the Full view)";
  return `${SHORT[k] ? SHORT[k] + ": " : ""}${p.source}, ${pdate(p)}`;
}
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
  const rows = [], add = (sec, item, qty, unit, price, total, note) => rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  add(R, "Steer calves", steers, "head", v.swt * v.sp / 100, steers * v.swt * v.sp / 100, `${num(v.swt)} lb at ${usd(v.sp, 2)}/cwt`);
  add(R, "Heifer calves", heifers, "head", v.hwt * v.hp / 100, heifers * v.hwt * v.hp / 100, `${num(v.hwt)} lb at ${usd(v.hp, 2)}/cwt`);
  add(R, "Cull cows", culls, "head", v.cwt_ * v.cp / 100, culls * v.cwt_ * v.cp / 100, `${num(v.cwt_)} lb at ${usd(v.cp, 2)}/cwt`);
  add(R, "Cull bulls", cbulls, "head", v.bwt * v.bp / 100, cbulls * v.bwt * v.bp / 100, `${num(v.bwt)} lb at ${usd(v.bp, 2)}/cwt`);
  const income = rows.reduce((t, r) => t + r.total, 0), sold = steers + heifers + culls + cbulls;

  const pa = forageAcre(v.psys, v.fert), wa = forageAcre(v.wsys, v.fert), ha = forageAcre("hay", v.fert);
  const pAcres = N * v.acres, wAcres = N * v.wacres;
  add(O, "Pasture upkeep", pAcres, "acres", pa.d, pAcres * pa.d, `MSU pasture budget at today's prices (fertilizer ${usd(pa.fert, 2)}/acre)`);
  if (wAcres > 0) add(O, "Winter annual pasture", wAcres, "acres", wa.d, wAcres * wa.d, wa.name);
  const tons = units * v.hayday * v.haydays / 2000 / (1 - v.waste / 100);
  let hAcres = 0;
  if (v.haysrc === "raise") {
    hAcres = tons / v.hyield;
    add(O, "Hay, raised", tons, "tons", ha.d / v.hyield, hAcres * ha.d, `${num(hAcres, 1)} acres at ${num(v.hyield, 2)} tons/acre; MSU hay budget at today's prices`);
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
  const mkt = income * v.comm / 100 + sold * (v.haul + 1);
  add(O, "Marketing", sold, "head", mkt / sold, mkt, `${num(v.comm, 2)}% commission, hauling and the $1 beef checkoff`);
  const acresAll = pAcres + wAcres + hAcres;
  if (v.chrent) add(O, "Land rent", acresAll, "acres", v.rent, acresAll * v.rent);
  const opBefore = rows.filter(r => r.sec === O).reduce((t, r) => t + r.total, 0);
  const interest = opBefore * v.rate / 100 * v.imonths / 12;
  add(O, "Interest on operating money", opBefore, "$", v.rate, interest, `${num(v.rate, 2)}% for ${num(v.imonths)} months`);
  const op = opBefore + interest;

  const machinery = pAcres * pa.f + wAcres * wa.f + hAcres * ha.f;
  add(F, "Forage machinery and establishment", pAcres + wAcres + hAcres, "acres", machinery / Math.max(acresAll, 1e-9), machinery, "MSU forage budgets, machinery carried forward with the BLS machinery PPI");
  add(F, "Facilities and equipment", N, "cows", v.fac, N * v.fac);
  const salvage = v.bwt * v.bp / 100, bdep = B * Math.max(0, v.bullcost - salvage) / v.byears;
  add(F, "Bull depreciation", B, "bulls", bdep / Math.max(B, 1e-9), bdep, `${usd(v.bullcost)} bull, ${usd(salvage)} salvage, ${num(v.byears)} years`);
  add(F, "Overhead, taxes and insurance", N, "cows", v.ovh, N * v.ovh);
  if (v.cowint) add(F, "Interest on cow investment", N, "cows", v.cowval * v.rate / 100, N * v.cowval * v.rate / 100);
  const own = rows.filter(r => r.sec === F).reduce((t, r) => t + r.total, 0);

  const calfLb = steers * v.swt + heifers * v.hwt;
  const other = rows.filter(r => /Cull/.test(r.item)).reduce((t, r) => t + r.total, 0);
  const c = v.comm / 100;
  const noComm = x => x - income * c;                      // costs without the commission, which moves with price
  const be = cost => calfLb > 0 ? ((noComm(cost)) / (1 - c) - other) / calfLb * 100 : NaN;
  return { rows, income, op, own, total: op + own, net: income - op - own, N, calfLb, sold,
           beOp: be(op), beAll: be(op + own), per: N, unit: "cow", tons, units };
}

// ---------- stocker budget ----------
function stocker(v) {
  const H = v.head, w1 = v.w0 + v.adg * v.days, sold = H * (1 - v.death / 100);
  const rows = [], add = (sec, item, qty, unit, price, total, note) => rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  const income = sold * w1 * v.p1 / 100;
  add(R, `Feeder ${v.cls.toLowerCase()} sold`, sold, "head", w1 * v.p1 / 100, income, `${num(w1)} lb at ${usd(v.p1, 2)}/cwt after ${num(v.death, 1)}% death loss`);
  const buy = H * v.w0 * v.p0 / 100;
  add(O, "Calves bought", H, "head", v.w0 * v.p0 / 100, buy, `${num(v.w0)} lb at ${usd(v.p0, 2)}/cwt`);
  add(O, "Freight in", H, "head", v.freight, H * v.freight);
  let acres = 0, fa = null;
  if (v.sys === "custom") add(O, "Grazing", H * v.days, "head-days", v.gday, H * v.days * v.gday);
  else { fa = forageAcre(v.sys, v.fert); acres = H / v.stock; add(O, "Grazing", acres, "acres", fa.d, acres * fa.d, `${fa.name}; MSU forage budget at today's prices`); }
  add(O, "Hay", H * v.hayt, "tons", v.hayp, H * v.hayt * v.hayp);
  const fp = P[v.feed] + v.handling, ft = H * v.slb * v.days / 2000;
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
  const cattleInt = buy * v.crate / 100 * t;
  add(O, "Interest on cattle", buy, "$", v.crate, cattleInt, `${num(v.crate, 2)}% for ${num(v.days)} days`);
  const otherOp = rows.filter(r => r.sec === O && !/Calves bought|Interest/.test(r.item)).reduce((s, r) => s + r.total, 0);
  const opInt = otherOp * v.rate / 100 * t / 2;
  add(O, "Interest on other costs", otherOp, "$", v.rate, opInt, "Half the costs borrowed for the whole time");
  const op = rows.filter(r => r.sec === O).reduce((s, r) => s + r.total, 0);
  if (fa) add(F, "Forage machinery and establishment", acres, "acres", fa.f * t, acres * fa.f * t, "Share of the yearly cost for the days owned");
  add(F, "Facilities and equipment", H, "head", v.fac, H * v.fac);
  add(F, "Overhead and insurance", H, "head", v.ovh, H * v.ovh);
  const own = rows.filter(r => r.sec === F).reduce((s, r) => s + r.total, 0);
  const total = op + own, c = v.comm / 100, saleLb = sold * w1;
  const beSale = (total - income * c) / (1 - c) / saleLb * 100;
  const gain = saleLb - H * v.w0;
  return { rows, income, op, own, total, net: income - total, N: H, sold, w1,
           beSale, cog: (total - buy - cattleInt) / gain * 100, per: H, unit: "head" };
}
function maxBuy(v) {   // purchase price that breaks even: net is linear in it
  const a = stocker({ ...v, p0: 0 }).net, b = stocker({ ...v, p0: 100 }).net;
  return a / (a - b) * 100;
}

// ---------- retained ownership budget ----------
function retained(v) {
  const H = v.head, r = roDates(v), sold = H * (1 - v.death / 100), t = r.dof / 365;
  const rows = [], add = (sec, item, qty, unit, price, total, note) => rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs";
  const income = sold * v.outwt * v.sp / 100;
  add(R, `Fed ${v.cls.toLowerCase()} sold`, sold, "head", v.outwt * v.sp / 100, income, `${num(v.outwt)} lb at ${usd(v.sp, 2)}/cwt after ${num(v.death, 2)}% death loss`);
  const wn = weanNet(v), calves = H * wn;
  add(O, "Calves at their weaning value", H, "head", wn, calves, `What they would have netted at a Mississippi auction in ${MONTHS_LONG[v.wmonth]}: ${num(v.ww)} lb at ${usd(v.wp, 2)}/cwt`);
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
  const cBase = calves + H * v.freight, cInt = cBase * v.crate / 100 * t;
  add(O, "Interest on the calves", cBase, "$", v.crate, cInt, `${num(v.crate, 2)}% for ${num(r.dof)} days, on the calves and trucking`);
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
  const rows = [], add = (sec, item, qty, unit, price, total, note) => rows.push({ sec, item, qty, unit, price, total, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs";
  [["halves", s.h, v.ph, 2], ["quarters", s.q, v.pq, 4], ["wholes", s.w, v.pw, 1]].forEach(([name, sh, pr, n]) => {
    if (sh <= 0) return;
    const l = lbs * sh / 100;
    add(R, `Beef sold as ${name}`, l, "lb", pr, l * pr, `${num(sold * sh / 100 * n, 1)} ${name} of about ${num(hang / n)} lb hanging`);
  });
  const income = rows.reduce((x, r) => x + r.total, 0);
  const cattle = H * v.w0 * v.p0 / 100;
  add(O, "Calves at their starting value", H, "head", v.w0 * v.p0 / 100, cattle, `${num(v.w0)} lb at ${usd(v.p0, 2)}/cwt; your own calves are charged what they'd bring at auction`);
  const avgW = (v.w0 + v.w1) / 2;
  if (v.conc > 0) {
    const m = mix(v), tons = H * avgW * v.conc / 100 * days / 2000;
    add(O, "Grain mix", tons, "tons", m.price + v.handling, tons * (m.price + v.handling), `${num(avgW * v.conc / 100, 1)} lb a head a day for ${num(days)} days`);
  }
  const ht = H * v.hayday * days / 2000;
  if (ht > 0) add(O, "Hay", ht, "tons", v.hayp, ht * v.hayp);
  const pa = forageAcre("pasture", v.fert), wa = forageAcre(v.wsys, v.fert);
  const pAc = H * v.pacres, wAc = H * v.wacres, pShare = Math.min(1, t);
  if (pAc > 0) add(O, "Permanent pasture", pAc, "acres", pa.d * pShare, pAc * pa.d * pShare, `MSU pasture budget at today's prices, for ${num(days)} days`);
  if (wAc > 0) add(O, "Winter annual pasture", wAc, "acres", wa.d, wAc * wa.d, `${wa.name}; one season`);
  const ml = H * v.minoz / 16 * days;
  add(O, "Salt and mineral", ml, "lb", v.minp, ml * v.minp);
  add(O, "Vet and medicine", H, "head", v.vet, H * v.vet);
  add(O, "Labor", H * v.hrs, "hours", v.wage, H * v.hrs * v.wage);
  add(O, "Fuel", H * v.gal, "gal", P.diesel, H * v.gal * P.diesel);
  add(O, "Hauling to the processor", sold, "head", v.haulp, sold * v.haulp);
  if (v.pay === "you") add(O, "Processing", sold, "head", v.kill + v.cw * hang, sold * (v.kill + v.cw * hang), `${usd(v.kill)} harvest fee and ${usd(v.cw, 2)}/lb hanging to cut, wrap and freeze`);
  add(O, "Advertising, insurance and permits", H, "head", v.mktg, H * v.mktg);
  const rentAc = pAc + (v.wsys === "ryegrass" ? wAc : 0);
  if (v.chrent && rentAc > 0) add(O, "Land rent", rentAc, "acres", v.rent * pShare, rentAc * v.rent * pShare, `${usd(v.rent)}/acre/year for ${num(days)} days`);
  const cInt = cattle * v.crate / 100 * t;
  add(O, "Interest on cattle", cattle, "$", v.crate, cInt, `${num(v.crate, 2)}% for ${num(days)} days`);
  const other = rows.filter(r => r.sec === O && !/Calves at|Interest|Processing|to the processor/.test(r.item)).reduce((x, r) => x + r.total, 0);
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
  st: ["p0", "p1", "hayp", "wage", "crate", "rate", "rent"],
  ro: ["wp", "ration", "fut", "basis", "sp", "cogq", "crate", "rate"],
  fb: ["p0", "hayp", "wage", "crate", "rate", "rent", "ph", "pq", "pw"],
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
  const today = D.cattle.cows, base = today["Boner 80-85%"] || Object.values(today)[0];
  const cows = {};
  Object.entries(today).forEach(([g, c]) => { cows[g] = { ...c, price: rec.cow * c.price / base.price }; });
  const ppi = { ...D.ppi };
  Object.entries(rec.ppi).forEach(([k, r]) => { ppi[k] = { ...ppi[k], ratio: r }; });
  D = { ...D, ppi, counties: [], cattle: { ...D.cattle, slide: rec.slide, slide_dates: [`${rec.m}-01`, `${rec.m}-28`], cows, bulls: { price: rec.bull } } };
  Object.assign(P, rec.P);
  try { return fn(); }
  finally { D = saveD; Object.keys(P).forEach(k => delete P[k]); Object.assign(P, saveP); }
}
function histValues(st, extra = {}) {           // the form's values under the current (historical) prices
  const typed = { ...st.typed, season: 0, ...extra };
  (HIST_MARKET[st.key] || []).forEach(k => { if (!(k in extra)) delete typed[k]; });
  if ("county" in typed) typed.county = "";
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
        return { net: r.net / r.N, beOp: r.beOp, beAll: r.beAll, price: v.sp, op: r.op / r.N, income: r.income / r.N }; });
    } else if (st.key === "st") {        // bought in the purchase month, sold days later at that month's price
      const buy = by[ym(y, v0.bmonth)], n = Math.round(v0.days / 30.4);
      const [sy, sm] = shiftMonth(y, v0.bmonth, n), sale = by[ym(sy, sm)];
      const win = histWindow(by, y, v0.bmonth, 0, Math.max(n - 1, 0));
      if (!buy || !sale || !buy.slide[v0.cls] || !sale.slide[v0.cls]) continue;
      const w1 = v0.w0 + v0.adg * v0.days, p1 = withHist(sale, () => slide(v0.cls, w1));
      row = withHist(histAverage(win, buy), () => { const v = histValues(st, { p1 }); const r = stocker(v);
        return { net: r.net / r.N, be: r.beSale, buy: v.p0, price: v.p1, cog: r.cog }; });
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
        return { be: r.beHang, calf: v.p0 }; });
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
  const mkt = line(/^Marketing/), bdep = line(/^Bull depreciation/);
  return { v, r, costPerCow: (r.total - mkt) / r.N, upkeep: (r.total - mkt - bdep) / r.N,
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
  return `Today's ${usd(b.price, 2)}/cwt from your Cow-calf budget` +
    (h ? `. Calves this weight averaged ${usd(h.avg, 2)}/cwt in ${MONTHS_LONG[b.v.month]} over ${h.y0}–${h.y1}; prices this high may not last a cow's lifetime` : "");
}
const PP = [
  { g: "Purchase", open: true, f: [
    ["kind", "What you're buying", "", "cow", { wide: true, show: () => false, select: [["cow", "Bred cow"], ["heifer", "Bred heifer"], ["bull", "Bull"]] }],
    ["head", "Head bought", "head", v => isBull(v) ? 1 : 10, { step: 1 }],
    ["price", "Purchase price", "$/head", v => ({ cow: 2750, heifer: 3500, bull: 6500 })[v.kind], { step: 25, src: () => "Enter your price; the starting number is a placeholder" }],
    ["extra", "Trucking, testing and other purchase costs", "$/head", 25, { step: 5, src: () => "A starting guess" }],
    ["years", "Years in your herd", "years", v => ({ cow: 5, heifer: 8, bull: 4 })[v.kind], { step: 1,
      src: v => ({ cow: "A bred cow bought at 4 to 6 years old, kept to about 10", heifer: "Calves at 2, kept to about 10", bull: "Years of service" })[v.kind] }],
    ["death", "Death loss per year", "%", v => isBull(v) ? 3 : 1.5, { step: .5, src: v => isBull(v) ? "Injury and death; a starting guess" : "" }],
    ["rate", "Interest rate (your cost of money)", "%", () => P.cattle_rate, { step: .05, src: () => priceSrc("cattle_rate") }],
  ]},
  { g: "Calves", open: true, f: [
    ["cows", "Cows he breeds each year", "cows", 25, { step: 1, show: isBull }],
    ["wean", "Calves weaned per cow exposed", "%", () => ccBase().v.wean, { step: 1, src: () => "From your Cow-calf budget" }],
    ["wean1", "First calf weaned", "%", v => Math.max(0, v.wean - 5), { step: 1, show: v => v.kind === "heifer", src: () => "First-calf heifers often wean a few percent fewer" }],
    ["cwt", "Calf sale weight", "lb", () => Math.round(ccBase().cwt / 5) * 5, { step: 10, src: () => "Average of your Cow-calf steer and heifer weights" }],
    ["cp", "Calf price you expect over these years", "$/cwt", () => ccBase().price, { step: 1, src: v => calfPriceSrc(v) }],
    ["epd", "Weaning weight EPD advantage over your current bulls", "lb", 0, { step: 5, show: isBull, src: () => "Extra weaning weight you expect per calf; 0 leaves genetics out" }],
    ["comm", "Commission when calves and culls sell", "%", 3, { step: .25 }],
    ["haul", "Hauling and checkoff per head sold", "$/head", 7, { step: 1 }],
  ]},
  { g: "Yearly costs", open: true, f: [
    ["cost", "Yearly cost to keep a cow", "$/cow", () => ccBase().costPerCow, { step: 10, show: isFemale, src: () => "Your Cow-calf budget's costs per cow, without marketing" }],
    ["bcost", "Yearly cost to keep the bull", "$/bull", () => 1.4 * ccBase().upkeep, { step: 10, show: isBull, src: () => "1.4 times your Cow-calf costs per cow, as that budget counts a bull" }],
  ]},
  { g: "When culled", f: [
    ["cullwt", "Weight when culled", "lb", v => isBull(v) ? ccBase().v.bwt : ccBase().v.cwt_, { step: 25 }],
    ["cullp", "Cull price", "$/cwt", v => isBull(v) ? ccBase().v.bp : ccBase().v.cp, { step: 1, src: v => isBull(v) ? "Today's slaughter bull price from your Cow-calf budget" : "Today's cull cow price from your Cow-calf budget" }],
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
  const rows = [], add = (sec, item, qty, unit, price, total, note) => rows.push({ sec, item, qty, unit, price, total: total * H, note });
  const R = "Income", O = "Operating costs", F = "Ownership costs", label = bull ? "bull" : "cow";
  if (bull) { if (v.epd > 0) add(R, "Extra calf value from his genetics", calves * H, "calves", v.epd / 100 * v.cp * (1 - c), inc, `${num(v.epd)} lb more per calf at ${usd(v.cp, 2)}/cwt`); }
  else add(R, "Calves sold", calves * H, "calves", calfNet, inc, `${num(v.cwt)} lb at ${usd(v.cp, 2)}/cwt over ${L} years, less commission and hauling`);
  add(R, "Cull value at the end", alive * H, "head", cullNet, salv, `${num(v.cullwt)} lb at ${usd(v.cullp, 2)}/cwt after ${num(v.death, 1)}% death loss a year`);
  add(O, bull ? "Yearly upkeep" : "Yearly costs", years0 * H, `${label}-years`, bull ? v.bcost : v.cost, cost);
  add(F, "Purchase price", H, "head", v.price, v.price);
  if (v.extra) add(F, "Trucking, testing and other purchase costs", H, "head", v.extra, v.extra);
  rows.push({ sec: F, item: "Interest (your cost of money)", qty: buy * H, unit: "$", price: v.rate, total: interest * H,
              note: `${num(v.rate, 2)}% a year over ${L} years: the gap between the cash totals and their value today` });
  const sum = sec => rows.filter(x => x.sec === sec).reduce((t, x) => t + x.total, 0);
  const income = sum(R), op = sum(O), own = sum(F);
  let irr = null;                                     // rate that makes the purchase break even
  const npvAt = rr => years.reduce((t, y) => t + y.net / Math.pow(1 + rr, y.t), -buy);
  if (npvAt(-0.5) > 0 && npvAt(1) < 0) { let lo = -0.5, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (npvAt(m) > 0) lo = m; else hi = m; } irr = (lo + hi) / 2; }
  const crf = r > 0 ? r / (1 - Math.pow(1 + r, -L)) : 1 / L;
  const pvSalv = salv * disc(L), annualCost = (buy + pvCost - pvSalv) * crf;
  const perYearCalves = bull ? v.cows * v.wean / 100 : v.wean / 100;
  return { rows, income, op, own, total: op + own, net: income - op - own, N: H, per: H, unit: bull ? "bull" : KIND_NAME[v.kind].toLowerCase().replace("bred ", ""),
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
      if (/^Cull (cows|bulls)/.test(it)) return at(v.tcull);
      if (/^Pasture upkeep/.test(it)) return at(v.tpast);
      if (/^Winter annual/.test(it)) return at(v.twin);
      if (/^Hay/.test(it)) return at(v.thay);
      if (/^Supplement/.test(it)) return run(v.tsupp, Math.max(1, Math.round(v.cdays / 30.4)));
      if (/^Vet/.test(it)) return [[col(v.tvet), .5], [col(v.month), .5]];
      if (/^Breeding/.test(it)) return at(v.tvet + 2);
      if (/^Land rent/.test(it)) return at(v.trent);
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
      if (/^Calves bought|^Freight in|^Processing/.test(it)) return at(0);
      if (/^Grazing/.test(it)) return annual ? at(plant) : owned();
      if (/sold$|^Marketing|^Interest/.test(it)) return at(n);
      return owned();                                     // hay, supplement, mineral, labor, fuel, rent, overhead
    };
  }
  const lines = [], nonCash = [];
  r.rows.forEach(row => {
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
