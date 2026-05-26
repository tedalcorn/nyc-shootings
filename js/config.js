// Dashboard configuration — edit these as needed.

window.CONFIG = {
  covid: {
    // NYC State of Emergency: declared 2020-03-12, rescinded 2022-09-05.
    start: "2020-03-12",
    end:   "2022-09-05",
    label: "NYC COVID-19 emergency",
  },

  // Borough display order + colors
  boros: ["BRONX", "BROOKLYN", "MANHATTAN", "QUEENS", "STATEN ISLAND"],
  boroColors: {
    "BRONX":         "#d62728",
    "BROOKLYN":      "#1f77b4",
    "MANHATTAN":     "#2ca02c",
    "QUEENS":        "#ff7f0e",
    "STATEN ISLAND": "#9467bd",
  },
  citywideColor: "#1a1a1a",

  // NYCHA cluster thresholds for highlighting rows (trailing-365-day counts)
  nyhcaHotThreshold:     3,   // bg = light yellow
  nyhcaVeryHotThreshold: 5,   // bg = orange

  // Demographic category color scheme — UNKNOWN gets a deliberate gray
  unknownColor: "#b0b0b0",
};
