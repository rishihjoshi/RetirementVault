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
  other: A.otherMonthlyIncome || 0
};
let state = { ...defaults };

// --- Projection model (today's dollars) ---------------------------------
// While working: salary grows by `raise`, contributions = salary * contribRate.
// In retirement: draw down (expenses − other income) each year to end of plan.
// `o` overrides individual state fields; `rateBump` nudges the return.
function project(realRate, o = {}) {
  const s = { ...state, ...o };
  const years = prim.planToAge - prim.age;
  const ytr = s.retireAge - prim.age;
  let salary = s.salary1 + s.salary2;
  let bal = totalSaved, shortfallYear = null;
  const pts = [];
  for (let y = 0; y <= years; y++) {
    pts.push({ year: P.startYear + y, age: prim.age + y, bal: Math.max(bal, 0) });
    const working = y < ytr;
    if (working) {
      bal = bal * (1 + realRate) + salary * s.contribRate;
      salary *= (1 + s.raise);
    } else {
      const net = Math.max(0, (s.monthly - s.other) * 12);
      bal = bal * (1 + realRate) - net;
      if (bal < 0 && shortfallYear === null) shortfallYear = P.startYear + y + 1;
    }
  }
  return { pts, shortfallYear, end: Math.max(pts[pts.length - 1].bal, 0) };
}

const projectWith = (offset, o = {}) => project(state.rate + offset + (o.rateBump || 0), o);
function scenarios() {
  return {
    average: projectWith(P.returns.average),
    below: projectWith(P.returns.below),
    sig: projectWith(P.returns.significantlyBelow)
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
  const x0 = sc.average.pts[0].year, x1 = sc.average.pts.at(-1).year;
  const X = yr => pad.l + (yr - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = v => H - pad.b - v / maxBal * (H - pad.t - pad.b);

  ctx.font = "11px system-ui"; ctx.fillStyle = "#9aa6c4"; ctx.strokeStyle = "#2a3458";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = maxBal * i / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(shortMoney(v), pad.l - 6, y + 3);
  }
  ctx.textAlign = "center";
  for (let yr = x0; yr <= x1; yr += Math.ceil((x1 - x0) / 6)) ctx.fillText(yr, X(yr), H - 8);

  const retYear = P.startYear + (state.retireAge - prim.age);
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
      sub: "Age " + prim.planToAge + " · " + sc.average.pts.at(-1).year },
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
const pct = v => (v * 100).toFixed(1) + "%";
function contribLabel(v) {
  const yr = (state.salary1 + state.salary2) * v;
  return pct(v) + " · " + fmt$(yr) + "/yr · " + fmt$(yr / 12) + "/mo";
}
const CONTROLS = [
  { key: "salary1",   label: P.people[0].name + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) + "/yr" },
  { key: "salary2",   label: (P.people[1] ? P.people[1].name : "Partner") + " salary", min: 0, max: 400000, step: 5000, fmt: v => fmt$(v) + "/yr" },
  { key: "contribRate", label: "Contribution rate (% of salary)", min: 0, max: 0.5, step: 0.01, fmt: contribLabel },
  { key: "raise",     label: "Annual raise (real)", min: 0, max: 0.05, step: 0.005, fmt: pct },
  { key: "rate",      label: "Real return / yr", min: 0, max: 0.08, step: 0.005, fmt: pct },
  { key: "retireAge", label: "Retirement age", min: 55, max: 75, step: 1, fmt: v => v },
  { key: "monthly",   label: "Monthly retirement expenses", min: 5000, max: 20000, step: 100, fmt: v => fmt$(v) },
  { key: "other",     label: "Social Security / other income", min: 0, max: 10000, step: 100, fmt: v => fmt$(v) + "/mo" }
];
function syncOutputs() {
  CONTROLS.forEach(c => { $("#out-" + c.key).textContent = c.fmt(state[c.key]); });
}
function renderControls() {
  $("#controls").innerHTML = CONTROLS.map(c => `
    <div class="ctl">
      <label>${c.label}<output id="out-${c.key}"></output></label>
      <input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${state[c.key]}" />
    </div>`).join("");
  CONTROLS.forEach(c => {
    $("#in-" + c.key).addEventListener("input", e => {
      state[c.key] = +e.target.value;
      syncOutputs();          // salary changes also move the contribution $ label
      recompute();
    });
  });
  syncOutputs();
  $("#rateNote").textContent =
    `Contributions = salary × rate, growing with your raise each working year. Scenarios offset the chosen ` +
    `return: average = slider, below-avg −${(-P.returns.below*100).toFixed(0)}%, significantly below ` +
    `−${(-P.returns.significantlyBelow*100).toFixed(0)}%. Everything is in today's dollars.`;
}

// --- Impact: 5 single-lever changes -------------------------------------
function renderImpact() {
  const baseAvg = projectWith(P.returns.average).end;
  const baseSf = projectWith(P.returns.significantlyBelow).shortfallYear;

  const nudges = [
    { label: "Save 2% more of salary",      o: { contribRate: state.contribRate + 0.02 } },
    { label: "Work 1 more year",            o: { retireAge: state.retireAge + 1 } },
    { label: "Trim expenses $500/mo",       o: { monthly: Math.max(0, state.monthly - 500) } },
    { label: "Add $1,000/mo other income",  o: { other: state.other + 1000 } },
    { label: "Earn 0.5% more real return",  o: { rateBump: 0.005 } }
  ];

  const deltaStr = (d) => {
    if (Math.abs(d) < 1) return `<span class="muted">no change</span>`;
    const cls = d > 0 ? "good" : "bad";
    return `<span class="big ${cls}" style="font-size:14px">${d > 0 ? "+" : "−"}${fmt$(Math.abs(d))}</span>`;
  };
  const sfStr = (sf) => {
    if (!sf) return `<span class="good">none</span>`;
    const dy = baseSf ? sf - baseSf : null;
    const tag = dy ? ` <span class="muted">(${dy > 0 ? "+" : ""}${dy}y)</span>` : "";
    return `<span class="bad">${sf}</span>${tag}`;
  };

  $("#impact tbody").innerHTML = nudges.map(n => {
    const avg = projectWith(P.returns.average, n.o).end;
    const sf = projectWith(P.returns.significantlyBelow, n.o).shortfallYear;
    return `<tr><td>${n.label}</td>
      <td class="num">${deltaStr(avg - baseAvg)}</td>
      <td class="num">${sfStr(sf)}</td></tr>`;
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
    `<div class="kv"><span class="muted">Est. need in retirement</span><span>${fmt$(P.reported.monthlyNeed)}/mo</span></div>`;

  const palette = ["#5b8cff","#8b6bff","#36d399","#fbbd23","#9aa6c4"];
  $("#assetmix").innerHTML = bars(P.assetMix, palette);
  $("#taxmix").innerHTML = bars(P.taxMix, ["#5b8cff","#fbbd23","#36d399"]) +
    `<div class="kv" style="margin-top:8px"><span class="muted">Across accounts</span>
     <span>${fmt$(totalSaved)}</span></div>`;

  $("#disclaimer").innerHTML =
    "Hypothetical, educational projections in today's dollars — not guarantees of future results, not advice. " +
    "A simple deterministic model (grow salary-based contributions to retirement, then draw down expenses net of " +
    "other income); it does not run the Monte Carlo simulation behind the reported 86% probability of success. " +
    "Reported snapshot figures come from the original Fidelity Planning &amp; Guidance Center report. " +
    "Edit <code>plan.js</code> to plug in your own numbers.";
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
  renderImpact();
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
