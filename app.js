// Apply any in-app edits (localStorage) over the plan.js defaults, BEFORE
// anything reads window.PLAN. This is what lets you enter your own numbers.
try { const ov = JSON.parse(localStorage.getItem("rv-plan") || "null"); if (ov) Object.assign(window.PLAN, ov); } catch (e) { /* ignore corrupt override */ }

const APP_VERSION = "1.1.0";
const P = window.PLAN;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt$ = n => "$" + Math.round(n).toLocaleString("en-US");
const short$ = v => v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + Math.round(v / 1e3) + "k" : "$" + Math.round(v);
const pct = v => (v * 100).toFixed(1) + "%";
const reduceMotion = matchMedia("(prefers-reduced-motion:reduce)").matches;

const prim = P.people[0];
const totalSaved = P.accounts.reduce((s, a) => s + a.balance, 0);
const totalContrib = P.accounts.reduce((s, a) => s + a.contrib, 0);
const monthlyExpense = P.expenses.essential + P.expenses.nonEssential;
const baseSalary = P.people.reduce((s, p) => s + p.income, 0);
const A = P.assumptions || {};
// Share of savings that is tax-deferred — only these withdrawals get taxed.
const deferredBal = P.accounts.filter(a => a.tax === "Tax deferred").reduce((s, a) => s + a.balance, 0);
const deferredFrac = totalSaved > 0 ? deferredBal / totalSaved : 0;

const defaults = {
  salary1: P.people[0].income,
  salary2: (P.people[1] && P.people[1].income) || 0,
  contribRate: A.contribRate != null ? A.contribRate : (baseSalary ? totalContrib / baseSalary : 0),
  raise: A.salaryGrowth || 0,
  rate: P.returns.base,
  retireAge: prim.retireAge,
  monthly: monthlyExpense,
  taxRate: A.retirementTaxRate != null ? A.retirementTaxRate : 0.15,
  ssMonthly: A.ssMonthly || 0,
  ssStartAge: A.ssStartAge || 67,
  coastFrom: prim.retireAge,
  volatility: P.returns.volatility != null ? P.returns.volatility : 0.12,
  swr: (P.coast && P.coast.swr) || 0.04
};
const defaultMethod = (P.coast && P.coast.method) || "deplete";
let state = { ...defaults, coastMethod: defaultMethod, ...parseHash() };
let activeTab = "projection";

function parseHash() {
  const out = {};
  const q = new URLSearchParams(location.hash.slice(1));
  for (const k in defaults) if (q.has(k)) { const v = +q.get(k); if (!Number.isNaN(v)) out[k] = v; }
  if (q.get("method") === "swr" || q.get("method") === "deplete") out.coastMethod = q.get("method");
  return out;
}
function writeHash() {
  const q = new URLSearchParams();
  for (const k in defaults) if (typeof state[k] === "number" && state[k] !== defaults[k]) q.set(k, +(+state[k]).toFixed(4));
  if (state.coastMethod !== defaultMethod) q.set("method", state.coastMethod);
  if (activeTab !== "projection") q.set("tab", activeTab);
  const h = q.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}

// --- Retirement cashflow (shared by every model) ------------------------
// Gross annual withdrawal = spending minus Social Security, grossed up for the
// tax owed on the tax-deferred share. One source of truth so the deterministic
// projection, Monte Carlo, and Coast FIRE all agree.
const taxGross = s => (1 - deferredFrac) + deferredFrac / (1 - Math.min(0.9, s.taxRate));
function grossNeed(s, age) {
  const ss = age >= s.ssStartAge ? s.ssMonthly * 12 : 0;
  return Math.max(0, s.monthly * 12 - ss) * taxGross(s);
}

// --- Deterministic projection (today's dollars) -------------------------
function project(realRate, o = {}) {
  const s = { ...state, ...o };
  const years = prim.planToAge - prim.age, ytr = s.retireAge - prim.age, coastAge = Math.min(s.coastFrom, s.retireAge);
  let salary = s.salary1 + s.salary2, bal = totalSaved, shortfallYear = null, shortfallAge = null;
  const pts = [];
  for (let y = 0; y <= years; y++) {
    const age = prim.age + y;
    pts.push({ year: P.startYear + y, age, bal: Math.max(bal, 0) });
    if (y < ytr) { bal = bal * (1 + realRate) + (age < coastAge ? salary * s.contribRate : 0); salary *= (1 + s.raise); }
    else { bal = bal * (1 + realRate) - grossNeed(s, age); if (bal < 0 && shortfallYear === null) { shortfallYear = P.startYear + y + 1; shortfallAge = age + 1; } }
  }
  return { pts, shortfallYear, shortfallAge, end: Math.max(pts.at(-1).bal, 0) };
}
const endAt = o => project(state.rate + (o.rateBump || 0), o).end;

// --- Monte Carlo (normal real returns) ----------------------------------
function mulberry32(seed) {
  return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function mkGauss() { const rng = mulberry32((P.sim && P.sim.seed) || 1); return () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }; }
const TRIALS = () => (P.sim && P.sim.trials) || 500;

// Success probability only (no path storage) — used for the impact table.
function successProbOnly(o = {}) {
  const s = { ...state, ...o }, g = mkGauss(), trials = TRIALS();
  const years = prim.planToAge - prim.age, ytr = s.retireAge - prim.age, coastAge = Math.min(s.coastFrom, s.retireAge);
  let success = 0;
  for (let t = 0; t < trials; t++) {
    let bal = totalSaved, salary = s.salary1 + s.salary2, ok = true;
    for (let y = 0; y < years; y++) {
      const age = prim.age + y, r = s.rate + (o.rateBump || 0) + s.volatility * g();
      if (y < ytr) { bal = bal * (1 + r) + (age < coastAge ? salary * s.contribRate : 0); salary *= (1 + s.raise); }
      else { bal = bal * (1 + r) - grossNeed(s, age); if (bal < 0) { ok = false; break; } }
    }
    if (ok) success++;
  }
  return Math.round(success / trials * 100);
}

// Full simulation: 10th / 50th / 90th percentile balance paths + probability.
function simulate(st) {
  const s = st || state, g = mkGauss(), trials = TRIALS();
  const years = prim.planToAge - prim.age, ytr = s.retireAge - prim.age, coastAge = Math.min(s.coastFrom, s.retireAge);
  const byYear = Array.from({ length: years + 1 }, () => new Float64Array(trials));
  let success = 0;
  for (let t = 0; t < trials; t++) {
    let bal = totalSaved, salary = s.salary1 + s.salary2, ok = true;
    for (let y = 0; y <= years; y++) {
      byYear[y][t] = Math.max(bal, 0);
      if (y < years) {
        const age = prim.age + y, r = s.rate + s.volatility * g();
        if (y < ytr) { bal = bal * (1 + r) + (age < coastAge ? salary * s.contribRate : 0); salary *= (1 + s.raise); }
        else { bal = bal * (1 + r) - grossNeed(s, age); if (bal < 0 && ok) ok = false; }
      }
    }
    if (ok) success++;
  }
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  const p10 = [], p50 = [], p90 = [], ages = [];
  for (let y = 0; y <= years; y++) {
    const a = byYear[y]; a.sort();
    p10.push(q(a, 0.10)); p50.push(q(a, 0.50)); p90.push(q(a, 0.90));
    ages.push({ year: P.startYear + y, age: prim.age + y });
  }
  let p10Short = null;
  for (let y = ytr; y <= years; y++) if (p10[y] <= 0) { p10Short = prim.age + y; break; }
  return { p10, p50, p90, ages, prob: Math.round(success / trials * 100), end: p50[years], p10Short };
}

// --- Coast FIRE ----------------------------------------------------------
function coastFire(st) {
  const s = st || state, r = s.rate, ytr = s.retireAge - prim.age, retYears = prim.planToAge - s.retireAge;
  let target;
  if (s.coastMethod === "swr") {
    const steadyNet = Math.max(0, s.monthly * 12 - s.ssMonthly * 12) * taxGross(s);
    target = s.swr > 0 ? steadyNet / s.swr : Infinity;
  } else {
    target = 0;
    for (let y = 0; y < retYears; y++) { const g = grossNeed(s, s.retireAge + y); target += r > 0 ? g / Math.pow(1 + r, y) : g; }
  }
  const coastNow = ytr > 0 ? target / Math.pow(1 + r, ytr) : target;
  let bal = totalSaved, salary = s.salary1 + s.salary2, coastAge = null;
  for (let y = 0; y <= ytr; y++) { if (bal * Math.pow(1 + r, ytr - y) >= target - 0.5) { coastAge = prim.age + y; break; } bal = bal * (1 + r) + salary * s.contribRate; salary *= (1 + s.raise); }
  return { target, coastNow, coastAge, reached: totalSaved >= coastNow, annualContrib: (s.salary1 + s.salary2) * s.contribRate };
}

// --- Canvas helpers ------------------------------------------------------
function setup(cv) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}
const COL = { med: "#5b8cff", hi: "#36d399", lo: "#fbbd23" };
const cv = $("#chart"), tip = $("#tip"), gaugeCv = $("#coastGauge");
let simLatest = null, cursorIdx = null, plot = null;

// --- Animation engine ----------------------------------------------------
const D = { p10: null, p50: null, p90: null, prob: 0, coastPct: 0, coastNow: 0, end: 0 };
const T = { p10: null, p50: null, p90: null, prob: 0, coastPct: 0, coastNow: 0, end: 0 };
let rafId = null, prevKpi = { prob: null, end: null, coast: null };

function setTargets() {
  simLatest = simulate();
  const c = coastFire();
  T.p10 = simLatest.p10; T.p50 = simLatest.p50; T.p90 = simLatest.p90;
  T.prob = simLatest.prob; T.end = simLatest.end;
  T.coastNow = c.coastNow === Infinity ? 0 : c.coastNow;
  T.coastPct = c.coastNow > 0 ? Math.min(100, totalSaved / c.coastNow * 100) : 100;
  if (!D.p10) { D.p10 = T.p10.map(() => 0); D.p50 = T.p50.map(() => 0); D.p90 = T.p90.map(() => 0); }
  if (reduceMotion) { D.p10 = [...T.p10]; D.p50 = [...T.p50]; D.p90 = [...T.p90]; D.prob = T.prob; D.coastPct = T.coastPct; D.coastNow = T.coastNow; D.end = T.end; }
  return c;
}
function startAnim() { if (!rafId) rafId = requestAnimationFrame(tick); }
function tick() {
  const k = reduceMotion ? 1 : 0.22; let moving = false;
  for (const s of ["p10", "p50", "p90"]) { const d = D[s], t = T[s]; for (let i = 0; i < t.length; i++) { d[i] += (t[i] - d[i]) * k; if (Math.abs(t[i] - d[i]) > 1) moving = true; } }
  for (const key of ["prob", "coastPct", "coastNow", "end"]) { D[key] += (T[key] - D[key]) * k; if (Math.abs(T[key] - D[key]) > (key === "prob" || key === "coastPct" ? 0.1 : 1)) moving = true; }
  drawChart(); drawGauge(D.coastPct); updateKpis();
  if (moving) rafId = requestAnimationFrame(tick);
  else { for (const s of ["p10", "p50", "p90"]) D[s] = [...T[s]]; D.prob = T.prob; D.coastPct = T.coastPct; D.coastNow = T.coastNow; D.end = T.end; drawChart(); drawGauge(D.coastPct); updateKpis(); rafId = null; }
}

// --- KPI bar -------------------------------------------------------------
function updateKpis() {
  const prob = Math.round(D.prob), pe = $("#kpi-prob");
  pe.textContent = prob + "%"; pe.className = "kpi-v " + (prob >= 80 ? "good" : prob >= 50 ? "warn" : "bad");
  $("#kpi-end").textContent = short$(D.end);
  $("#kpi-coast").textContent = short$(D.coastNow);
  const se = $("#kpi-short"); se.textContent = simLatest.p10Short ? "age " + simLatest.p10Short : "none";
  se.className = "kpi-v " + (simLatest.p10Short ? "bad" : "good");
  flashIfChanged("prob", prob, pe.parentElement);
  flashIfChanged("end", Math.round(D.end / 1e4), $("#kpi-end").parentElement);
  flashIfChanged("coast", Math.round(D.coastNow / 1e4), $("#kpi-coast").parentElement);
}
function flashIfChanged(key, val, el) {
  if (prevKpi[key] !== null && prevKpi[key] !== val && !reduceMotion) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  prevKpi[key] = val;
}

// --- Projection chart (percentile bands) --------------------------------
function drawChart() {
  if (!cv.clientWidth || !simLatest) return;
  const { ctx, W, H } = setup(cv);
  const pad = { l: 54, r: 60, t: 14, b: 24 }, ages = simLatest.ages;
  const maxBal = Math.max(1, ...T.p90);
  const x0 = ages[0].year, x1 = ages.at(-1).year;
  const X = yr => pad.l + (yr - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = v => H - pad.b - v / maxBal * (H - pad.t - pad.b);
  plot = { pad, W, H, x0, x1, X, Y };

  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa6c4"; ctx.strokeStyle = "#232c4e"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = maxBal * i / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.textAlign = "right"; ctx.fillText(short$(v), pad.l - 6, y + 3); }
  ctx.textAlign = "center";
  for (let yr = x0; yr <= x1; yr += Math.ceil((x1 - x0) / 6)) ctx.fillText(yr, X(yr), H - 7);

  // 10th–90th percentile band
  ctx.beginPath();
  D.p90.forEach((b, i) => i ? ctx.lineTo(X(ages[i].year), Y(b)) : ctx.moveTo(X(ages[0].year), Y(b)));
  for (let i = D.p10.length - 1; i >= 0; i--) ctx.lineTo(X(ages[i].year), Y(D.p10[i]));
  ctx.closePath(); ctx.fillStyle = "rgba(91,140,255,0.12)"; ctx.fill();

  mark(ctx, X(P.startYear + (state.retireAge - prim.age)), "retire " + state.retireAge, "#f87272", pad, H);
  if (state.coastFrom < state.retireAge) mark(ctx, X(P.startYear + (state.coastFrom - prim.age)), "coast " + state.coastFrom, "#36d399", pad, H);

  const line = (arr, color, w, dash) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath(); arr.forEach((b, i) => i ? ctx.lineTo(X(ages[i].year), Y(b)) : ctx.moveTo(X(ages[0].year), Y(b))); ctx.stroke(); ctx.setLineDash([]); };
  line(D.p90, COL.hi, 1.3, [5, 4]); line(D.p10, COL.lo, 1.3, [2, 3]); line(D.p50, COL.med, 2.6, []);

  ctx.textAlign = "left";
  [[D.p90, COL.hi], [D.p50, COL.med], [D.p10, COL.lo]].forEach(([arr, c]) => { const b = arr.at(-1); ctx.fillStyle = c; ctx.fillText(short$(b), X(x1) + 6, Y(b) + 3); });

  if (cursorIdx != null) drawCursor(ctx);
}
function mark(ctx, x, label, color, pad, H) { ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(label, x + 4, pad.t + 10); }
function drawCursor(ctx) {
  const { pad, H, X, Y } = plot, ages = simLatest.ages;
  cursorIdx = Math.max(0, Math.min(ages.length - 1, cursorIdx));
  const p = ages[cursorIdx], x = X(p.year);
  ctx.strokeStyle = "#e8ecf7"; ctx.globalAlpha = .35; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  const rows = [["p90", COL.hi, "Great (90th)"], ["p50", COL.med, "Median"], ["p10", COL.lo, "Poor (10th)"]];
  rows.forEach(([s, c]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, Y(simLatest[s][cursorIdx]), 3.5, 0, 7); ctx.fill(); });
  tip.innerHTML = `<div class="ty">${p.year} · age ${p.age}</div>` + rows.map(([s, c, n]) => `<div class="tr"><span><i class="dot" style="background:${c}"></i>${n}</span><b>${fmt$(simLatest[s][cursorIdx])}</b></div>`).join("");
  tip.classList.add("on");
  const half = tip.offsetWidth / 2;
  tip.style.left = Math.max(half, Math.min(plot.W - half, x)) + "px";
  tip.style.top = (Y(simLatest.p50[cursorIdx]) - 10) + "px";
  $("#chartLive").textContent = `${p.year}, age ${p.age}: 90th percentile ${fmt$(simLatest.p90[cursorIdx])}, median ${fmt$(simLatest.p50[cursorIdx])}, 10th percentile ${fmt$(simLatest.p10[cursorIdx])}.`;
}
function clearCursor() { cursorIdx = null; tip.classList.remove("on"); drawChart(); }
function cursorFromX(clientX) { if (!plot) return; const rect = cv.getBoundingClientRect(); const yr = plot.x0 + (clientX - rect.left - plot.pad.l) / (rect.width - plot.pad.l - plot.pad.r) * (plot.x1 - plot.x0); cursorIdx = Math.round(yr - plot.x0); drawChart(); }
cv.addEventListener("pointermove", e => cursorFromX(e.clientX));
cv.addEventListener("pointerdown", e => cursorFromX(e.clientX));
cv.addEventListener("pointerleave", clearCursor);
cv.addEventListener("blur", clearCursor);
cv.addEventListener("keydown", e => {
  const n = simLatest ? simLatest.ages.length : 0; if (!n) return;
  if (cursorIdx == null) cursorIdx = Math.floor(n / 2);
  if (e.key === "ArrowRight") cursorIdx++; else if (e.key === "ArrowLeft") cursorIdx--;
  else if (e.key === "Home") cursorIdx = 0; else if (e.key === "End") cursorIdx = n - 1;
  else if (e.key === "Escape") { clearCursor(); return; } else return;
  e.preventDefault(); drawChart();
});

// --- Coast gauge ---------------------------------------------------------
function drawGauge(pctVal) {
  if (!gaugeCv.clientWidth) return;
  const { ctx, W, H } = setup(gaugeCv);
  const cx = W / 2, cy = H - 14, rad = Math.min(W / 2 - 16, H - 28), a0 = Math.PI, a1 = 2 * Math.PI, p = Math.max(0, Math.min(1, pctVal / 100));
  ctx.lineWidth = 14; ctx.lineCap = "round"; ctx.strokeStyle = "#1b2340"; ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
  const g = ctx.createLinearGradient(cx - rad, 0, cx + rad, 0); g.addColorStop(0, "#36d399"); g.addColorStop(1, "#5b8cff");
  ctx.strokeStyle = p >= 1 ? "#36d399" : g; ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a0 + (a1 - a0) * p); ctx.stroke();
  ctx.fillStyle = "#e8ecf7"; ctx.textAlign = "center"; ctx.font = "700 26px system-ui"; ctx.fillText(Math.round(pctVal) + "%", cx, cy - rad * 0.28);
  ctx.fillStyle = "#9aa6c4"; ctx.font = "12px system-ui"; ctx.fillText("of Coast FIRE number", cx, cy - rad * 0.28 + 18);
}

// --- Donuts --------------------------------------------------------------
function drawDonut(canvasEl, entries, palette, progress) {
  if (!canvasEl.clientWidth) return;
  const { ctx, W, H } = setup(canvasEl);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6, r = R * 0.58, total = entries.reduce((s, e) => s + e[1], 0) || 1;
  let a = -Math.PI / 2;
  entries.forEach(([, v], i) => { const ang = v / total * 2 * Math.PI * progress; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a, a + ang); ctx.closePath(); ctx.fillStyle = palette[i % palette.length]; ctx.fill(); a += ang; });
  ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.globalCompositeOperation = "source-over";
}
function donutLegend(entries, palette) { return entries.map(([k, v], i) => `<div class="kv"><span><i class="dot" style="background:${palette[i % palette.length]}"></i>${esc(k)}</span><span>${v}%</span></div>`).join(""); }
let assetEntries, taxEntries;
const ASSET_PAL = ["#5b8cff", "#8b6bff", "#36d399", "#fbbd23", "#9aa6c4"], TAX_PAL = ["#5b8cff", "#36d399", "#fbbd23"];
function animateDonuts() { let p = 0; const step = () => { p = reduceMotion ? 1 : Math.min(1, p + 0.08); drawDonut($("#assetDonut"), assetEntries, ASSET_PAL, p); drawDonut($("#taxDonut"), taxEntries, TAX_PAL, p); if (p < 1) requestAnimationFrame(step); }; step(); }

// --- Coast text ----------------------------------------------------------
function renderCoast(c) {
  const rpct = (state.rate * 100).toFixed(1);
  const status = c.reached ? `✓ Past your Coast FIRE number — at ${rpct}% real return you could stop contributing today.`
    : c.coastAge != null ? `Keep contributing and you reach Coast FIRE at <b>age ${c.coastAge}</b> (${P.startYear + (c.coastAge - prim.age)}).`
      : `At ${rpct}% real return you don't reach Coast FIRE before retirement — raise contributions/returns or trim expenses.`;
  const gap = c.reached ? `<div class="kv"><span class="muted">Could redirect to today</span><span class="good">${fmt$(c.annualContrib / 12)}/mo</span></div>`
    : `<div class="kv"><span class="muted">Still to invest (lump sum)</span><span>${fmt$(Math.max(0, c.coastNow - totalSaved))}</span></div>`;
  $("#coast").innerHTML = `<p style="margin:6px 0 4px">${status}</p>
    <div class="kv"><span class="muted">You have now</span><span>${fmt$(totalSaved)}</span></div>
    <div class="kv"><span class="muted">Nest egg at retirement (${state.coastMethod === "swr" ? (state.swr * 100).toFixed(2) + "% rule" : "deplete"}, after-tax)</span><span>${fmt$(c.target)}</span></div>${gap}`;
  $("#coastNote").textContent = state.coastFrom >= state.retireAge
    ? "Contributing to retirement. Lower “stop contributing at age” to model coasting — a green marker appears on the chart."
    : `Modelling: contribute to age ${state.coastFrom}, then coast ${state.retireAge - state.coastFrom} year(s) with no new contributions.`;
}

// --- Controls ------------------------------------------------------------
function contribLabel(v) { const yr = (state.salary1 + state.salary2) * v; return pct(v) + " · " + fmt$(yr / 12) + "/mo"; }
const CONTROLS = [
  { key: "salary1", label: esc(P.people[0].name) + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) },
  { key: "salary2", label: (P.people[1] ? esc(P.people[1].name) : "Partner") + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) },
  { key: "contribRate", label: "Contribution (% of salary)", min: 0, max: 0.5, step: 0.01, fmt: contribLabel },
  { key: "raise", label: "Annual raise (real)", min: 0, max: 0.05, step: 0.005, fmt: pct },
  { key: "rate", label: "Real return / yr", min: 0, max: 0.08, step: 0.005, fmt: pct },
  { key: "volatility", label: "Market volatility (SD)", min: 0, max: 0.30, step: 0.01, fmt: pct },
  { key: "retireAge", label: "Retirement age", min: 55, max: 75, step: 1, fmt: v => v },
  { key: "monthly", label: "Monthly expenses (retire)", min: 5000, max: 20000, step: 100, fmt: v => fmt$(v) },
  { key: "taxRate", label: "Retirement tax rate (on tax-deferred)", min: 0, max: 0.37, step: 0.01, fmt: pct },
  { key: "ssMonthly", label: "Social Security / mo", min: 0, max: 8000, step: 100, fmt: v => fmt$(v) },
  { key: "ssStartAge", label: "SS start age", min: 62, max: 70, step: 1, fmt: v => v }
];
function syncOutputs() {
  CONTROLS.forEach(c => { $("#out-" + c.key).textContent = c.fmt(state[c.key]); });
  $("#out-coastFrom").textContent = state.coastFrom >= state.retireAge ? `${state.retireAge} · none` : `${state.coastFrom}`;
  $("#out-swr").textContent = pct(state.swr); $("#swrWrap").hidden = state.coastMethod !== "swr";
}
function renderControls() {
  $("#controls").innerHTML = CONTROLS.map(c => `<div class="ctl"><label for="in-${c.key}">${c.label}<output id="out-${c.key}"></output></label><input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${state[c.key]}" /></div>`).join("");
  CONTROLS.forEach(c => $("#in-" + c.key).addEventListener("input", e => { state[c.key] = +e.target.value; recompute(); }));
  $("#rateNote").innerHTML = `Shaded band = the middle 80% of ${TRIALS()} Monte-Carlo outcomes (10th–90th percentile); solid line = median. Probability counts runs that never deplete.`;
}

// --- Impact --------------------------------------------------------------
function renderImpact() {
  const baseEnd = endAt({}), baseProb = successProbOnly();
  const nudges = [
    { label: "Save 2% more of salary", o: { contribRate: state.contribRate + 0.02 } },
    { label: "Work 1 more year", o: { retireAge: state.retireAge + 1 } },
    { label: "Trim expenses $500/mo", o: { monthly: Math.max(0, state.monthly - 500) } },
    { label: "Claim $1,000/mo more SS", o: { ssMonthly: state.ssMonthly + 1000 } },
    { label: "Earn 0.5% more real return", o: { rateBump: 0.005 } }
  ];
  const dEnd = d => Math.abs(d) < 1 ? `<span class="muted">—</span>` : `<span class="${d > 0 ? "good" : "bad"}" style="font-weight:700">${d > 0 ? "+" : "−"}${short$(Math.abs(d))}</span>`;
  const dProb = d => d === 0 ? `<span class="muted">—</span>` : `<span class="${d > 0 ? "good" : "bad"}" style="font-weight:700">${d > 0 ? "+" : "−"}${Math.abs(d)} pp</span>`;
  $("#impact tbody").innerHTML = nudges.map(n => `<tr><td>${n.label}</td><td class="num">${dEnd(endAt(n.o) - baseEnd)}</td><td class="num">${dProb(successProbOnly(n.o) - baseProb)}</td></tr>`).join("");
}
function renderProjTable() {
  const ages = simLatest.ages, retIdx = state.retireAge - prim.age;
  const rows = ages.filter((p, i) => i === 0 || i === ages.length - 1 || i === retIdx || (p.year % 5 === 0));
  $("#projTable tbody").innerHTML = rows.map(p => { const i = p.age - prim.age; return `<tr><td>${p.year}${i === retIdx ? " · retire" : ""}</td><td class="num">${p.age}</td><td class="num">${fmt$(simLatest.p90[i])}</td><td class="num">${fmt$(simLatest.p50[i])}</td><td class="num">${fmt$(simLatest.p10[i])}</td></tr>`; }).join("");
}

// --- Static --------------------------------------------------------------
function renderStatic() {
  $("#asof").textContent = "as of " + P.asOf;
  $("#appver").textContent = "v" + APP_VERSION;
  $("#accounts tbody").innerHTML = P.accounts.map(a => `<tr><td>${esc(a.name)}<div class="muted" style="font-size:12px">${esc(a.custodian)}</div></td><td>${esc(a.owner)}</td><td class="num">${fmt$(a.balance)}</td><td class="num">${fmt$(a.contrib)}</td></tr>`).join("") + `<tr><td><b>Total</b></td><td></td><td class="num"><b>${fmt$(totalSaved)}</b></td><td class="num"><b>${fmt$(totalContrib)}</b></td></tr>`;
  $("#household").innerHTML = P.people.map(p => `<div class="kv"><span>${esc(p.name)} <span class="pill">age ${p.age}</span></span><span>${fmt$(p.income)}/yr</span></div><div class="kv muted"><span style="font-weight:400">${esc(p.status)} · retire ${p.retireAge} · plan to ${p.planToAge}</span><span></span></div>`).join("") + `<div class="kv"><span class="muted">Tax-deferred share of savings</span><span>${(deferredFrac * 100).toFixed(0)}%</span></div><div class="kv"><span class="muted">Net spending after SS (live)</span><span id="needVal"></span></div>`;
  assetEntries = Object.entries(P.assetMix);
  const taxSums = {}; P.accounts.forEach(a => { taxSums[a.tax] = (taxSums[a.tax] || 0) + a.balance; });
  taxEntries = Object.entries(taxSums).map(([k, v]) => [k, +(v / totalSaved * 100).toFixed(1)]);
  $("#assetLegend").innerHTML = donutLegend(assetEntries, ASSET_PAL);
  $("#taxLegend").innerHTML = donutLegend(taxEntries, TAX_PAL);
  $("#disclaimer").innerHTML = "Hypothetical, educational projections in today's dollars — not advice. Every figure is computed live. The chart and probability come from one seeded Monte Carlo (" + TRIALS() + " runs, normal real returns: mean = return slider, SD = volatility); the band is the 10th–90th percentile and the line is the median. Tax-deferred withdrawals (" + (deferredFrac * 100).toFixed(0) + "% of savings) are grossed up by the retirement tax rate; Social Security is added from your chosen start age. Normal-return Monte Carlo understates fat tails / sequence risk vs historical backtesting. Edit <code>plan.js</code> or use “Edit your numbers”.<div style=\"margin-top:8px;opacity:.8\">RetirementVault v" + APP_VERSION + "</div>";
}

// --- Coast controls ------------------------------------------------------
const coastSlider = $("#in-coastFrom"); coastSlider.min = prim.age + 1; coastSlider.max = 75; coastSlider.value = state.coastFrom;
coastSlider.addEventListener("input", e => { state.coastFrom = +e.target.value; recompute(); });
const methodSel = $("#in-coastMethod"); methodSel.value = state.coastMethod;
methodSel.addEventListener("change", e => { state.coastMethod = e.target.value; recompute(); });
const swrSlider = $("#in-swr"); swrSlider.value = state.swr;
swrSlider.addEventListener("input", e => { state.swr = +e.target.value; recompute(); });

// --- Wire up -------------------------------------------------------------
function recompute() {
  const c = setTargets();
  renderCoast(c); renderImpact(); renderProjTable(); syncOutputs(); renderMilestones(c);
  if (activeTab === "scenarios") renderScenarios();
  $("#needVal").textContent = fmt$(Math.max(0, state.monthly - state.ssMonthly)) + "/mo";
  $("#kpiLive").textContent = `Success ${T.prob}%, median assets at end ${short$(T.end)}, Coast FIRE number ${short$(T.coastNow)}.`;
  writeHash(); startAnim();
}
$("#reset").addEventListener("click", () => {
  state = { ...defaults, coastMethod: defaultMethod };
  cursorIdx = null; tip.classList.remove("on");
  renderControls(); coastSlider.value = state.coastFrom; swrSlider.value = state.swr; methodSel.value = state.coastMethod;
  recompute();
});
$("#copy").addEventListener("click", async () => {
  const b = $("#copy");
  try { await navigator.clipboard.writeText(location.href); b.textContent = "Copied ✓"; b.classList.add("ok"); setTimeout(() => { b.textContent = "Copy link"; b.classList.remove("ok"); }, 2000); }
  catch { window.prompt("Copy this link:", location.href); }
});
$("#tableToggle").addEventListener("click", e => { const t = $("#projTable"), open = t.hidden; t.hidden = !open; e.target.setAttribute("aria-expanded", String(open)); e.target.textContent = open ? "Hide table" : "Data table"; });
window.addEventListener("resize", () => { drawChart(); drawGauge(D.coastPct); drawDonut($("#assetDonut"), assetEntries, ASSET_PAL, 1); drawDonut($("#taxDonut"), taxEntries, TAX_PAL, 1); });

renderStatic();
renderControls();
recompute();

// --- Milestones ----------------------------------------------------------
function renderMilestones(c) {
  c = c || coastFire();
  const yr = age => P.startYear + (age - prim.age);
  const items = [{ age: prim.age, color: "#9aa6c4", lbl: "Today", sub: P.people.map(p => esc(p.name)).join(" & ") }];
  if (state.coastFrom < state.retireAge) items.push({ age: state.coastFrom, color: "#36d399", lbl: "Stop contributing (coast)", sub: "no new contributions after this" });
  if (c.coastAge != null) items.push({ age: c.coastAge, color: "#5b8cff", lbl: "Coast FIRE reached", sub: "current savings alone can carry you" });
  items.push({ age: state.retireAge, color: "#f87272", lbl: "Retirement", sub: "stop working, begin drawdown" });
  if (state.ssMonthly > 0) items.push({ age: state.ssStartAge, color: "#8b6bff", lbl: "Social Security starts", sub: fmt$(state.ssMonthly) + "/mo" });
  if (simLatest && simLatest.p10Short) items.push({ age: simLatest.p10Short, color: "#fbbd23", lbl: "Money runs low (10th percentile)", sub: "in a poor market" });
  items.push({ age: prim.planToAge, color: "#9aa6c4", lbl: "Plan horizon", sub: "end of projection" });
  items.sort((a, b) => a.age - b.age);
  $("#milestones").innerHTML = items.map(it => `<div class="ms"><span class="dot2" style="background:${it.color}"></span><span class="age">age ${it.age}</span><span class="lbl">${it.lbl}<div class="yr">${yr(it.age)} · ${it.sub}</div></span></div>`).join("");
}

// --- Scenarios (save / compare / load) ----------------------------------
const loadScenarios = () => { try { return JSON.parse(localStorage.getItem("rv-scenarios") || "[]"); } catch { return []; } };
const saveScenarios = a => localStorage.setItem("rv-scenarios", JSON.stringify(a));
function snapshotState() { const o = { coastMethod: state.coastMethod }; for (const k in defaults) o[k] = state[k]; return o; }
function metricsFor(sv) {
  const st = { ...defaults, coastMethod: defaultMethod, ...sv };
  const sim = simulate(st), c = coastFire(st);
  return { prob: sim.prob, end: sim.end, coast: c.coastNow === Infinity ? 0 : c.coastNow, short: sim.p10Short };
}
function renderScenarios() {
  const list = loadScenarios();
  const rows = [{ name: "Current (live)", m: metricsFor(snapshotState()), idx: -1 }]
    .concat(list.map((s, i) => ({ name: s.name, m: metricsFor(s.state), idx: i })));
  const probCell = p => `<td class="num ${p >= 80 ? "good" : p >= 50 ? "warn" : "bad"}" style="font-weight:700">${p}%</td>`;
  const body = rows.map(r => `<tr><td>${esc(r.name)}</td>${probCell(r.m.prob)}<td class="num">${short$(r.m.end)}</td><td class="num">${short$(r.m.coast)}</td><td class="num">${r.m.short ? "age " + r.m.short : "—"}</td><td class="num" style="white-space:nowrap">${r.idx < 0 ? "" : `<button class="btn" data-load="${r.idx}" style="padding:4px 10px;min-height:0">Load</button> <button class="btn" data-del="${r.idx}" aria-label="Delete scenario" style="padding:4px 10px;min-height:0">×</button>`}</td></tr>`).join("");
  $("#scenTable").innerHTML = `<table><thead><tr><th>Scenario</th><th class="num">Success</th><th class="num">Median end</th><th class="num">Coast #</th><th class="num">Shortfall</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}
$("#scenSave").addEventListener("click", () => {
  const list = loadScenarios();
  const name = ($("#scenName").value.trim()) || "Scenario " + (list.length + 1);
  list.push({ name, state: snapshotState() }); saveScenarios(list);
  $("#scenName").value = ""; renderScenarios();
});
$("#scenTable").addEventListener("click", e => {
  const load = e.target.getAttribute("data-load"), del = e.target.getAttribute("data-del");
  if (del != null) { const list = loadScenarios(); list.splice(+del, 1); saveScenarios(list); renderScenarios(); }
  else if (load != null) {
    const sv = loadScenarios()[+load]; if (!sv) return;
    state = { ...defaults, coastMethod: defaultMethod, ...sv.state };
    renderControls(); coastSlider.value = state.coastFrom; swrSlider.value = state.swr; methodSel.value = state.coastMethod;
    recompute(); renderScenarios();
  }
});

// --- Tabs (KPI bar + levers stay outside; tabs swap the main view) ------
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activate(tab) {
  if (!tab) return;
  activeTab = tab.id.replace("tab-", "");
  tabs.forEach(t => { const sel = t === tab; t.setAttribute("aria-selected", String(sel)); t.tabIndex = sel ? 0 : -1; document.getElementById(t.getAttribute("aria-controls")).hidden = !sel; });
  if (activeTab === "projection") drawChart();
  else if (activeTab === "coast") drawGauge(D.coastPct);
  else if (activeTab === "accounts") animateDonuts();
  else if (activeTab === "scenarios") renderScenarios();
  else if (activeTab === "milestones") renderMilestones();
  writeHash();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => activate(t));
  t.addEventListener("keydown", e => { let n = null; if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length]; else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length]; else if (e.key === "Home") n = tabs[0]; else if (e.key === "End") n = tabs[tabs.length - 1]; if (n) { e.preventDefault(); n.focus(); activate(n); } });
});
activate(document.getElementById("tab-" + (new URLSearchParams(location.hash.slice(1)).get("tab") || "projection")) || tabs[0]);

// --- In-app editor -------------------------------------------------------
const TAX_OPTS = ["Tax deferred", "Tax exempt", "Taxable"];
const editDlg = $("#editDlg");
function acctRow(a = { name: "", custodian: "", owner: "", balance: 0, contrib: 0, tax: "Tax deferred" }) {
  return `<div class="acctrow">
    <label class="fld">Account<input data-f="name" value="${esc(a.name)}" /></label>
    <label class="fld">Custodian<input data-f="cust" value="${esc(a.custodian)}" /></label>
    <label class="fld">Owner<input data-f="owner" value="${esc(a.owner)}" /></label>
    <label class="fld">Balance<input data-f="bal" type="number" inputmode="decimal" value="${+a.balance || 0}" /></label>
    <label class="fld">Contrib/yr<input data-f="con" type="number" inputmode="decimal" value="${+a.contrib || 0}" /></label>
    <label class="fld">Tax<select data-f="tax">${TAX_OPTS.map(o => `<option ${o === a.tax ? "selected" : ""}>${o}</option>`).join("")}</select></label>
    <button type="button" class="btn rm" aria-label="Remove account">✕</button></div>`;
}
function personBlock(i) {
  const p = P.people[i] || { name: "", age: 40, income: 0, retireAge: 65, planToAge: 95, status: "Working" };
  return `<h3>${i === 0 ? "You" : "Partner (clear the name to remove)"}</h3>
    <div class="grid3">
      <label class="fld">Name<input id="p${i}-name" value="${esc(p.name)}" /></label>
      <label class="fld">Current age<input id="p${i}-age" type="number" inputmode="numeric" value="${p.age}" /></label>
      <label class="fld">Salary / yr<input id="p${i}-income" type="number" inputmode="decimal" value="${+p.income || 0}" /></label>
      <label class="fld">Retire age<input id="p${i}-retire" type="number" inputmode="numeric" value="${p.retireAge}" /></label>
      <label class="fld">Plan to age<input id="p${i}-plan" type="number" inputmode="numeric" value="${p.planToAge}" /></label>
      <label class="fld">Status<input id="p${i}-status" value="${esc(p.status || "")}" /></label>
    </div>`;
}
function buildEditor() {
  $("#editBody").innerHTML =
    `<label class="fld" style="max-width:240px">As-of label<input id="ed-asof" value="${esc(P.asOf || "")}" /></label>` +
    personBlock(0) + personBlock(1) +
    `<h3>Accounts</h3><div id="acctRows">${P.accounts.map(a => acctRow(a)).join("")}</div>
     <button type="button" class="btn" id="addAcct" style="margin-top:4px">+ Add account</button>
     <h3>Monthly expenses in retirement (today's $)</h3>
     <div class="grid2">
       <label class="fld">Essential / mo<input id="ex-ess" type="number" inputmode="decimal" value="${+P.expenses.essential || 0}" /></label>
       <label class="fld">Non-essential / mo<input id="ex-non" type="number" inputmode="decimal" value="${+P.expenses.nonEssential || 0}" /></label>
     </div>`;
  $("#acctRows").addEventListener("click", e => { if (e.target.classList.contains("rm")) e.target.closest(".acctrow").remove(); });
  $("#addAcct").addEventListener("click", () => $("#acctRows").insertAdjacentHTML("beforeend", acctRow()));
}
const numId = id => { const el = $("#" + id); const v = el ? +el.value : NaN; return Number.isFinite(v) ? v : 0; };
const valId = id => { const el = $("#" + id); return el ? el.value.trim() : ""; };
function gatherEditor() {
  const people = [];
  [0, 1].forEach(i => {
    const name = valId(`p${i}-name`); if (!name) return;
    const age = Math.max(16, Math.min(100, numId(`p${i}-age`) || 40));
    const retireAge = Math.max(age + 1, Math.min(100, numId(`p${i}-retire`) || age + 1));
    const planToAge = Math.max(retireAge + 1, Math.min(115, numId(`p${i}-plan`) || retireAge + 1));
    people.push({ name, age, income: numId(`p${i}-income`), retireAge, planToAge, status: valId(`p${i}-status`) || "Working" });
  });
  if (!people.length) people.push({ name: "You", age: 40, income: 0, retireAge: 65, planToAge: 95, status: "Working" });
  const accounts = [...document.querySelectorAll("#acctRows .acctrow")].map(r => ({
    name: r.querySelector('[data-f=name]').value.trim() || "Account",
    custodian: r.querySelector('[data-f=cust]').value.trim(),
    owner: r.querySelector('[data-f=owner]').value.trim(),
    balance: +r.querySelector('[data-f=bal]').value || 0,
    contrib: +r.querySelector('[data-f=con]').value || 0,
    tax: r.querySelector('[data-f=tax]').value
  })).filter(a => a.balance || a.contrib);
  return { asOf: valId("ed-asof"), people, accounts, expenses: { essential: numId("ex-ess"), nonEssential: numId("ex-non") } };
}
function applyAndReload(data) {
  if (data) localStorage.setItem("rv-plan", JSON.stringify(data)); else localStorage.removeItem("rv-plan");
  history.replaceState(null, "", location.pathname + location.search);
  location.reload();
}
$("#editBtn").addEventListener("click", () => { buildEditor(); editDlg.showModal(); });
$("#editSave").addEventListener("click", () => applyAndReload(gatherEditor()));
$("#editReset").addEventListener("click", () => applyAndReload(null));
$("#editForm").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName === "INPUT") e.preventDefault(); });
