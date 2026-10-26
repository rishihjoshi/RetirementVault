# RetirementVault

An interactive, offline-capable **retirement plan snapshot** — a static PWA (no backend,
no build step). Drag the sliders to see how real return, contributions, retirement age
and monthly expenses reshape your asset projection.

**Live:** https://rishihjoshi.github.io/RetirementVault/

## What it does
- Reactive **asset projection** chart (vanilla canvas) with three market scenarios:
  average, below-average, significantly below-average.
- Headline cards: probability of success, assets at end of plan, shortfall year.
- Household, accounts, asset mix and tax-treatment breakdowns.
- Installable PWA, works offline via a service worker.

## Plug in your own numbers
Everything reads from [`plan.js`](plan.js). Edit the balances, contributions, ages,
expenses and return assumptions there — no other file needs to change.

## Projection model
A simple deterministic model in **today's (real) dollars**: grow contributions until
retirement, then draw down annual expenses to the end of plan. It is *not* the Monte
Carlo simulation behind the reported 86% probability of success — that figure is carried
over from the original Fidelity Planning & Guidance Center report for reference.

## Run locally
Any static server, e.g.:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Files
| File | Purpose |
|------|---------|
| `index.html` | Layout + styles |
| `plan.js` | **Your data** — edit this |
| `app.js` | Projection math, chart, controls |
| `sw.js` / `manifest.webmanifest` | PWA offline + install |

> Hypothetical and educational, not financial advice.
