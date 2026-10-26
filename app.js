const P = window.PLAN;
const $ = s => document.querySelector(s);
const fmt$ = n => "$" + Math.round(n).toLocaleString("en-US");
const fmt$0 = n => "$" + Math.round(n).toLocaleString("en-US");

const primary = P.people[0];                       // drives the timeline
const totalSaved = P.accounts.reduce((s, a) => s + a.balance, 0);
const totalContrib = P.accounts.reduce((s, a) => s + a.contrib, 0);
const monthlyExpense = P.expenses.essential + P.expenses.nonEssential;

// Live, editable state (seeded from the snapshot)
const defaults = {
  rate: P.returns.base,
  contrib: totalContrib,
  retireAge: primary.retireAge,
  monthly: monthlyExpense
};
let state = { ...defaults };

// --- Projection model (today's dollars) ---------------------------------
// Grow with contributions until retirement, then draw down expenses to end of plan.
function project(realRate) {
  const years = primary.planToAge - primary.age;           // horizon in years
  const yearsToRetire = state.retireAge - primary.age;
  const annualExpense = state.monthly * 12;
  const pts = [];
  let bal = totalSaved;
  let shortfallYear = null;
  for (let y = 0; y <= years; y++) {
    pts.push({ year: P.startYear + y, age: primary.age + y, bal: Math.max(bal, 0) });
    const working = y < yearsToRetire;
    bal = bal * (1 + realRate) + (working ? state.contrib : -annualExpense);
    if (!working && bal < 0 && shortfallYear === null) shortfallYear = P.startYear + y + 1;
  }
  return { pts, shortfallYear, end: Math.max(pts[pts.length - 1].bal, 0) };
}

function scenarios() {
  return {
    average: project(state.rate + P.returns.average),
    below: project(state.rate + P.returns.below),
    sig: project(state.rate + P.returns.significantlyBelow)
  };
}

// --- Chart (vanilla canvas) ---------------------------------------------
const cv = $("#chart"), ctx = cv.getContext("2d");
const COL = { average: "#5b8cff", below: "#36d399", sig: "#fbbd23" };

function drawChart(sc) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 58, r: 14, t: 14, b: 26 };
  const all = [...sc.average.pts, ...sc.below.pts, ...sc.sig.pts];
  const maxBal = Math.max(1, ...all.map(p => p.bal));
  const x0 = sc.average.pts[0].year, x1 = sc.average.pts[sc.average.pts.length - 1].year;
  const X = yr => pad.l + (yr - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = v => H - pad.b - v / maxBal * (H - pad.t - pad.b);

  // gridlines + y labels
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa6c4"; ctx.strokeStyle = "#2a3458";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = maxBal * i / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(shortMoney(v), pad.l - 6, y + 3);
  }
  // x labels
  ctx.textAlign = "center";
  for (let yr = x0; yr <= x1; yr += Math.ceil((x1 - x0) / 6)) ctx.fillText(yr, X(yr), H - 8);

  // retirement marker
  const retYear = P.startYear + (state.retireAge - primary.age);
  ctx.strokeStyle = "#f87272"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(retYear), pad.t); ctx.lineTo(X(retYear), H - pad.b); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = "#f87272"; ctx.textAlign = "left";
  ctx.fillText("retire " + state.retireAge, X(retYear) + 4, pad.t + 10);

  const line = (pts, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(p.year), Y(p.bal)) : ctx.moveTo(X(p.year), Y(p.bal)));
    ctx.stroke();
  };
  line(sc.sig.pts, COL.sig);
  line(sc.below.pts, COL.below);
  line(sc.average.pts, COL.average);
}
function shortMoney(v) {
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + Math.round(v / 1e3) + "k";
  return "$" + Math.round(v);
}

// --- Headline cards (reactive) ------------------------------------------
function renderHeadline(sc) {
  const prob = P.reported.probabilityOfSuccess;
  const probClass = prob >= 80 ? "good" : prob >= 50 ? "warn" : "bad";
  const shortfall = sc.sig.shortfallYear;
  const cards = [
    { h: "Probability of success", v: prob + "%", cls: probClass,
      sub: prob >= 80 ? "On-track — well done!" : "Room to improve" },
    { h: "Assets at end of plan · average", v: fmt$(sc.average.end), cls: "good",
      sub: "Age " + primary.planToAge + " · " + sc.average.pts.at(-1).year },
    { h: "Assets at end of plan · below-avg", v: fmt$(sc.below.end), cls: sc.below.end > 0 ? "" : "bad",
      sub: sc.below.end > 0 ? "Still covered" : "Depleted" },
    { h: "Significantly below market", v: shortfall ? shortfall : fmt$(sc.sig.end),
      cls: shortfall ? "bad" : "", sub: shortfall ? "Shortfall year" : "No shortfall" }
  ];
  $("#headline").innerHTML = cards.map(c =>
    `<div class="card"><h2>${c.h}</h2><div class="big ${c.cls}">${c.v}</div>
     <div class="muted" style="margin-top:6px;font-size:13px">${c.sub}</div></div>`).join("");
}

// --- Controls ------------------------------------------------------------
const CONTROLS = [
  { key: "rate",      label: "Real return / yr", min: 0, max: 0.08, step: 0.005, fmt: v => (v * 100).toFixed(1) + "%" },
  { key: "contrib",   label: "Annual contributions", min: 0, max: 150000, step: 1000, fmt: fmt$0 },
  { key: "retireAge", label: "Retirement age", min: 55, max: 75, step: 1, fmt: v => v },
  { key: "monthly",   label: "Monthly expenses", min: 5000, max: 20000, step: 100, fmt: fmt$0 }
];
function renderControls() {
  $("#controls").innerHTML = CONTROLS.map(c => `
    <div class="ctl">
      <label>${c.label}<output id="out-${c.key}"></output></label>
      <input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${state[c.key]}" />
    </div>`).join("");
  CONTROLS.forEach(c => {
    const inp = $("#in-" + c.key);
    const sync = () => {
      state[c.key] = +inp.value;
      $("#out-" + c.key).textContent = c.fmt(state[c.key]);
      recompute();
    };
    inp.addEventListener("input", sync);
    $("#out-" + c.key).textContent = c.fmt(state[c.key]);
  });
  $("#rateNote").textContent =
    `Scenarios offset the chosen real return: average = slider, below-avg = −${(-P.returns.below*100).toFixed(0)}%, ` +
    `significantly below = −${(-P.returns.significantlyBelow*100).toFixed(0)}%. All figures in today's dollars.`;
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
    `<div class="kv"><span class="muted">Est. need in retirement</span><span>${fmt$(P.reported.monthlyNeed)}/mo</span></div>`;

  const palette = ["#5b8cff","#8b6bff","#36d399","#fbbd23","#9aa6c4"];
  $("#assetmix").innerHTML = bars(P.assetMix, palette);
  $("#taxmix").innerHTML = bars(P.taxMix, ["#5b8cff","#fbbd23","#36d399"]) +
    `<div class="kv" style="margin-top:8px"><span class="muted">Across accounts</span>
     <span>${fmt$(totalSaved)}</span></div>`;

  $("#disclaimer").innerHTML =
    "Hypothetical, educational projections in today's dollars — not guarantees of future results, not advice. " +
    "A simple deterministic model (grow contributions to retirement, then draw down expenses); it does not run the " +
    "Monte Carlo simulation behind the reported 86% probability of success. Reported snapshot figures come from the " +
    "original Fidelity Planning &amp; Guidance Center report. Edit <code>plan.js</code> to plug in your own numbers.";
}
function bars(obj, palette) {
  const entries = Object.entries(obj);
  const segs = entries.map(([k, v], i) =>
    `<i style="width:${v}%;background:${palette[i % palette.length]}" title="${k} ${v}%"></i>`).join("");
  const rows = entries.map(([k, v], i) =>
    `<div class="kv"><span><i class="dot" style="background:${palette[i % palette.length]}"></i>${k}</span><span>${v}%</span></div>`).join("");
  return `<div class="bar">${segs}</div><div style="margin-top:10px">${rows}</div>`;
}

// --- Wire up -------------------------------------------------------------
function recompute() {
  const sc = scenarios();
  drawChart(sc);
  renderHeadline(sc);
}
$("#reset").addEventListener("click", () => {
  state = { ...defaults };
  renderControls();
  recompute();
});
window.addEventListener("resize", () => drawChart(scenarios()));

renderStatic();
renderControls();
recompute();
