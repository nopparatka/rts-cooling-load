# RTS Cooling Load

An open-source JavaScript engine implementing the **ASHRAE Radiant Time Series (RTS) method** for nonresidential cooling load calculation (ASHRAE Handbook—Fundamentals, Chapter 18).

Single file, no dependencies, no build step. Works in Node.js (`require`) and in the browser (`<script>`; every function and constant becomes a global).

> This engine is the calculation part of the ezyRTS web application ([ezyhvac.com](https://ezyhvac.com)). The user interface is **not** part of this repository.

**Version 2.0.0** replaces the table-based v1.0.0 engine. It is not backward compatible (see [Changes from v1.0.0](#changes-from-v100)).

## What it does

- **Conduction time factors computed at run time** — `computeCtsFromLayers()` builds the 24-hour CTS of any layer assembly with a transient finite-volume calculation and checks the result on every call against the steady-state transmittance (U = 1/R).
- **Radiant time factors computed at run time** — `rts2Compute()` builds nonsolar and solar RTS for the zone entered (geometry, construction class, carpet, glazing, partition and furnishing fractions) with a Carroll mean-radiant-temperature network and a direct solution of the 24-hour cyclic zone response; the energy balance is reported on every call.
- **Solar position and clear-sky irradiance** for any location, date and hour.
- **Sol-air temperature and opaque-surface conduction** for walls and roofs.
- **Window heat gain** — beam, diffuse and conduction, with angle-dependent SHGC from simple-performance-index curves (`shgcAtAngle()`), optional interior shading.
- **Internal loads** — occupants, lighting, equipment, miscellaneous (radiant/convective split + RTS).
- **Outdoor air** — sensible and latent loads, with optional DOAS, ERV or HRV treatment.
- **Psychrometrics** — saturation pressure, humidity ratio, enthalpy, atmospheric pressure from elevation.
- **Weather-workbook parsing** — reads monthly design conditions and clear-sky optical depths from a station page pasted into a spreadsheet.
- **12-month aggregation and design summary** — duct loss, fan heat and safety factors; RSHR, TSHR, supply air.

### Weather data are not included

No climatic data are distributed with this software. Weather data for a site must always be supplied by the user — either as a workbook read with `parseWeatherFile()` / `extractWeatherData()`, or as a `WeatherData` object built directly (see [`docs/API.md`](docs/API.md#weatherdata)).

## Installation

Download `rts-cooling-load.js` and use it directly:

```js
// Node.js 14 or later
const rts = require('./rts-cooling-load.js');
```

```html
<!-- Browser -->
<script src="rts-cooling-load.js"></script>
```

Reading `.xlsx` weather workbooks with `parseWeatherFile()` additionally requires [SheetJS](https://sheetjs.com/) (global `XLSX`) in the browser. Everything else, including `extractWeatherData()` on an already-read sheet, needs nothing else.

## Quick start

```js
const rts = require('./rts-cooling-load.js');

// Conduction time factors for a preset assembly (thickness in mm)
const preset = rts.COMPONENT_PRESETS.find(p => p.name === '100 mm Brick wall w/stucco');
const cts = rts.computeCtsFromLayers(
  preset.layers.map(l => ({ material: l.material, thickness: l.thk })));
console.log(cts.uExactWm2K, cts.uRelError, cts.cts);   // U = 1/R, check, 24 values (%)

// Radiant time factors for a 6 m x 6 m x 3 m zone, construction class M, carpet
const nsRts = rts.rts2Compute('M', true, 0.5, 'nonsolar',
  { W: 6, D: 6, H: 3, glassFrac: 0.3, partFrac: 0.75, dt: 60, iters: 4, maxCyc: 80 });
console.log(nsRts.rtf, nsRts.balance);                 // 24 values (%), energy balance

// Angle-dependent SHGC
const glass = rts.SHGC_TABLE.find(g => g.name === 'Dbl 6mm LE CLR');
console.log(rts.shgcAtAngle(glass, 40));
```

A complete example — CTS, RTS, SHGC and a 12-month load for a wall, a window and lighting — is in [`examples/basic_usage.js`](examples/basic_usage.js):

```bash
node examples/basic_usage.js
```

All weather values in that example are **fictitious**.

## Tests

```bash
node test/regression.js
```

The regression script checks the radiant-time-factor solver (hour-0 factors, 100 % sums, energy balance), the SHGC curves, and the U = 1/R identity and 100 % sum of the conduction time factors for every preset assembly. Its reference numbers come from the same solvers and only detect unintended changes; they are not an external validation.

To reproduce a full room calculation without writing code, use the web interface at [ezyhvac.com](https://ezyhvac.com/Coolingload) with your own weather file.

## Repository structure

```
rts-cooling-load.js      the engine (single file)
examples/basic_usage.js  usage example (fictitious weather values)
test/regression.js       regression checks
docs/API.md              function reference
CITATION.cff             citation metadata
LICENSE, LICENSE.txt     MIT licence
```

## Changes from v1.0.0

- Conduction and radiant time factors are computed at run time; the tabulated `WALL_CTS`, `ROOF_CTS`, `NSRTS` and `SRTS` are removed.
- SHGC comes from curve coefficients (`SHGC_CURVE_COEFFS`, `shgcAtAngle()`); the angle table `SHGC_TABLE` now holds `{name, shgc0, curve}`.
- The built-in weather table `TH_PROVINCE_WEATHER` and the ventilation tables are removed.
- `computeUFactor()` is removed; `computeCtsFromLayers()` returns U = 1/R as `uExactWm2K`.
- Function and constant names follow the ezyRTS web application.

## Citing this software

Please cite this software if you use it in academic work — see [`CITATION.cff`](CITATION.cff). The accompanying SoftwareX article will be added when published.

## License

MIT — see [`LICENSE`](LICENSE).

## Authors

Nopparat Katkhaw, Rachaneewan Aungkurabrut — School of Engineering, University of Phayao, Thailand
Sorrawich Suksabay — MECH CODE ROBOTECH Co., Ltd., Chiang Mai, Thailand

Contact: nopparat.ka@up.ac.th
