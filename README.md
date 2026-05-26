# NYC Shootings

A dashboard for exploring NYC shooting incident data, 2006–present.

**Live site:** https://tedalcorn.github.io/nyc-shootings/

## What it shows

- **Counts** — 365-day rolling totals (citywide + per borough), cumulative-by-day-of-year overlay, monthly counts. Toggle between incidents / victims and between all / fatal / non-fatal.
- **Geography** — borough × year heatmap (counts or rates per 100,000 residents), precinct × year sortable table, neighborhood (NTA) hotspot table with linked map, NYCHA development clusters, interactive incident map.
- **Who** — victim and suspect demographic breakdowns over time (race, age, sex), location-type breakdowns, structural-missingness charts.

## Data sources

- [Shootings (2006-Present)](https://data.cityofnewyork.us/Public-Safety/Shootings-2006-Present-/5ucz-vwe8) — NYPD via NYC Open Data
- [Shooting Victims (2006-Present)](https://data.cityofnewyork.us/Public-Safety/Shooting-Victims-2006-Present-/pztn-9bne)
- [Shooting Offenders (2006-Present)](https://data.cityofnewyork.us/Public-Safety/Shooting-Offenders-2006-Present-/gdk4-mbsv)
- [NYPD Complaint Data Historic](https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Historic/qgea-i56i) — used to recover coordinates for shootings that NYPD geocoded only to the precinct stationhouse
- [NYCHA Public Housing Developments](https://data.cityofnewyork.us/Housing-Development/NYCHA-Public-Housing-Developments/phvi-damg)
- [2020 Neighborhood Tabulation Areas](https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd)
- [Census Bureau county population estimates](https://www.census.gov/programs-surveys/popest.html) (2006–2024)

## Methodology in brief

About 48% of NYC shooting records have lat/lon set to the precinct stationhouse rather than the actual incident location (NYPD's default when an address can't be geocoded). The pipeline:

1. Detects fallback-geocoded rows by finding lat/lon shared by 3+ incidents in a single precinct.
2. Attempts to recover real coordinates by cross-matching to the NYPD Complaint dataset:
   - **Fatal shootings:** deterministic match via complaint number suffix (`incident_key + 'H<n>'` on a MURDER complaint).
   - **Non-fatal shootings:** fuzzy match on date + precinct + ±60-minute time window + offense in {FELONY ASSAULT, ROBBERY}.
3. Validates the matching against precisely-geocoded shootings as ground truth (84–87% of recovered coordinates land within 75 m of the true location).
4. Excludes fallback rows that couldn't be recovered from all map and small-area analyses.

See the dashboard's "About" tab for full methodology.

## How it's built

Static site: vanilla HTML + JS, Plotly.js for charts, Leaflet for maps. JSON data files are pre-computed by a Python pipeline that lives in the parent project directory (not in this repo).
