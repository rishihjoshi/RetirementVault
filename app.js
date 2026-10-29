const P = window.PLAN;
const $ = s => document.querySelector(s);
const fmt$ = n => "$" + Math.round(n).toLocaleString("en-US");

const prim = P.people[0];                              // drives the timeline
const totalSaved = P.accounts.reduce((s, a) => s + a.balance, 0);
const totalContrib = P.accounts.reduce((s, a) => s + a.contrib, 0);
const monthlyExpense = P.expenses.essential + P.expenses.nonEssential;
const baseSalary = P.people.reduce((s, p) => s + p.income, 0);
const A = P.assumptions || {};

// Live, editable state (seeded from the snapshot). Rates stored as fractions.
const defaults = {
  salary1: P.people[0].income,
  salary2: (P.people[1] && P.people[1].income) || 0,
  contribRate: A.contribRate != null ? A.contribRate : (baseSalary ? totalContrib / baseSalary : 0),
  raise: A.salaryGrowth || 0,
  rate: P.returns.base,
  retireAge: prim.retireAge,
  monthly: monthlyExpense,
  other: A.otherMonthlyIncome || 0,
  coastFrom: prim.retireAge,          // age to stop contributing; = retireAge means "never coast"
  volatility: P.returns.volatility != null ? P.returns.volatility : 0.12,
  swr: (P.coast && P.coast.swr) || 0.04
};
const defaultMethod = (P.coast && P.coast.method) || "deplete";   // non-numeric → tracked separately
let state = { ...defaults, coastMethod: defaultMethod, ...parseHash() };
let activeTab = "overview";

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
  if (activeTab !== "overview") q.set("tab", activeTab);
  const h = q.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}

// --- Projection model (today's dollars) ---------------------------------
// While working: contributions = salary * contribRate, until the coast age.
// After coasting (or in retirement): no new contributions; in retirement draw down.
function project(realRate, o = {}) {
  const s = { ...state, ...o };
  const years = prim.planToAge - prim.age;
  const ytr = s.retireAge - prim.age;
  const coastAge = Math.min(s.coastFrom, s.retireAge);   // can't contribute past retirement
  let salary = s.salary1 + s.salary2;
  let bal = totalSaved, shortfallYear = null, shortfallAge = null;
  const pts = [];
  for (let y = 0; y <= years; y++) {
    const age = prim.age + y;
    pts.push({ year: P.startYear + y, age, bal: Math.max(bal, 0) });
    const working = y < ytr;
    if (working) {
      const contributing = age < coastAge;
      bal = bal * (1 + realRate) + (contributing ? salary * s.contribRate : 0);
      salary *= (1 + s.raise);
    } else {
      const net = Math.max(0, (s.monthly - s.other) * 12);
      bal = bal * (1 + realRate) - net;
      if (bal < 0 && shortfallYear === null) { shortfallYear = P.startYear + y + 1; shortfallAge = age + 1; }
    }
  }
  return { pts, shortfallYear, shortfallAge, end: Math.max(pts[pts.length - 1].bal, 0) };
}

const projectWith = (offset, o = {}) => project(state.rate + offset + (o.rateBump || 0), o);
function scenarios() {
  return {
    average: projectWith(P.returns.average),
    below: projectWith(P.returns.below),
    sig: projectWith(P.returns.significantlyBelow)
  };
}
// Snapshot baselines (fixed at page defaults) for the "vs snapshot" deltas.
const BASE = {
  avg: project(defaults.rate + P.returns.average, defaults).end,
  below: project(defaults.rate + P.returns.below, defaults).end
};

// --- Monte Carlo probability of success ---------------------------------
// Live replacement for the old frozen 86%. Each trial draws annual real returns
// from a normal(mean = return slider, sd = volatility slider) and follows the
// exact same contribute/coast/draw-down rules as project(). Seeded so the same
// inputs always give the same number (no flicker on each drag).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function successProbability() {
  const trials = (P.sim && P.sim.trials) || 500;
  const rng = mulberry32((P.sim && P.sim.seed) || 1);
  const gauss = () => {                                     // Box–Muller
    let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const years = prim.planToAge - prim.age, ytr = state.retireAge - prim.age;
  const coastAge = Math.min(state.coastFrom, state.retireAge);
  const net = Math.max(0, (state.monthly - state.other) * 12);
  let success = 0;
  for (let t = 0; t < trials; t++) {
    let bal = totalSaved, salary = state.salary1 + state.salary2, ok = true;
    for (let y = 0; y < years; y++) {
      const r = state.rate + state.volatility * gauss();
      if (y < ytr) {
        bal = bal * (1 + r) + ((prim.age + y) < coastAge ? salary * state.contribRate : 0);
        salary *= (1 + state.raise);
      } else {
        bal = bal * (1 + r) - net;
        if (bal < 0) { ok = false; break; }
      }
    }
    if (ok) success++;
  }
  return Math.round(success / trials * 100);
}

// --- Coast FIRE ----------------------------------------------------------
// Target nest egg at retirement depends on the chosen method:
//   deplete → PV (at retirement) of real withdrawals to end of plan (pot → 0)
//   swr     → 1/swr × annual expenses (withdraw only the rate, never deplete)
// Coast number today = target discounted back at the return slider. Coast age =
// first age the current balance, growing with NO further contributions, reaches it.
function coastFire() {
  const r = state.rate;
  const ytr = state.retireAge - prim.age;
  const retYears = prim.planToAge - state.retireAge;
  const net = Math.max(0, (state.monthly - state.other) * 12);
  const target = state.coastMethod === "swr"
    ? (state.swr > 0 ? net / state.swr : Infinity)
    : (r > 0 ? net * (1 - Math.pow(1 + r, -retYears)) / r : net * retYears);
  const coastNow = ytr > 0 ? target / Math.pow(1 + r, ytr) : target;

  let bal = totalSaved, salary = state.salary1 + state.salary2, coastAge = null;
  for (let y = 0; y <= ytr; y++) {
    if (bal * Math.pow(1 + r, ytr - y) >= target - 0.5) { coastAge = prim.age + y; break; }
    bal = bal * (1 + r) + salary * state.contribRate;
    salary *= (1 + state.raise);
  }
  return { target, coastNow, coastAge, reached: totalSaved >= coastNow,
    annualContrib: (state.salary1 + state.salary2) * state.contribRate };
}
function renderCoast() {
  const c = coastFire();
  const pctHave = c.coastNow > 0 ? Math.min(100, totalSaved / c.coastNow * 100) : 100;
  const rpct = (state.rate * 100).toFixed(1);
  const status = c.reached
    ? `✓ You're past your Coast FIRE number — at a ${rpct}% real return you could stop contributing today and still reach your retirement nest egg.`
    : c.coastAge != null
      ? `Keep contributing at today's rate and you reach Coast FIRE at <b>age ${c.coastAge}</b> (${P.startYear + (c.coastAge - prim.age)}). After that you can stop and let it ride.`
      : `At a ${rpct}% real return you don't reach Coast FIRE before retirement — raise contributions or returns, or trim retirement expenses.`;
  const gapRow = c.reached
    ? `<div class="kv"><span class="muted">Contributions you could redirect to today</span><span class="good">${fmt$(c.annualContrib / 12)}/mo</span></div>`
    : `<div class="kv"><span class="muted">Shortfall to coast today (lump sum)</span><span>${fmt$(Math.max(0, c.coastNow - totalSaved))}</span></div>`;
  $("#coast").innerHTML = `
    <div class="muted" style="font-size:13px;text-transform:uppercase;letter-spacing:.8px">Coast FIRE number · today's dollars</div>
    <div class="coastbig ${c.reached ? "good" : ""}">${fmt$(c.coastNow)}</div>
    <p class="statusline">${status}</p>
    <div class="progress" role="img" aria-label="${Math.round(pctHave)} percent of your Coast FIRE number invested"><i style="width:${pctHave}%"></i></div>
    <div class="kv"><span class="muted">You have invested now</span><span>${fmt$(totalSaved)} · ${Math.round(pctHave)}%</span></div>
    <div class="kv"><span class="muted">Nest egg needed at retirement (age ${state.retireAge}) · ${state.coastMethod === "swr" ? (state.swr * 100).toFixed(2) + "% rule" : "deplete"}</span><span>${fmt$(c.target)}</span></div>
    ${gapRow}`;
  $("#coastNote").textContent = state.coastFrom >= state.retireAge
    ? "You're contributing all the way to retirement. Lower “stop contributing at age” to model coasting and watch the Overview chart and end-of-plan assets update."
    : `Modelling: contribute until age ${state.coastFrom}, then coast ${state.retireAge - state.coastFrom} year(s) to retirement with no new contributions. A green marker appears on the Overview chart.`;
}

// --- Chart (vanilla canvas) ---------------------------------------------
const cv = $("#chart"), ctx = cv.getContext("2d"), tip = $("#tip");
const COL = { average: "#5b8cff", below: "#36d399", sig: "#fbbd23" };
let plot = null;       // geometry + data kept for hit-testing the cursor
let cursorIdx = null;  // hovered/selected year index into pts, or null

function drawChart(sc) {
  if (!cv.clientWidth) return;                 // panel hidden — redraw when it shows
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 58, r: 64, t: 14, b: 26 };
  const all = [...sc.average.pts, ...sc.below.pts, ...sc.sig.pts];
  const maxBal = Math.max(1, ...all.map(p => p.bal));
  const x0 = sc.average.pts[0].year, x1 = sc.average.pts.at(-1).year;
  const X = yr => pad.l + (yr - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = v => H - pad.b - v / maxBal * (H - pad.t - pad.b);
  plot = { pad, W, H, x0, x1, X, Y, sc };

  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa6c4"; ctx.strokeStyle = "#2a3458";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = maxBal * i / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(shortMoney(v), pad.l - 6, y + 3);
  }
  ctx.textAlign = "center";
  for (let yr = x0; yr <= x1; yr += Math.ceil((x1 - x0) / 6)) ctx.fillText(yr, X(yr), H - 8);

  // Uncertainty band between the average (best) and significantly-below (worst) paths.
  ctx.beginPath();
  sc.average.pts.forEach((p, i) => i ? ctx.lineTo(X(p.year), Y(p.bal)) : ctx.moveTo(X(p.year), Y(p.bal)));
  [...sc.sig.pts].reverse().forEach(p => ctx.lineTo(X(p.year), Y(p.bal)));
  ctx.closePath(); ctx.fillStyle = "rgba(91,140,255,0.10)"; ctx.fill();

  // Retirement marker, and a coast marker when coasting is modelled.
  marker(X(P.startYear + (state.retireAge - prim.age)), "retire " + state.retireAge, "#f87272", X, pad, H);
  if (state.coastFrom < state.retireAge)
    marker(X(P.startYear + (state.coastFrom - prim.age)), "coast " + state.coastFrom, "#36d399", X, pad, H);

  const line = (pts, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash); ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(p.year), Y(p.bal)) : ctx.moveTo(X(p.year), Y(p.bal)));
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(sc.sig.pts, COL.sig, [2, 3]);
  line(sc.below.pts, COL.below, [6, 4]);
  line(sc.average.pts, COL.average, []);

  ctx.textAlign = "left";
  [["average", COL.average], ["below", COL.below], ["sig", COL.sig]].forEach(([k, c]) => {
    const p = sc[k].pts.at(-1); ctx.fillStyle = c;
    ctx.fillText(shortMoney(p.bal), X(p.year) + 6, Y(p.bal) + 3);
  });

  if (cursorIdx != null) drawCursor();
}
function marker(x, label, color, X, pad, H) {
  ctx.strokeStyle = color; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = color; ctx.textAlign = "left";
  ctx.fillText(label, x + 4, pad.t + 10);
}
function shortMoney(v) {
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + Math.round(v / 1e3) + "k";
  return "$" + Math.round(v);
}

function drawCursor() {
  if (!plot) return;
  const { pad, H, X, Y, sc } = plot;
  const pts = sc.average.pts;
  cursorIdx = Math.max(0, Math.min(pts.length - 1, cursorIdx));
  const p = pts[cursorIdx], x = X(p.year);
  ctx.strokeStyle = "#e8ecf7"; ctx.globalAlpha = 0.35; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  const rows = [["average", COL.average], ["below", COL.below], ["sig", COL.sig]];
  rows.forEach(([k, c]) => {
    const yv = Y(sc[k].pts[cursorIdx].bal);
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, yv, 3.5, 0, 7); ctx.fill();
  });
  const names = { average: "Average", below: "Below-avg", sig: "Sig. below" };
  tip.innerHTML = `<div class="ty">${p.year} · age ${p.age}</div>` + rows.map(([k, c]) =>
    `<div class="tr"><span><i class="dot" style="background:${c}"></i>${names[k]}</span><b>${fmt$(sc[k].pts[cursorIdx].bal)}</b></div>`).join("");
  tip.classList.add("on");
  const half = tip.offsetWidth / 2;
  tip.style.left = Math.max(half, Math.min(plot.W - half, x)) + "px";
  tip.style.top = (Y(sc.average.pts[cursorIdx].bal) - 10) + "px";
  $("#chartLive").textContent =
    `${p.year}, age ${p.age}: average ${fmt$(sc.average.pts[cursorIdx].bal)}, ` +
    `below-average ${fmt$(sc.below.pts[cursorIdx].bal)}, ` +
    `significantly below ${fmt$(sc.sig.pts[cursorIdx].bal)}.`;
}
function clearCursor() { cursorIdx = null; tip.classList.remove("on"); drawChart(scenarios()); }
function cursorFromX(clientX) {
  if (!plot) return;
  const rect = cv.getBoundingClientRect();
  const span = plot.x1 - plot.x0;
  const yr = plot.x0 + (clientX - rect.left - plot.pad.l) / (rect.width - plot.pad.l - plot.pad.r) * span;
  cursorIdx = Math.round(yr - plot.x0);
  drawChart(plot.sc);
}
cv.addEventListener("pointermove", e => cursorFromX(e.clientX));
cv.addEventListener("pointerdown", e => cursorFromX(e.clientX));
cv.addEventListener("pointerleave", clearCursor);
cv.addEventListener("blur", clearCursor);
cv.addEventListener("keydown", e => {
  const n = plot ? plot.sc.average.pts.length : 0;
  if (!n) return;
  if (cursorIdx == null) cursorIdx = Math.floor(n / 2);
  if (e.key === "ArrowRight") cursorIdx++;
  else if (e.key === "ArrowLeft") cursorIdx--;
  else if (e.key === "Home") cursorIdx = 0;
  else if (e.key === "End") cursorIdx = n - 1;
  else if (e.key === "Escape") { clearCursor(); return; }
  else return;
  e.preventDefault(); drawChart(plot.sc);
});

// --- Headline cards (reactive) ------------------------------------------
function deltaChip(now, base) {
  const d = now - base;
  if (Math.abs(d) < 1) return `<div class="delta">= snapshot</div>`;
  const cls = d > 0 ? "good" : "bad";
  return `<div class="delta ${cls}">${d > 0 ? "▲ +" : "▼ −"}${fmt$(Math.abs(d))} vs snapshot</div>`;
}
function renderHeadline(sc, prob) {
  const probClass = prob >= 80 ? "good" : prob >= 50 ? "warn" : "bad";
  const sig = sc.sig, below = sc.below;
  const cards = [
    { h: "Probability of success", v: prob + "%", cls: probClass,
      sub: `Monte Carlo · ${(P.sim && P.sim.trials) || 500} trials` },
    { h: "Assets at end of plan · average", v: fmt$(sc.average.end), cls: "good",
      sub: "Age " + prim.planToAge + " · " + sc.average.pts.at(-1).year, delta: deltaChip(sc.average.end, BASE.avg) },
    { h: "Assets at end of plan · below-avg", v: fmt$(below.end), cls: below.end > 0 ? "" : "bad",
      sub: below.end > 0 ? "Still covered" : `Depleted · age ${below.shortfallAge} (${below.shortfallYear})`,
      delta: deltaChip(below.end, BASE.below) },
    { h: "Significantly below market", v: sig.shortfallYear ? sig.shortfallYear : fmt$(sig.end),
      cls: sig.shortfallYear ? "bad" : "",
      sub: sig.shortfallYear ? `Shortfall · age ${sig.shortfallAge}` : "No shortfall" }
  ];
  $("#headline").innerHTML = cards.map(c =>
    `<div class="card"><h2>${c.h}</h2><div class="big ${c.cls}">${c.v}</div>
     <div class="muted" style="margin-top:6px;font-size:13px">${c.sub}</div>${c.delta || ""}</div>`).join("");
}

// --- Controls ------------------------------------------------------------
const pct = v => (v * 100).toFixed(1) + "%";
function contribLabel(v) {
  const yr = (state.salary1 + state.salary2) * v;
  return pct(v) + " · " + fmt$(yr) + "/yr · " + fmt$(yr / 12) + "/mo";
}
const CONTROLS = [
  { key: "salary1",   label: P.people[0].name + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) + "/yr" },
  { key: "salary2",   label: (P.people[1] ? P.people[1].name : "Partner") + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) + "/yr" },
  { key: "contribRate", label: "Contribution (% of salary → $)", min: 0, max: 0.5, step: 0.01, fmt: contribLabel },
  { key: "raise",     label: "Annual raise (real)", min: 0, max: 0.05, step: 0.005, fmt: pct },
  { key: "rate",      label: "Real return / yr", min: 0, max: 0.08, step: 0.005, fmt: pct },
  { key: "volatility",label: "Market volatility (return SD)", min: 0, max: 0.30, step: 0.01, fmt: pct },
  { key: "retireAge", label: "Retirement age", min: 55, max: 75, step: 1, fmt: v => v },
  { key: "monthly",   label: "Monthly retirement expenses", min: 5000, max: 20000, step: 100, fmt: v => fmt$(v) },
  { key: "other",     label: "Social Security / other income", min: 0, max: 10000, step: 100, fmt: v => fmt$(v) + "/mo" }
];
function syncOutputs() {
  CONTROLS.forEach(c => { $("#out-" + c.key).textContent = c.fmt(state[c.key]); });
  $("#out-coastFrom").textContent = state.coastFrom >= state.retireAge
    ? `age ${state.retireAge} · no coasting` : `age ${state.coastFrom}`;
  $("#out-swr").textContent = pct(state.swr);
  $("#swrWrap").hidden = state.coastMethod !== "swr";
}
function renderControls() {
  $("#controls").innerHTML = CONTROLS.map(c => `
    <div class="ctl">
      <label for="in-${c.key}">${c.label}<output id="out-${c.key}"></output></label>
      <input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${state[c.key]}" />
    </div>`).join("");
  CONTROLS.forEach(c => {
    $("#in-" + c.key).addEventListener("input", e => { state[c.key] = +e.target.value; syncOutputs(); recompute(); });
  });
  $("#rateNote").textContent =
    `Contributions = salary × rate, growing with your raise each working year. Scenarios offset the chosen ` +
    `return: average = slider, below-avg −${(-P.returns.below*100).toFixed(0)}%, significantly below ` +
    `−${(-P.returns.significantlyBelow*100).toFixed(0)}%. Everything is in today's dollars.`;
}
// Coast FIRE controls (live, in the Coast FIRE tab).
const coastSlider = $("#in-coastFrom");
coastSlider.min = prim.age + 1; coastSlider.max = 75; coastSlider.value = state.coastFrom;
coastSlider.addEventListener("input", e => { state.coastFrom = +e.target.value; syncOutputs(); recompute(); });

const methodSel = $("#in-coastMethod");
methodSel.value = state.coastMethod;
methodSel.addEventListener("change", e => { state.coastMethod = e.target.value; syncOutputs(); recompute(); });

const swrSlider = $("#in-swr");
swrSlider.value = state.swr;
swrSlider.addEventListener("input", e => { state.swr = +e.target.value; syncOutputs(); recompute(); });

// --- Impact: 5 single-lever changes -------------------------------------
function renderImpact() {
  const baseAvg = projectWith(P.returns.average).end;
  const base = projectWith(P.returns.significantlyBelow);

  const nudges = [
    { label: "Save 2% more of salary",      o: { contribRate: state.contribRate + 0.02 } },
    { label: "Work 1 more year",            o: { retireAge: state.retireAge + 1 } },
    { label: "Trim expenses $500/mo",       o: { monthly: Math.max(0, state.monthly - 500) } },
    { label: "Add $1,000/mo other income",  o: { other: state.other + 1000 } },
    { label: "Earn 0.5% more real return",  o: { rateBump: 0.005 } }
  ];
  const deltaStr = d => {
    if (Math.abs(d) < 1) return `<span class="muted">no change</span>`;
    return `<span class="big ${d > 0 ? "good" : "bad"}" style="font-size:14px">${d > 0 ? "+" : "−"}${fmt$(Math.abs(d))}</span>`;
  };
  const sfStr = res => {
    if (!res.shortfallYear) return `<span class="good">none</span>`;
    const dy = base.shortfallYear ? res.shortfallYear - base.shortfallYear : null;
    const tag = dy ? ` <span class="muted">(${dy > 0 ? "+" : ""}${dy}y)</span>` : "";
    return `<span class="bad">${res.shortfallYear} · age ${res.shortfallAge}</span>${tag}`;
  };
  $("#impact tbody").innerHTML = nudges.map(n => {
    const avg = projectWith(P.returns.average, n.o).end;
    const res = projectWith(P.returns.significantlyBelow, n.o);
    return `<tr><td>${n.label}</td><td class="num">${deltaStr(avg - baseAvg)}</td><td class="num">${sfStr(res)}</td></tr>`;
  }).join("");
}

// --- Data-table fallback for the chart (accessibility) ------------------
function renderProjTable(sc) {
  const pts = sc.average.pts;
  const retIdx = state.retireAge - prim.age;
  const rows = pts.filter((p, i) => i === 0 || i === pts.length - 1 || i === retIdx || (p.year % 5 === 0));
  $("#projTable tbody").innerHTML = rows.map(p => {
    const i = p.age - prim.age;
    return `<tr><td>${p.year}${i === retIdx ? " · retire" : ""}</td><td class="num">${p.age}</td>
      <td class="num">${fmt$(sc.average.pts[i].bal)}</td>
      <td class="num">${fmt$(sc.below.pts[i].bal)}</td>
      <td class="num">${fmt$(sc.sig.pts[i].bal)}</td></tr>`;
  }).join("");
}

// --- Static tables -------------------------------------------------------
function renderStatic() {
  $("#asof").textContent = "as of " + P.asOf;

  $("#accounts tbody").innerHTML = P.accounts.map(a =>
    `<tr><td>${a.name}<div class="muted" style="font-size:12px">${a.custodian}</div></td>
     <td>${a.owner}</td><td class="num">${fmt$(a.balance)}</td><td class="num">${fmt$(a.contrib)}</td></tr>`).join("") +
    `<tr><td><b>Total saved</b></td><td></td><td class="num"><b>${fmt$(totalSaved)}</b></td>
     <td class="num"><b>${fmt$(totalContrib)}</b></td></tr>`;

  $("#household").innerHTML = P.people.map(p =>
    `<div class="kv"><span>${p.name} <span class="pill">age ${p.age}</span></span><span>${fmt$(p.income)}/yr</span></div>
     <div class="kv muted"><span>${p.status} · retire ${p.retireAge} · plan to ${p.planToAge}</span><span></span></div>`).join("") +
    `<div class="kv"><span class="muted">Married filing jointly · Missouri</span><span></span></div>` +
    `<div class="kv"><span class="muted">Est. need in retirement (live)</span><span id="needVal"></span></div>`;

  const palette = ["#5b8cff","#8b6bff","#36d399","#fbbd23","#9aa6c4"];
  $("#assetmix").innerHTML = bars(P.assetMix, palette);

  const taxSums = {};
  P.accounts.forEach(a => { taxSums[a.tax] = (taxSums[a.tax] || 0) + a.balance; });
  const taxMix = {};
  Object.entries(taxSums).forEach(([k, v]) => { taxMix[k] = +(v / totalSaved * 100).toFixed(1); });
  $("#taxmix").innerHTML = bars(taxMix, ["#5b8cff","#36d399","#fbbd23"]) +
    `<div class="kv" style="margin-top:8px"><span class="muted">Across accounts</span><span>${fmt$(totalSaved)}</span></div>`;

  $("#disclaimer").innerHTML =
    "Hypothetical, educational projections in today's dollars — not guarantees of future results, not advice. " +
    "Every figure is computed live from the sliders: the projection chart and Coast FIRE use a deterministic model " +
    "(grow salary-based contributions, then draw down expenses net of other income), and the probability of success " +
    "is a seeded Monte Carlo over normally-distributed real returns (mean = return slider, SD = volatility slider). " +
    "The original Fidelity Planning &amp; Guidance Center report put probability at " + P.reported.probabilityOfSuccess +
    "%. Edit <code>plan.js</code> to change any assumption.";
}
function bars(obj, palette) {
  const entries = Object.entries(obj);
  const segs = entries.map(([k, v], i) =>
    `<i style="width:${v}%;background:${palette[i % palette.length]}" title="${k} ${v}%"></i>`).join("");
  const rows = entries.map(([k, v], i) =>
    `<div class="kv"><span><i class="dot" style="background:${palette[i % palette.length]}"></i>${k}</span><span>${v}%</span></div>`).join("");
  return `<div class="bar">${segs}</div><div style="margin-top:10px">${rows}</div>`;
}

// --- Tabs ----------------------------------------------------------------
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activate(tab) {
  if (!tab) return;
  activeTab = tab.id.replace("tab-", "");
  tabs.forEach(t => {
    const sel = t === tab;
    t.setAttribute("aria-selected", String(sel));
    t.tabIndex = sel ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !sel;
  });
  if (activeTab === "overview") drawChart(scenarios());   // canvas needs a visible panel to size
  writeHash();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => activate(t));
  t.addEventListener("keydown", e => {
    let n = null;
    if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") n = tabs[0];
    else if (e.key === "End") n = tabs[tabs.length - 1];
    if (n) { e.preventDefault(); n.focus(); activate(n); }
  });
});

// --- Wire up -------------------------------------------------------------
function recompute() {
  const sc = scenarios();
  drawChart(sc);
  renderHeadline(sc, successProbability());
  renderCoast();
  renderImpact();
  renderProjTable(sc);
  syncOutputs();
  const need = $("#needVal");
  if (need) need.textContent = fmt$(Math.max(0, (state.monthly - state.other))) + "/mo";
  writeHash();
}
$("#reset").addEventListener("click", () => {
  state = { ...defaults, coastMethod: defaultMethod };
  cursorIdx = null; tip.classList.remove("on");
  renderControls();
  coastSlider.value = state.coastFrom;
  swrSlider.value = state.swr;
  methodSel.value = state.coastMethod;
  recompute();
});
$("#copy").addEventListener("click", async () => {
  const btn = $("#copy");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied ✓"; btn.classList.add("ok");
    setTimeout(() => { btn.textContent = "Copy shareable link"; btn.classList.remove("ok"); }, 2000);
  } catch { window.prompt("Copy this link:", location.href); }
});
$("#tableToggle").addEventListener("click", e => {
  const t = $("#projTable"), open = t.hidden;
  t.hidden = !open;
  e.target.setAttribute("aria-expanded", String(open));
  e.target.textContent = open ? "Hide data table" : "Show data table";
});
window.addEventListener("resize", () => drawChart(scenarios()));

renderStatic();
renderControls();
activate(document.getElementById("tab-" + (new URLSearchParams(location.hash.slice(1)).get("tab") || "overview")) || tabs[0]);
recompute();
