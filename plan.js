// Edit this file to plug in your own numbers — everything else reads from here.
window.PLAN = {
  asOf: "Oct 22, 2026",
  startYear: 2026,

  people: [
    { name: "Rishi Joshi", age: 42, income: 150000, retireAge: 65, planToAge: 94, status: "Still working" },
    { name: "Hetal Joshi", age: 41, income: 50000,  retireAge: 65, planToAge: 96, status: "Still working" }
  ],

  accounts: [
    { name: "Enterprise Plan 401(k)", custodian: "Fidelity", owner: "Rishi", balance: 521025.53, contrib: 30000 },
    { name: "Hetal's 401(k)",         custodian: "Fidelity", owner: "Hetal", balance: 79000,     contrib: 17000 },
    { name: "Rishi's Roth IRA",       custodian: "Vanguard", owner: "Rishi", balance: 10000,     contrib: 3000  }
  ],

  // Tax treatment of total saved
  taxMix: { "Tax deferred": 92, "Taxable": 0, "Tax exempt": 8 },

  // Current asset allocation
  assetMix: {
    "Domestic stock": 56.3, "Foreign stock": 15.4, "Bonds": 26.5, "Short-term": 1.5, "Other": 0.2
  },

  // Monthly expenses in retirement (today's dollars)
  expenses: { essential: 9440, nonEssential: 2360 },

  // Reported snapshot figures (for reference cards)
  reported: {
    probabilityOfSuccess: 86,       // %
    monthlyNeed: 12112,             // $ need in retirement
    monthlyBelowAvg: 14951,         // $ projected if markets below-average
    endAssetsAverage: 11824689,
    endAssetsBelowAvg: 2694043,
    endYear: 2077
  },

  // Real (after-inflation) annual return assumptions, today's dollars.
  // "base" is the slider's starting point; scenarios offset from it.
  returns: { base: 0.05, average: 0.00, below: -0.02, significantlyBelow: -0.04 },

  // Levers you can tune (seed values; sliders start here).
  assumptions: {
    salaryGrowth: 0.01,        // real annual raise while working
    otherMonthlyIncome: 0,     // Social Security / pension / annuity per month
    // Contribution rate as a % of combined gross salary. Default is derived
    // from the accounts above (total contrib / total salary) if left null.
    contribRate: null
  }
};
