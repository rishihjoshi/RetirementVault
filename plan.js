// Edit this file to plug in your own numbers — everything else reads from here.
window.PLAN = {
  asOf: "Oct 22, 2026",
  startYear: 2026,

  people: [
    { name: "Rishi Joshi", age: 42, income: 150000, retireAge: 65, planToAge: 94, status: "Still working" },
    { name: "Hetal Joshi", age: 41, income: 50000,  retireAge: 65, planToAge: 96, status: "Still working" }
  ],

  // Each account carries its tax treatment; the Tax-treatment panel is computed from these.
  accounts: [
    { name: "Enterprise Plan 401(k)",  custodian: "Fidelity", owner: "Rishi", balance: 521025.53, contrib: 30000, tax: "Tax deferred" },
    { name: "Hetal's 401(k)",          custodian: "Fidelity", owner: "Hetal", balance: 79000,     contrib: 17000, tax: "Tax deferred" },
    { name: "Rishi's Roth IRA",        custodian: "Vanguard", owner: "Rishi", balance: 10000,     contrib: 3000,  tax: "Tax exempt"  },
    { name: "Hetal's Roth IRA",        custodian: "Vanguard", owner: "Hetal", balance: 25600,     contrib: 0,     tax: "Tax exempt"  },
    { name: "Hetal's Traditional IRA", custodian: "Vanguard", owner: "Hetal", balance: 12400,     contrib: 0,     tax: "Tax deferred" }
  ],

  // Current asset allocation
  assetMix: {
    "Domestic stock": 56.3, "Foreign stock": 15.4, "Bonds": 26.5, "Short-term": 1.5, "Other": 0.2
  },

  // Monthly expenses in retirement (today's dollars)
  expenses: { essential: 9440, nonEssential: 2360 },

  // Reported snapshot figures, kept only as the original report's reference point.
  // Nothing on screen is read from here any more — every number is computed live.
  reported: {
    probabilityOfSuccess: 86,       // original Fidelity report %
    monthlyNeed: 12112              // original report's stated monthly need
  },

  // Real (after-inflation) annual return assumptions, today's dollars.
  // "base" is the slider's starting point; scenarios offset from it. "volatility"
  // is the annual return standard deviation used by the Monte Carlo probability.
  returns: { base: 0.05, average: 0.00, below: -0.02, significantlyBelow: -0.04, volatility: 0.12 },

  // Monte Carlo settings for the live probability-of-success calculation.
  sim: { trials: 600, seed: 20261029 },

  // Coast FIRE assumptions (seed values; the Coast FIRE tab can change them live).
  //   method "deplete" = fund expenses to end of plan (draw the pot to zero)
  //   method "swr"     = 4%-rule style, hold 1/swr × expenses so it never depletes
  //   coastFrom        = age to stop contributing (defaults to retirement = no coasting)
  coast: { method: "deplete", swr: 0.04 },

  // Levers you can tune (seed values; sliders start here).
  assumptions: {
    salaryGrowth: 0.01,        // real annual raise while working
    contribRate: null,         // % of combined gross salary; null = derive from accounts
    // Retirement income taxes: tax-deferred withdrawals are grossed up by this
    // effective rate (Roth/taxable balances are treated as tax-free here).
    retirementTaxRate: 0.15,
    // Social Security / pension: a monthly benefit (today's $) that starts at ssStartAge.
    ssMonthly: 0,
    ssStartAge: 67
  }
};
