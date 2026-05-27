// NYC Shootings dashboard — vanilla JS, Plotly + Leaflet.

const DATA = {};
const RENDERED = {};

async function loadJSON(name) {
  const r = await fetch(`data/${name}.json?v=${Date.now()}`);
  if (!r.ok) throw new Error(`Failed to load ${name}: ${r.status}`);
  return r.json();
}

async function loadAll() {
  const names = [
    "meta", "citywide_rolling", "boro_rolling", "cumulative_by_year",
    "monthly", "precinct_year", "boro_year", "incidents", "nycha_clusters",
    "nta_hotspots", "demographics", "location_types", "data_quality",
    "populations",
  ];
  const results = await Promise.all(names.map(loadJSON));
  names.forEach((n, i) => DATA[n] = results[i]);
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatMonthYear(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}
function formatLongDate(isoDate) {
  // "2026-02-15" -> "Feb 15, 2026"
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}
function formatLongDateAbbr(isoDate) {
  // "2026-02-15" -> "Feb. 15, 2026"
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]}. ${d}, ${y}`;
}
function trailingPeriodLabel(endDate) {
  // "2026-02-28" -> "Mar 1, 2025 – Feb 28, 2026"  (window = day + 364 prior, inclusive)
  const end = new Date(endDate);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  return `${MONTHS_SHORT[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} – ` +
         `${MONTHS_SHORT[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

// ---------------------------- helpers ----------------------------

function fmt(n) { return Number(n).toLocaleString("en-US"); }

function plotlyLayoutDefaults(extra) {
  return Object.assign({
    margin: { l: 50, r: 20, t: 20, b: 50 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    font: { family: "-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif", size: 12 },
    hovermode: "x unified",
    showlegend: true,
    legend: { orientation: "h", y: -0.18, x: 0 },
  }, extra || {});
}

function plotlyConfig() {
  return { displaylogo: false, responsive: true,
           modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines"] };
}

function covidShape() {
  return {
    type: "rect", xref: "x", yref: "paper",
    x0: CONFIG.covid.start, x1: CONFIG.covid.end,
    y0: 0, y1: 1, fillcolor: "rgba(150,150,160,0.18)", line: { width: 0 },
    layer: "below",
  };
}

// ---------------------------- header ----------------------------

function renderHeader() {
  const m = DATA.meta;
  const [start, end] = m.date_range;
  document.getElementById("dataspan").textContent =
    `${fmt(m.totals.incidents)} incidents · ${fmt(m.totals.victims)} victims · ` +
    `${formatLongDateAbbr(start)} to ${formatLongDateAbbr(end)}`;

  document.getElementById("build-info").textContent =
    `Database built ${m.built_at}. Totals: ` +
    `${fmt(m.totals.incidents)} incidents, ${fmt(m.totals.victims)} victims, ` +
    `${fmt(m.totals.offenders)} identified suspects.`;

  const ul = document.getElementById("sources");
  for (const [name, url] of Object.entries(m.sources)) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = name;
    li.appendChild(a);
    ul.appendChild(li);
  }

  // Geocoding-quality summary — set every span that exists in the current HTML.
  const dq = DATA.data_quality;
  const gq = dq.geocoding_quality;
  const setIf = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setIf("fallback-pct",         `${gq.fallback_pct}%`);
  setIf("banner-fallback-pct",  `${gq.fallback_pct}%`);
  setIf("banner-usable-pct",    `${gq.usable_pct}%`);
  setIf("banner-precise-pct",   `${gq.precise_pct}%`);
  setIf("banner-recovered-pct", `${gq.recovered_pct}%`);

  // Map quality caption
  const sj = dq.spatial_join;
  document.getElementById("map-quality").innerHTML =
    `All incidents with coordinates. <strong>${fmt(dq.geocoding_quality.precinct_fallback)} of ` +
    `${fmt(dq.total_incidents)} (${dq.geocoding_quality.fallback_pct}%) </strong> are geocoded to a ` +
    `precinct stationhouse rather than the actual incident location — these are hidden by default ` +
    `via the "Hide precinct-fallback" checkbox.`;

  // NYCHA quality caption
  document.getElementById("nycha-quality").innerHTML =
    `Computed on the <strong>${fmt(sj.denominator_n)}</strong> precisely-geocoded incidents ` +
    `(${dq.geocoding_quality.precise_pct}% of all). Of those, <strong>${fmt(sj.nycha_n)}</strong> ` +
    `(${sj.nycha_pct}%) fall within 100 ft of an NYCHA development. ` +
    `Precinct-fallback shootings are excluded because they'd cluster around stationhouses, ` +
    `which can sit adjacent to NYCHA campuses and create false hits.`;
}

// ---------------------------- Counts (was Trends) ----------------------------

function findHistoricalMin(values, dates) {
  // Skip the first 364 days (rolling sum is undefined / partial there — but data already has it dropped)
  let minIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[minIdx]) minIdx = i;
  }
  return { value: values[minIdx], date: dates[minIdx] };
}

// Shared unit state across all tabs. Both #unit-seg (counts) and #unit-seg-geo (geography)
// reflect and update this. setUnit() syncs both segs to the same value.
let UNIT_STATE = "incidents";
function currentUnit() { return UNIT_STATE; }
function setUnit(val) {
  UNIT_STATE = val;
  for (const seg of document.querySelectorAll("#unit-seg, #unit-seg-geo")) {
    seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.val === val));
  }
}
function currentMurder() {
  return document.querySelector("#murder-seg button.on").dataset.val;
}

function unitNouns(unit) {
  // What to call things in hover/text
  return unit === "victims"
    ? { all: "victims", fatal: "fatal (died)", nonfatal: "non-fatal (survived)", title: "victims" }
    : { all: "shootings", fatal: "fatal shootings (1+ killed)", nonfatal: "non-fatal shootings (no deaths)", title: "incidents" };
}

function renderRolling() {
  const unit = currentUnit();
  const which = currentMurder();
  const cw = DATA.citywide_rolling;
  const boro = DATA.boro_rolling;
  const series = cw[unit][which];
  const boroSeries = boro[unit];
  const histMin = findHistoricalMin(series, cw.dates);

  const nouns = unitNouns(unit);
  const noun = which === "fatal" ? nouns.fatal : which === "nonfatal" ? nouns.nonfatal : nouns.all;
  const periodLabels = cw.dates.map(trailingPeriodLabel);

  const traces = [
    {
      x: cw.dates, y: series, type: "scatter", mode: "lines",
      name: "Citywide", line: { color: CONFIG.citywideColor, width: 2.5 },
      customdata: periodLabels,
      hovertemplate: `<b>%{customdata}: %{y:,} ${noun}</b><extra></extra>`,
    },
  ];
  for (const b of CONFIG.boros) {
    if (!boroSeries[b]) continue;
    const niceName = b.charAt(0) + b.slice(1).toLowerCase();
    traces.push({
      x: boro.dates, y: boroSeries[b][which], type: "scatter", mode: "lines",
      name: niceName,
      line: { color: CONFIG.boroColors[b], width: 1.5 },
      visible: which === "all" ? true : "legendonly",
      hovertemplate: `${niceName}: %{y:,}<extra></extra>`,
    });
  }

  // Dotted horizontal line at the historical citywide minimum, extending across the entire span
  const lastDate = cw.dates[cw.dates.length - 1];
  const minLongDate = histMin.date ? formatLongDate(histMin.date) : "";
  const layout = plotlyLayoutDefaults({
    yaxis: { title: "Trailing 365-day count", rangemode: "tozero" },
    // Suppress the x-axis hover header so the citywide trace's period+count line is the prominent one
    xaxis: { title: "", hoverformat: " " },
    hoverlabel: { bgcolor: "rgba(255,255,255,0.95)", bordercolor: "#888",
                  font: { size: 13 } },
    shapes: [
      covidShape(),
      {
        type: "line", xref: "x", yref: "y",
        x0: histMin.date, x1: lastDate,
        y0: histMin.value, y1: histMin.value,
        line: { color: "#444", width: 1.2, dash: "dot" },
      },
    ],
    annotations: [
      {
        x: CONFIG.covid.start, y: 1, yref: "paper", xanchor: "left", yanchor: "top",
        text: " " + CONFIG.covid.label,
        showarrow: false, font: { size: 11, color: "#555" },
      },
      {
        x: lastDate, y: histMin.value, xanchor: "right", yanchor: "bottom",
        text: ` historical low: ${fmt(histMin.value)} for the 365 days ending ${minLongDate} `,
        showarrow: false, font: { size: 11, color: "#444" },
        bgcolor: "rgba(255,255,255,0.75)",
      },
    ],
  });
  Plotly.react("chart-rolling", traces, layout, plotlyConfig());
}

// Find the last day-of-year that actually has data for the current year (where cumulative changes).
function renderCumulative() {
  const unit = currentUnit();
  const which = currentMurder();
  const d = DATA.cumulative_by_year;
  const yearData = d[unit];
  const years = Object.keys(yearData).map(Number).sort();
  const maxYear = years[years.length - 1];
  const minYear = years[0];

  function lastDataDay(arr) {
    let last = arr.length - 1;
    while (last > 0 && arr[last] === arr[last - 1]) last--;
    return last;
  }

  // Single-hue blue gradient: older=lighter, newer=darker. Current year emphasized in orange.
  function color(y) {
    if (y === maxYear) return "#c2410c";
    const t = (y - minYear) / (maxYear - minYear || 1);
    // Light slate blue (low t) → dark navy (high t)
    const lightness = 78 - t * 50;   // 78% → 28%
    return `hsl(212, 55%, ${lightness}%)`;
  }

  // Year before the current year (newest historical) — kept in the legend explicitly
  const newestHistorical = maxYear - 1;

  const x = Array.from({length: 366}, (_, i) => i + 1);
  const traces = [];
  for (const y of years) {
    const series = yearData[y][which];
    // Only show 3 years in the legend: oldest historical, newest historical, current.
    const showLegend = (y === minYear || y === newestHistorical || y === maxYear);
    if (y === maxYear) {
      const last = lastDataDay(series);
      const xt = x.slice(0, last + 1);
      const yt = series.slice(0, last + 1);
      traces.push({
        x: xt, y: yt, type: "scatter", mode: "lines+markers",
        name: String(y),
        line: { color: color(y), width: 2.8 },
        marker: { color: color(y), size: 4, line: { width: 0 } },
        hovertemplate: `${y}, day %{x}: %{y:,}<extra></extra>`,
        showlegend: true,
      });
      traces.push({
        x: [xt[xt.length - 1]], y: [yt[yt.length - 1]],
        type: "scatter", mode: "markers",
        marker: { color: color(y), size: 10, line: { color: "white", width: 2 } },
        showlegend: false, hoverinfo: "skip",
      });
    } else {
      const t = (y - minYear) / (maxYear - minYear || 1);
      const w = 0.8 + t * 1.0;
      traces.push({
        x: x, y: series, type: "scatter", mode: "lines",
        name: String(y),
        line: { color: color(y), width: w },
        hovertemplate: `${y}, day %{x}: %{y:,}<extra></extra>`,
        showlegend: showLegend,
      });
    }
  }
  const layout = plotlyLayoutDefaults({
    yaxis: { title: "Cumulative shootings", rangemode: "tozero" },
    xaxis: { title: "Day of year", range: [1, 366] },
    legend: { orientation: "h", y: -0.18, x: 0 },
    margin: { l: 50, r: 20, t: 20, b: 50 },
  });
  Plotly.react("chart-cumulative", traces, layout, plotlyConfig());
}

function renderMonthly() {
  const unit = currentUnit();
  const which = currentMurder();
  const d = DATA.monthly;
  const nouns = unitNouns(unit);
  const noun = which === "fatal" ? nouns.fatal : which === "nonfatal" ? nouns.nonfatal : nouns.title;
  const trace = {
    x: d.months, y: d[unit][which], type: "bar",
    marker: { color: "#c2410c" },
    name: "Monthly",
    hovertemplate: `%{x}<br>%{y:,} ${noun}<extra></extra>`,
  };
  const layout = plotlyLayoutDefaults({
    yaxis: { title: "Shootings", rangemode: "tozero" },
    shapes: [covidShape()],
    showlegend: false,
    annotations: [{
      x: CONFIG.covid.start, y: 1, yref: "paper", xanchor: "left", yanchor: "top",
      text: " " + CONFIG.covid.label,
      showarrow: false, font: { size: 11, color: "#555" },
    }],
  });
  Plotly.react("chart-monthly", [trace], layout, plotlyConfig());
}

function renderCounts() {
  renderRolling();
  renderCumulative();
  renderMonthly();
}

// ---------------------------- Geography ----------------------------

// Single-hue darkening colorscale — dark = high. (Plotly's "Reds" has light cream at 0,
// not white, which can look pale. Build a custom 0=white → high=dark.)
const REDS_DARK_HIGH = [
  [0, "#ffffff"], [0.1, "#fee5d9"], [0.25, "#fcbba1"], [0.45, "#fc9272"],
  [0.65, "#fb6a4a"], [0.82, "#de2d26"], [1.0, "#7a0000"],
];

function renderBoroHeatmap() {
  const mode = document.getElementById("boro-mode").value;
  const unit = currentUnit();
  const d = DATA.boro_year;
  const pops = DATA.populations;
  const years = d.years;
  const unitBlock = d[unit];

  let z, hoverFmt, label, srcNote = "";
  const rawCounts = unitBlock.boros.map(r => r.counts);
  const boroNames = unitBlock.boros.map(r => r.boro);
  const unitNoun = unit === "victims" ? "victims" : "shootings";

  if (mode === "rate" && pops) {
    z = boroNames.map((b, i) => years.map((y, j) => {
      const p = (pops.by_boro[b] || [])[pops.years.indexOf(y)];
      return p ? (100000 * rawCounts[i][j] / p) : null;
    }));
    hoverFmt = `%{y}, %{x}: %{z:.1f} per 100k (%{customdata:,} ${unitNoun})<extra></extra>`;
    label = unit === "victims" ? "Victims per 100K residents" : "Shootings per 100K residents";
    const latestYear = pops.years[pops.years.length - 1];
    srcNote = "Population: Census Bureau Vintage 2024 / intercensal estimates. "
              + `${latestYear} carried forward where no later vintage is published.`;
  } else {
    z = rawCounts;
    hoverFmt = "%{y}, %{x}: %{z:,}<extra></extra>";
    label = unit === "victims" ? "Victims" : "Shootings";
  }
  document.getElementById("boro-rate-source").textContent = srcNote;

  const text = z.map(row => row.map(v =>
    v == null ? "" : (mode === "rate" ? v.toFixed(1) : fmt(v))
  ));
  const layout = plotlyLayoutDefaults({
    yaxis: { title: "" },
    xaxis: { title: "", side: "top" },
    margin: { l: 110, r: 20, t: 30, b: 20 },
    showlegend: false,
  });
  Plotly.react("chart-boro", [{
    type: "heatmap", z: z, x: years, y: boroNames,
    colorscale: REDS_DARK_HIGH, showscale: true,
    text: text, texttemplate: "%{text}",
    textfont: { size: 12, color: "#1a1a1a" },
    customdata: rawCounts,
    hovertemplate: hoverFmt,
    colorbar: { title: { text: label, side: "right" } },
  }], layout, plotlyConfig());
}

// Map a value into the same red ramp used in Plotly heatmaps (for HTML cell backgrounds).
function redCellBg(v, vmax) {
  if (!v) return "white";
  const t = Math.min(v / vmax, 1);
  // 7-stop ramp matching REDS_DARK_HIGH visually
  const stops = [
    [0,   [255,255,255]],
    [0.1, [254,229,217]],
    [0.25,[252,187,161]],
    [0.45,[252,146,114]],
    [0.65,[251,106,74]],
    [0.82,[222,45,38]],
    [1.0, [122,0,0]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const u = (t - t0) / (t1 - t0 || 1);
      const c = c0.map((x, k) => Math.round(x + u * (c1[k] - x)));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(122,0,0)";
}

let PRECINCT_SORT = { key: "recent", desc: true };

function renderPrecinctTable() {
  const unit = currentUnit();
  const d = DATA.precinct_year;
  const unitBlock = d[unit];
  const groupByBoro = document.getElementById("precinct-group-by-boro").checked;
  const tbl = document.getElementById("precinct-table");
  const thead = tbl.querySelector("thead");
  const tbody = tbl.querySelector("tbody");

  const vmax = Math.max(
    ...unitBlock.precincts.flatMap(p => p.counts), 1
  );

  // ---- Header
  thead.innerHTML = "";
  const tr1 = document.createElement("tr");
  function th(label, key, opts = {}) {
    const el = document.createElement("th");
    el.textContent = label;
    if (key) {
      el.classList.add("sortable");
      if (PRECINCT_SORT.key === key) el.classList.add(PRECINCT_SORT.desc ? "sorted-desc" : "sorted-asc");
      el.addEventListener("click", () => {
        if (PRECINCT_SORT.key === key) PRECINCT_SORT.desc = !PRECINCT_SORT.desc;
        else { PRECINCT_SORT.key = key; PRECINCT_SORT.desc = opts.defaultDesc !== false; }
        renderPrecinctTable();
      });
    }
    if (opts.cls) el.classList.add(opts.cls);
    return el;
  }
  tr1.appendChild(th("Precinct", "precinct", { defaultDesc: false }));
  tr1.appendChild(th("Borough", "borough", { defaultDesc: false }));
  for (const y of d.years) {
    tr1.appendChild(th(String(y), `y${y}`, { cls: "num" }));
  }
  tr1.appendChild(th("Total", "total", { cls: "num" }));
  thead.appendChild(tr1);

  // ---- Body
  function sortValue(row) {
    const k = PRECINCT_SORT.key;
    if (k === "precinct") return row.precinct;
    if (k === "borough") return row.borough || "";
    if (k === "total") return row.total;
    if (k.startsWith("y")) {
      const year = parseInt(k.slice(1), 10);
      return row.counts[d.years.indexOf(year)];
    }
    if (k === "recent") return row.counts[d.years.length - 1];
    return 0;
  }
  function cmp(a, b) {
    const va = sortValue(a), vb = sortValue(b);
    if (typeof va === "number") return PRECINCT_SORT.desc ? vb - va : va - vb;
    return PRECINCT_SORT.desc ? String(vb).localeCompare(String(va))
                              : String(va).localeCompare(String(vb));
  }

  function makeBodyRow(r) {
    const tr = document.createElement("tr");
    const tdP = document.createElement("td"); tdP.textContent = r.precinct;
    const tdB = document.createElement("td"); tdB.textContent = r.borough || "";
    tr.appendChild(tdP); tr.appendChild(tdB);
    for (const v of r.counts) {
      const td = document.createElement("td");
      td.textContent = v;
      td.classList.add("num");
      if (v === 0) td.classList.add("zero");
      td.style.backgroundColor = redCellBg(v, vmax);
      if (v && v > vmax * 0.55) td.style.color = "white";
      tr.appendChild(td);
    }
    const tdT = document.createElement("td"); tdT.textContent = fmt(r.total);
    tdT.classList.add("num"); tdT.style.fontWeight = "600";
    tr.appendChild(tdT);
    return tr;
  }

  tbody.innerHTML = "";
  const rows = [...unitBlock.precincts];

  if (groupByBoro) {
    const boroOrder = ["BRONX", "BROOKLYN", "MANHATTAN", "QUEENS", "STATEN ISLAND"];
    const groups = {};
    for (const r of rows) {
      const b = r.borough || "(unknown)";
      (groups[b] ||= []).push(r);
    }
    const orderedBoros = [...boroOrder, ...Object.keys(groups).filter(b => !boroOrder.includes(b))];
    for (const b of orderedBoros) {
      if (!groups[b]) continue;
      const header = document.createElement("tr");
      const th = document.createElement("td");
      th.colSpan = 3 + d.years.length;
      th.textContent = b;
      th.classList.add("boro-divider");
      header.appendChild(th);
      tbody.appendChild(header);
      groups[b].sort(cmp);
      for (const r of groups[b]) tbody.appendChild(makeBodyRow(r));
    }
  } else {
    rows.sort(cmp);
    for (const r of rows) tbody.appendChild(makeBodyRow(r));
  }
}

// State for NTA filter applied via click-through
let MAP_NTA_FILTER = null;          // nta_code or null
let MAP_NTA_NAME = null;

function focusMapOnNTA(ntaCode, ntaName, dateWindow) {
  MAP_NTA_FILTER = ntaCode;
  MAP_NTA_NAME = ntaName;

  const fromEl = document.getElementById("map-from");
  const toEl = document.getElementById("map-to");
  const fatalOnly = document.getElementById("map-fatal-only");

  const meta = DATA.meta;
  const lastDate = meta.date_range[1];
  const end = new Date(lastDate);
  const start = new Date(end);
  if (dateWindow === "last_365") start.setDate(start.getDate() - 364);
  else if (dateWindow === "last_5y") start.setDate(start.getDate() - 365 * 5);
  else start.setTime(new Date(meta.date_range[0]).getTime());
  fromEl.value = start.toISOString().slice(0, 10);
  toEl.value = lastDate;
  fatalOnly.checked = dateWindow === "fatal_total";

  // Update the quick-range segmented control to reflect the chosen window
  const daysMap = { last_365: "365", last_5y: "1825", total: "0", fatal_total: "0" };
  const days = daysMap[dateWindow];
  document.querySelectorAll("#map-range-seg button").forEach(b => {
    b.classList.toggle("on", b.dataset.days === days);
  });

  refreshMap();
  // Don't scroll — map is now next to the table.
}

function clearNtaFilter() {
  MAP_NTA_FILTER = null;
  MAP_NTA_NAME = null;
  refreshMap();
}

// ----- NTA hotspot table -----
function renderNtaTable() {
  const d = DATA.nta_hotspots;
  const tbl = document.getElementById("nta-table");
  const thead = tbl.querySelector("thead");
  const tbody = tbl.querySelector("tbody");

  const cols = [
    { key: "name", label: "Neighborhood (NTA)", num: false },
    { key: "borough", label: "Borough", num: false },
    { key: "last_365", label: `Last 365 days`, num: true },
    { key: "last_5y", label: "Last 5 years", num: true },
    { key: "total", label: "All-time", num: true },
    { key: "fatal_total", label: "Fatal", num: true },
  ];

  let sortKey = "last_365";
  let sortDesc = true;

  function rebuild() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c.label;
      if (c.num) th.classList.add("num");
      if (c.key === sortKey) th.classList.add(sortDesc ? "sorted-desc" : "sorted-asc");
      th.addEventListener("click", () => {
        if (sortKey === c.key) sortDesc = !sortDesc;
        else { sortKey = c.key; sortDesc = c.num; }
        rebuild();
      });
      tr.appendChild(th);
    }
    thead.appendChild(tr);

    const rows = [...d.ntas].filter(r => r.total > 0);
    rows.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === "number") return sortDesc ? vb - va : va - vb;
      return sortDesc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
    });
    tbody.innerHTML = "";
    for (const r of rows.slice(0, 60)) {
      const row = document.createElement("tr");
      if (r.last_365 >= 8) row.classList.add("very-hot");
      else if (r.last_365 >= 4) row.classList.add("hot");
      for (const c of cols) {
        const td = document.createElement("td");
        if (c.key === "name") {
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = r.name;
          a.addEventListener("click", e => {
            e.preventDefault();
            focusMapOnNTA(r.nta, r.name, "last_5y");
          });
          td.appendChild(a);
        } else if (c.num) {
          // Make numeric cells clickable to filter map by that time window
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = fmt(r[c.key]);
          a.classList.add("subtle");
          a.title = `View these ${r[c.key]} shootings on the map`;
          a.addEventListener("click", e => {
            e.preventDefault();
            focusMapOnNTA(r.nta, r.name, c.key);  // c.key is last_365 / last_5y / total / fatal_total
          });
          td.appendChild(a);
          td.classList.add("num");
        } else {
          td.textContent = r[c.key];
        }
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    // Footer note about how many were truncated
    const truncated = rows.length - 60;
    if (truncated > 0) {
      const footRow = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.style.textAlign = "center"; td.style.color = "#888"; td.style.fontStyle = "italic";
      td.textContent = `… ${truncated} more neighborhoods with at least 1 shooting (not shown)`;
      footRow.appendChild(td);
      tbody.appendChild(footRow);
    }
  }
  rebuild();
}

// ----- NYCHA table with sparklines -----
function sparklineSVG(values, width = 80, height = 18) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const dx = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${(i*dx).toFixed(1)},${(height - (v/max)*height).toFixed(1)}`).join(" ");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#c2410c" stroke-width="1.4" points="${points}"/>
  </svg>`;
}

let NYCHA_BUFFER = "100";  // chosen via radio toggle; key into r.by_buffer

function renderNychaTable() {
  const d = DATA.nycha_clusters;
  const tbl = document.getElementById("nycha-table");
  const thead = tbl.querySelector("thead");
  const tbody = tbl.querySelector("tbody");

  // Pick the current buffer; fall back to the largest available if 100ft slot
  // is empty (e.g., old build emitted flat structure)
  const availableBuffers = (d.buffers || [100]).map(String);
  if (!availableBuffers.includes(NYCHA_BUFFER)) NYCHA_BUFFER = availableBuffers[0];

  // Pull per-row figures for the active buffer; supports legacy flat structure too
  const pick = r => (r.by_buffer ? r.by_buffer[NYCHA_BUFFER] : {
    total: r.total, fatal_total: r.fatal_total, last_365: r.last_365, by_year: r.by_year || [],
  });

  // Compute formatted date-range labels: "Mar. 11, 2025–Mar. 10, 2026" and "Jan. 1, 2006–Mar. 10, 2026"
  function isoMinusDays(iso, days) {
    const d = new Date(iso);
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  const last365Label = `${formatLongDateAbbr(isoMinusDays(d.as_of, 364))}–${formatLongDateAbbr(d.as_of)}`;
  const allTimeLabel = `${formatLongDateAbbr(`${d.years[0]}-01-01`)}–${formatLongDateAbbr(d.as_of)}`;

  const cols = [
    { key: "name", label: "Development", num: false },
    { key: "borough", label: "Borough", num: false },
    { key: "last_365", label: last365Label, num: true },
    { key: "total", label: allTimeLabel, num: true },
    { key: "fatal_total", label: "Fatal", num: true },
  ];

  let sortKey = "last_365";
  let sortDesc = true;

  function rebuild() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c.label;
      if (c.num) th.classList.add("num");
      if (c.key === sortKey) th.classList.add(sortDesc ? "sorted-desc" : "sorted-asc");
      th.addEventListener("click", () => {
        if (sortKey === c.key) sortDesc = !sortDesc;
        else { sortKey = c.key; sortDesc = c.num; }
        rebuild();
      });
      tr.appendChild(th);
    }
    thead.appendChild(tr);

    const rows = d.developments.map(r => ({ ...r, _pick: pick(r) }))
      .filter(r => r._pick.total > 0);
    rows.sort((a, b) => {
      let va, vb;
      if (sortKey === "name" || sortKey === "borough") {
        va = a[sortKey]; vb = b[sortKey];
        return sortDesc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
      }
      va = a._pick[sortKey]; vb = b._pick[sortKey];
      return sortDesc ? vb - va : va - vb;
    });
    tbody.innerHTML = "";
    for (const r of rows) {
      const row = document.createElement("tr");
      const p = r._pick;
      if (p.last_365 >= CONFIG.nyhcaVeryHotThreshold) row.classList.add("very-hot");
      else if (p.last_365 >= CONFIG.nyhcaHotThreshold) row.classList.add("hot");
      for (const c of cols) {
        const td = document.createElement("td");
        if (c.key === "name") {
          const btn = document.createElement("button");
          btn.textContent = r.name;
          btn.className = "dev-link";
          btn.style.cssText = "background:none; border:none; padding:0; color:#1f6feb; cursor:pointer; text-align:left; font:inherit; text-decoration:underline;";
          btn.addEventListener("click", () => openDevMap(r));
          td.appendChild(btn);
        } else if (c.key === "borough") {
          td.textContent = r.borough;
        } else {
          td.textContent = fmt(p[c.key]);
          td.classList.add("num");
        }
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
  }
  rebuild();
}

// Re-render the table when the buffer radio changes
document.addEventListener("change", e => {
  if (e.target && e.target.name === "nycha-buffer") {
    NYCHA_BUFFER = e.target.value;
    renderNychaTable();
  }
});

// ----- Per-development map modal -----
let DEV_GEO = null;            // FeatureCollection, lazy-loaded
let DEV_MAP = null;            // Leaflet map instance, reused across openings
let DEV_INCIDENTS_IDX = null;  // {tds: {buffer: [incident_key]}}, lazy-loaded

async function openDevMap(dev) {
  const overlay = document.getElementById("dev-map-overlay");
  const panel   = document.getElementById("dev-map-panel");
  const title   = document.getElementById("dev-map-title");
  const meta    = document.getElementById("dev-map-meta");

  title.textContent = dev.name + " (" + dev.borough + ")";
  const p = dev.by_buffer ? dev.by_buffer[NYCHA_BUFFER] : dev;
  meta.textContent = `Buffer ${NYCHA_BUFFER} ft · ${p.total} all-time shootings · ` +
                     `${p.fatal_total} fatal · ${p.last_365} in the last 365 days`;
  overlay.style.display = "flex";

  // Replace the map container with a fresh DIV every open. Avoids ALL Leaflet
  // re-init quirks (stuck _leaflet_id, leftover handlers, stale sizes).
  const oldMapDiv = document.getElementById("dev-map");
  const newMapDiv = document.createElement("div");
  newMapDiv.id = "dev-map";
  newMapDiv.style.cssText = "width:100%; height:540px; border-radius:6px; background:#f3f4f6;";
  oldMapDiv.replaceWith(newMapDiv);
  if (DEV_MAP) { try { DEV_MAP.remove(); } catch (e) {} DEV_MAP = null; }

  // Load polygon data on first open
  if (!DEV_GEO) {
    try {
      const r = await fetch("data/nycha_geometries.json");
      DEV_GEO = await r.json();
    } catch (e) {
      newMapDiv.innerHTML = "<p style='padding:20px;color:#900'>Failed to load polygon data: " + e + "</p>";
      return;
    }
  }
  const feat = DEV_GEO.features.find(f => (f.properties.tds || "") === dev.tds);
  if (!feat) {
    newMapDiv.innerHTML = "<p style='padding:20px;color:#900'>No polygon on file (tds=" + dev.tds + ")</p>";
    return;
  }

  // Wait for the modal to fully lay out so Leaflet can measure the container.
  await new Promise(r => setTimeout(r, 50));

  // Compute polygon centroid up front so we can setView immediately.
  // (Leaflet draws nothing visible until the map has a view; doing setView FIRST
  // means layers added next render correctly.)
  function featureCenter(feature) {
    const coords = feature.geometry.coordinates;
    let lats = [], lons = [];
    function walk(arr) {
      if (typeof arr[0] === "number") { lons.push(arr[0]); lats.push(arr[1]); }
      else arr.forEach(walk);
    }
    walk(coords);
    return [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lons) + Math.max(...lons)) / 2,
    ];
  }
  const center = featureCenter(feat);

  try {
    DEV_MAP = L.map(newMapDiv, { zoomControl: true }).setView(center, 16);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CartoDB",
      maxZoom: 19,
    }).addTo(DEV_MAP);
  } catch (e) {
    newMapDiv.innerHTML = "<p style='padding:20px;color:#900'>Map init failed: " + e + "</p>";
    console.error("dev-map L.map() failed:", e);
    return;
  }

  // Force size recalc NOW so subsequent layer adds and fitBounds use real dimensions.
  DEV_MAP.invalidateSize();

  // 1. Polygon
  const polygon = L.geoJSON(feat, {
    style: { color: "#1f6feb", weight: 2, fillColor: "#1f6feb", fillOpacity: 0.14 },
  }).addTo(DEV_MAP);

  // 2. Buffer ring (optional — needs Turf.js)
  const bufferFt = Number(NYCHA_BUFFER);
  let bufferedFeat = null;
  if (typeof turf !== "undefined" && turf && typeof turf.buffer === "function") {
    try {
      bufferedFeat = turf.buffer(feat, bufferFt * 0.3048, { units: "meters" });
      L.geoJSON(bufferedFeat, {
        style: { color: "#1f6feb", weight: 1.5, dashArray: "5,4",
                 fillColor: "#1f6feb", fillOpacity: 0.04, opacity: 0.7 },
      }).addTo(DEV_MAP);
    } catch (e) {
      console.warn("turf.buffer failed:", e);
    }
  }

  // 3. Bounding box for map framing (always works, no Turf dependency)
  let bbox;
  if (bufferedFeat) {
    bbox = L.geoJSON(bufferedFeat).getBounds();
  } else {
    const pb = polygon.getBounds();
    const padLat = bufferFt / 364320;
    const padLon = bufferFt / 287000;
    bbox = L.latLngBounds(
      [pb.getSouth() - padLat, pb.getWest() - padLon],
      [pb.getNorth() + padLat, pb.getEast() + padLon],
    );
  }

  // 4. Shooting markers — use the EXACT incident_keys the pipeline computed for
  // this (development, buffer). Guarantees the plotted count matches the table.
  if (!MAP_INCIDENTS) MAP_INCIDENTS = parseIncidents();
  if (!DEV_INCIDENTS_IDX) {
    try {
      const r = await fetch("data/nycha_dev_incidents.json");
      const j = await r.json();
      DEV_INCIDENTS_IDX = j.by_dev_buffer || {};
    } catch (e) {
      DEV_INCIDENTS_IDX = {};
      console.warn("Couldn't load nycha_dev_incidents.json:", e);
    }
  }
  const targetKeys = new Set(
    (DEV_INCIDENTS_IDX[dev.tds] && DEV_INCIDENTS_IDX[dev.tds][NYCHA_BUFFER]) || []
  );
  const incidents = MAP_INCIDENTS.filter(i => targetKeys.has(i.key));

  // Group incidents by coordinate so we don't render multiple markers stacked invisibly
  // at the same intersection — one marker per location, sized by count, popup lists all.
  const byCoord = new Map();
  for (const i of incidents) {
    const k = `${i.lat.toFixed(5)},${i.lon.toFixed(5)}`;
    if (!byCoord.has(k)) byCoord.set(k, []);
    byCoord.get(k).push(i);
  }
  for (const group of byCoord.values()) {
    const anyFatal = group.some(g => g.fatal);
    const radius = 5 + Math.min(group.length - 1, 6) * 1.2;  // grows with stack size
    const m = L.circleMarker([group[0].lat, group[0].lon], {
      radius, weight: 1.5, color: "#fff",
      fillColor: anyFatal ? "#dc2626" : "#f59e0b",
      fillOpacity: 0.92,
    });
    // Tooltip on hover: just the count summary
    const totalVic = group.reduce((s, g) => s + (g.vic_n || 0), 0);
    const fatalCount = group.filter(g => g.fatal).length;
    const hover = group.length === 1
      ? `${group[0].date} · ${group[0].fatal ? "fatal" : "non-fatal"} · ` +
        `${group[0].vic_n || "?"} victim${(group[0].vic_n || 0) === 1 ? "" : "s"}`
      : `${group.length} shootings stacked · ${fatalCount} fatal · ${totalVic} victims total`;
    m.bindTooltip(hover, { direction: "top" });
    // Popup on click: full list when stacked
    if (group.length > 1) {
      const lines = group
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map(i => `<li>${i.date} — ${i.fatal ? "<strong style='color:#b91c1c'>fatal</strong>" : "non-fatal"}` +
                  ` · ${i.vic_n || "?"} victim${(i.vic_n || 0) === 1 ? "" : "s"}</li>`)
        .join("");
      m.bindPopup(
        `<strong>${group.length} shootings at this location</strong>` +
        `<ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px">${lines}</ul>`
      );
    }
    m.addTo(DEV_MAP);
  }

  // 5. NOW fit to the buffered bounds (size is known correct from step 0)
  DEV_MAP.fitBounds(bbox, { padding: [24, 24], maxZoom: 18 });
  setTimeout(() => {
    if (!DEV_MAP) return;
    DEV_MAP.invalidateSize();
    DEV_MAP.fitBounds(bbox, { padding: [24, 24], maxZoom: 18 });
  }, 250);

  const fatalN = incidents.filter(i => i.fatal).length;
  meta.textContent +=
    ` · ${incidents.length} plotted at ${byCoord.size} location${byCoord.size === 1 ? "" : "s"} ` +
    `(${fatalN} fatal)`;
}

function closeDevMap() {
  const overlay = document.getElementById("dev-map-overlay");
  overlay.style.display = "none";
}
document.getElementById("dev-map-close").addEventListener("click", closeDevMap);
document.getElementById("dev-map-overlay").addEventListener("click", e => {
  if (e.target.id === "dev-map-overlay") closeDevMap();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("dev-map-overlay").style.display === "flex") {
    closeDevMap();
  }
});

// ----- Map -----
let MAP = null;
let MAP_LAYER = null;
let MAP_INCIDENTS = null;
let MAP_REFRESH = null;       // closure assigned in renderMap so click-throughs can call it

function refreshMap() { if (MAP_REFRESH) MAP_REFRESH(); }

function parseIncidents() {
  const d = DATA.incidents;
  const idx = {};
  d.columns.forEach((c, i) => idx[c] = i);
  return d.rows.map(r => ({
    key: r[idx.incident_key],
    date: r[idx.occur_date].slice(0, 10),
    year: r[idx.year],
    boro: r[idx.boro],
    precinct: r[idx.precinct],
    lat: r[idx.latitude],
    lon: r[idx.longitude],
    fatal: r[idx.fatal],
    vic_n: r[idx.vic_n],
    loc_class: r[idx.loc_class],
    loc_desc: r[idx.loc_desc],
    nycha: r[idx.nycha],
    nta: r[idx.nta],
    geo_q: r[idx.geo_q],
    coord_src: r[idx.coord_src],
  }));
}

function renderMap() {
  if (!MAP_INCIDENTS) MAP_INCIDENTS = parseIncidents();
  const dates = MAP_INCIDENTS.map(i => i.date);
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  const fromEl = document.getElementById("map-from");
  const toEl = document.getElementById("map-to");
  if (!fromEl.value) {
    const max = new Date(maxDate);
    const min = new Date(max);
    min.setDate(min.getDate() - 365);
    fromEl.value = min.toISOString().slice(0, 10);
    toEl.value = maxDate;
    fromEl.min = minDate; fromEl.max = maxDate;
    toEl.min = minDate;   toEl.max = maxDate;
  }

  if (!MAP) {
    MAP = L.map("map").setView([40.72, -73.94], 11);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 19,
    }).addTo(MAP);
  }

  function filtered() {
    const fatalOnly = document.getElementById("map-fatal-only").checked;
    const preciseOnly = document.getElementById("map-precise-only").checked;
    const nychaOnly = document.getElementById("map-nycha-only").checked;
    const f = fromEl.value, t = toEl.value;
    return MAP_INCIDENTS.filter(i =>
      i.date >= f && i.date <= t &&
      (!fatalOnly || i.fatal === 1) &&
      (!preciseOnly || i.geo_q === "precise") &&
      (!nychaOnly || i.nycha) &&
      (!MAP_NTA_FILTER || i.nta === MAP_NTA_FILTER)
    );
  }

  function refresh() {
    if (MAP_LAYER) MAP.removeLayer(MAP_LAYER);
    const mode = document.getElementById("map-mode").value;
    const incidents = filtered();

    if (mode === "heat") {
      const points = incidents.map(i => [i.lat, i.lon, i.fatal === 1 ? 2 : 1]);
      MAP_LAYER = L.heatLayer(points, { radius: 15, blur: 20, maxZoom: 17 }).addTo(MAP);
    } else if (mode === "points") {
      const layer = L.layerGroup();
      for (const i of incidents) {
        const color = i.fatal === 1 ? "#b91c1c" : "#1f77b4";
        const recovered = i.coord_src && i.coord_src.startsWith("linked_complaint");
        layer.addLayer(L.circleMarker([i.lat, i.lon], {
          radius: 3, fillColor: color, color: recovered ? "#0369a1" : color,
          weight: recovered ? 1.8 : 0.5, fillOpacity: 0.5,
          dashArray: recovered ? "2,2" : null,
        }).bindPopup(popupHtml(i)));
      }
      layer.addTo(MAP);
      MAP_LAYER = layer;
    } else {
      const cluster = L.markerClusterGroup({ chunkedLoading: true });
      for (const i of incidents) {
        const color = i.fatal === 1 ? "#b91c1c" : "#1f77b4";
        const recovered = i.coord_src && i.coord_src.startsWith("linked_complaint");
        cluster.addLayer(L.circleMarker([i.lat, i.lon], {
          radius: 4, fillColor: color, color: recovered ? "#0369a1" : color,
          weight: recovered ? 1.8 : 1, fillOpacity: 0.65,
          dashArray: recovered ? "2,2" : null,
        }).bindPopup(popupHtml(i)));
      }
      cluster.addTo(MAP);
      MAP_LAYER = cluster;
    }

    document.getElementById("map-count").textContent = `${fmt(incidents.length)} incidents in view`;

    // Show NTA filter banner if active, and fit map bounds to the filtered incidents
    let banner = document.getElementById("map-nta-banner");
    if (MAP_NTA_FILTER) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "map-nta-banner";
        banner.className = "map-banner";
        const mapEl = document.getElementById("map");
        mapEl.parentNode.insertBefore(banner, mapEl);
      }
      banner.innerHTML = `<strong>Filtered to ${MAP_NTA_NAME}</strong> ` +
                         `<button id="clear-nta">clear</button>`;
      document.getElementById("clear-nta").onclick = clearNtaFilter;
      // Fit bounds to the filtered points
      if (incidents.length) {
        const lats = incidents.map(i => i.lat), lons = incidents.map(i => i.lon);
        MAP.fitBounds([
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)],
        ], { padding: [40, 40] });
      }
    } else if (banner) {
      banner.remove();
    }
  }
  MAP_REFRESH = refresh;

  function popupHtml(i) {
    let attribution = "";
    if (i.geo_q === "precinct_fallback") {
      attribution = `<small style='color:#888'>⚠ geocoded to precinct stationhouse</small>`;
    } else if (i.coord_src === "linked_complaint_h_suffix") {
      attribution = `<small style='color:#0369a1'>✓ coordinates recovered from linked MURDER ` +
                    `complaint (deterministic ID match)</small>`;
    } else if (i.coord_src === "linked_complaint_fuzzy") {
      attribution = `<small style='color:#0369a1'>✓ coordinates recovered from linked ` +
                    `complaint (date + precinct + time match)</small>`;
    }
    return `<strong>${i.date}</strong><br>` +
      `Precinct ${i.precinct ?? "?"} (${i.boro ?? "?"})<br>` +
      (i.fatal === 1 ? "<span style='color:#b91c1c'>Fatal</span><br>" : "") +
      (i.loc_class ? `Location class: ${i.loc_class}<br>` : "") +
      (i.loc_desc ? `Location: ${i.loc_desc}<br>` : "") +
      (i.nycha ? `<em>NYCHA: ${i.nycha}</em><br>` : "") +
      attribution;
  }

  // Quick-range buttons
  const seg = document.getElementById("map-range-seg");
  if (seg && !seg.dataset.wired) {
    seg.dataset.wired = "1";
    seg.addEventListener("click", e => {
      const btn = e.target.closest("button");
      if (!btn) return;
      seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
      const days = parseInt(btn.dataset.days, 10);
      const end = new Date(maxDate);
      let start;
      if (days === 0) {
        start = new Date(minDate);
      } else {
        start = new Date(end);
        start.setDate(start.getDate() - days + 1);
      }
      fromEl.value = start.toISOString().slice(0, 10);
      toEl.value = maxDate;
      refresh();
    });
  }

  fromEl.onchange = () => { clearRangeSelection(); refresh(); };
  toEl.onchange   = () => { clearRangeSelection(); refresh(); };
  function clearRangeSelection() {
    document.querySelectorAll("#map-range-seg button.on").forEach(b => b.classList.remove("on"));
  }
  document.getElementById("map-fatal-only").onchange = refresh;
  document.getElementById("map-precise-only").onchange = refresh;
  document.getElementById("map-nycha-only").onchange = refresh;
  document.getElementById("map-mode").onchange = refresh;
  refresh();

  setTimeout(() => MAP.invalidateSize(), 100);
}

function renderGeography() {
  renderBoroHeatmap();
  renderPrecinctTable();
  renderNtaTable();
  renderNychaTable();
  renderMap();
}

// ---------------------------- Who ----------------------------

function unknownAwareColors(categories) {
  const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                   "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#7f7f7f"];
  let pi = 0;
  return categories.map(c => {
    if (c === "UNKNOWN" || c === "UNKNOWN/PRE-2022" || c === "UNKNOWN/NONE")
      return CONFIG.unknownColor;
    return palette[pi++ % palette.length];
  });
}

function renderDimension(divId, ct, title) {
  const cats = ct.categories;
  const colors = unknownAwareColors(cats);
  const rowTotals = ct.matrix.map(row => row.reduce((a,b)=>a+b, 0));
  const traces = cats.map((cat, j) => ({
    name: cat,
    x: ct.years,
    y: ct.matrix.map((row, i) => rowTotals[i] ? 100 * row[j] / rowTotals[i] : 0),
    customdata: ct.matrix.map(row => row[j]),
    type: "bar",
    marker: { color: colors[j] },
    hovertemplate: `${cat}: %{y:.1f}% (%{customdata:,} records)<extra></extra>`,
  }));
  const layout = plotlyLayoutDefaults({
    barmode: "stack",
    yaxis: { title: "Share (%)", range: [0, 100] },
    xaxis: { title: "" },
    legend: { orientation: "h", y: -0.18, x: 0 },
  });
  Plotly.react(divId, traces, layout, plotlyConfig());
}

function renderNoOffender() {
  const d = DATA.demographics.offender_unreported;
  const pct = d.years.map((y, i) => d.n_incidents[i] ? 100 * d.n_no_offender[i] / d.n_incidents[i] : 0);
  const trace = {
    x: d.years, y: pct, type: "bar",
    marker: { color: "#7f7f7f" },
    customdata: d.years.map((_, i) => [d.n_no_offender[i], d.n_incidents[i]]),
    hovertemplate: "%{x}: %{y:.1f}% (%{customdata[0]:,} of %{customdata[1]:,} incidents)<extra></extra>",
  };
  const layout = plotlyLayoutDefaults({
    yaxis: { title: "% of incidents with no suspect record", range: [0, 100] },
    xaxis: { title: "" },
    showlegend: false,
  });
  Plotly.react("chart-no-offender", [trace], layout, plotlyConfig());
}

function renderLocClass() {
  renderDimension("chart-locclass", DATA.location_types.loc_class, "By location class");
}

function renderLocDesc() {
  const d = DATA.location_types.loc_desc;
  const totals = d.categories.map((_, j) =>
    d.matrix.reduce((a, row) => a + row[j], 0));
  const idxs = totals.map((_, i) => i).sort((a,b) => totals[b] - totals[a]).slice(0, 12);
  renderDimension("chart-locdesc", {
    years: d.years,
    categories: idxs.map(i => d.categories[i]),
    matrix: d.matrix.map(row => idxs.map(i => row[i])),
  });
}

function renderWho() {
  const side = document.getElementById("who-side").value;
  const dim = side === "victims" ? DATA.demographics.victims : DATA.demographics.offenders;
  renderDimension("chart-race", dim.race);
  renderDimension("chart-age", dim.age);
  renderDimension("chart-sex", dim.sex);

  const isOff = side === "offenders";
  document.getElementById("off-unrep-h2").style.display = isOff ? "" : "none";
  document.getElementById("off-unrep-caption").style.display = isOff ? "" : "none";
  document.getElementById("chart-no-offender").style.display = isOff ? "" : "none";
  if (isOff) renderNoOffender();

  renderLocClass();
  renderLocDesc();
}

// ---------------------------- tabs ----------------------------

function activateTab(name) {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const sec of document.querySelectorAll(".panel")) {
    sec.classList.toggle("active", sec.id === name);
  }
  if (!RENDERED[name]) {
    if (name === "counts") renderCounts();
    if (name === "geography") renderGeography();
    if (name === "who") renderWho();
    RENDERED[name] = true;
  } else if (name === "geography") {
    if (MAP) setTimeout(() => MAP.invalidateSize(), 100);
  }
  history.replaceState(null, "", "#" + name);
}

// ---------------------------- init ----------------------------

async function init() {
  await loadAll();
  renderHeader();
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  }
  // Wire up segmented controls (NYT-pattern: click button → set .on)
  function wireSeg(segId, onChange) {
    const seg = document.getElementById(segId);
    if (!seg) return;
    seg.addEventListener("click", e => {
      const btn = e.target.closest("button");
      if (!btn) return;
      seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
      onChange();
    });
  }
  function refreshUnitLabels() {
    const unit = currentUnit();
    document.getElementById("seg-fatal").textContent =
      unit === "incidents" ? "1+ fatality" : "Fatal (died)";
    document.getElementById("seg-nonfatal").textContent =
      unit === "incidents" ? "No fatalities" : "Non-fatal";
  }
  // Both unit segs (#unit-seg on Counts, #unit-seg-geo on Geography) update shared UNIT_STATE
  function onUnitClick(e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    setUnit(btn.dataset.val);
    refreshUnitLabels();
    if (RENDERED.counts) renderCounts();
    if (RENDERED.geography) renderGeography();
  }
  for (const segId of ["unit-seg", "unit-seg-geo"]) {
    const seg = document.getElementById(segId);
    if (seg) seg.addEventListener("click", onUnitClick);
  }
  wireSeg("murder-seg", () => { if (RENDERED.counts) renderCounts(); });
  refreshUnitLabels();

  document.getElementById("precinct-group-by-boro").addEventListener("change", () => {
    if (RENDERED.geography) renderPrecinctTable();
  });
  document.getElementById("boro-mode").addEventListener("change", () => {
    if (RENDERED.geography) renderBoroHeatmap();
  });
  document.getElementById("who-side").addEventListener("change", () => {
    if (RENDERED.who) renderWho();
  });

  const initial = (location.hash || "#counts").slice(1);
  activateTab(["counts","geography","who","about"].includes(initial) ? initial : "counts");
}

init().catch(err => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:20px;color:#b91c1c">Failed to load dashboard:\n${err.message}\n\nMake sure you're serving this directory with a local server (e.g. python -m http.server) rather than opening index.html directly — browsers block fetch() on file:// URLs.</pre>`;
});
