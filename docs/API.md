# RTS Cooling Load v2.0.0 — API reference

`const rts = require('./rts-cooling-load.js')` (Node.js), or load the file with a `<script>` tag (browser globals).
`rts.RTS_COOLING_LOAD_VERSION` is `'2.0.0'`.

Units: SI. Temperatures °C, areas m², U-factors W/(m²·K), loads W, angles degrees.
24-value series are indexed 0–23 for hours 1–24. Monthly arrays are indexed 0–11 for January–December.
Time-factor series (CTS, RTS) are in percent and sum to 100.

The main functions are listed below. Every other top-level function and constant in the file is also exported; those not listed here are internal helpers and may change between versions.

---

## Reference data

| Name | Content |
|---|---|
| `MATERIALS` | Material properties `{name, k, isAir, …}`; solid layers also carry density and specific heat for the conduction solver. Air films and cavities (`isAir: true`) are resistance-only. |
| `COMPONENT_PRESETS` | Example assemblies `{name, layers:[{material, thk}]}` (`thk` in mm) |
| `SHGC_TABLE` | Glazing groups `{name, shgc0, curve}` |
| `SHGC_CURVE_COEFFS`, `SHGC_CURVE_INFO` | Coefficients and descriptions of the SHGC angular curves |
| `ACTIVITY_LEVELS` | Occupant heat gain `{name, sensible, latent, radiantFrac, met}` (W per person) |
| `LIGHTING_FIXTURES` | `{name, radiantFrac, convFrac}` |
| `EQUIPMENT_COOLING_TYPES` | Radiant/convective split by equipment cooling type |
| `PDR_PROFILE_24` | Hourly fraction of the daily temperature range used to build outdoor temperature profiles |
| `COUNTRY_TZ` | `{country, tz}` — used only to resolve a country name read from a weather workbook |

No climatic data and no conduction or radiant time factor tables are included.

---

## Conduction time factors

### `computeCtsFromLayers(layers)`
- `layers`: outside → inside, `[{material, thickness}]`; `material` is a `MATERIALS` name, `thickness` in mm. The first and last layers must be air films.
- Returns `null` if the assembly cannot be solved, otherwise
  `{cts, converged, cycles, uWm2K, uExactWm2K, uRelError, responseDecayed}`:
  - `cts` — 24 values (%)
  - `uExactWm2K` — U = 1/ΣR from the layers
  - `uWm2K` — U recovered from the computed periodic response
  - `uRelError` — relative difference between the two (the per-call check)
  - `converged` — `true` when `uRelError` is below the solver tolerance

## Radiant time factors

### `rts2Compute(cls, carpet, furnFrac, mode, opt)`
- `cls`: construction class `'L' | 'M' | 'H'`
- `carpet`: `true | false`
- `furnFrac`: furnishing fraction of floor area, 0–1
- `mode`: `'nonsolar' | 'solar'`
- `opt`: `{W, D, H}` zone dimensions (m), `glassFrac` (glazed fraction of the exterior wall), `partFrac` (partition fraction of the total wall area), and solver settings `dt`, `iters`, `maxCyc` (the web application uses `dt: 60, iters: 4, maxCyc: 80`)
- Returns `{rtf, balance, cycles, converged, settings}`: `rtf` — 24 values (%); `balance` — energy balance of the zone response (1 = exact)

## Solar and window

### `surfaceIrradiance(hour, n, lat, lon, hemisphere, tz, taub, taud, surfaceAzimuth, tilt)`
Clear-sky irradiance on a surface. `n` = day of year from `dayOfYear(year, month, day)`. `lat` signed (south negative); `lon` unsigned with `hemisphere` `'E' | 'W'`; `tz` in hours. `surfaceAzimuth`: degrees from south, west positive (S = 0, W = 90, N = 180, E = −90). `tilt`: 90 = vertical.

### `shgcAtAngle(glassEntry, thetaDeg)`
SHGC at incidence angle `thetaDeg` for `glassEntry = {shgc0, curve}` (an entry of `SHGC_TABLE` or your own).
Related: `shgcNormTau(curve, phiDeg)`, `shgcHemispherical(shgc0, curve)`, `shgcHemisphericalShapeIntegral(curve)`.

## Component loads (24 hours, one month)

`solar` below is `{lat, lon, hemisphere, tz, taub, taud, surfaceAzimuth, tilt, year, month, day}` — pass that month's `taub`/`taud`.

### `calcOpaqueSurfaceCoolingLoad24(p)`
`p = {kind: 'wall'|'roof', uFactor, area, roomTemp, outdoorTempHourly24, alphaHo, cts24, nsRts24, solar}`
`alphaHo`: absorptance divided by outside film coefficient (the web application uses 0.052 for dark and 0.026 for light surfaces).
Returns `{hourly, correction, convFraction}`; `hourly[h].totalCoolingLoad` is the cooling load (W).

### `calcWindowCoolingLoad24(p)`
`p = {area, uFactor, roomTemp, glassEntry, shaded, outdoorTempHourly24, srts24, nsRts24, solar}`
`srts24` is used only when `shaded` is `false`. `hourly[h].totalCoolingLoad` is the cooling load (W).

### `calcOccupantLoad24(p)`, `calcLightingLoad24(p)`, `calcEquipmentLoad24(p)`, `calcMiscLoad24(p)`
- Occupants: `{count, activityLevelIndex, usageProfile24, nsRts24}`
- Lighting: `{watt, fixtureIndex, usageProfile24, nsRts24}`
- Equipment: `{sensibleW, latentW, coolingTypeIndex, usageProfile24, nsRts24}`

`usageProfile24` holds fractions 0–1. The result's `hourly[h].total` is the cooling load (W); occupants and equipment also report latent load. See the comments above each function for the full field list.

### `calcOutdoorAirLoad24(p)`, `calcOutdoorAirLoad24WithTreatment(p)`
Outdoor-air sensible and latent loads. The second adds `treatmentType: 'none' | 'doas' | 'erv' | 'hrv'` with `doasTemp`, `doasRH`, `tempEffPct`, `enthalpyEffPct` as applicable. See the function comments for the input fields.

### 12-month wrappers
`calcOpaqueSurfaceCoolingLoad12Month(p)` and `calcWindowCoolingLoad12Month(p)` loop over the 21st of each month using `p.weatherData`, but they use the **0.4 %** design dry-bulb for every month and keep the `taub`/`taud` given in `p.solar` **for all months**. The web application instead loops the 24-hour functions month by month with each month's `taub`/`taud` and the selected design percentile — as shown in [`examples/basic_usage.js`](../examples/basic_usage.js).

## Room totals

### `combineRoomLoad12Month(components, safetyFactors)`
Adds component results at the same month and hour and applies `safetyFactors = {ductLossPct, fanHeatGainPct, overallSafetyFactorPct}`. Returns `{perMonth, peak}`. Input shape: see the function comment.

### `calcOutputSummary(p)`
`p = {designSensible, designLatent, roomTemp, supplyAirTemp, …}` → RSHR, TSHR and supply-air values. See the function comment.

## Outdoor conditions and psychrometrics

- `hourlyOutdoorTempForMonth(designDB, mdbr)` → 24 temperatures
- `generateHourlyOutdoorTempAllMonths(weatherData)` → 12 × 24 (uses `monthlyDesignDB.p0_4`)
- `hourlyOutdoorRHForMonth(designDB, mdbr, designWB, mcwbr, elevM)`
- `pws(T)`, `pwsExact(Tc)`, `humidityRatio(T, rhFrac, pressureKPa)` (g/kg), `rhFromHumidityRatio(T, W_gkg, pressureKPa)`, `moistAirEnthalpy(Tc, W_gPerKg)`, `atmosphericPressure(elevM)` (kPa), `solveTadp(DB, rhFrac, pressureKPa, rshr)`

## Weather workbooks

### `parseWeatherFile(file, countryTzTable)` *(async, browser)*
Reads a `File` (`.xlsx`) with SheetJS (global `XLSX` required) and returns `extractWeatherData(...)`.

### `extractWeatherData(aoa, countryTzTable)`
Parses a station page already read into an array of rows (`aoa`), e.g. by any spreadsheet or CSV reader. Pass `COUNTRY_TZ` as `countryTzTable`. Returns the fields below plus `errors` (labels not found). Check `errors` and missing values before use — nothing is filled in for you.

### WeatherData
The object the calculation functions expect (build it yourself or take it from `extractWeatherData`):

```
name, lat (signed), lon (unsigned), hemisphere ('E'|'W'), elev (m), tz (h)
hottestMonth                      1–12
monthlyDesignDB   {p0_4, p2, p5}  [12] each, °C
monthlyDesignMCWB {p0_4, p2, p5}  [12] each, °C
mdbr[12], mcwbr[12]               mean coincident daily DB / WB range, K
taub[12], taud[12]                clear-sky optical depths
```

## Room-state helpers

`createDefaultRoomState()`, `newWall()`, `newWindow()`, `newRoof()`, `newCeiling()`, `newPartition()`, `newFloor()`, `newOccupant()`, `newLighting()`, `newEquipment()`, `newMisc()`, `newLayer(materialName, thicknessMm)`, `addComponent(state, type)`, `removeComponent(state, type, id)`, `recomputeRoomGeometry(state)`, `recomputeLightingWatt(state)` — input-object templates used by the web application.
