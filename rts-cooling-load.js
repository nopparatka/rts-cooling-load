/**
 * RTS Cooling Load v2.0.0 — open-source JavaScript engine implementing the
 * ASHRAE Radiant Time Series (RTS) method for nonresidential cooling load
 * calculation (ASHRAE Handbook—Fundamentals, Chapter 18).
 *
 * Covers: solar geometry and clear-sky irradiance; sol-air temperature and
 * periodic conduction with conduction time factors computed at run time from
 * the layer assembly (computeCtsFromLayers); radiant time factors computed at
 * run time for the entered zone (rts2Compute); window heat gain with
 * angle-dependent SHGC (simple-performance-index curves); internal loads;
 * outdoor air / ventilation with DOAS, ERV and HRV treatment; psychrometrics;
 * weather-workbook parsing; 12-month load aggregation and design summary.
 *
 * No climatic data are included: weather data are always supplied by the
 * caller. No ASHRAE conduction or radiant time factor tables are included.
 *
 * This file is the calculation part of the ezyRTS web application
 * (https://ezyhvac.com). The user interface is not part of this package.
 *
 * Runs in Node.js (require) or in a browser (<script>; every declaration
 * below is then a global). parseWeatherFile() additionally needs SheetJS
 * (global XLSX) to read .xlsx files; extractWeatherData() does not.
 *
 * @license MIT
 * @author  Nopparat Katkhaw, Rachaneewan Aungkurabrut
 *          School of Engineering, University of Phayao, Thailand
 *          Sorrawich Suksabay
 *          MECH CODE ROBOTECH Co., Ltd., Chiang Mai, Thailand
 * @see     CITATION.cff
 */

'use strict';
// ===== rts_reference_data.js =====
// ============================================================
// Reference data used by the engine: glazing groups and SHGC curve
// coefficients, material properties, assembly presets. No conduction or
// radiant time factor tables are included — both are computed at run time.
//
// IMPORTANT — U-factor policy (confirmed by user):
// The app NEVER uses a matched/looked-up U-factor value. Every
// component's U-factor is always computed live from its material
// layers (thickness / k, or h for air films) via the U-factor
// calculator.
//
// WALL_CTS / ROOF_CTS — REMOVED 15 Aug 2026. Wall/Roof CTS is now
// computed live from the same layers as U-factor (computeCtsFromLayers(),
// wired into applyUToRow()), stored per-row in .in-cts-json — see
// getStoredCts(). The fixed 29-entry FastCTF table this app used from
// 15 Aug 2026 until later that same day is gone; there is no fallback
// table lookup anymore, only the live solver.
// ============================================================

// NSRTS / SRTS — REMOVED 16 Aug 2026. These were the literal ASHRAE
// Radiant Time Factor tables (48 exterior-zone combinations — 3 mass x
// 2 carpet x 4 glass% x {nonsolar,solar} — plus 12 interior-zone entries)
// flagged as the highest-risk copyrighted data still in this file. Now
// computed live per room from first principles (Carroll 1980 MRT network
// + finite-difference conduction, ASHRAE RP-875 procedure) by
// rts2Compute() below, using this app's own MATERIALS properties via
// buildRts2MaterialsFromDatabase() — see openRtsCalc()/runRtsCalc() for
// the popup UI, getSelectedNsRts()/getSelectedSrts() for how a room's
// stored result is read back. No coefficient table from any handbook or
// standard remains in this file.

// SHGC — live-computed 17 Aug 2026, replacing the 15 Aug 2026 version of
// this table (which stored the full 0/40/50/60/70/80/diffuse angle table
// per entry and interpolated linearly between those 6 points). Source:
// Methodology_Brief_SHGC_24_Glazings.docx + SHGC_Table_25_Glazings.xlsx
// (user-supplied), sheets Base_Data / Curve_Coefficients /
// ASHRAE_Style_Classification. Same 8 representative glazing groups as
// before (unchanged names, unchanged SHGC(0) — the Glass Type dropdown
// and every existing project's saved selection are unaffected) but now
// only SHGC(0) and a curve code are stored per entry; SHGC at any angle
// (not just the 6 that used to be tabulated) is computed from
// SHGC_CURVE_COEFFS via the Arasteh/Kohler/Griffith (2009) Simple Window
// Model formula — see shgcNormTau()/shgcAtAngle() below. Curve codes were
// read directly from the source file's Base_Data sheet for each group's
// representative product (Guardian Clear Glass=A, AGC Ocean Green=B, the
// six low-e/reflective groups=D, Viridian VistaTech XP Green=J), matching
// the methodology's own stated rule (low-e/reflective/solar-control of
// any kind -> D; single tinted uncoated -> B; genuine triple-pane -> J).
// Every SHGC(θ) value this produces was checked against the source
// Excel's own live formula output before this change (not assumed) —
// e.g. "Dbl 6mm LE CLR" (curve D, SHGC0=0.35) at 40°: 0.35 *
// normtau_D(40°) = 0.35 * 0.950549730947814 = 0.332692405831735, matching
// the xlsx's SHGC_40 column exactly.
const SHGC_CURVE_COEFFS = {
  // a,b,c,d,e — Arasteh, D., C. Kohler, B. Griffith (2009), "Modeling
  // Windows in EnergyPlus with Simple Performance Indices," LBNL-2804E.
  // Reproduced from EnergyPlus Engineering Reference, "Window Calculation
  // Module" -> "Simple Window Model" -> "Normalized Transmittance
  // Correlations for Angular Performance" (public DOE/LBNL methodology
  // document, not an ASHRAE table). tau(phi) = a + b*cos(phi) +
  // c*cos(phi)^2 + d*cos(phi)^3 + e*cos(phi)^4.
  A: [0, 3.36, -3.85, 1.49, 0.01],   // Single: 3mm clear (uncoated)
  B: [0, 2.83, -2.42, 0.04, 0.55],   // Single: 3mm bronze/tinted (uncoated, absorptive)
  D: [0, 2.85, -2.58, 0.40, 0.35],   // Single: 3mm coated (used for low-e/reflective/solar-control double glazing)
  E: [0, 1.51, 2.49, -5.87, 2.88],   // Double: 3mm clear + clear (uncoated) — not used by any SHGC_TABLE entry below, kept for completeness
  J: [0, 0.08, 6.02, -8.84, 3.74],   // Triple: 3mm coated, clear, coated (genuine triple-pane low-e)
};

/** Raw (un-normalized) tau(phi) from the curve's polynomial — phiDeg in degrees. */
function shgcTau(curveCode, phiDeg) {
  const [a,b,c,d,e] = SHGC_CURVE_COEFFS[curveCode];
  const x = Math.cos(phiDeg * Math.PI / 180);
  return a + b*x + c*x*x + d*x*x*x + e*x*x*x*x;
}
/** normtau(phi) = tau(phi)/tau(0) — this is what the source file's own
 *  "normtau" columns hold, and is exactly 1.0 at phi=0 for every curve
 *  (confirmed against the source Angular_Shape_Calc sheet), even though
 *  raw tau(0) itself is not exactly 1 for every curve (curve D's raw
 *  tau(0) checks to 1.02, for instance — the /tau(0) division matters). */
function shgcNormTau(curveCode, phiDeg) {
  return shgcTau(curveCode, phiDeg) / shgcTau(curveCode, 0);
}
/** Hemispherical/diffuse shape-integral S(curve) = Integral[0,90deg]
 *  normtau(phi)*cos(phi)*sin(phi) dphi — composite Simpson's rule on a
 *  5-degree grid (19 points, 18 intervals), matching the source file's
 *  own Angular_Shape_Calc sheet exactly (checked: S('D') here = the
 *  0.434647093771825 that sheet computes). Depends only on curve code,
 *  not on any specific glazing product, so there are only 5 possible
 *  results ever — cached per curve code rather than recomputed on every
 *  call (this function runs inside the per-hour, per-window solar loop). */
const _shgcShapeIntegralCache = {};
function shgcHemisphericalShapeIntegral(curveCode) {
  if (_shgcShapeIntegralCache[curveCode] !== undefined) return _shgcShapeIntegralCache[curveCode];
  const hRad = 5 * Math.PI / 180;
  let sum = 0;
  for (let i = 0; i <= 18; i++) {
    const phiDeg = i * 5;
    const phiRad = phiDeg * Math.PI / 180;
    const integrand = shgcNormTau(curveCode, phiDeg) * Math.cos(phiRad) * Math.sin(phiRad);
    const weight = (i === 0 || i === 18) ? 1 : (i % 2 === 1 ? 4 : 2);
    sum += weight * integrand;
  }
  const S = (hRad / 3) * sum;
  _shgcShapeIntegralCache[curveCode] = S;
  return S;
}
/** SHGC (or Vt) hemispherical/diffuse value = Property(0) * 2 * S(curve). */
function shgcHemispherical(shgc0, curveCode) {
  return shgc0 * 2 * shgcHemisphericalShapeIntegral(curveCode);
}

// Human-readable description of each curve, shown next to the code in the
// custom-glazing dialog. A user picking a curve has no way to know what "D"
// means otherwise, and picking the wrong one silently shifts SHGC at every
// angle except 0 deg. Wording follows the curve definitions in
// SHGC_CURVE_COEFFS above.
const SHGC_CURVE_INFO = {
  A: { en: 'Single, clear, uncoated',                 th: 'ชั้นเดียว ใส ไม่เคลือบ' },
  B: { en: 'Single, tinted/body-coloured, uncoated',  th: 'ชั้นเดียว สี/ชา ไม่เคลือบ' },
  D: { en: 'Coated: low-e / reflective / solar control', th: 'เคลือบ: low-e / สะท้อนแสง / กันความร้อน' },
  E: { en: 'Double, clear + clear, uncoated',         th: 'สองชั้น ใส+ใส ไม่เคลือบ' },
  J: { en: 'Triple, genuine low-e',                   th: 'สามชั้นแท้ เคลือบ low-e' },
};

const SHGC_TABLE = [
  { name: "Sngl 6mm CLR",                   shgc0: 0.84, curve: "A" },
  { name: "Sngl 6mm GRN",                   shgc0: 0.62, curve: "B" },
  { name: "Dbl 4mm LE CLR",                 shgc0: 0.63, curve: "D" },
  { name: "Dbl 6mm GRN-LE CLR",             shgc0: 0.32, curve: "D" },
  { name: "Dbl 6mm LE CLR",                 shgc0: 0.35, curve: "D" },
  { name: "Dbl 6mm NEU-LE CLR",             shgc0: 0.43, curve: "D" },
  { name: "Dbl 6mm REFL CLR",               shgc0: 0.28, curve: "D" },
  { name: "Trpl 5-12-4-12-4 mm GRN LE LE",  shgc0: 0.35, curve: "J" },
];

// MATERIALS — thermal properties per material: k (W/m·K) and, for mass
// materials, rho (density, kg/m3) and c (specific heat, J/(kg·K)), used by
// the finite-volume CTS solver (computeCtsFromLayers) and by the zone model
// of rts2Compute (via buildRts2MaterialsFromDatabase). isAir:true entries are
// air films / cavities stored as a conductance h = 1/R (W/m²·K); they have no
// rho/c and are resistance-only in the solvers.
// Optional provenance tags (rhocSource for mass materials, hSource for films):
//   'rights-clean:ID' = ezyRTS_Thermal_Material_Database_Rights_Clean_v2_2
//                       .xlsx — 47 mass records MIT-licensed via RWTH Aachen's
//                       CityEnrich/TEASER MaterialTemplates.json, plus 5
//                       air-film/cavity values (SR01-SR05) calculated from
//                       disclosed McAdams/Walton correlations (EnergyPlus /
//                       Modelica Buildings Library documentation), converted
//                       to h = 1/R. ID is that dataset's own Material ID.
//   'th-dss:ID'       = Concrete block: k = 0.456 W/m·K for a 9 cm block,
//                       tested by the Department of Science Service (Thailand)
//                       as published by Wongklom Block
//                       (https://www.wkblock.com/blogs/thermal-conductivity-concrete-block).
//                       Density 1900 kg/m3 is a midpoint of the draft TIS 58
//                       "medium weight" class (1680-2000 kg/m3); c = 850
//                       J/(kg·K) is a generic cement-based estimate.
//   'estimated'       = general engineering reference values.
//   (no tag)          = default values the user can edit (the glass entries).
const MATERIALS = [{"name": "Air: In ceiling", "k": 5.3476, "isAir": true, "hSource": "rights-clean:SR05"}, {"name": "Air: In wall cavity", "k": 6.3694, "isAir": true, "hSource": "rights-clean:SR04"}, {"name": "Air: Indoor air - Horizontal surface", "k": 6.8493, "isAir": true, "hSource": "rights-clean:SR03"}, {"name": "Air: Indoor air - Vertical surface", "k": 7.7519, "isAir": true, "hSource": "rights-clean:SR02"}, {"name": "Air: Outdoor air", "k": 25.0, "isAir": true, "hSource": "rights-clean:SR01"}, {"name": "Aluminum", "k": 237.0, "isAir": false, "rho": 2800.0, "c": 897.0, "rhocSource": "rights-clean:MET01"}, {"name": "Basalt Fibre Insulation — 100 kg/m³", "k": 0.044, "isAir": false, "rho": 100.0, "c": 840.0, "rhocSource": "rights-clean:INS03"}, {"name": "Basalt Fibre Insulation — 45 kg/m³", "k": 0.049, "isAir": false, "rho": 45.0, "c": 840.0, "rhocSource": "rights-clean:INS05"}, {"name": "Basalt Fibre Insulation — 57.5 kg/m³", "k": 0.04, "isAir": false, "rho": 57.5, "c": 840.0, "rhocSource": "rights-clean:INS02"}, {"name": "Blast-Furnace Slag — 1000 kg/m³", "k": 0.302, "isAir": false, "rho": 1000.0, "c": 920.0, "rhocSource": "rights-clean:AGG05"}, {"name": "Blast-Furnace Slag — 1200 kg/m³", "k": 0.395, "isAir": false, "rho": 1200.0, "c": 920.0, "rhocSource": "rights-clean:AGG06"}, {"name": "Brick", "k": 0.9608, "isAir": false, "rho": 1952.2104, "c": 862.62, "rhocSource": "rights-clean:MAS01"}, {"name": "Calcium-Silicate Adhesive", "k": 0.9, "isAir": false, "rho": 1516.2, "c": 850.0, "rhocSource": "rights-clean:ADH01"}, {"name": "Calcium-Silicate Board — 222 kg/m³", "k": 0.0568, "isAir": false, "rho": 222.2537, "c": 1303.19, "rhocSource": "rights-clean:INS08"}, {"name": "Calcium-Silicate Board — 270 kg/m³", "k": 0.069, "isAir": false, "rho": 270.1367, "c": 1161.96, "rhocSource": "rights-clean:INS07"}, {"name": "Carpet", "k": 0.06, "isAir": false, "rho": 200, "c": 1300, "rhocSource": "estimated"}, {"name": "Cast iron", "k": 52, "isAir": false, "rho": 7200, "c": 460, "rhocSource": "estimated"}, {"name": "Cellulose Fibre — 70 kg/m³", "k": 0.04, "isAir": false, "rho": 70.0, "c": 1600.0, "rhocSource": "rights-clean:INS13"}, {"name": "Cellulose Insulation — 50 kg/m³", "k": 0.039, "isAir": false, "rho": 50.0, "c": 1600.0, "rhocSource": "rights-clean:INS14"}, {"name": "Cement Floating Screed — 1940 kg/m³", "k": 1.4, "isAir": false, "rho": 1940.0, "c": 1000.0, "rhocSource": "rights-clean:SCR02"}, {"name": "Ceramic tile", "k": 0.338, "isAir": false, "rho": 2300, "c": 800, "rhocSource": "estimated"}, {"name": "Clear glass", "k": 0.96, "isAir": false, "rho": 2528, "c": 880}, {"name": "Concrete", "k": 1.6, "isAir": false, "rho": 2300, "c": 850, "rhocSource": "rights-clean:CON02"}, {"name": "Concrete block", "k": 0.456, "isAir": false, "rho": 1900, "c": 850, "rhocSource": "th-dss:concrete-block-9cm"}, {"name": "Concrete roof tiles", "k": 0.993, "isAir": false, "rho": 2100, "c": 840, "rhocSource": "estimated"}, {"name": "Concrete — Medium Density", "k": 1.9375, "isAir": false, "rho": 2104.2, "c": 775.85, "rhocSource": "rights-clean:CON01"}, {"name": "Copper", "k": 388, "isAir": false, "rho": 8900, "c": 385, "rhocSource": "estimated"}, {"name": "Cotton-Fibre Insulation — 50 kg/m³", "k": 0.056, "isAir": false, "rho": 50.0, "c": 1273.0, "rhocSource": "rights-clean:INS06"}, {"name": "Dense Basalt Mineral-Fibre Board — 350 kg/m³", "k": 0.047, "isAir": false, "rho": 350.0, "c": 840.0, "rhocSource": "rights-clean:INS04"}, {"name": "Double corrugated fiber cement tiles", "k": 0.395, "isAir": false, "rho": 1700, "c": 900, "rhocSource": "estimated"}, {"name": "Expanded Clay — 719 kg/m³", "k": 0.13, "isAir": false, "rho": 719.0, "c": 850.0, "rhocSource": "rights-clean:AGG04"}, {"name": "Expanded Shale — 655 kg/m³", "k": 0.198, "isAir": false, "rho": 655.0, "c": 920.0, "rhocSource": "rights-clean:AGG03"}, {"name": "Fiber cement board", "k": 0.084, "isAir": false, "rho": 1200, "c": 900, "rhocSource": "estimated"}, {"name": "Flax Insulation Board", "k": 0.038, "isAir": false, "rho": 39.0, "c": 850.0, "rhocSource": "rights-clean:INS09"}, {"name": "Floating Screed — Medium Density", "k": 0.9662, "isAir": false, "rho": 2057.5, "c": 699.37, "rhocSource": "rights-clean:SCR01"}, {"name": "Granite", "k": 2.385, "isAir": false, "rho": 1974.0359, "c": 813.27, "rhocSource": "rights-clean:STN02"}, {"name": "Gypsum Fibreboard — High Density", "k": 0.3405, "isAir": false, "rho": 1133.3, "c": 1228.0, "rhocSource": "rights-clean:BRD01"}, {"name": "Gypsum Plaster", "k": 0.3, "isAir": false, "rho": 850.0, "c": 1000.0, "rhocSource": "rights-clean:FIN01"}, {"name": "Gypsum, Mineral and Fiber board", "k": 0.2113, "isAir": false, "rho": 732.0223, "c": 1383.88, "rhocSource": "rights-clean:BRD02"}, {"name": "Hardwood", "k": 0.13, "isAir": false, "rho": 650, "c": 1500, "rhocSource": "rights-clean:WOD04"}, {"name": "Hardwood Plywood — High Density", "k": 0.1, "isAir": false, "rho": 708.05, "c": 1600.0, "rhocSource": "rights-clean:WOD01"}, {"name": "Hollow Clay Brick — 600 kg/m³", "k": 0.12, "isAir": false, "rho": 600.0, "c": 850.0, "rhocSource": "rights-clean:MAS02"}, {"name": "Hollow Clay Brick — 695 kg/m³", "k": 0.13, "isAir": false, "rho": 695.0, "c": 850.0, "rhocSource": "rights-clean:MAS03"}, {"name": "ISO Wall", "k": 0.025, "isAir": false, "rho": 40, "c": 1400, "rhocSource": "estimated"}, {"name": "Insulation - Air Bubble, Bubble Foil", "k": 0.042, "isAir": false, "rho": 50, "c": 1500, "rhocSource": "estimated"}, {"name": "Insulation- Close cell polyolefins", "k": 0.032, "isAir": false, "rho": 30, "c": 1800, "rhocSource": "estimated"}, {"name": "Insulation- Close cell rubber", "k": 0.038, "isAir": false, "rho": 70, "c": 1500, "rhocSource": "estimated"}, {"name": "Insulation- Fiber Glass", "k": 0.043, "isAir": false, "rho": 53, "c": 840, "rhocSource": "rights-clean:INS01"}, {"name": "Insulation- Polyethylene foam, PE", "k": 0.024, "isAir": false, "rho": 30, "c": 2300, "rhocSource": "estimated"}, {"name": "Insulation- Polyurethane foam", "k": 0.025, "isAir": false, "rho": 32, "c": 1590, "rhocSource": "estimated"}, {"name": "Insulation- Rockwool", "k": 0.064, "isAir": false, "rho": 100, "c": 840, "rhocSource": "estimated"}, {"name": "Laminate flooring", "k": 0.115, "isAir": false, "rho": 800, "c": 1500, "rhocSource": "estimated"}, {"name": "Laminated Veneer Lumber", "k": 0.13, "isAir": false, "rho": 462.0, "c": 1600.0, "rhocSource": "rights-clean:WOD03"}, {"name": "Laminated glass", "k": 0.39, "isAir": false, "rho": 2528, "c": 880}, {"name": "Large corrugated translucent fiberglass tile", "k": 0.181, "isAir": false, "rho": 1500, "c": 1200, "rhocSource": "estimated"}, {"name": "Large, corrugated fiber cement tiles", "k": 0.441, "isAir": false, "rho": 1700, "c": 900, "rhocSource": "estimated"}, {"name": "Lightweight Calcium-Silicate Adhesive", "k": 0.216, "isAir": false, "rho": 820.0332, "c": 1306.6, "rhocSource": "rights-clean:ADH02"}, {"name": "Lightweight Mineral Plaster", "k": 0.1062, "isAir": false, "rho": 465.4663, "c": 1172.61, "rhocSource": "rights-clean:PLS01"}, {"name": "Lightweight roof tiles", "k": 0.341, "isAir": false, "rho": 1400, "c": 880, "rhocSource": "estimated"}, {"name": "Mirror", "k": 0.853, "isAir": false, "rho": 2528, "c": 880}, {"name": "Mortar", "k": 1.2, "isAir": false, "rho": 2000, "c": 850, "rhocSource": "rights-clean:PLS02"}, {"name": "Opaque white double corrugated fiberglass tile", "k": 0.208, "isAir": false, "rho": 1500, "c": 1200, "rhocSource": "estimated"}, {"name": "Parquet", "k": 0.167, "isAir": false, "rho": 700, "c": 1600, "rhocSource": "estimated"}, {"name": "Plaster board", "k": 0.8, "isAir": false, "rho": 1200, "c": 840, "rhocSource": "estimated"}, {"name": "Plaster for lightweight concrete", "k": 0.326, "isAir": false, "rho": 1000, "c": 840, "rhocSource": "estimated"}, {"name": "Plasterboard — Dense Grade", "k": 0.3, "isAir": false, "rho": 717.0, "c": 1000.0, "rhocSource": "rights-clean:BRD03"}, {"name": "Plywood", "k": 0.11, "isAir": false, "rho": 427, "c": 1600, "rhocSource": "rights-clean:WOD02"}, {"name": "Pumice Gravel — 750 kg/m³", "k": 0.186, "isAir": false, "rho": 750.0, "c": 920.0, "rhocSource": "rights-clean:AGG02"}, {"name": "Reflective glass", "k": 0.931, "isAir": false, "rho": 2528, "c": 880}, {"name": "Sintered Ash Material", "k": 0.14, "isAir": false, "rho": 720.0, "c": 920.0, "rhocSource": "rights-clean:AGG01"}, {"name": "Slate (for Roof)", "k": 1.7, "isAir": false, "rho": 1980, "c": 850, "rhocSource": "rights-clean:STN01"}, {"name": "Slate (for floor)", "k": 1.7, "isAir": false, "rho": 1980, "c": 850, "rhocSource": "rights-clean:STN01"}, {"name": "Small Corrugated Tiles", "k": 0.384, "isAir": false, "rho": 1700, "c": 900, "rhocSource": "estimated"}, {"name": "Smooth translucent fiberglass tile", "k": 0.213, "isAir": false, "rho": 1500, "c": 1200, "rhocSource": "estimated"}, {"name": "Softwood", "k": 0.13, "isAir": false, "rho": 650, "c": 1500, "rhocSource": "rights-clean:WOD04"}, {"name": "Steel", "k": 48, "isAir": false, "rho": 7800, "c": 477, "rhocSource": "rights-clean:MET02"}, {"name": "Tea glass", "k": 0.913, "isAir": false, "rho": 2528, "c": 880}, {"name": "Tempered glass", "k": 0.691, "isAir": false, "rho": 2528, "c": 880}, {"name": "Translucent corrugated tile", "k": 0.16, "isAir": false, "rho": 1500, "c": 1200, "rhocSource": "estimated"}, {"name": "Urea-Formaldehyde Foam — 35 kg/m³", "k": 0.049, "isAir": false, "rho": 35.0, "c": 1380.0, "rhocSource": "rights-clean:INS10"}, {"name": "Urea-Formaldehyde Foam — 75 kg/m³", "k": 0.052, "isAir": false, "rho": 75.0, "c": 1380.0, "rhocSource": "rights-clean:INS11"}, {"name": "Vinyl tile", "k": 0.573, "isAir": false, "rho": 1700, "c": 1000, "rhocSource": "estimated"}, {"name": "Wood Chips — 150 kg/m³", "k": 0.116, "isAir": false, "rho": 150.0, "c": 2000.0, "rhocSource": "rights-clean:INS12"}, {"name": "Wood-Wool Board, Gypsum-Bonded — 460 kg/m³", "k": 0.11, "isAir": false, "rho": 460.0, "c": 2000.0, "rhocSource": "rights-clean:BRD04"}, {"name": "Wood-Wool Board, Magnesia-Bonded — 370 kg/m³", "k": 0.081, "isAir": false, "rho": 370.0, "c": 2000.0, "rhocSource": "rights-clean:BRD05"}, {"name": "Wood-Wool Board, Magnesia-Bonded — 460 kg/m³", "k": 0.116, "isAir": false, "rho": 460.0, "c": 2000.0, "rhocSource": "rights-clean:BRD06"}];

const COMPONENT_PRESETS = [{"name": "100 mm Brick wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Brick", "thk": 100}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "100 LD concrete wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Concrete", "thk": 100}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "100 mm CB wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Concrete block", "thk": 100}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "100 mm ISO Wall", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "ISO Wall", "thk": 100}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "200 mm Brick wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Brick", "thk": 200}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "200 LD concrete wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Concrete", "thk": 200}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "200 mm CB wall w/stucco", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Concrete block", "thk": 200}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "100 mm concrete roof", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Concrete", "thk": 100}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "150 mm concrete roof", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Concrete", "thk": 150}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "100 mm concrete roof w/ceiling", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Concrete", "thk": 100}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "150 mm concrete roof w/ceiling", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Concrete", "thk": 150}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "300 mm concrete roof w/ceiling", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Concrete", "thk": 300}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "Slate or tile roof w/ceiling", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Slate (for Roof)", "thk": 5}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "metal roof w/ceiling", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Steel", "thk": 0.47}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "Gypsum Partition", "layers": [{"material": "Air: Indoor air - Vertical surface", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 10}, {"material": "Air: In wall cavity", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "Concrete Partition", "layers": [{"material": "Air: Indoor air - Vertical surface", "thk": 1}, {"material": "Mortar", "thk": 10}, {"material": "Concrete", "thk": 100}, {"material": "Mortar", "thk": 10}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "Window: Clear glass", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Clear glass", "thk": 6}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "Window: Tea glass", "layers": [{"material": "Air: Outdoor air", "thk": 1}, {"material": "Tea glass", "thk": 6}, {"material": "Air: Indoor air - Vertical surface", "thk": 1}]}, {"name": "150 mm Concrete floor", "layers": [{"material": "Air: Indoor air - Vertical surface", "thk": 1}, {"material": "Concrete", "thk": 150}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}, {"name": "150 mm Concrete floor w/ceiling", "layers": [{"material": "Air: Indoor air - Vertical surface", "thk": 1}, {"material": "Concrete", "thk": 150}, {"material": "Air: In ceiling", "thk": 1}, {"material": "Gypsum, Mineral and Fiber board", "thk": 9}, {"material": "Air: Indoor air - Horizontal surface", "thk": 1}]}];


// ===== country_tz.js =====
// ============================================================
// Country -> Timezone (UTC offset) lookup table.
// Extracted from ezyRTS.xlsm, Sheet 'Location', range B47:C238
// (header row 47: 'Country' | 'TZ', data rows 48-238).
//
// Used only to resolve the country name read from an uploaded weather
// file (matchCountryTz) to a canonical name for display. It holds no
// climatic data, and an uploaded file's own "Time zone:" value is always
// the one used for calculation.
//
// 191 countries, all with a non-null TZ value (verified — zero gaps).
// ============================================================

const COUNTRY_TZ = [{"country": "Afghanistan", "tz": 4.5}, {"country": "Albania", "tz": 1}, {"country": "Algeria", "tz": 1}, {"country": "Andorra", "tz": 1}, {"country": "Angola", "tz": 1}, {"country": "Antigua and Barbuda", "tz": -4}, {"country": "Argentina", "tz": -3}, {"country": "Armenia", "tz": 4}, {"country": "Australia", "tz": 10}, {"country": "Austria", "tz": 1}, {"country": "Azerbaijan", "tz": 4}, {"country": "Bahamas", "tz": -5}, {"country": "Bahrain", "tz": 3}, {"country": "Bangladesh", "tz": 6}, {"country": "Barbados", "tz": -4}, {"country": "Belarus", "tz": 3}, {"country": "Belgium", "tz": 1}, {"country": "Belize", "tz": -6}, {"country": "Benin", "tz": 1}, {"country": "Bhutan", "tz": 6}, {"country": "Bolivia", "tz": -4}, {"country": "Bosnia and Herzegovina", "tz": 1}, {"country": "Botswana", "tz": 2}, {"country": "Brazil", "tz": -3}, {"country": "Brunei", "tz": 8}, {"country": "Bulgaria", "tz": 2}, {"country": "Burkina Faso", "tz": 0}, {"country": "Burundi", "tz": 2}, {"country": "Cambodia", "tz": 7}, {"country": "Cameroon", "tz": 1}, {"country": "Canada", "tz": -5}, {"country": "Central African Republic", "tz": 1}, {"country": "Chad", "tz": 1}, {"country": "Chile", "tz": -4}, {"country": "China", "tz": 8}, {"country": "Colombia", "tz": -5}, {"country": "Comoros", "tz": 3}, {"country": "Congo", "tz": 1}, {"country": "Costa Rica", "tz": -6}, {"country": "Croatia", "tz": 1}, {"country": "Cuba", "tz": -5}, {"country": "Cyprus", "tz": 2}, {"country": "Czech Republic", "tz": 1}, {"country": "Denmark", "tz": 1}, {"country": "Djibouti", "tz": 3}, {"country": "Dominica", "tz": -4}, {"country": "Dominican Republic", "tz": -4}, {"country": "Ecuador", "tz": -5}, {"country": "Egypt", "tz": 2}, {"country": "El Salvador", "tz": -6}, {"country": "Equatorial Guinea", "tz": 1}, {"country": "Eritrea", "tz": 3}, {"country": "Estonia", "tz": 2}, {"country": "Eswatini", "tz": 2}, {"country": "Ethiopia", "tz": 3}, {"country": "Fiji", "tz": 12}, {"country": "Finland", "tz": 2}, {"country": "France", "tz": 1}, {"country": "Gabon", "tz": 1}, {"country": "Gambia", "tz": 0}, {"country": "Georgia", "tz": 4}, {"country": "Germany", "tz": 1}, {"country": "Ghana", "tz": 0}, {"country": "Greece", "tz": 2}, {"country": "Grenada", "tz": -4}, {"country": "Guatemala", "tz": -6}, {"country": "Guinea", "tz": 0}, {"country": "Guinea-Bissau", "tz": 0}, {"country": "Guyana", "tz": -4}, {"country": "Haiti", "tz": -5}, {"country": "Honduras", "tz": -6}, {"country": "Hungary", "tz": 1}, {"country": "Iceland", "tz": 0}, {"country": "India", "tz": 5.5}, {"country": "Indonesia", "tz": 7}, {"country": "Iran", "tz": 3.5}, {"country": "Iraq", "tz": 3}, {"country": "Ireland", "tz": 0}, {"country": "Israel", "tz": 2}, {"country": "Italy", "tz": 1}, {"country": "Jamaica", "tz": -5}, {"country": "Japan", "tz": 9}, {"country": "Jordan", "tz": 3}, {"country": "Kazakhstan", "tz": 6}, {"country": "Kenya", "tz": 3}, {"country": "Kiribati", "tz": 12}, {"country": "Kuwait", "tz": 3}, {"country": "Kyrgyzstan", "tz": 6}, {"country": "Laos", "tz": 7}, {"country": "Latvia", "tz": 2}, {"country": "Lebanon", "tz": 2}, {"country": "Lesotho", "tz": 2}, {"country": "Liberia", "tz": 0}, {"country": "Libya", "tz": 2}, {"country": "Liechtenstein", "tz": 1}, {"country": "Lithuania", "tz": 2}, {"country": "Luxembourg", "tz": 1}, {"country": "Madagascar", "tz": 3}, {"country": "Malawi", "tz": 2}, {"country": "Malaysia", "tz": 8}, {"country": "Maldives", "tz": 5}, {"country": "Mali", "tz": 0}, {"country": "Malta", "tz": 1}, {"country": "Marshall Islands", "tz": 12}, {"country": "Mauritania", "tz": 0}, {"country": "Mauritius", "tz": 4}, {"country": "Mexico", "tz": -6}, {"country": "Micronesia", "tz": 10}, {"country": "Moldova", "tz": 2}, {"country": "Monaco", "tz": 1}, {"country": "Mongolia", "tz": 8}, {"country": "Montenegro", "tz": 1}, {"country": "Morocco", "tz": 0}, {"country": "Mozambique", "tz": 2}, {"country": "Myanmar", "tz": 6.5}, {"country": "Namibia", "tz": 2}, {"country": "Nauru", "tz": 12}, {"country": "Nepal", "tz": 5.75}, {"country": "Netherlands", "tz": 1}, {"country": "New Zealand", "tz": 12}, {"country": "Nicaragua", "tz": -6}, {"country": "Niger", "tz": 1}, {"country": "Nigeria", "tz": 1}, {"country": "North Korea", "tz": 9}, {"country": "North Macedonia", "tz": 1}, {"country": "Norway", "tz": 1}, {"country": "Oman", "tz": 4}, {"country": "Pakistan", "tz": 5}, {"country": "Palau", "tz": 9}, {"country": "Panama", "tz": -5}, {"country": "Papua New Guinea", "tz": 10}, {"country": "Paraguay", "tz": -4}, {"country": "Peru", "tz": -5}, {"country": "Philippines", "tz": 8}, {"country": "Poland", "tz": 1}, {"country": "Portugal", "tz": 0}, {"country": "Qatar", "tz": 3}, {"country": "Romania", "tz": 2}, {"country": "Russia", "tz": 3}, {"country": "Rwanda", "tz": 2}, {"country": "Saint Kitts and Nevis", "tz": -4}, {"country": "Saint Lucia", "tz": -4}, {"country": "Saint Vincent and the Grenadines", "tz": -4}, {"country": "Samoa", "tz": 13}, {"country": "San Marino", "tz": 1}, {"country": "Sao Tome and Principe", "tz": 0}, {"country": "Saudi Arabia", "tz": 3}, {"country": "Senegal", "tz": 0}, {"country": "Serbia", "tz": 1}, {"country": "Seychelles", "tz": 4}, {"country": "Sierra Leone", "tz": 0}, {"country": "Singapore", "tz": 8}, {"country": "Slovakia", "tz": 1}, {"country": "Slovenia", "tz": 1}, {"country": "Solomon Islands", "tz": 11}, {"country": "Somalia", "tz": 3}, {"country": "South Africa", "tz": 2}, {"country": "South Sudan", "tz": 2}, {"country": "Spain", "tz": 1}, {"country": "Sri Lanka", "tz": 5.5}, {"country": "Sudan", "tz": 2}, {"country": "Suriname", "tz": -3}, {"country": "Sweden", "tz": 1}, {"country": "Switzerland", "tz": 1}, {"country": "Syria", "tz": 3}, {"country": "Taiwan", "tz": 8}, {"country": "Tajikistan", "tz": 5}, {"country": "Tanzania", "tz": 3}, {"country": "Thailand", "tz": 7}, {"country": "Timor-Leste", "tz": 9}, {"country": "Togo", "tz": 0}, {"country": "Tonga", "tz": 13}, {"country": "Trinidad and Tobago", "tz": -4}, {"country": "Tunisia", "tz": 1}, {"country": "Turkey", "tz": 3}, {"country": "Turkmenistan", "tz": 5}, {"country": "Tuvalu", "tz": 12}, {"country": "Uganda", "tz": 3}, {"country": "Ukraine", "tz": 2}, {"country": "United Arab Emirates", "tz": 4}, {"country": "United Kingdom", "tz": 0}, {"country": "United States", "tz": -5}, {"country": "Uruguay", "tz": -3}, {"country": "Uzbekistan", "tz": 5}, {"country": "Vanuatu", "tz": 11}, {"country": "Vatican City", "tz": 1}, {"country": "Venezuela", "tz": -4}, {"country": "Vietnam", "tz": 7}, {"country": "Yemen", "tz": 3}, {"country": "Zambia", "tz": 2}, {"country": "Zimbabwe", "tz": 2}];


// ===== Built-in weather databases: REMOVED (17 Sep 2026) =====
// The Thailand 77-province table (TH_PROVINCE_WEATHER) and the worldwide
// major-city table (WORLD_CITY_WEATHER) were removed to keep third-party
// climatic data out of the distributed program. Weather data are ALWAYS
// supplied by the user (parseWeatherFile / extractWeatherData, or an object
// of the shape below built by the caller).
//
// WeatherData shape expected by the calculation functions:
//  name, lat (signed), lon (unsigned), hemisphere ('E'|'W'), elev (m), tz
//  taub[12], taud[12]            - clear-sky optical depths, Jan..Dec
//  hottestMonth                  - 1-12
//  monthlyDesignDB.{p0_4,p2,p5}  - [12] each, deg C
//  monthlyDesignMCWB.{p0_4,p2,p5}- [12] each, deg C
//  mdbr[12], mcwbr[12]           - mean coincident daily DB / WB range, K
// Optional keys: country (string); fictitious (true when the station line
// carries WMO 000000 and the word FICTITIOUS - the example file format).

// ===== rts_engine_v3.js =====
// Radiant Time Factor solver: 24 nonsolar/solar RTF values for the room the
// user actually entered, replacing the pulse-marching engine used up to
// 16 Aug 2026 (rts_engine_v2.js).
//
// METHOD (all from open literature; no ASHRAE source code or table data is
// reproduced here):
//   1. Per construction, a periodic response kernel is built by driving one
//      face with a unit triangular boundary pulse and folding the resulting
//      hourly flux series onto a 24-hour cycle. Conduction is solved with a
//      1-D finite-volume mesh and a fully implicit (backward Euler) step,
//      using the Thomas algorithm.
//   2. Longwave exchange between surfaces uses the Carroll (1980) MRT
//      network: an area-based geometric factor, a gray-surface factor that
//      folds in emissivity, and a linearised radiation coefficient.
//   3. The inside-surface heat balance is written for all 24 hours at once as
//      a cyclic system and solved directly, rather than time-marching to
//      steady-periodic. Cooling load is the convective transfer to room air,
//      summed over surfaces, then normalised to 24 factors totalling 100%.
//
// Inside convection coefficients are Walton's constant-coefficient set
// (Walton 1983, NBSIR 83-2655, a US Government work), as documented in the
// EnergyPlus Engineering Reference "Simple Natural Convection Algorithm":
// 3.076 vertical, 4.040 horizontal enhanced (floor, heat flow up), 0.948
// horizontal reduced (ceiling, heat flow down), all W/(m^2*K).
//
// Layer properties come from this app's own MATERIALS database at startup via
// buildRts2MaterialsFromDatabase(); only layer THICKNESSES are fixed here,
// because MATERIALS stores intensive properties only.
//
// KNOWN LIMITATION (documented deliberately, not hidden): RTS3_BOUNDARY_BETA
// scales the boundary-face conductance. The value 1 is used. beta = 1 and
// beta = 4/3 do not converge to the same answer under mesh refinement, so the
// boundary discretisation is not yet proven to be consistent. This affects
// the absolute level of the first-hour factor; it does not affect energy
// conservation, which is checked on every call.
//
// NOTE: the surrounding file is one big <script> with no module wrapper, so
//       everything below is plain top-level declarations, same as the rest of
//       this bundle.
let RTS2_GLAZ=['glass6'], RTS2_FURN=['wood25'], RTS2_CARPET='carpet';
const RTS2_MAT = {
  gyp12:[12,0.16,800,1090], gyp9:[9,0.16,800,1090], plas15:[15,0.72,1860,840],
  brick100:[100,0.85,1800,840], conc100:[100,1.75,2300,900],
  conc150:[150,1.75,2300,900], tile8:[8,1.30,2300,840], ins50:[50,0.04,20,840],
  steel:[0.6,50,7800,480], glass6:[6,1.0,2500,840], carpet:[10,0.06,200,1300],
  wood25:[12.5,0.15,600,1600], airV:[null,0.16], airC:[null,0.18],
};
let RTS2_CONSTR = {
  L:{wall:['steel','ins50','airV','gyp12'], ceil:['conc100','airC','gyp9'],
     part:['gyp12','airV','gyp12'], floor:['gyp9','airC','conc100','tile8']},
  M:{wall:['plas15','brick100','plas15'], ceil:['conc100','airC','gyp9'],
     part:['plas15','brick100','plas15'], floor:['gyp9','airC','conc100','tile8']},
  H:{wall:['plas15','conc150','plas15'], ceil:['conc150'],
     part:['plas15','brick100','plas15'], floor:['conc150','tile8']},
};
const RTS2_SIG=5.670374419e-8, RTS2_TA=24, RTS2_EPS=0.9;
// Walton (1983) via EnergyPlus Engineering Reference, Simple Natural Convection
const RTS2_HCV=3.076, RTS2_HCU=4.040, RTS2_HCD=0.948;
const RTS3_CELLS_PER_LAYER=24, RTS3_DT=60, RTS3_RESPONSE_STEPS=9600;
const RTS3_MAX_ITER=200, RTS3_ITER_TOL=1e-7;   // surface/MRT coupling loop
const RTS3_BOUNDARY_BETA=1;          // see KNOWN LIMITATION above
const RTS3_STILL_AIR_K=0.0263, RTS3_STILL_AIR_RHO=1.1614, RTS3_STILL_AIR_CP=1007;

/** A resistance-only layer is represented as a slab of still air of the same
 *  resistance. Its heat capacity is ~5 J/(m^2*K), i.e. negligible, so this is
 *  numerically equivalent to a massless resistance but keeps one code path. */
function rts3PhysicalLayer(code){
  const m = RTS2_MAT[code];
  if(!m) throw new Error('Unknown material code: '+code);
  if(m[0]===null){
    return {th: RTS3_STILL_AIR_K*m[1], k: RTS3_STILL_AIR_K,
            rho: RTS3_STILL_AIR_RHO, cp: RTS3_STILL_AIR_CP};
  }
  return {th: m[0]/1000, k: m[1], rho: m[2], cp: m[3]};
}

function rts3Grid(codes){
  const cells=[];
  for(const code of codes){
    const L=rts3PhysicalLayer(code);
    if(!(L.th>0 && L.k>0 && L.rho>=0 && L.cp>=0)) throw new Error('Bad layer data: '+code);
    const dx=L.th/RTS3_CELLS_PER_LAYER;
    for(let j=0;j<RTS3_CELLS_PER_LAYER;j++) cells.push({dx, k:L.k, rc:L.rho*L.cp});
  }
  if(!cells.length) throw new Error('A surface needs at least one layer.');
  return cells;
}

function rts3Thomas(lower, diag, upper, rhs, x, cp, dp){
  const n=diag.length;
  cp[0]= n>1 ? upper[0]/diag[0] : 0;
  dp[0]= rhs[0]/diag[0];
  for(let i=1;i<n;i++){
    const den=diag[i]-lower[i]*cp[i-1];
    cp[i]= i+1<n ? upper[i]/den : 0;
    dp[i]=(rhs[i]-lower[i]*dp[i-1])/den;
  }
  x[n-1]=dp[n-1];
  for(let i=n-2;i>=0;i--) x[i]=dp[i]-cp[i]*x[i+1];
}

function rts3TriangularBoundary(sec){
  if(sec<=3600) return sec/3600;
  if(sec<=7200) return 2-sec/3600;
  return 0;
}

/** Flux at the driven face (near) and the far face, hour by hour, for a unit
 *  triangular boundary-temperature pulse. */
function rts3PulseResponse(codes){
  const cells=rts3Grid(codes), n=cells.length, dt=RTS3_DT;
  const T=new Float64Array(n);
  const G=new Float64Array(Math.max(0,n-1));
  for(let i=0;i+1<n;i++)
    G[i]=2*cells[i].k*cells[i+1].k/(cells[i].dx*cells[i+1].k+cells[i+1].dx*cells[i].k);
  const beta=RTS3_BOUNDARY_BETA;
  const lower=new Float64Array(n), diag=new Float64Array(n),
        upper=new Float64Array(n), rhs=new Float64Array(n),
        x=new Float64Array(n), cpv=new Float64Array(n), dpv=new Float64Array(n);
  const near=[], far=[];
  const leftDirect  = beta*cells[0].k/(0.5*cells[0].dx);
  const rightDirect = beta*cells[n-1].k/(0.5*cells[n-1].dx);
  const leftCorr  = n>1 ? (beta-1)*G[0]   : 0;
  const rightCorr = n>1 ? (beta-1)*G[n-2] : 0;
  const perHour=Math.round(3600/dt);
  let lastNear=0, lastFar=0;
  for(let step=1; step<=RTS3_RESPONSE_STEPS; step++){
    const t=step*dt;
    if(!(t>7200 && Math.abs(lastNear)<1e-9 && Math.abs(lastFar)<1e-9)){
      const leftT=rts3TriangularBoundary(t);
      for(let i=0;i<n;i++){
        const store=cells[i].rc*cells[i].dx/dt;
        diag[i]=store; rhs[i]=store*T[i]; lower[i]=0; upper[i]=0;
      }
      for(let i=0;i+1<n;i++){
        let g=G[i];
        if(i===0 || i===n-2) g*=beta;
        diag[i]+=g; diag[i+1]+=g; upper[i]-=g; lower[i+1]-=g;
      }
      diag[0]+=leftDirect;  rhs[0]+=leftDirect*leftT;
      diag[n-1]+=rightDirect;
      rts3Thomas(lower,diag,upper,rhs,x,cpv,dpv);
      T.set(x);
      lastNear = leftDirect*(leftT-T[0])  + (n>1 ? leftCorr*(T[1]-T[0]) : 0);
      lastFar  = rightDirect*T[n-1]       + (n>1 ? rightCorr*(T[n-1]-T[n-2]) : 0);
    }
    if(step % perHour === 0){ near.push(lastNear); far.push(lastFar); }
  }
  return {near, far};
}

function rts3Fold24(v){
  const out=new Float64Array(24);
  for(let h=0;h<24;h++)
    for(let d=0; d<8; d++){ const i=h+24*d; if(i<v.length) out[h]+=v[i]; }
  return out;
}

/** Conduction kernel seen from the room. Scaled so the kernel sums to zero,
 *  which is what an adiabatic-backed zone requires: no net steady conduction
 *  leaves the zone, only storage and release. */
const _rts3KernelCache = new Map();
function rts3Kernel(codes){
  const key=codes.join('|');
  if(_rts3KernelCache.has(key)) return _rts3KernelCache.get(key);
  const fwd=rts3PulseResponse(codes);
  const rev=rts3PulseResponse(codes.slice().reverse());
  const cross=rts3Fold24(fwd.far), inside=rts3Fold24(rev.near);
  let sumY=0, sumZ=0;
  for(let i=0;i<24;i++){ sumY+=cross[i]; sumZ+=inside[i]; }
  const scale = sumZ!==0 ? sumY/sumZ : 0;
  const kernel=new Float64Array(24);
  for(let i=0;i<24;i++) kernel[i]=cross[i]-inside[i]*scale;
  _rts3KernelCache.set(key, kernel);
  return kernel;
}
function rts3ClearKernelCache(){ _rts3KernelCache.clear(); }

function rts3CarrollF(areas){
  let total=0; for(const a of areas) total+=a;
  const F=areas.map(a=>1/(1-a/total));
  for(let it=0; it<10; it++){
    for(let i=0;i<F.length;i++){
      let den=0; for(let j=0;j<F.length;j++) den+=areas[j]*F[j];
      F[i]=1/(1-areas[i]*F[i]/den);
    }
  }
  return F;
}

function rts3DenseSolve(M, rhs){
  const n=rhs.length;
  const a=M.map((row,i)=>row.slice().concat(rhs[i]));
  for(let c=0;c<n;c++){
    let p=c;
    for(let r=c+1;r<n;r++) if(Math.abs(a[r][c])>Math.abs(a[p][c])) p=r;
    if(Math.abs(a[p][c])<1e-14) throw new Error('Singular heat-balance matrix.');
    const t=a[c]; a[c]=a[p]; a[p]=t;
    const s=a[c][c];
    for(let j=c;j<=n;j++) a[c][j]/=s;
    for(let r=0;r<n;r++){
      if(r===c) continue;
      const f=a[r][c];
      if(f===0) continue;
      for(let j=c;j<=n;j++) a[r][j]-=f*a[c][j];
    }
  }
  return a.map(row=>row[n]);
}

/** Live RTS computation for one thermal zone.
 *  cls: 'L'|'M'|'H'. carpet: boolean. furnFrac: 0-1 fraction of floor area
 *  (furnishing surface = 2 x furnFrac x floor area, both faces exposed).
 *  mode: 'nonsolar'|'solar'. opt: {W,D,H, glassFrac, partFrac}.
 *  Returns {rtf: 24 values summing to 100, balance (must be ~1), cycles}. */
function rts2Compute(cls, carpet, furnFrac, mode, opt={}){
  const c=RTS2_CONSTR[cls];
  if(!c) throw new RangeError('cls must be L, M or H.');
  if(mode!=='nonsolar' && mode!=='solar') throw new RangeError("mode must be 'nonsolar' or 'solar'.");
  const W=opt.W||6, D=opt.D||6, H=opt.H||3;
  const g=(opt.glassFrac!==undefined)?opt.glassFrac:0.5;   // of the exterior wall
  const p=(opt.partFrac!==undefined)?opt.partFrac:0.75;    // of the total wall area
  const floorLayers = carpet ? c.floor.concat([RTS2_CARPET]) : c.floor;
  const faces=[W*H, D*H, W*H, D*H];
  const spec=[];
  const add=(name,area,layers,hc,solarTarget)=>{
    if(area>1e-10) spec.push({name,area,layers,hc,solarTarget:!!solarTarget});
  };
  for(let i=0;i<4;i++){
    const aPart=faces[i]*p, aExt=faces[i]-aPart, aGl=aExt*g, aOp=aExt-aGl;
    add('ext'+(i+1),  aOp,   c.wall,    RTS2_HCV, false);
    add('win'+(i+1),  aGl,   RTS2_GLAZ, RTS2_HCV, false);
    add('part'+(i+1), aPart, c.part,    RTS2_HCV, false);
  }
  const Af=W*D;
  add('floor', Af, floorLayers, RTS2_HCU, true);
  add('ceil',  Af, c.ceil,      RTS2_HCD, false);
  const Afu=2*furnFrac*Af;
  if(Afu>1e-10) for(let k=0;k<4;k++) add('furn'+(k+1), Afu/4, RTS2_FURN, RTS2_HCV, true);
  if(spec.length<4) throw new Error('Zone needs at least four surfaces for the Carroll network.');

  const areas=spec.map(s=>s.area);
  const geo=rts3CarrollF(areas);
  // hr_base per Carroll: 4*sigma*Tref^3 / (1/F + (1-eps)/eps), Tref = 300 K
  const hrBase=geo.map(F=>4*RTS2_SIG*Math.pow(300,3)/(1/F + (1-RTS2_EPS)/RTS2_EPS));

  // Per-surface cyclic operator: conduction kernel + surface film, inverted once.
  const ops=spec.map((s,i)=>{
    const K=rts3Kernel(s.layers);
    const M=[];
    for(let r=0;r<24;r++){
      const row=new Array(24);
      for(let cc=0;cc<24;cc++) row[cc]=-K[(r-cc+24)%24];
      row[r]+= s.hc + hrBase[i];
      M.push(row);
    }
    return M;
  });

  // Pulse distribution: nonsolar over every surface by emissivity-weighted
  // area; solar over floor + furnishings by area (physically consistent, and
  // identical to the fixed half-and-half split at 50% furnishings).
  const Q=1000, w=new Float64Array(spec.length);
  if(mode==='nonsolar'){
    let tot=0; for(const s of spec) tot+=RTS2_EPS*s.area;
    for(let i=0;i<spec.length;i++) w[i]=RTS2_EPS*spec[i].area/tot;
  } else {
    let tot=0; for(const s of spec) if(s.solarTarget) tot+=s.area;
    if(!(tot>0)) throw new Error('No surface available for the solar distribution.');
    for(let i=0;i<spec.length;i++) w[i]= spec[i].solarTarget ? spec[i].area/tot : 0;
  }

  const Ts=spec.map(()=>new Float64Array(24).fill(RTS2_TA));
  const hr=spec.map((s,i)=>new Float64Array(24).fill(hrBase[i]));
  const mrt=new Float64Array(24).fill(RTS2_TA);
  let load=new Float64Array(24), prev=new Float64Array(24), cyc=0, converged=false;
  // Cap raised from 40 to RTS3_MAX_ITER on 16 Aug 2026: an 864-case sweep found
  // 72 cases (8.3%) that exhausted 40 without meeting the tolerance and then
  // returned silently. The answers were still right to 4 decimal places, but a
  // solver must not report a number it could not verify. The cap is now high
  // enough that nothing in that sweep reaches it, and `converged` is returned
  // so callers can refuse an unverified result.
  for(cyc=1; cyc<=RTS3_MAX_ITER; cyc++){
    prev.set(load);
    for(let i=0;i<spec.length;i++){
      const s=spec[i], rhs=new Array(24);
      for(let h=0;h<24;h++){
        const qp = h===0 ? Q*w[i]/s.area : 0;
        rhs[h]= s.hc*RTS2_TA + hrBase[i]*mrt[h] + qp;
      }
      Ts[i]=Float64Array.from(rts3DenseSolve(ops[i], rhs));
      for(let h=0;h<24;h++){
        hr[i][h]=(0.865 + Ts[i][h]/200)*hrBase[i];
        let num=0, den=0;
        for(let j=0;j<spec.length;j++){ den+=spec[j].area*hr[j][h]; num+=spec[j].area*hr[j][h]*Ts[j][h]; }
        mrt[h]=num/den;
      }
    }
    load.fill(0);
    for(let h=0;h<24;h++)
      for(let i=0;i<spec.length;i++) load[h]+=spec[i].area*spec[i].hc*(Ts[i][h]-RTS2_TA);
    let mx=0;
    for(let h=0;h<24;h++) mx=Math.max(mx, Math.abs(load[h]-prev[h]));
    if(cyc>2 && mx<RTS3_ITER_TOL){ converged=true; break; }
  }
  let tot=0; for(let h=0;h<24;h++) tot+=load[h];
  if(!(tot>0)) throw new Error('Calculated radiant cooling load is not positive.');
  return {rtf: Array.from(load, v=>v/tot*100), balance: tot/Q, cycles: cyc,
          converged, settings:{maxIterations:RTS3_MAX_ITER, iterTolW:RTS3_ITER_TOL,
            cellsPerLayer:RTS3_CELLS_PER_LAYER, conductionStepS:RTS3_DT,
            responseSteps:RTS3_RESPONSE_STEPS, boundaryBeta:RTS3_BOUNDARY_BETA}};
}

/** Replaces RTS2_MAT/RTS2_CONSTR/RTS2_GLAZ/RTS2_FURN/RTS2_CARPET with
 *  values read live from MATERIALS, by name. Layer thicknesses (mm) stay
 *  as this project's own reference construction — MATERIALS has no notion of
 *  thickness (that is a per-layer, per-preset choice elsewhere in this app),
 *  only intensive properties, so thickness has to come from somewhere and
 *  this keeps the same zone the method was checked against. Called once from
 *  DOMContentLoaded, after MATERIALS-dependent init but before any RTS popup
 *  can realistically be opened. Falls back to the placeholder RTS2_MAT above
 *  (silently) if any named material is missing — so a future MATERIALS edit
 *  that renames/removes one of these ten names doesn't hard-crash the app,
 *  just makes this specific calculation use a stale generic number until
 *  fixed. Also clears the conduction-kernel cache, since the kernels depend
 *  on these properties. */
function buildRts2MaterialsFromDatabase(){
  const byName = {};
  MATERIALS.forEach(m => { byName[m.name] = m; });
  const km = (name, fallback) => byName[name] ? byName[name].k : fallback;
  const rm = (name, fallback) => byName[name] ? byName[name].rho : fallback;
  const cm = (name, fallback) => byName[name] ? byName[name].c : fallback;
  const gypK=km('Gypsum, Mineral and Fiber board',0.16), gypR=rm('Gypsum, Mineral and Fiber board',800), gypC=cm('Gypsum, Mineral and Fiber board',1090);
  const plasK=km('Mortar',0.72), plasR=rm('Mortar',1860), plasC=cm('Mortar',840);
  const brkK=km('Brick',0.85), brkR=rm('Brick',1800), brkC=cm('Brick',840);
  const conK=km('Concrete',1.75), conR=rm('Concrete',2300), conC=cm('Concrete',900);
  const tileK=km('Ceramic tile',1.30), tileR=rm('Ceramic tile',2300), tileC=cm('Ceramic tile',840);
  const insK=km('Insulation- Fiber Glass',0.04), insR=rm('Insulation- Fiber Glass',20), insC=cm('Insulation- Fiber Glass',840);
  const stlK=km('Steel',50), stlR=rm('Steel',7800), stlC=cm('Steel',480);
  const glsK=km('Clear glass',1.0), glsR=rm('Clear glass',2500), glsC=cm('Clear glass',840);
  const wodK=km('Hardwood',0.15), wodR=rm('Hardwood',600), wodC=cm('Hardwood',1600);
  const cptK=km('Carpet',0.06), cptR=rm('Carpet',200), cptC=cm('Carpet',1300);
  const airCavity = byName['Air: In wall cavity'] ? 1/byName['Air: In wall cavity'].k : 0.16;
  const airCeil   = byName['Air: In ceiling']     ? 1/byName['Air: In ceiling'].k     : 0.18;

  const mat = {
    gyp12:[12,gypK,gypR,gypC], gyp9:[9,gypK,gypR,gypC], plas15:[15,plasK,plasR,plasC],
    brick100:[100,brkK,brkR,brkC], conc100:[100,conK,conR,conC], conc150:[150,conK,conR,conC],
    tile8:[8,tileK,tileR,tileC], ins50:[50,insK,insR,insC],
    steel:[0.6,stlK,stlR,stlC], glass6:[6,glsK,glsR,glsC], carpet:[10,cptK,cptR,cptC],
    wood25:[12.5,wodK,wodR,wodC], airV:[null,airCavity], airC:[null,airCeil],
  };
  const constr = {
    L:{wall:['steel','ins50','airV','gyp12'], ceil:['conc100','airC','gyp9'],
       part:['gyp12','airV','gyp12'], floor:['gyp9','airC','conc100','tile8']},
    M:{wall:['plas15','brick100','plas15'], ceil:['conc100','airC','gyp9'],
       part:['plas15','brick100','plas15'], floor:['gyp9','airC','conc100','tile8']},
    H:{wall:['plas15','conc150','plas15'], ceil:['conc150'],
       part:['plas15','brick100','plas15'], floor:['conc150','tile8']},
  };
  for(const k of Object.keys(RTS2_MAT)) delete RTS2_MAT[k];
  Object.assign(RTS2_MAT, mat);
  RTS2_CONSTR = constr;
  RTS2_GLAZ = ['glass6']; RTS2_FURN = ['wood25']; RTS2_CARPET = 'carpet';
  rts3ClearKernelCache();
}

// ===== weather_parser.js =====
// ============================================================
// ezyRTS Weather File Parser
//
// Reads an uploaded Excel file containing ASHRAE climatic design
// data (as published by ashrae-meteo.info, 2021 ASHRAE Handbook of
// Fundamentals format) and extracts the values needed to drive the
// RTS cooling load calculation for all 12 months.
//
// IMPORTANT: this parser uses LABEL-BASED matching, not fixed cell
// coordinates — because the user pastes this data from a web page,
// the exact row/column position can shift depending on how much was
// copied. Matching is done by searching for the section/row labels
// that ASHRAE's own report format always uses (e.g. "Cooling
// DB/MCWB", "DBAvg", "MDBR"), then reading the values that sit in a
// fixed position *relative to that label*.
//
// This exact layout was cross-checked against TWO sources:
//  1. The sample weather file format the user provided (a paste
//     from ashrae-meteo.info for Bangkok Don Mueang).
//  2. ezyRTS.xlsm's own internal "Weather" sheet (used for Bangkok
//     Metropolis), which is the authoritative template the original
//     tool itself expects — confirms the same label layout.
//
// Uses SheetJS (xlsx) to read the uploaded file into a 2D array
// (aoa = "array of arrays") per sheet, then parses that array.
// ============================================================

/**
 * Parse an uploaded weather Excel file (File object from an <input type="file">)
 * @param {File} file
 * @param {Array<{country:string, tz:number}>} [countryTzTable] - pass COUNTRY_TZ
 *   here so timezone is matched by country name rather than trusting the
 *   free-text "Time zone: X.XX" line in the pasted report.
 * @returns {Promise<WeatherData>}
 */
async function parseWeatherFile(file, countryTzTable) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  // Use the first sheet — the pasted report is expected to be the only sheet,
  // or at least the first one, in the uploaded file.
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const aoa = normalizeSheet(raw); // strip \u00A0 and collapse whitespace before any matching
  return extractWeatherData(aoa, countryTzTable);
}

// ---------- low-level search helpers ----------

/**
 * Normalize a cell value before comparison. Critical: text copied from a web
 * page (ashrae-meteo.info) frequently contains NON-BREAKING SPACE (\u00A0)
 * characters instead of regular spaces — e.g. "Heating\u00A0DB" instead of
 * "Heating DB". An exact string match against a normal space would silently
 * fail. This was caught by testing against real pasted data, not assumed.
 */
function norm(v) {
  if (typeof v === 'string') {
    return v.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return v;
}

/** Normalize an entire sheet (array of arrays) once, up front. */
function normalizeSheet(aoa) {
  return aoa.map((row) => (row ? row.map(norm) : row));
}

function isNum(v) {
  return typeof v === 'number' && !isNaN(v);
}

/** First row index (searching from `from`) where `predicate(cellValue)` is true for some cell. */
function findRow(aoa, predicate, from = 0) {
  for (let r = from; r < aoa.length; r++) {
    const row = aoa[r];
    if (row && row.some(predicate)) return r;
  }
  return -1;
}

/** Column index within `row` where `predicate(cellValue)` is true. */
function findCol(row, predicate) {
  if (!row) return -1;
  for (let c = 0; c < row.length; c++) {
    if (predicate(row[c])) return c;
  }
  return -1;
}

/** Exact (already-normalized) string match predicate factory. */
function eq(label) {
  return (v) => v === label;
}

/** Substring match predicate factory (case-sensitive; labels are consistent ASHRAE report text). */
function contains(sub) {
  return (v) => typeof v === 'string' && v.indexOf(sub) !== -1;
}

/** Row containing ALL of the given exact (normalized) labels — used to disambiguate a header row. */
function findRowWithAll(aoa, labels, from = 0) {
  for (let r = from; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    const ok = labels.every((lab) => row.some((v) => v === lab));
    if (ok) return r;
  }
  return -1;
}

/** First row at/after `from` whose first cell is numeric — used to find a data row below a header block. */
function findNextNumericRow(aoa, from, maxLookahead = 10) {
  for (let r = from; r < Math.min(aoa.length, from + maxLookahead); r++) {
    if (aoa[r] && isNum(aoa[r][0])) return r;
  }
  return -1;
}

/**
 * Extract 12 monthly values that sit immediately to the right of a label cell,
 * with a 1-cell gap for an "Annual" value in between (matches the pattern used
 * by rows like "DBAvg", "taub", "taud": label, Annual, Jan..Dec).
 */
function extractMonthlyAfterLabel_withAnnualGap(aoa, label) {
  const r = findRow(aoa, eq(label));
  if (r === -1) return null;
  const c = findCol(aoa[r], eq(label));
  return aoa[r].slice(c + 2, c + 14); // skip Annual at c+1, take 12 months
}

/**
 * Extract 12 monthly values that sit immediately to the right of a label cell,
 * with NO gap (matches rows like "MDBR", "MCWBR": label, Jan..Dec directly).
 */
function extractMonthlyAfterLabel_noGap(aoa, label, from = 0) {
  const r = findRow(aoa, eq(label), from);
  if (r === -1) return null;
  const c = findCol(aoa[r], eq(label));
  return aoa[r].slice(c + 1, c + 13);
}

// ---------- section-specific extractors ----------

/**
 * Station info, kept field-for-field compatible with the shared WeatherData
 * per-province records: { name, lat, lon, hemisphere, elev, tz }.
 * (`wmo`, `handbookYear`, `country`, `tzSource` are extra bonus fields, not
 * present on province records, but harmless — they don't conflict with the
 * shared schema.)
 *
 * @param {Array} aoa - normalized sheet
 * @param {Array<{country:string, tz:number}>} [countryTzTable] - COUNTRY_TZ
 *   reference table. When provided, TZ is looked up by COUNTRY NAME and that
 *   value takes priority over whatever is parsed from the "Time zone: X.XX"
 *   text in the file — matching against a known 191-country list is far more
 *   reliable than regex-parsing free text that a user copy-pasted from a web
 *   page, which can be malformed or missing. The text-parsed value is kept
 *   only as a fallback (and flagged) when no country match is found.
 */
function extractStationInfo(aoa, countryTzTable) {
  // Row 0-ish: "20XX ASHRAE Handbook - Foundamentals (SI)" — capture the year for reference.
  const handbookRow = findRow(aoa, (v) => typeof v === 'string' && /ASHRAE Handbook/i.test(v));
  let handbookYear = null;
  if (handbookRow !== -1) {
    const cell = aoa[handbookRow].find((v) => typeof v === 'string' && /ASHRAE Handbook/i.test(v));
    const m = String(cell).match(/(\d{4})/);
    if (m) handbookYear = parseInt(m[1], 10);
  }

  // Lat / Lon / Elev row — found first (used both for its own fields below,
  // and as a fallback anchor for locating the station name row when that
  // row doesn't have a WMO number, see below).
  const latRow = findRow(aoa, (v) => typeof v === 'string' && v.indexOf('Lat:') === 0);

  // Station name + WMO: "STATION NAME, COUNTRY (WMO: 123456)"
  const stationRow = findRow(aoa, contains('WMO:'));
  let name = null, wmo = null, country = null;
  if (stationRow !== -1) {
    const cell = aoa[stationRow].find((v) => typeof v === 'string' && v.indexOf('WMO:') !== -1);
    const m = String(cell).match(/^(.*?)\s*\(WMO:\s*(\d+)\)/i);
    if (m) {
      name = m[1].trim();
      wmo = m[2];
      // Country is the text after the LAST comma in the name, e.g.
      // "BANGKOK METROPOLIS, THAILAND" -> "THAILAND".
      const parts = name.split(',');
      if (parts.length > 1) country = parts[parts.length - 1].trim();
    }
  }
  // CONFIRMED FIX: some real ASHRAE report exports/editions omit the "(WMO:
  // ######)" suffix entirely, which previously made the whole station block
  // come back null — failing the upload outright even when Lat/Lon/Elev/TZ
  // were all present and perfectly usable. Fallback: the station name line
  // is consistently the row immediately ABOVE the "Lat:" row in every
  // observed report layout, so if the strict WMO-pattern search found
  // nothing, try reading a plain "NAME[, COUNTRY]" line from there instead
  // (no WMO number in this case — `wmo` stays null, which is fine, since
  // it's supplementary metadata, not something the calc engine needs).
  if (name === null && latRow > 0) {
    const candidateRow = aoa[latRow - 1];
    const candidateCell = candidateRow && candidateRow.find((v) => typeof v === 'string' && v.trim().length > 0);
    if (candidateCell) {
      name = candidateCell.trim();
      const parts = name.split(',');
      if (parts.length > 1) country = parts[parts.length - 1].trim();
    }
  }

  // lat is stored SIGNED (negative for Southern Hemisphere) — CONFIRMED FIX: this
  // used to be stored unsigned, which silently broke solar geometry for every
  // Southern Hemisphere station uploaded via a weather file.
  // lon is stored UNSIGNED with a separate `hemisphere` string ('E'|'W'),
  // matching the shared WeatherData layout.
  let lat = null, lon = null, hemisphere = null, elev = null;
  if (latRow !== -1) {
    for (const cell of aoa[latRow]) {
      if (typeof cell !== 'string') continue;
      let m;
      if ((m = cell.match(/^Lat:\s*([\d.]+)([NS])/i))) {
        lat = parseFloat(m[1]);
        if (m[2].toUpperCase() === 'S') lat = -lat; // Southern Hemisphere — CONFIRMED bug fix:
        // the regex always captured N/S but this sign was previously discarded, silently
        // treating every Southern Hemisphere station (Sydney, Cape Town, Jakarta-south, etc.)
        // as Northern — which flips solar declination's effect and badly corrupts solar
        // altitude/azimuth (and therefore solar heat gain) for every wall/window/roof.
      }
      else if ((m = cell.match(/^Lon:\s*([\d.]+)([EW])/i))) { lon = parseFloat(m[1]); hemisphere = m[2].toUpperCase(); }
      else if ((m = cell.match(/^Elev:\s*([\d.-]+)/i))) elev = parseFloat(m[1]);
    }
  }

  // Time zone — for an UPLOADED file, always use the station's own
  // "Time zone: 7.00 (E07)" value from the file itself. The COUNTRY_TZ
  // database is never used as a substitute here — if the uploaded file
  // doesn't have a usable "Time zone:" line, tz stays null and the confirm
  // popup's TZ field is left for the user to fill in manually, rather than
  // silently guessing from the country.
  let tzParsed = null;
  const tzRow = findRow(aoa, contains('Time zone:'));
  if (tzRow !== -1) {
    const cell = aoa[tzRow].find((v) => typeof v === 'string' && v.indexOf('Time zone:') !== -1);
    const m = String(cell).match(/Time zone:\s*([\d.+-]+)/i);
    if (m) tzParsed = parseFloat(m[1]);
  }

  const tz = tzParsed;
  const tzSource = 'parsed';

  // The program's own example workbook (all values fictitious) is marked by
  // WMO 000000 plus the word FICTITIOUS in the station line. Flagged here, from
  // the file itself, so renaming the station in the confirm modal cannot hide it.
  const fictitious = wmo === '000000' && /FICTITIOUS/i.test(name || '');
  return { name, lat, lon, hemisphere, elev, tz, tzParsed, tzSource, wmo, country, handbookYear, fictitious };
}

function extractHeatingDesign(aoa) {
  const headerRow = findRowWithAll(aoa, ['Coldest Month', 'Heating DB']);
  if (headerRow === -1) return null;
  const dataRow = findNextNumericRow(aoa, headerRow + 1);
  if (dataRow === -1) return null;
  const d = aoa[dataRow];
  return {
    coldestMonth: d[0],       // 1-12
    heatingDB_99_6: d[1],     // °C, 99.6% design heating DB
    heatingDB_99: d[2],       // °C, 99% design heating DB
  };
}

function extractCoolingDesign(aoa) {
  const headerRow = findRow(aoa, eq('Cooling DB/MCWB'));
  if (headerRow === -1) return null;
  const dataRow = findNextNumericRow(aoa, headerRow + 1);
  if (dataRow === -1) return null;
  const d = aoa[dataRow];
  return {
    hottestMonth: d[0],        // 1-12
    dbRangeAnnual: d[1],       // °C, annual hottest-month daily DB range
    cooling_0_4: { db: d[2], mcwb: d[3] },
    cooling_1:   { db: d[4], mcwb: d[5] },
    cooling_2:   { db: d[6], mcwb: d[7] },
  };
}

function extractMonthlyDBAvg(aoa) {
  return extractMonthlyAfterLabel_withAnnualGap(aoa, 'DBAvg');
}

/** Monthly Design DB & MCWB, all 3 published percentile levels (0.4% / 2% / 5%) —
 *  matches the schema used by the shared WeatherData shape (monthlyDesignDB / monthlyDesignMCWB
 *  each as {p0_4, p2, p5}), so an uploaded file and a province-DB lookup are interchangeable. */
function extractMonthlyDesignDB_MCWB(aoa) {
  const sectionRow = findRow(aoa, contains('Monthly Design Dry Bulb and Mean Coincident Wet Bulb'));
  if (sectionRow === -1) return null;

  // IMPORTANT: in this report format the section title and the FIRST (0.4%) data
  // row are the SAME row — e.g. ['Monthly Design Dry Bulb...', null, 0.004, 'DB', ...].
  // Searching from sectionRow + 1 silently skips the 0.4% block and grabs 0.02%
  // instead. Confirmed by testing against real data (ezyRTS.xlsm's own Weather
  // sheet) — search must start AT sectionRow, not after it.
  const keys = ['p0_4', 'p2', 'p5'];
  const db = {}, mcwb = {};
  let searchFrom = sectionRow;
  for (let i = 0; i < 3; i++) {
    const dbRow = findRow(aoa, eq('DB'), searchFrom);
    if (dbRow === -1) break;
    const dbCol = findCol(aoa[dbRow], eq('DB'));
    db[keys[i]] = aoa[dbRow].slice(dbCol + 1, dbCol + 13);
    const mcwbRow = dbRow + 1;
    const mcwbCol = findCol(aoa[mcwbRow], eq('MCWB'));
    mcwb[keys[i]] = mcwbCol !== -1 ? aoa[mcwbRow].slice(mcwbCol + 1, mcwbCol + 13) : null;
    searchFrom = mcwbRow + 1;
  }
  if (!db.p0_4) return null;
  return { db, mcwb };
}

/** Monthly Design WB & MCDB, all 3 percentile levels — same fix as DB/MCWB above. */
function extractMonthlyDesignWB_MCDB(aoa) {
  const sectionRow = findRow(aoa, contains('Monthly Design Wet Bulb and Mean Coincident Dry Bulb'));
  if (sectionRow === -1) return null;
  const keys = ['p0_4', 'p2', 'p5'];
  const wb = {}, mcdb = {};
  let searchFrom = sectionRow; // same "title row = first data row" layout as the DB/MCWB section
  for (let i = 0; i < 3; i++) {
    const wbRow = findRow(aoa, eq('WB'), searchFrom);
    if (wbRow === -1) break;
    const wbCol = findCol(aoa[wbRow], eq('WB'));
    wb[keys[i]] = aoa[wbRow].slice(wbCol + 1, wbCol + 13);
    const mcdbRow = wbRow + 1;
    const mcdbCol = findCol(aoa[mcdbRow], eq('MCDB'));
    mcdb[keys[i]] = mcdbCol !== -1 ? aoa[mcdbRow].slice(mcdbCol + 1, mcdbCol + 13) : null;
    searchFrom = mcdbRow + 1;
  }
  if (!wb.p0_4) return null;
  return { wb, mcdb };
}

function extractMeanDailyRange(aoa) {
  // NOTE: some workbooks (e.g. ezyRTS's own internal "Weather" template) contain
  // an unrelated helper cell elsewhere that also literally equals "MDBR" (part of
  // a month-index lookup array, far to the right, used by other formulas). Always
  // anchor the search to AFTER the real "Mean Daily Temperature Range" section
  // header, never search the whole sheet — confirmed necessary by testing against
  // ezyRTS.xlsm's real Weather sheet, which contains exactly this decoy.
  const sectionRow = findRow(aoa, contains('Mean Daily Temperature Range'));
  if (sectionRow === -1) return { mdbr: null, mcwbr: null };
  const mdbr = extractMonthlyAfterLabel_noGap(aoa, 'MDBR', sectionRow);
  // MCWBR — CONFIRMED BUG: this was never extracted at all before (only mdbr
  // was), silently leaving hourlyOutdoorRHForMonth's mcwbr argument as 0 for
  // every uploaded file, which skews the calculated outdoor RH profile. The
  // real report has TWO "MCWBR" rows (one in the "5% DB" group right after
  // MDBR, one further down in the separate "5% WB" group) — the first one,
  // paired with the same "5% DB" section as MDBR itself, is the one that
  // matches the shared WeatherData own single mcwbr[12] field.
  const mcwbr = extractMonthlyAfterLabel_noGap(aoa, 'MCWBR', sectionRow);
  return { mdbr, mcwbr };
}

/** Clear-sky optical depths (ASHRAE clear-sky solar model), used for solar heat gain calc. */
function extractClearSkyOpticalDepths(aoa) {
  const sectionRow = findRow(aoa, contains('Clear Sky Solar Irradiance'));
  if (sectionRow === -1) return { taub: null, taud: null };
  const taubRow = findRow(aoa, eq('taub'), sectionRow);
  if (taubRow === -1) return { taub: null, taud: null };
  const taubCol = findCol(aoa[taubRow], eq('taub'));
  const taub = aoa[taubRow].slice(taubCol + 2, taubCol + 14);
  const taudRow = taubRow + 1;
  const taudCol = findCol(aoa[taudRow], eq('taud'));
  const taud = taudCol !== -1 ? aoa[taudRow].slice(taudCol + 2, taudCol + 14) : null;
  return { taub, taud };
}

// ---------- top-level ----------

const REQUIRED_SECTIONS = [
  ['heating', extractHeatingDesign],
  ['cooling', extractCoolingDesign],
  ['monthlyDBAvg', extractMonthlyDBAvg],
  ['_designDB_MCWB', extractMonthlyDesignDB_MCWB], // reshaped into monthlyDesignDB / monthlyDesignMCWB below
];

/**
 * @typedef {Object} WeatherData
 * @property {object} station
 * @property {object} heating
 * @property {object} cooling
 * @property {number[]} monthlyDBAvg              - 12 values, Jan..Dec (optional)
 * @property {object} monthlyDesignDB              - {p0_4:[12], p2:[12], p5:[12]} — same shape as the shared WeatherData
 * @property {object} monthlyDesignMCWB            - {p0_4:[12], p2:[12], p5:[12]} — same shape as the shared WeatherData
 * @property {object|null} monthlyDesignWB         - {p0_4:[12], p2:[12], p5:[12]} (optional bonus, not in province DB)
 * @property {object|null} monthlyDesignMCDB       - {p0_4:[12], p2:[12], p5:[12]} (optional bonus, not in province DB)
 * @property {object|null} meanDailyRange          - { mdbr:[12] }
 * @property {object|null} clearSkyOpticalDepths   - { taub:[12], taud:[12] }
 * @property {string[]} errors - labels that could not be found (empty if fully valid)
 *
 * @param {Array} aoa - normalized sheet
 * @param {Array<{country:string, tz:number}>} [countryTzTable] - see extractStationInfo()
 */
function extractWeatherData(aoa, countryTzTable) {
  const errors = [];
  const result = {};

  // Station handled separately (not via REQUIRED_SECTIONS) because it needs
  // the optional countryTzTable argument for the country-based TZ lookup.
  const station = extractStationInfo(aoa, countryTzTable);
  const stationValid = station.name && isNum(station.lat) && isNum(station.lon);
  if (!stationValid) errors.push('station');
  result.station = stationValid ? station : null;
  if (stationValid && station.tz == null) {
    // The uploaded file didn't have a usable "Time zone:" line — per the
    // user's requirement, we do NOT substitute a COUNTRY_TZ database guess
    // here. Flagged so the confirm popup's TZ field draws attention and the
    // user fills it in manually from the source data.
    errors.push(`tz (uploaded file has no "Time zone:" line — please enter it manually)`);
  }

  for (const [key, fn] of REQUIRED_SECTIONS) {
    const val = fn(aoa);
    if (val === null || val === undefined) errors.push(key);
    result[key] = val;
  }

  // Reshape into the same field names/shape as the shared WeatherData so an uploaded
  // file and a province-DB lookup can be used interchangeably by the calc engine.
  const designDB_MCWB = result._designDB_MCWB;
  result.monthlyDesignDB = designDB_MCWB ? designDB_MCWB.db : null;
  result.monthlyDesignMCWB = designDB_MCWB ? designDB_MCWB.mcwb : null;
  delete result._designDB_MCWB;

  // Optional sections — nice to have for solar/hourly-profile accuracy, but the
  // app should still let the user proceed (with a warning) if these are missing,
  // since they may fall back to ASHRAE default assumptions.
  const designWB_MCDB = extractMonthlyDesignWB_MCDB(aoa);
  result.monthlyDesignWB = designWB_MCDB ? designWB_MCDB.wb : null;
  result.monthlyDesignMCDB = designWB_MCDB ? designWB_MCDB.mcdb : null;
  result.meanDailyRange = extractMeanDailyRange(aoa);
  result.clearSkyOpticalDepths = extractClearSkyOpticalDepths(aoa);

  if (!result.monthlyDesignWB) errors.push('monthlyDesignWB (optional)');
  if (!result.meanDailyRange?.mdbr) errors.push('meanDailyRange.mdbr (optional)');
  if (!result.clearSkyOpticalDepths?.taub) errors.push('clearSkyOpticalDepths.taub (optional)');
  if (!result.clearSkyOpticalDepths?.taud) errors.push('clearSkyOpticalDepths.taud (optional)');

  result.errors = errors;
  result.isValid = result.station && result.heating && result.cooling &&
    result.monthlyDBAvg && result.monthlyDesignDB && result.monthlyDesignMCWB;

  return result;
}

// Exports (for use as an ES module in the real app build)


// ===== weather_hourly.js =====
// ============================================================
// ezyRTS Web — Hourly Outdoor Dry-Bulb Temperature Generator
//
// Formula extracted directly from ezyRTS.xlsm, sheet
// "Usage Profile and Outdoor" (columns D37:D61 for the PDR table,
// P39 for the per-hour formula) — verified against the source cell
// text, not reconstructed from memory:
//
//   to(hour, month) = DesignDB_0.4%(month) - MDBR(month) * PDR(hour) / 100
//
// PDR = "Percent of Daily [Temperature] Range" — the standard ASHRAE
// Fundamentals default 24-hour profile (single fixed profile; ezyRTS
// does not switch profiles by %DB-range zone, it always uses this one
// table for every month). Both DesignDB_0.4% and MDBR come from the
// SAME per-month arrays already produced by weather_parser.js
// (monthlyDesignDB.p0_4) (monthlyDesignDB.p0_4,
// mdbr) — so this generator works identically regardless of which
// source supplied the weather data.
// ============================================================

// Hour 1..24, confirmed from ezyRTS.xlsm 'Usage Profile and Outdoor'!D38:D61
const PDR_PROFILE_24 = [
  87, 92, 96, 99, 100, 98, 93, 84, 71, 56, 39, 23,
  11, 3, 0, 3, 10, 21, 34, 47, 58, 68, 76, 82,
];

/**
 * Generate the 24-hour outdoor dry-bulb temperature profile for one month.
 * @param {number} designDB_p0_4 - this month's 0.4% design DB, °C (monthlyDesignDB.p0_4[monthIdx])
 * @param {number} mdbr          - this month's Mean Coincident Daily DB Range, °C (mdbr[monthIdx])
 * @returns {number[]} 24 values, hour 1..24
 */
function hourlyOutdoorTempForMonth(designDB_p0_4, mdbr) {
  return PDR_PROFILE_24.map((pdr) => designDB_p0_4 - mdbr * pdr / 100);
}

/**
 * Generate the full 12-month x 24-hour outdoor temperature matrix from a
 * WeatherData-shaped object (the shared shape produced by both
 * weather_parser.js (upload path): monthlyDesignDB.p0_4[12], mdbr[12]).
 * @param {object} weatherData
 * @returns {number[][]} outer index 0-11 = Jan-Dec, inner = 24 hourly values
 */
function generateHourlyOutdoorTempAllMonths(weatherData) {
  const designDB = weatherData.monthlyDesignDB?.p0_4;
  const mdbr = weatherData.mdbr;
  if (!designDB || !mdbr) {
    throw new Error('generateHourlyOutdoorTempAllMonths: weatherData is missing monthlyDesignDB.p0_4 or mdbr');
  }
  const result = [];
  for (let m = 0; m < 12; m++) {
    result.push(hourlyOutdoorTempForMonth(designDB[m], mdbr[m]));
  }
  return result;
}



// ===== engine_conduction.js =====
// ============================================================
// ezyRTS Web — Wall / Roof Conductive Heat Gain Engine
//
// Implements the ASHRAE Radiant Time Series (RTS) method for opaque
// surfaces (walls and roofs), using formulas extracted DIRECTLY from
// ezyRTS.xlsm's own calculation sheets (Wa1_Et, Wa1_Total_CL,
// Wa1_CTS Wall, Wa1_NS-RTS / R1_Et, R1_Output, R1_CTS Roof, R1_NS-RTS
// Roof) — not reconstructed from memory. Every formula below has a
// comment pointing at the exact source cell.
//
// CONFIRMED constants (user-verified):
//   Wall : sol-air correction term = 0 (blank cell in source)
//          convective/radiant split = 54% / 46% (per actual formula;
//          the file's own header LABEL says "37%/63%", which is a
//          typo in ezyRTS itself — 54/46 is the value that is
//          actually computed and was confirmed as authoritative)
//   Roof : sol-air correction term = 4 °C (matches ASHRAE's standard
//          horizontal-surface long-wave correction)
//          convective/radiant split = 40% / 60% (label matches formula)
//
// KNOWN LIMITATION: ezyRTS.xlsm's own example/template calculation
// sheets contain no completed worked example (Input_SI / Location are
// blank templates, so every dependent cell evaluates to #VALUE!/#N/A
// in the source file). This means the formulas below were verified by
// reading the formula text directly from the source cells (confirmed
// correct), but could NOT be cross-checked against a known-good
// numeric result from the file itself, because no such result exists
// in the workbook. Basic physical sanity checks are included instead
// (see the bottom of this file) — solar altitude near local noon at
// low latitude should approach ~90°, declination bounded to ±23.45°, etc.
// ============================================================

const DEG = Math.PI / 180;
const toRad = (d) => d * DEG;
const toDeg = (r) => r / DEG;

/** Day of year (1 = Jan 1), matching Excel's `date - DATE(year,1,1)` pattern (0-based there; +1 here for clarity). */
function dayOfYear(year, month, day) {
  const start = Date.UTC(year, 0, 1);
  const d = Date.UTC(year, month - 1, day);
  return Math.round((d - start) / 86400000); // 0 for Jan 1, matching the source's day-count convention
}

// ---------- ASHRAE Clear-Sky Solar Model ----------
// Source: Wa1_Et!B4 (Equation of Time), B9 (Declination), B15-17 (ab/ad/E0),
// B21:O44 (per-hour solar position + irradiance). Verified formula-for-formula.

/** Equation of Time, minutes. n = day-of-year (0-based, Jan 1 = 0). */
function equationOfTime(n) {
  const g1 = toRad(360 * n / 365);
  const g2 = toRad(720 * n / 365);
  return 2.2918 * (0.0075 + 0.1868 * Math.cos(g1) - 3.2077 * Math.sin(g1)
    - 1.4615 * Math.cos(g2) - 4.089 * Math.sin(g2));
}

/**
 * Solar declination, degrees. n = day-of-year (0-based, Jan1=0, same
 * convention as equationOfTime's n).
 * CONFIRMED FIX: the source file's own declination formula uses a DIFFERENT
 * day-count reference (`DATE(year,1,0)`, i.e. Dec 31 of the prior year — a
 * 1-based count) than its Equation of Time formula (`DATE(year,1,1)`, 0-based)
 * — a genuine inconsistency within ezyRTS.xlsm itself, confirmed by
 * re-extracting both formulas directly from the source cells (Wa1_Et!B4 vs
 * B9). So `n+1` is used here to match B9's reference point while keeping a
 * single shared `n` convention across this module. This was invisible in
 * wall validation (the sol-air formula heavily damps solar error via the
 * small alpha/ho factor, 0.026-0.052) but became visible (~1% error) for
 * windows, where SHGC (~0.7) barely damps it at all — found by the user's
 * detailed hour-by-hour Excel comparison for a window.
 */
function solarDeclination(n) {
  return 23.45 * Math.sin(2 * Math.PI * (n + 1 + 284) / 365);
}

/** Extraterrestrial normal irradiance, W/m². n = day-of-year (0-based), same
 *  `n+1` fix as solarDeclination — confirmed from Wa1_Et!B17 using DATE(year,1,0). */
function extraterrestrialIrradiance(n) {
  return (Math.cos(2 * Math.PI * (n + 1 - 3) / 365) * 0.033 + 1) * 1367;
}

/** Beam/diffuse air-mass exponents from clear-sky optical depths (taub, taud). */
function airMassExponents(taub, taud) {
  const ab = 1.454 - 0.406 * taub - 0.268 * taud + 0.021 * taub * taud;
  const ad = 0.507 + 0.205 * taub - 0.08 * taud - 0.19 * taub * taud;
  return { ab, ad };
}

/**
 * Full per-hour solar position + surface irradiance calc for one wall/roof surface.
 * @param {number} hour        - local standard time hour (1-24, matches source's A13..A36)
 * @param {number} n            - day-of-year (0-based)
 * @param {number} lat          - degrees, SIGNED (negative = Southern Hemisphere). The
 *   standard formula below (sinβ = cosL·cosδ·cosH + sinL·sinδ) is correct for either sign.
 * @param {number} lon          - degrees, unsigned
 * @param {'E'|'W'} hemisphere  - longitude hemisphere
 * @param {number} tz           - UTC offset (e.g. 7 for Thailand)
 * @param {number} taub         - clear-sky beam optical depth, this month
 * @param {number} taud         - clear-sky diffuse optical depth, this month
 * @param {number} surfaceAzimuth - degrees, surface facing direction in ASHRAE convention
 *   (S=0, SW=45, W=90, NW=135, N=180/-180, NE=-135, E=-90, SE=-45 — matches Wa1_Input!D22:E37)
 * @param {number} tilt         - degrees from horizontal (90 = vertical wall, 0 = flat roof)
 * @returns {{Et:number, altitude:number, azimuth:number}}
 */
function surfaceIrradiance(hour, n, lat, lon, hemisphere, tz, taub, taud, surfaceAzimuth, tilt) {
  const ET = equationOfTime(n);                         // Wa1_Et!B4
  const delta = solarDeclination(n);                    // Wa1_Et!B9
  const E0 = extraterrestrialIrradiance(n);              // Wa1_Et!B17
  const { ab, ad } = airMassExponents(taub, taud);       // Wa1_Et!B15,B16
  const LSM = tz * 15;                                   // Wa1_Et!B6

  // AST = MOD(hour + ET/60 + (lonSigned - LSM)/15, 24)   — Wa1_Et!B21
  const lonSigned = hemisphere === 'W' ? -lon : lon;
  let AST = hour + ET / 60 + (lonSigned - LSM) / 15;
  AST = ((AST % 24) + 24) % 24;

  const H = 15 * (AST - 12);                             // Hour angle — Wa1_Et!C21

  // Solar altitude (β): sinβ = cosL·cosδ·cosH + sinL·sinδ  — Wa1_Et!D21
  const sinBeta = Math.cos(toRad(lat)) * Math.cos(toRad(delta)) * Math.cos(toRad(H))
    + Math.sin(toRad(lat)) * Math.sin(toRad(delta));
  const beta = toDeg(Math.asin(Math.max(-1, Math.min(1, sinBeta))));

  // Solar azimuth (φ) via atan2 — Wa1_Et!E21. IMPORTANT: Excel's ATAN2(x_num, y_num)
  // takes arguments in (x, y) order, opposite of JavaScript's Math.atan2(y, x) —
  // confirmed by re-checking the exact source formula against real ezyRTS output
  // (a north wall in Bangkok/May was landing high solar irradiance at the wrong
  // hours; tracing it back to azimuth being wrong specifically near solar noon at
  // high altitude — a classic symptom of a swapped-argument atan2 bug). The two
  // arguments below are swapped relative to Excel's literal (x_num, y_num) order
  // to correctly convert to JS's (y, x) convention.
  const phi = toDeg(Math.atan2(
    Math.sin(toRad(H)) * Math.cos(toRad(delta)),
    Math.cos(toRad(H)) * Math.cos(toRad(delta)) * Math.sin(toRad(lat)) - Math.sin(toRad(delta)) * Math.cos(toRad(lat))
  ));

  // Air mass (m) — Wa1_Et!F21
  const m = beta <= 0 ? 38 : 1 / (Math.sin(toRad(beta)) + 0.50572 * Math.pow(6.07995 + beta, -1.6364));

  // Beam & diffuse irradiance on a surface normal to the sun — Wa1_Et!G21,H21
  const Eb = beta < 0 ? 0 : E0 * Math.exp(-taub * Math.pow(m, ab));
  const Ed = beta < 0 ? 0 : E0 * Math.exp(-taud * Math.pow(m, ad));

  // Surface-solar azimuth (γ), normalized to [-180,180] — Wa1_Et!I21
  const gamma = (((phi - surfaceAzimuth + 180) % 360) + 360) % 360 - 180;

  // Surface incident angle (θ) — Wa1_Et!J21
  const cosTheta = Math.cos(toRad(beta)) * Math.cos(toRad(gamma)) * Math.sin(toRad(tilt))
    + Math.sin(toRad(beta)) * Math.cos(toRad(tilt));
  const theta = toDeg(Math.acos(Math.max(-1, Math.min(1, cosTheta))));

  // Direct-beam component on the surface — Wa1_Et!K21
  const Etb = Math.cos(toRad(theta)) > 0 ? Eb * Math.cos(toRad(theta)) : 0;

  // Anisotropic-sky diffuse factor Y — Wa1_Et!L21
  const Y = Math.max(0.45, 0.55 + 0.437 * Math.cos(toRad(theta)) + 0.313 * Math.pow(Math.cos(toRad(theta)), 2));

  // Diffuse component on the surface — Wa1_Et!M21
  const Etd = tilt <= 90
    ? Ed * (Y * Math.sin(toRad(tilt)) + Math.cos(toRad(tilt)))
    : Ed * Y * Math.sin(toRad(tilt));

  // Ground-reflected component — Wa1_Et!N21 (default ground reflectance rho_g = 0.2)
  const Etr = (Eb * Math.sin(toRad(beta)) + Ed) * 0.2 * (1 - Math.cos(toRad(tilt))) / 2;

  const Et = Etb + Etd + Etr; // Wa1_Et!O21

  return { Et, altitude: beta, azimuth: phi };
}

// ---------- Sol-air temperature & heat input ----------

/**
 * @param {number} to        - outdoor dry-bulb temp this hour, °C
 * @param {number} alphaHo   - solar absorptance / outside film coefficient (0.026 light, 0.052 dark — Dropdown!M21:N22)
 * @param {number} Et        - total surface irradiance this hour, W/m² (from surfaceIrradiance())
 * @param {number} correction - long-wave correction, °C (0 for walls, 4 for roofs — Wa1_Total_CL!D13 vs R1_Output!D13)
 */
function solAirTemp(to, alphaHo, Et, correction) {
  return to + alphaHo * Et - correction;
}

/** Heat Input q(t) = U·A·(te - trc) — Wa1_Total_CL!F13 */
function heatInput(uFactor, area, solAirTempC, roomTempC) {
  return uFactor * area * (solAirTempC - roomTempC);
}

// ---------- CTS / NS-RTS convolution ----------

/**
 * Convolve a 24-hour heat-input series with a 24-value CTS or RTS
 * percentage series to get the delayed heat gain (or radiant cooling
 * load) at each hour. Matches the circular-shift INDEX logic in
 * Wa1_CTS Wall! / Wa1_NS-RTS! exactly (verified formula-for-formula):
 *   Gain(t) = Σ_{n=0}^{23} pct[n]/100 × input[(t-n+24) mod 24]
 * where input[] and pct[] are both 24-length, hour-1-indexed arrays
 * (index 0 = hour 1 .. index 23 = hour 24).
 */
function convolve24(inputArray24, pctArray24) {
  const out = new Array(24).fill(0);
  for (let t = 0; t < 24; t++) {
    let sum = 0;
    for (let n = 0; n < 24; n++) {
      const srcIdx = ((t - n) % 24 + 24) % 24;
      sum += (pctArray24[n] / 100) * inputArray24[srcIdx];
    }
    out[t] = sum;
  }
  return out;
}

// ============================================================
// Live CTS solver — added 15 Aug 2026, porting METHODOLOGY_CTS_RTF.md
// section 3 (1D implicit finite-difference conduction, backward Euler,
// Thomas-algorithm tridiagonal solve, steady-periodic convergence) into
// the engine so Wall/Roof CTS is computed directly from the same layers
// the U-factor calculator already uses, instead of picked from a fixed
// table. Validated as a timing/shape proof-of-concept beforehand (see
// conversation) — NOT yet checked against a specific published ASHRAE
// case number-for-number, since this app has no such reference embedded.
// Requires MATERIALS[].rho/c (added 15 Aug 2026, see comment above
// MATERIALS for provenance/estimated-value flags).
//
// Layer convention matches calcU()/COMPONENT_PRESETS exactly: boundary
// air films (isAir material, e.g. "Air: Outdoor air") are ordinary
// entries at the START and END of the `layers` array, not a separate
// argument — R = 1/k for those (thickness is ignored, same as calcU()).
// Any OTHER (mid-assembly) air layer, e.g. "Air: In wall cavity", is
// resistance-only and gets folded into the adjacent gap, same as a
// boundary film would, per methodology sec 3.1.

/**
 * Build the 1D node/resistance mesh for a layered assembly.
 * @param {Array<{material:string, thickness:(number|string)}>} layers  outside -> inside order, boundary air films included
 * @returns {{nodesC:number[], resistances:number[], Rout:number, Rin:number}|null} null if the assembly can't be solved (see reasons in code)
 */
function ctsBuildMesh(layers) {
  const resolved = layers
    .map(l => {
      const mat = MATERIALS.find(m => m.name === l.material);
      if (!mat) return null;
      // A layer can carry its own kOverride (SI units, W/m·K for solids or
      // W/m²·K for air films) — set when the user typed a custom k/h value
      // in the U-factor popup instead of accepting the material default.
      // Falls back to the material's own k when absent, matching calcU()'s
      // same fallback (added 15 Aug 2026 to fix bug 3.3: CTS previously
      // always used mat.k and ignored a user-typed k, so U-factor and CTS
      // could disagree for the same row).
      const hasOverride = typeof l.kOverride === 'number' && isFinite(l.kOverride) && l.kOverride > 0;
      const k = hasOverride ? l.kOverride : mat.k;
      return { mat, thickness: parseFloat(l.thickness), k };
    })
    .filter(Boolean); // drop empty/unrecognized rows, same as calcU()

  if (resolved.length === 0) return null;

  // Boundary films: first/last entries, IF they are air. An assembly
  // with no air film on one or both ends (e.g. user deleted it) can't
  // be solved without a film coefficient — return null rather than
  // silently assuming a value.
  let Rout = null, Rin = null;
  let bodyStart = 0, bodyEnd = resolved.length;
  if (resolved[0].mat.isAir) { Rout = 1 / resolved[0].k; bodyStart = 1; }
  if (resolved.length > 1 && resolved[resolved.length - 1].mat.isAir) { Rin = 1 / resolved[resolved.length - 1].k; bodyEnd = resolved.length - 1; }
  if (Rout === null || Rin === null) return null;

  const nodesC = [0];
  const resistances = [];
  let pendingHalfCell = 0;

  for (let i = bodyStart; i < bodyEnd; i++) {
    const { mat, thickness, k } = resolved[i];
    if (mat.isAir) {
      // mid-assembly air gap (e.g. wall cavity): resistance-only, folded
      // into whichever node-to-node gap it falls in.
      pendingHalfCell += 1 / k;
      continue;
    }
    if (!(thickness > 0)) return null; // solid layer needs a real thickness
    if (mat.rho == null || mat.c == null) return null; // shouldn't happen post-15-Aug-2026, but guard anyway
    const thk = thickness / 1000; // mm -> m
    const nCells = Math.max(2, Math.ceil(thk / 0.015)); // <=15mm per cell, min 2 (sec 3.1)
    const dx = thk / nCells;
    const cellR = dx / k;
    const cellC = mat.rho * mat.c * dx;
    for (let c = 0; c < nCells; c++) {
      nodesC.push(cellC);
      resistances.push(pendingHalfCell + cellR / 2);
      pendingHalfCell = cellR / 2;
    }
  }
  if (nodesC.length < 2) return null; // no solid capacitive layer at all
  nodesC.push(0);
  resistances.push(pendingHalfCell);

  return { nodesC, resistances, Rout, Rin };
}

// Numerical settings for the CTS periodic-response solver. cellsPerLayer = 6
// is the value the method was checked at; refining to 96 moves the first
// factor by only 0.04 percentage points, so the choice is not sensitive.
// responseSteps must NOT be reduced: heavy masonry assemblies are still
// releasing flux at 4800 steps and truncating there costs 0.22 pp.
const CTS3_CELLS_PER_LAYER = 6, CTS3_DT = 60, CTS3_RESPONSE_STEPS = 9600;
const CTS3_CUTOFF = 1e-9, CTS3_U_TOL = 1e-3;
const CTS3_STILL_AIR_K = 0.0263, CTS3_STILL_AIR_RC = 1.1614 * 1007;

/** Triangular boundary pulse: rises 0->1 over the first hour, falls back to 0
 *  over the second, zero afterwards. Driving one face with this and folding
 *  the hourly flux onto 24 h gives the periodic response factors. */
function ctsTriangularPulse(seconds) {
  if (seconds <= 3600) return seconds / 3600;
  if (seconds <= 7200) return 2 - seconds / 3600;
  return 0;
}

/** Resolve the app's layer rows into the physical stack the solver needs,
 *  using exactly the same rules as ctsBuildMesh()/calcU(): unknown rows are
 *  dropped, a layer's kOverride wins over the material default (bug 3.3), and
 *  every isAir row — boundary film or mid-assembly cavity — becomes a pure
 *  resistance. Returns null on anything the solver cannot handle, so callers
 *  keep the same "null means refuse" contract they had before. */
function ctsResolveLayers(layers) {
  const out = [];
  for (const l of layers) {
    const mat = MATERIALS.find(m => m.name === l.material);
    if (!mat) continue;                       // drop empty/unrecognized rows
    const hasOverride = typeof l.kOverride === 'number' && isFinite(l.kOverride) && l.kOverride > 0;
    const k = hasOverride ? l.kOverride : mat.k;
    if (!(k > 0)) return null;
    if (mat.isAir) { out.push({ resistance: 1 / k }); continue; }
    const thk = parseFloat(l.thickness) / 1000;   // mm -> m
    if (!(thk > 0)) return null;
    if (mat.rho == null || mat.c == null) return null;
    out.push({ thickness: thk, k, rho: mat.rho, cp: mat.c });
  }
  return out.length ? out : null;
}

/** One-dimensional finite-volume mesh over the resolved stack. A
 *  resistance-only layer is represented as a slab of still air of the same
 *  resistance; its heat capacity is a few J/(m^2*K), i.e. negligible, which
 *  keeps a single code path for films, cavities and solids. */
function ctsGrid(resolved) {
  const cells = [];
  for (const L of resolved) {
    const th = (L.resistance !== undefined) ? CTS3_STILL_AIR_K * L.resistance : L.thickness;
    const k  = (L.resistance !== undefined) ? CTS3_STILL_AIR_K : L.k;
    const rc = (L.resistance !== undefined) ? CTS3_STILL_AIR_RC : L.rho * L.cp;
    if (!(th > 0 && k > 0)) return null;
    const dx = th / CTS3_CELLS_PER_LAYER;
    for (let j = 0; j < CTS3_CELLS_PER_LAYER; j++) cells.push({ dx, k, rc });
  }
  return cells.length ? cells : null;
}

/**
 * Compute the 24-value CTS series (%, sums to 100) for a layered assembly.
 *
 * Replaced 16 Aug 2026. The previous solver marched a triangular pulse to
 * steady-periodic and read the inside-face flux. It agreed with the method
 * below to ~0.03 percentage points on ordinary assemblies, but on the one
 * construction for which an independent unrounded reference exists it was out
 * by up to 0.63 pp (mean 0.39 pp over the three published hours), whereas this
 * method is out by at most 0.017 pp (mean 0.011 pp). The code comment on the
 * old solver said it had never been checked against a published case
 * number-for-number; it has now, and this is the result.
 *
 * Method: drive the outside face with a unit triangular temperature pulse,
 * record the hourly flux leaving the inside face, and fold that series onto a
 * 24-hour cycle. Those folded values ARE the periodic cross response factors;
 * their sum is the steady-state U-factor, and normalising by that sum gives
 * the CTS. The U identity is checked on every call — it is an exact property
 * of the physics (U = 1/sum(R)), so a mesh or boundary error shows up
 * immediately instead of hiding inside a normalised series.
 *
 * @param {Array<{material:string, thickness:(number|string)}>} layers
 * @returns {{cts:number[], converged:boolean, cycles:number, uWm2K:number, uExactWm2K:number, uRelError:number}|null}
 *          null if the assembly can't be solved (see ctsBuildMesh)
 */
function computeCtsFromLayers(layers) {
  // Keep the original gate: an assembly with no air film on one or both ends
  // has no film coefficient and must be refused, not silently assumed.
  if (!ctsBuildMesh(layers)) return null;
  const resolved = ctsResolveLayers(layers);
  if (!resolved) return null;
  const cells = ctsGrid(resolved);
  if (!cells) return null;

  const n = cells.length, dt = CTS3_DT;
  const T = new Float64Array(n);
  const G = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i + 1 < n; i++)
    G[i] = 2 * cells[i].k * cells[i + 1].k /
           (cells[i].dx * cells[i + 1].k + cells[i + 1].dx * cells[i].k);
  const lower = new Float64Array(n), diag = new Float64Array(n),
        upper = new Float64Array(n), rhs = new Float64Array(n),
        x = new Float64Array(n), cp = new Float64Array(n), dp = new Float64Array(n);
  const leftDirect  = cells[0].k / (0.5 * cells[0].dx);
  const rightDirect = cells[n - 1].k / (0.5 * cells[n - 1].dx);
  const perHour = Math.round(3600 / dt);
  const far = [];
  let lastFar = 0, decayed = false;

  for (let step = 1; step <= CTS3_RESPONSE_STEPS; step++) {
    const t = step * dt;
    if (!(t > 7200 && Math.abs(lastFar) < CTS3_CUTOFF)) {
      const drive = ctsTriangularPulse(t);
      for (let i = 0; i < n; i++) {
        const store = cells[i].rc * cells[i].dx / dt;
        diag[i] = store; rhs[i] = store * T[i]; lower[i] = 0; upper[i] = 0;
      }
      for (let i = 0; i + 1 < n; i++) {
        const g = G[i];
        diag[i] += g; diag[i + 1] += g; upper[i] -= g; lower[i + 1] -= g;
      }
      diag[0] += leftDirect;  rhs[0] += leftDirect * drive;
      diag[n - 1] += rightDirect;
      // Thomas algorithm
      cp[0] = n > 1 ? upper[0] / diag[0] : 0;
      dp[0] = rhs[0] / diag[0];
      for (let i = 1; i < n; i++) {
        const den = diag[i] - lower[i] * cp[i - 1];
        cp[i] = i + 1 < n ? upper[i] / den : 0;
        dp[i] = (rhs[i] - lower[i] * dp[i - 1]) / den;
      }
      x[n - 1] = dp[n - 1];
      for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
      T.set(x);
      lastFar = rightDirect * T[n - 1];
    } else if (!decayed) { decayed = true; }
    if (step % perHour === 0) far.push(lastFar);
  }

  const cross = new Float64Array(24);
  for (let h = 0; h < 24; h++)
    for (let d = 0; d < 8; d++) { const i = h + 24 * d; if (i < far.length) cross[h] += far[i]; }

  let U = 0; for (let h = 0; h < 24; h++) U += cross[h];
  if (!(U > 0)) return null;   // degenerate assembly — refuse rather than divide by ~0

  // Exact steady-state U from the layer resistances. The folded cross response
  // must reproduce it; if it does not, the mesh or the boundary treatment is
  // wrong and the normalised CTS would hide that.
  let Rtot = 0;
  for (const L of resolved) Rtot += (L.resistance !== undefined) ? L.resistance : L.thickness / L.k;
  const uExact = Rtot > 0 ? 1 / Rtot : NaN;
  const uRelError = isFinite(uExact) ? Math.abs(U - uExact) / uExact : NaN;

  const cts = Array.from(cross, v => 100 * v / U);
  // "converged" is decided by the U identity alone. If the response window had
  // truncated a meaningful tail, the folded cross response would sum to LESS
  // than 1/sum(R); matching it to ~1e-7 therefore proves nothing was lost.
  // The decay flag is reported for diagnostics but is deliberately NOT part of
  // the test: heavy masonry is still emitting flux above the 1e-9 cutoff at the
  // end of the window while its U identity is already exact to 4e-8, so gating
  // on decay would raise a false alarm on every heavy assembly.
  const converged = isFinite(uRelError) && uRelError < CTS3_U_TOL;
  return { cts, converged, cycles: far.length, uWm2K: U, uExactWm2K: uExact,
           uRelError, responseDecayed: decayed };
}


// ---------- Top-level: one wall or roof, 24-hour cooling load ----------

/**
 * @param {object} p
 * @param {'wall'|'roof'} p.kind
 * @param {number} p.uFactor        - W/m²K (computed from layers — never looked up)
 * @param {number} p.area           - m²
 * @param {number} p.roomTemp       - °C, constant (matches source: E13 = $B$6, not hour-varying)
 * @param {number[]} p.outdoorTempHourly24 - °C, 24 values (hour 1..24)
 * @param {number} p.alphaHo        - 0.026 (light) or 0.052 (dark)
 * @param {number[]} p.cts24        - CTS % series for the wall/roof (computeCtsFromLayers() output, or getStoredCts())
 * @param {number[]} p.nsRts24      - NS-RTS % series for the room (getSelectedNsRts(), live-computed)
 * @param {object} p.solar          - { lat, lon, hemisphere, tz, taub, taud, surfaceAzimuth, tilt, year, month, day }
 * @returns {{ hourly: {heatInput,heatGain,convective,radiantInput,radiantCoolingLoad,totalCoolingLoad,Et,solAirTemp}[], correction:number, convFraction:number }}
 */
function calcOpaqueSurfaceCoolingLoad24(p) {
  const correction = p.kind === 'roof' ? 4 : 0;               // confirmed constant
  const convFraction = p.kind === 'roof' ? 0.40 : 0.54;        // confirmed constant
  const radFraction = 1 - convFraction;

  const n = dayOfYear(p.solar.year, p.solar.month, p.solar.day);

  const heatInputArr = new Array(24);
  const perHour = new Array(24);

  for (let h = 1; h <= 24; h++) {
    const { Et } = surfaceIrradiance(
      h, n, p.solar.lat, p.solar.lon, p.solar.hemisphere, p.solar.tz,
      p.solar.taub, p.solar.taud, p.solar.surfaceAzimuth, p.solar.tilt
    );
    const to = p.outdoorTempHourly24[h - 1];
    const te = solAirTemp(to, p.alphaHo, Et, correction);
    const q = heatInput(p.uFactor, p.area, te, p.roomTemp);
    heatInputArr[h - 1] = q;
    perHour[h - 1] = { Et, solAirTemp: te, heatInput: q };
  }

  const heatGain24 = convolve24(heatInputArr, p.cts24);         // Wa1_CTS Wall!AC3:AC26
  const radiantInput24 = heatGain24.map((g) => g * radFraction); // Wa1_Total_CL!J13
  const convective24 = heatGain24.map((g) => g * convFraction);  // Wa1_Total_CL!I13
  const radiantCoolingLoad24 = convolve24(radiantInput24, p.nsRts24); // Wa1_NS-RTS!AC3:AC26

  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const totalCoolingLoad = radiantCoolingLoad24[h] + convective24[h]; // Wa1_Total_CL!M13
    hourly.push({
      ...perHour[h],
      heatGain: heatGain24[h],
      convective: convective24[h],
      radiantInput: radiantInput24[h],
      radiantCoolingLoad: radiantCoolingLoad24[h],
      totalCoolingLoad,
    });
  }

  return { hourly, correction, convFraction };
}

// ---------- Full 12-month wrapper ----------

/**
 * Run calcOpaqueSurfaceCoolingLoad24 for all 12 months, using the standard
 * representative day = the 21st of each month (confirmed from
 * Wa1_Et!B3 = DATE(YEAR(TODAY()), C3, 21) — ezyRTS always uses day 21).
 * Outdoor temperature for each month comes from weather_hourly.js's
 * generateHourlyOutdoorTempAllMonths(), driven by the same WeatherData
 * shape produced by weather_parser.js.
 *
 * @param {object} p - same shape as calcOpaqueSurfaceCoolingLoad24's `p`,
 *   EXCEPT: no `outdoorTempHourly24` (generated internally per month) and
 *   `solar` omits `year`/`month`/`day` (fixed to day 21, month = loop index);
 *   instead pass `p.weatherData` (the shared WeatherData object) and
 *   `p.year` (any year works — only used for leap-year day counting).
 * @returns {{ month:number, hourly:object[] }[]} 12 entries, Jan..Dec
 */
function calcOpaqueSurfaceCoolingLoad12Month(p) {
  // Lazy-require to avoid a hard dependency if this file is used standalone
  // in an environment without weather_hourly.js (e.g. a quick unit test).
  // (require-destructure stripped for bundle — names already global in this file)

  const allMonthsTemp = generateHourlyOutdoorTempAllMonths(p.weatherData);
  const results = [];
  for (let m = 1; m <= 12; m++) {
    const monthResult = calcOpaqueSurfaceCoolingLoad24({
      ...p,
      outdoorTempHourly24: allMonthsTemp[m - 1],
      solar: { ...p.solar, year: p.year || 2026, month: m, day: 21 },
    });
    results.push({ month: m, ...monthResult });
  }
  return results;
}



// ===== engine_window.js =====
// ============================================================
// ezyRTS Web — Window Solar Heat Gain + Conduction Engine
//
// Formulas extracted DIRECTLY from ezyRTS.xlsm — TWO parallel sheet sets
// exist in the source, selected by the "Shading" input (Input!G35):
//   Unshaded: Wi1_Window, Wi1_Output, Wi1_S-RTS, Wi1_NS-RTS
//   Shaded:   Wib1_Window, Wib1_Output, Wib1_NS-RTS  (NO S-RTS sheet exists
//             for the shaded case — confirmed by its absence in the workbook)
// Verified formula-for-formula, per the confirmed working rule: follow the
// formulas exactly, ignore header labels when they disagree with the formula.
//
// UNSHADED chain per hour:
//   1. Solar position + Etb/Etd/Etr — ASHRAE clear-sky model (same as engine_conduction.js).
//   2. qb = A * SHGC(θ) * IAC_beam * Etb        IAC_beam = (Eb>0 AND cosθ>0) ? 1 : 0
//   3. qd = A * (Etd+Etr) * SHGC_hemis * IACD    IACD = 1 always — CONFIRMED FIX (see below)
//   4. qcond = U * A * (to - trc)                — instantaneous, no sol-air, no delay
//   5. qb -> Solar RTS (SRTS_Table) -> 100% radiant, no convective split
//   6. (qd+qcond) -> split by SHGC(θ)>0.5 ? 67%conv : 54%conv -> radiant part -> NS-RTS
//   7. Total = radiantFromBeam + radiantFromDiffCond + convective
//
// SHADED chain per hour (interior shading device, e.g. blinds/curtains):
//   2. qb = A * SHGC(θ) * IAC_beam * Etb          IAC_beam = geometry-valid ? 0.55 : 0
//   3. qd = A * (Etd+Etr) * SHGC_hemis * IACD     IACD = 0.4 always
//   4. qcond = same as unshaded
//   5. NO Solar RTS at all — qb + qd + qcond are ALL combined into one series,
//      split by the SAME SHGC(θ)>0.5 rule, radiant part -> NS-RTS only.
//
// CONFIRMED FIX (diffuse IAC gating): the source file's own qd formula, in
// BOTH the unshaded and shaded sheets, incorrectly gated diffuse gain on
// the surface facing the sun directly (cos θ>0) — the same condition
// beam requires. Diffuse sky radiation doesn't need that; only daylight
// matters, and Ed itself already goes to 0 at night. User confirmed and
// already fixed both in Excel and here: IACD = 1 (unshaded) / 0.4 (shaded),
// constant, no gating condition at all.
// ============================================================

// (require-destructure stripped for bundle — names already global in this file)

/**
 * SHGC(θ) via the Arasteh/Kohler/Griffith (2009) Simple Window Model
 * angular correlation — replaces the old linear interpolation between 6
 * tabulated angles (17 Aug 2026) with the exact formula the source data
 * was itself generated from: SHGC(θ) = SHGC(0) * normtau(θ), where
 * normtau(θ) = tau(θ)/tau(0) and tau is the curve's own 4th-order cosine
 * polynomial (see SHGC_CURVE_COEFFS above). Same θ>=90°->0 behavior as
 * before (Wi1_Window!P21's outer IF) — though the formula already gives
 * exactly 0 there on its own, since every curve's "a" coefficient is 0,
 * so cos(90°)=0 makes tau(90°)=0 regardless; the explicit check just
 * guards floating-point edge cases at θ slightly past 90°.
 * @param {object} glassEntry - one entry from SHGC_TABLE, {name, shgc0, curve}
 * @param {number} thetaDeg   - surface incidence angle, degrees
 */
function shgcAtAngle(glassEntry, thetaDeg) {
  if (thetaDeg >= 90) return 0;
  return glassEntry.shgc0 * shgcNormTau(glassEntry.curve, thetaDeg);
}

/**
 * Full per-hour window irradiance + solar heat gain calc.
 * @param {boolean} shaded - false: Wi1_Window formulas (unshaded).
 *   true: Wib1_Window formulas (with interior shading) — IAC values differ
 *   and the beam term is NOT routed through Solar RTS (see calcWindowCoolingLoad24).
 */
function windowHourGain(hour, n, solar, glassEntry, area, uFactor, roomTemp, to, shaded) {
  const DEG = Math.PI / 180;
  const toRad = (d) => d * DEG;
  const toDeg = (r) => r / DEG;

  const g1 = toRad(360 * n / 365), g2 = toRad(720 * n / 365);
  const eqTime = 2.2918 * (0.0075 + 0.1868 * Math.cos(g1) - 3.2077 * Math.sin(g1)
    - 1.4615 * Math.cos(g2) - 4.089 * Math.sin(g2));
  // CONFIRMED FIX (same as engine_conduction.js's solarDeclination/
  // extraterrestrialIrradiance): the source file's declination and E0
  // formulas use a day-count reference one day ahead of the Equation of
  // Time formula's reference (DATE(year,1,0) vs DATE(year,1,1)) — a real
  // inconsistency in ezyRTS.xlsm itself. n+1 matches it.
  const delta = 23.45 * Math.sin(2 * Math.PI * (n + 1 + 284) / 365);
  const E0 = (Math.cos(2 * Math.PI * (n + 1 - 3) / 365) * 0.033 + 1) * 1367;
  const ab = 1.454 - 0.406 * solar.taub - 0.268 * solar.taud + 0.021 * solar.taub * solar.taud;
  const ad = 0.507 + 0.205 * solar.taub - 0.08 * solar.taud - 0.19 * solar.taub * solar.taud;
  const LSM = solar.tz * 15;
  const lonSigned = solar.hemisphere === 'W' ? -solar.lon : solar.lon;
  let AST = hour + eqTime / 60 + (lonSigned - LSM) / 15;
  AST = ((AST % 24) + 24) % 24;
  const H = 15 * (AST - 12);
  const sinBeta = Math.cos(toRad(solar.lat)) * Math.cos(toRad(delta)) * Math.cos(toRad(H))
    + Math.sin(toRad(solar.lat)) * Math.sin(toRad(delta));
  const beta = toDeg(Math.asin(Math.max(-1, Math.min(1, sinBeta))));
  // Solar azimuth — SAME atan2 argument-order fix as engine_conduction.js (see comment there).
  const phi = toDeg(Math.atan2(
    Math.sin(toRad(H)) * Math.cos(toRad(delta)),
    Math.cos(toRad(H)) * Math.cos(toRad(delta)) * Math.sin(toRad(solar.lat)) - Math.sin(toRad(delta)) * Math.cos(toRad(solar.lat))
  ));
  const m = beta <= 0 ? 38 : 1 / (Math.sin(toRad(beta)) + 0.50572 * Math.pow(6.07995 + beta, -1.6364));
  const Eb = beta < 0 ? 0 : E0 * Math.exp(-solar.taub * Math.pow(m, ab));
  const Ed = beta < 0 ? 0 : E0 * Math.exp(-solar.taud * Math.pow(m, ad));
  const gamma = (((phi - solar.surfaceAzimuth + 180) % 360) + 360) % 360 - 180;
  const cosTheta = Math.cos(toRad(beta)) * Math.cos(toRad(gamma)) * Math.sin(toRad(solar.tilt))
    + Math.sin(toRad(beta)) * Math.cos(toRad(solar.tilt));
  const theta = toDeg(Math.acos(Math.max(-1, Math.min(1, cosTheta))));
  const Etb = Math.cos(toRad(theta)) > 0 ? Eb * Math.cos(toRad(theta)) : 0;
  const Y = Math.max(0.45, 0.55 + 0.437 * Math.cos(toRad(theta)) + 0.313 * Math.pow(Math.cos(toRad(theta)), 2));
  const Etd = solar.tilt <= 90
    ? Ed * (Y * Math.sin(toRad(solar.tilt)) + Math.cos(toRad(solar.tilt)))
    : Ed * Y * Math.sin(toRad(solar.tilt));
  const Etr = (Eb * Math.sin(toRad(beta)) + Ed) * 0.2 * (1 - Math.cos(toRad(solar.tilt))) / 2;

  const beamGeomValid = (Eb > 0 && Math.cos(toRad(theta)) > 0);

  // IAC (beam) — Wi1_Window!Q21 (unshaded: 1) / Wib1_Window!Q21 (shaded: 0.55).
  // Both versions gate on the surface directly facing the sun — that gating
  // is correct for BEAM (confirmed; only diffuse's gating was the bug).
  const iacBeam = beamGeomValid ? (shaded ? 0.55 : 1) : 0;

  // IAC (diffuse) — CONFIRMED FIX per user (already corrected in the Excel
  // file too): IACD = 0.4 constant for the shaded case (1 constant for
  // unshaded, set above) — no gating condition at all. Safe at night
  // because Ed (diffuse irradiance) is already 0 whenever the sun is below
  // the horizon, so qd naturally goes to 0 without needing an extra flag.
  const iacDiffuse = shaded ? 0.4 : 1;

  const shgcTheta = shgcAtAngle(glassEntry, theta);       // Wi1_Window!P21 / Wib1_Window!P21 (same formula)
  const shgcHemis = shgcHemispherical(glassEntry.shgc0, glassEntry.curve); // Hemis SHGC (same for both), live-computed 17 Aug 2026

  const qb = area * shgcTheta * iacBeam * Etb;              // Wi1_Window!R21 / Wib1_Window!S21
  const qd = area * (Etd + Etr) * shgcHemis * iacDiffuse;   // Wi1_Window!T21 / Wib1_Window!U21
  const qcond = uFactor * area * (to - roomTemp);           // same for both — no sol-air, no delay

  return { theta, Etb, Etd, Etr, shgcTheta, shgcHemis, qb, qd, qcond };
}

/**
 * 24-hour window cooling load for one month.
 * @param {object} p
 * @param {number} p.area, p.uFactor, p.roomTemp
 * @param {object} p.glassEntry     - SHGC_TABLE entry {name, shgc:{...}}
 * @param {boolean} p.shaded        - false: Wi1_* formulas. true: Wib1_* formulas (interior shading)
 * @param {number[]} p.outdoorTempHourly24
 * @param {number[]} p.srts24       - Solar RTS % series — ONLY used when shaded=false
 * @param {number[]} p.nsRts24      - Nonsolar RTS % series — used in both cases
 * @param {object} p.solar          - { lat, lon, hemisphere, tz, taub, taud, surfaceAzimuth, tilt, year, month, day }
 */
function calcWindowCoolingLoad24(p) {
  const n = dayOfYear(p.solar.year, p.solar.month, p.solar.day);
  const perHour = new Array(24);

  for (let h = 1; h <= 24; h++) {
    const to = p.outdoorTempHourly24[h - 1];
    perHour[h - 1] = windowHourGain(h, n, p.solar, p.glassEntry, p.area, p.uFactor, p.roomTemp, to, p.shaded);
  }

  const hourly = [];

  if (!p.shaded) {
    // UNSHADED (Wi1_Output): qb -> Solar RTS, 100% radiant, no conv/rad split.
    // (qd + qcond) -> split by SHGC(θ) threshold -> radiant part -> NS-RTS.
    const qbArr = perHour.map((r) => r.qb);
    const qdCondArr = perHour.map((r) => r.qd + r.qcond); // Wi1_Output!H14 = F14+G14
    const radiantFromBeam24 = convolve24(qbArr, p.srts24);  // Wi1_S-RTS!AC3..

    const convFraction24 = perHour.map((r) => (r.shgcTheta > 0.5 ? 0.67 : 0.54));
    const convective24 = qdCondArr.map((v, i) => v * convFraction24[i]);
    const radiantInput24 = qdCondArr.map((v, i) => v * (1 - convFraction24[i]));
    const radiantFromDiffCond24 = convolve24(radiantInput24, p.nsRts24); // Wi1_NS-RTS!AC3..

    for (let h = 0; h < 24; h++) {
      const totalCoolingLoad = radiantFromBeam24[h] + radiantFromDiffCond24[h] + convective24[h]; // Wi1_Output!N14
      hourly.push({
        ...perHour[h], convFraction: convFraction24[h], convective: convective24[h],
        radiantFromBeam: radiantFromBeam24[h], radiantFromDiffCond: radiantFromDiffCond24[h],
        totalCoolingLoad,
      });
    }
  } else {
    // SHADED (Wib1_Output): NO Solar RTS at all (confirmed — no Wib1_S-RTS
    // sheet exists in the source file). qb + qd + qcond are ALL combined
    // into one series, split by the SAME SHGC(θ) threshold rule, and the
    // radiant part goes through ordinary NS-RTS only.
    const combined24 = perHour.map((r) => r.qb + r.qd + r.qcond); // Wib1_Output!H14 = F14+G14+S21(qb)
    const convFraction24 = perHour.map((r) => (r.shgcTheta > 0.5 ? 0.67 : 0.54));
    const convective24 = combined24.map((v, i) => v * convFraction24[i]);
    const radiantInput24 = combined24.map((v, i) => v * (1 - convFraction24[i]));
    const radiantCL24 = convolve24(radiantInput24, p.nsRts24); // Wib1_NS-RTS!AC3..

    for (let h = 0; h < 24; h++) {
      const totalCoolingLoad = radiantCL24[h] + convective24[h]; // Wib1_Output!N14 (E14 term is blank/0 in source)
      hourly.push({
        ...perHour[h], convFraction: convFraction24[h], convective: convective24[h],
        radiantFromBeam: 0, radiantFromDiffCond: radiantCL24[h],
        totalCoolingLoad,
      });
    }
  }

  return { hourly };
}

/** 12-month wrapper, same pattern as calcOpaqueSurfaceCoolingLoad12Month. Uses day 21 of each month. */
function calcWindowCoolingLoad12Month(p) {
  // (require-destructure stripped for bundle — names already global in this file)
  const allMonthsTemp = generateHourlyOutdoorTempAllMonths(p.weatherData);
  const results = [];
  for (let m = 1; m <= 12; m++) {
    const monthResult = calcWindowCoolingLoad24({
      ...p, // includes p.shaded
      outdoorTempHourly24: allMonthsTemp[m - 1],
      solar: { ...p.solar, year: p.year || 2026, month: m, day: 21 },
    });
    results.push({ month: m, ...monthResult });
  }
  return results;
}



// ===== engine_internal_loads.js =====
// ============================================================
// ezyRTS Web — Internal Loads Engine (Occupants, Lighting, Equipment, Miscellaneous)
//
// Formulas extracted DIRECTLY from ezyRTS.xlsm (O_input/O_Output,
// L_input/L_Output, E_input/E_Output, Misc) — verified formula-for-
// formula, per the confirmed rule: follow the formula exactly.
//
// CORRECTED (per user, 2026-08-08): the source file multiplied usage% TWICE
// in the radiant term for Lighting, and in BOTH the convective and radiant
// terms for Equipment (verified consistent across those two independent
// sheets in the source). This engine uses the corrected, single-multiplication
// form for all four load types, matching Occupants' (always-correct) pattern:
//   Occupants / Lighting / Equipment: radiantInput = usage% × heatGain × radiantFrac
//   Misc: no split at all — 100% instantaneous, no RTS convolution
// ============================================================

// (require-destructure stripped for bundle — names already global in this file)

// ---------- Reference tables ----------
// ACTIVITY_LEVELS — replaced 15 Aug 2026 with a 13-activity Met-based
// dataset supplied by the user (Reclining through Walking 6 km/h),
// replacing the old ASHRAE-Fundamentals-Table-1 "activity/application"
// list. radiantFrac here is the source's own %Radiant column (radiant
// share of SENSIBLE heat only) confirmed directly from the user, not
// derived or estimated — do not confuse with %Sensible (Sensible/Total),
// a different ratio the user also supplied but which this engine has no
// use for. `met` (metabolic rate) is new and not consumed by any
// calculation yet — kept for reference/future use per the user's
// instruction. Sensible/Latent per person, W; radiantFrac (convFrac =
// 1-radiantFrac).
const ACTIVITY_LEVELS = [{"name": "Reclining", "sensible": 66, "latent": 18, "radiantFrac": 0.56, "met": 0.8}, {"name": "Seated quiet", "sensible": 75, "latent": 19, "radiantFrac": 0.56, "met": 0.9}, {"name": "Seated typing", "sensible": 82, "latent": 23, "radiantFrac": 0.56, "met": 1.0}, {"name": "Seated filing", "sensible": 86, "latent": 40, "radiantFrac": 0.52, "met": 1.2}, {"name": "Standing quiet", "sensible": 84, "latent": 21, "radiantFrac": 0.57, "met": 1.0}, {"name": "Standing typing", "sensible": 83, "latent": 32, "radiantFrac": 0.56, "met": 1.1}, {"name": "Standing filing", "sensible": 89, "latent": 47, "radiantFrac": 0.51, "met": 1.3}, {"name": "Walking 1 km/h", "sensible": 100, "latent": 88, "radiantFrac": 0.43, "met": 1.8}, {"name": "Walking 2 km/h", "sensible": 107, "latent": 113, "radiantFrac": 0.41, "met": 2.1}, {"name": "Walking 3 km/h", "sensible": 114, "latent": 148, "radiantFrac": 0.38, "met": 2.5}, {"name": "Walking 4 km/h", "sensible": 122, "latent": 192, "radiantFrac": 0.36, "met": 3.0}, {"name": "Walking 5 km/h", "sensible": 134, "latent": 264, "radiantFrac": 0.33, "met": 3.8}, {"name": "Walking 6 km/h", "sensible": 143, "latent": 370, "radiantFrac": 0.3, "met": 4.9}];

// Lighting fixture type -> {radiantFrac, convFrac} — L_input!B38:D41 (confirmed
// 4 real items, not 3 — the mockup's original placeholder was missing one).
const LIGHTING_FIXTURES = [
  { name: 'Downlights (CFL & Incandescent)', radiantFrac: 0.98, convFrac: 0.02 },
  { name: 'Fluorescents (Recessed / Suspended)', radiantFrac: 0.62, convFrac: 0.38 },
  { name: 'LEDs (High-Bay / Pendant / High-Efficacy Troffer / Color Tuning)', radiantFrac: 0.48, convFrac: 0.52 },
  { name: 'LEDs (Troffer Partial Aperture / Uniform Diffuser / Retrofit / Downlight)', radiantFrac: 0.29, convFrac: 0.71 },
];

// ---------- Occupants ----------
/**
 * @param {object} p { count, activityLevelIndex, usageProfile24 (0-1, 24 values), nsRts24 }
 */
function calcOccupantLoad24(p) {
  const act = ACTIVITY_LEVELS[p.activityLevelIndex];
  const latent24 = new Array(24), convective24 = new Array(24), radiantInput24 = new Array(24);
  for (let h = 0; h < 24; h++) {
    const usage = p.usageProfile24[h];
    latent24[h] = usage * p.count * act.latent;                                  // O_Output!C4
    convective24[h] = usage * p.count * act.sensible * (1 - act.radiantFrac);    // O_Output!D4
    radiantInput24[h] = usage * p.count * act.sensible * act.radiantFrac;        // O_Output!E4
  }
  const radiantCL24 = convolve24(radiantInput24, p.nsRts24);                     // O_NS-RTS!AC3..
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const sensible = radiantCL24[h] + convective24[h];    // O_Output!H4
    const total = radiantCL24[h] + (latent24[h] + convective24[h]); // O_Output!I4
    hourly.push({ latent: latent24[h], convective: convective24[h], radiantCoolingLoad: radiantCL24[h], sensible, total });
  }
  return { hourly };
}

// ---------- Lighting ----------
/**
 * @param {object} p { watt, fixtureIndex, usageProfile24, nsRts24 }
 */
function calcLightingLoad24(p) {
  const fx = LIGHTING_FIXTURES[p.fixtureIndex];
  const heatGain24 = new Array(24), convective24 = new Array(24), radiantInput24 = new Array(24);
  for (let h = 0; h < 24; h++) {
    const usage = p.usageProfile24[h];
    heatGain24[h] = p.watt * usage;                                    // L_Output!E4 (Total 100%)
    convective24[h] = p.watt * fx.convFrac * usage;                    // L_Output!F4
    // FIXED per user: usage% multiplied only once (matches convective24's
    // pattern and standard practice), not twice as the source file did.
    radiantInput24[h] = fx.radiantFrac * heatGain24[h];
  }
  const radiantCL24 = convolve24(radiantInput24, p.nsRts24);
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const total = radiantCL24[h] + convective24[h]; // L_Output!J4
    hourly.push({ heatGain: heatGain24[h], convective: convective24[h], radiantCoolingLoad: radiantCL24[h], total });
  }
  return { hourly };
}

// ---------- Equipment ----------
/**
 * @param {object} p { sensibleW, latentW, coolingTypeIndex, usageProfile24, nsRts24 }
 * Cooling-type fraction table — E_input!A33:C36 (confirmed: column B = "Radiative",
 * column C = "Convective" — labels DO match formula usage here, unlike Wall's split).
 */
const EQUIPMENT_COOLING_TYPES = [
  { name: 'Equipment with cooling fan', radiantFrac: 0.1, convFrac: 0.9 },
  { name: 'Equipment without cooling fan', radiantFrac: 0.3, convFrac: 0.7 },
  { name: 'Equipment with exhaust hood', radiantFrac: 0.3, convFrac: 0 },
  { name: 'Motor', radiantFrac: 0.5, convFrac: 0.5 },
];

function calcEquipmentLoad24(p) {
  const ct = EQUIPMENT_COOLING_TYPES[p.coolingTypeIndex];
  const heatGain24 = new Array(24), convective24 = new Array(24), radiantInput24 = new Array(24);
  for (let h = 0; h < 24; h++) {
    const usage = p.usageProfile24[h];
    heatGain24[h] = usage * p.sensibleW;                              // E_Output!F4
    // FIXED per user: usage% multiplied only once (source file's G4/H4 each
    // multiplied by an extra usage% on top of F4, which already had one).
    convective24[h] = ct.convFrac * heatGain24[h];                    // E_Output!G4
    radiantInput24[h] = ct.radiantFrac * heatGain24[h];                // E_Output!H4
  }
  const radiantCL24 = convolve24(radiantInput24, p.nsRts24);
  const latent24 = p.usageProfile24.map((u) => u * p.latentW);
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const total = radiantCL24[h] + convective24[h] + latent24[h];
    hourly.push({ heatGain: heatGain24[h], convective: convective24[h], radiantCoolingLoad: radiantCL24[h], latent: latent24[h], total });
  }
  return { hourly };
}

// ---------- Miscellaneous ----------
/** No RTS split at all — 100% instantaneous (Misc!F8/G8). */
function calcMiscLoad24(p) {
  const hourly = p.usageProfile24.map((usage) => ({
    sensible: usage * p.sensibleW,
    latent: usage * p.latentW,
    total: usage * p.sensibleW + usage * p.latentW,
  }));
  return { hourly };
}



// ===== engine_outdoor_air.js =====
// ============================================================
// ezyRTS Web — Outdoor Air Load Engine
//
// Formulas extracted DIRECTLY from ezyRTS.xlsm (OA_input, OA_output, and
// 'Usage Profile and Outdoor' for the hourly WB→RH derivation).
// Unlike every other component, Outdoor Air load is NOT put through
// CTS/RTS at all — it's added straight to the room load, 100%
// instantaneous, both sensible and latent (confirmed: OA_output!D5,G5
// have no NS-RTS/S-RTS reference anywhere in the sheet).
// ============================================================

/** Exact ASHRAE (Hyland-Wexler) saturation pressure of water vapor, kPa.
 *  T in °C. Confirmed from 'Usage Profile and Outdoor'!I38 — matches this
 *  precisely (NOT the simpler Magnus-form approximation used earlier; this
 *  exact formula matters because Outdoor Air's %RH derivation is sensitive
 *  to it). */
function pwsExact(Tc) {
  const Tk = Tc + 273.15;
  return Math.exp(
    -5800.2206 / Tk + 1.3914993 - 0.048640239 * Tk + 0.000041764768 * Tk * Tk
    - 0.000000014452093 * Tk * Tk * Tk + 6.5459673 * Math.log(Tk)
  ) / 1000;
}

/** Saturation pressure — kept as the simpler Magnus-form for humidityRatio()
 *  callers that don't need Hyland-Wexler precision (kept for compatibility). */
function pws(T) {
  return 0.61078 * Math.exp(17.2694 * T / (T + 237.3));
}

/** Humidity ratio (g/kg dry air) from dry-bulb T(°C), RH (0-1 fraction), and
 *  atmospheric pressure P (kPa). Matches OA_output!F5/F3 formula exactly. */
function humidityRatio(T, rhFrac, pressureKPa) {
  const p = pws(T);
  return 622 * (rhFrac * p) / (pressureKPa - rhFrac * p);
}

/** Inverse of humidityRatio() — %RH (0-1 fraction) from dry-bulb T(°C),
 *  humidity ratio W (g/kg), and atmospheric pressure (kPa). Used for the
 *  psychrometric chart's point labels (Mixed/Supply points are computed
 *  as (T,W) pairs, so their %RH needs to be derived back out for display). */
function rhFromHumidityRatio(T, W_gkg, pressureKPa) {
  const p = pws(T);
  return W_gkg * pressureKPa / (p * (622 + W_gkg));
}

/** Atmospheric pressure at elevation, kPa. (OA_output!A3 = OA_input!B5) */
function atmosphericPressure(elevM) {
  return 101.325 * Math.pow(1 - 2.25577e-5 * elevM, 5.2559);
}

/* ===== Apparatus Dew Point (Tadp) and the supply air temperature =====
 *
 * Ported from the workbook's own Module2.Solve_Tadp_VBA_0p1C_Fast, and using
 * the identical psychrometric formulas (Hyland-Wexler saturation pressure,
 * 0.62198 humidity ratio, 1.006/2501/1.805 enthalpy).
 *
 * Tadp is the point where the RSHR line drawn from the room condition meets
 * the saturation curve, i.e. the T that satisfies
 *      1.006 × (DB − T) / (h_room − h_sat(T)) = RSHR
 *
 * TWO DELIBERATE DIFFERENCES FROM THE MACRO, both to get a correct answer:
 *
 *  1. The macro brackets [0, DB−0.5] and bisects immediately, only falling
 *     back to a sign-change scan if that bracket fails. But this residual
 *     changes sign more than once — it also flips where (h_room − h_sat)
 *     passes through zero, a few degrees below the room temperature — so
 *     bisecting the wide bracket can converge on that discontinuity instead
 *     of the real root. Here the sign-change scan runs FIRST and the lowest
 *     crossing is taken, which is the physical one.
 *
 *  2. The macro stops at 0.1°C and rounds to 1 decimal. This resolves to
 *     0.001°C. On the workbook's own sample (DB 24, RH 50%, RSHR 0.87218)
 *     the macro left 12.7 in the sheet; the true root is 11.96, and
 *     substituting 12.7 back into the equation gives 0.078, not 0.
 */
function tadpResidual(t, DB, pressurePa, hRoom, rshr) {
  const pwsPa = pwsExact(t) * 1000;                 // pwsExact returns kPa
  const wAdp = 0.62198 * pwsPa / (pressurePa - pwsPa);
  const hAdp = 1.006 * t + wAdp * (2501 + 1.805 * t);
  const denom = hRoom - hAdp;
  // Above the point where the saturation enthalpy equals the room's, the
  // expression blows through infinity and comes back with the opposite sign.
  // That flip is a discontinuity, not a root — reporting the denominator lets
  // the caller reject it instead of bisecting onto a pole.
  return { f: 1.006 * (DB - t) / denom - rshr, denom: denom };
}

/**
 * @returns {{tadp:number, exact:boolean}|null} null when the RSHR line never
 *   reaches saturation — the workbook's "Unable to determine Tadp because the
 *   ERSHR line does not intersect the saturation curve" case, which happens
 *   when the latent load is high enough to make RSHR lower than any point on
 *   the curve can produce.
 */
function solveTadp(DB, rhFrac, pressureKPa, rshr) {
  if (!isFinite(DB) || !isFinite(rhFrac) || !isFinite(rshr) || rshr <= 0) return null;
  const P = pressureKPa * 1000;
  const pwRoom = rhFrac * pwsExact(DB) * 1000;
  const wRoom = 0.62198 * pwRoom / (P - pwRoom);
  const hRoom = 1.006 * DB + wRoom * (2501 + 1.805 * DB);

  const lo0 = 0, hi0 = DB - 0.5;
  if (hi0 <= lo0) return null;

  // Scan upward for a genuine sign change: both ends must sit on the same side
  // of the pole (denominator keeping one sign), otherwise the flip is the
  // discontinuity described in tadpResidual, not a solution. The scan also
  // stops at the pole — beyond it, saturation is warmer than the room, which
  // is not a coil condition at all.
  const STEP = 0.25;
  let prevT = lo0, prev = tadpResidual(lo0, DB, P, hRoom, rshr);
  let a = null, b = null;
  for (let t = lo0 + STEP; t <= hi0 + 1e-9; t += STEP) {
    const cur = tadpResidual(t, DB, P, hRoom, rshr);
    if (cur.denom <= 0) break;                    // reached the pole — stop here
    if (prev.f * cur.f < 0) { a = prevT; b = t; break; }
    prevT = t; prev = cur;
  }

  if (a === null) {
    // No crossing below the pole. Same fallback as the macro's BestFit_Tadp:
    // accept the closest approach only if it is within 0.01 of zero, otherwise
    // report failure rather than returning a number that isn't a solution.
    let bestT = lo0, bestAbs = Infinity;
    for (let t = lo0; t <= hi0; t += 0.1) {
      const c = tadpResidual(t, DB, P, hRoom, rshr);
      if (c.denom <= 0) break;
      const v = Math.abs(c.f);
      if (v < bestAbs) { bestAbs = v; bestT = t; }
    }
    return bestAbs <= 0.01 ? { tadp: bestT, exact: false } : null;
  }

  let fa = tadpResidual(a, DB, P, hRoom, rshr).f;
  for (let i = 0; i < 40 && (b - a) > 0.001; i++) {
    const m = (a + b) / 2;
    const fm = tadpResidual(m, DB, P, hRoom, rshr).f;
    if (fa * fm < 0) b = m; else { a = m; fa = fm; }
  }
  return { tadp: (a + b) / 2, exact: true };
}

/**
 * Hourly outdoor %RH (0-1 fraction) for one month — confirmed derivation
 * chain from 'Usage Profile and Outdoor'!E38:J38 (F38 = the %RH formula):
 *   1. WB(h) = designWB - mcwbr * PDR(h)/100        — SAME PDR-based shape
 *      as hourlyOutdoorTempForMonth, just using WB/MCWBR instead of DB/MDBR.
 *   2. Wswb = 0.621945 * Pws(WB) / (Patm - Pws(WB))  — humidity ratio AT
 *      saturation for the wet-bulb temperature.
 *   3. W = ((2501-2.326*WB)*Wswb - 1.006*(DB-WB)) / (2501+1.86*DB-4.186*WB)
 *      — the standard ASHRAE WB-based actual humidity ratio formula.
 *   4. RH = 100 * (W*Patm/(0.621945+W)) / Pws(DB)   — convert W back to %RH
 *      relative to saturation at the dry-bulb temperature.
 * Uses the EXACT Hyland-Wexler pwsExact(), matching the source formula's
 * own precision (not the simpler Magnus approximation).
 */
function hourlyOutdoorRHForMonth(designDB, mdbr, designWB, mcwbr, elevM) {
  const patmKPa = atmosphericPressure(elevM);
  const rh24 = [];
  for (let h = 0; h < 24; h++) {
    const pdr = PDR_PROFILE_24[h];
    const db = designDB - mdbr * pdr / 100;
    const wb = designWB - mcwbr * pdr / 100;
    const pwsWb = pwsExact(wb);
    const wsWb = 0.621945 * pwsWb / (patmKPa - pwsWb);
    const w = ((2501 - 2.326 * wb) * wsWb - 1.006 * (db - wb)) / (2501 + 1.86 * db - 4.186 * wb);
    const pwsDb = pwsExact(db);
    const pw = w * patmKPa / (0.621945 + w);
    const rhPct = 100 * pw / pwsDb;
    rh24.push(Math.max(0, Math.min(100, rhPct)) / 100); // clamp to a valid 0-1 fraction
  }
  return rh24;
}

/**
 * 24-hour Outdoor Air sensible + latent load, one month.
 * @param {object} p
 * @param {number} p.flowLs        - outdoor air flow rate, L/s (OA_input!B1)
 * @param {number} p.roomTemp      - indoor dry-bulb, °C (Ti)
 * @param {number} p.roomRH        - indoor RH, 0-1 fraction
 * @param {number} p.elevM         - site elevation, m
 * @param {number[]} p.outdoorTempHourly24 - °C, 24 values
 * @param {number[]} p.outdoorRH24 - 0-1 fraction, 24 values (use hourlyOutdoorRHForMonth to generate)
 * @param {number[]} p.usageProfile24 - 0-1, 24 values
 */
function calcOutdoorAirLoad24(p) {
  const pressureKPa = atmosphericPressure(p.elevM);
  const Wi = humidityRatio(p.roomTemp, p.roomRH, pressureKPa); // OA_output!F3

  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const to = p.outdoorTempHourly24[h];
    const rhOut = p.outdoorRH24[h];
    const usage = p.usageProfile24[h];
    // Wo uses the SAME elevation-adjusted pressureKPa as Wi (above) — physically
    // correct, since indoor and outdoor air are at the same site elevation and
    // therefore the same total atmospheric pressure. (A source spreadsheet was
    // cross-checked and found to hardcode standard sea-level pressure here
    // instead — confirmed to be a spreadsheet bug, not the correct physics, so
    // deliberately NOT replicated here. Only matters for elevated sites.)
    const Wo = humidityRatio(to, rhOut, pressureKPa); // OA_output!F5

    // Sensible: qs = 1.23 * L/s * (to - Ti) * usage%   — OA_output!D5
    const sensible = 1.23 * p.flowLs * (to - p.roomTemp) * usage;
    // Latent: ql = 3010 * L/s * (Wo - Wi)/1000 * usage%  — OA_output!G5
    const latent = 3010 * p.flowLs * (Wo - Wi) / 1000 * usage;

    hourly.push({ sensible, latent, total: sensible + latent });
  }
  return { hourly };
}

/** Moist air enthalpy, kJ/kg dry air. h = 1.006*T + (W/1000)*(2501+1.86*T),
 *  W in g/kg. Matches OA_output!G3/J3 formula exactly. */
function moistAirEnthalpy(Tc, W_gPerKg) {
  return 1.006 * Tc + (W_gPerKg / 1000) * (2501 + 1.86 * Tc);
}

/**
 * Outdoor Air load WITH a Treatment System applied — confirmed formulas from
 * OA_output (columns I-K for DOAS, M-T for ERV, V-Y for HRV). The room's
 * usual raw-outdoor calc (calcOutdoorAirLoad24) is only correct for
 * treatmentType 'none'; DOAS/ERV/HRV change the AIR CONDITION entering the
 * room before the usual sensible/latent split, so they need this separate path.
 *
 * @param {object} p - same fields as calcOutdoorAirLoad24, PLUS:
 * @param {'none'|'doas'|'erv'|'hrv'} p.treatmentType
 * @param {number} [p.doasTemp]      - DOAS/PAU supply air temp, °C (only for 'doas')
 * @param {number} [p.doasRH]        - DOAS/PAU supply air RH, 0-1 fraction (only for 'doas')
 * @param {number} [p.tempEffPct]    - Temperature efficiency, 0-100 (for 'erv'/'hrv')
 * @param {number} [p.enthalpyEffPct] - Enthalpy efficiency, 0-100 (for 'erv' only)
 */
function calcOutdoorAirLoad24WithTreatment(p) {
  if (!p.treatmentType || p.treatmentType === 'none') return calcOutdoorAirLoad24(p);

  const pressureKPa = atmosphericPressure(p.elevM);
  const Wi = humidityRatio(p.roomTemp, p.roomRH, pressureKPa); // g/kg — room condition
  const hi = moistAirEnthalpy(p.roomTemp, Wi);

  if (p.treatmentType === 'doas') {
    // DOAS/PAU pre-conditions outdoor air to a FIXED supply condition before
    // it enters the room — confirmed: OA_output!J5(SH)/I5(TH)/K5(LH) use the
    // DOAS setpoint (Tinlet/RHinlet) directly, NOT the variable outdoor
    // condition, so (unlike every other path) this does not vary hour-to-hour.
    const Winlet = humidityRatio(p.doasTemp, p.doasRH, pressureKPa);
    const hinlet = moistAirEnthalpy(p.doasTemp, Winlet);
    const hourly = p.usageProfile24.map(usage => {
      const sensible = 1.23 * p.flowLs * (p.doasTemp - p.roomTemp) * usage;          // OA_output!J5
      const total = (hinlet - hi) * p.flowLs * 1.2 * usage;                          // OA_output!I5
      const latent = total - sensible;                                               // OA_output!K5
      return { sensible, latent, total: sensible + latent };
    });
    return { hourly };
  }

  // ERV/HRV recover heat (and, for ERV only, moisture) from room exhaust air,
  // reducing the effective temperature gap by tempEffPct — confirmed:
  // OA_output!M5(Tinlet) = To - tempEff×(To-Ti).
  const tempEff = (p.tempEffPct || 0) / 100;
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const to = p.outdoorTempHourly24[h];
    const rhOut = p.outdoorRH24[h];
    const usage = p.usageProfile24[h];
    // Raw outdoor Wo — same elevation-adjusted pressureKPa as Wi (see comment in calcOutdoorAirLoad24()).
    const Wo = humidityRatio(to, rhOut, pressureKPa);
    const qsRaw = 1.23 * p.flowLs * (to - p.roomTemp) * usage;      // raw outdoor sensible (untreated)
    const qlRaw = 3010 * p.flowLs * (Wo - Wi) / 1000 * usage;       // raw outdoor latent (untreated)

    const tInlet = to - tempEff * (to - p.roomTemp);                 // OA_output!M5
    const sensible = 1.23 * p.flowLs * (tInlet - p.roomTemp) * usage; // OA_output!N5

    let latent;
    if (p.treatmentType === 'erv') {
      // ERV also recovers moisture, capped by enthalpy efficiency —
      // confirmed: OA_output!R5 = MIN(rawTotal×(1-enthalpyEff), sensible(treated)+latentRaw)
      const enthalpyEff = (p.enthalpyEffPct || 0) / 100;
      const totalRaw = qsRaw + qlRaw;                                // OA_output!P5
      const upperBound = sensible + qlRaw;                           // OA_output!Q5
      const totalCapped = totalRaw * (1 - enthalpyEff);
      const total = totalCapped > upperBound ? upperBound : totalCapped; // OA_output!R5
      latent = total - sensible;                                     // OA_output!S5
    } else {
      // HRV: sensible-only recovery — latent passes through unchanged.
      latent = qlRaw;                                                // OA_output!X5
    }
    hourly.push({ sensible, latent, total: sensible + latent });
  }
  return { hourly };
}



// ===== engine_combine.js =====
// ============================================================
// ezyRTS Web — Final Combination Engine (Total Room Load + Peak Selection)
//
// Formulas extracted DIRECTLY from ezyRTS.xlsm (Output, Output1).
//
// CONFIRMED: ezyRTS itself does NOT scan all 12 months automatically —
// Output1's peak formula (`MATCH(MAX($AA$71:$AA$94),...)`) only finds
// the peak HOUR within whichever ONE month is currently selected as
// "Calculated Month". This engine extends that same per-hour MAX logic
// across all 12 months to find the true annual peak (hour + month),
// matching the auto-follow-peak-month behavior already built into the
// mockup UI.
//
// Markup order (confirmed from Output!E20:E22, applied to the SUM of
// all components, not per-component):
//   1. Duct Loss %      — applied to (sum of all components)
//   2. Fan Heat Gain %  — applied to (sum of all components + duct loss)
//   3. Overall Safety Factor % — applied to (sum of all components + duct loss + fan heat)
//   Design Total = sum of all components + duct loss + fan heat + safety factor
// ============================================================

/**
 * @param {object} components - per-component 12-month x 24-hour hourly results,
 *   each shaped like the engines' output: components.wall[monthIdx].hourly[h] = {totalCoolingLoad|total, ...}
 *   Every component array must be 12 (Jan..Dec) x 24 (hour 1..24).
 *   Expected keys: walls[], windows[], roofs[], ceilings[], partitions[], floors[]
 *   (each an array of components, each shaped [12][24] with .totalCoolingLoad and
 *   for windows also implicitly sensible-only, no separate latent), occupants[],
 *   lighting[], equipment[], miscellaneous[] (each [12][24] with .total, and for
 *   occupants/equipment/misc also .latent), outdoorAir ([12][24] with .sensible/.latent).
 * @param {object} safetyFactors - { ductLossPct, fanHeatGainPct, overallSafetyFactorPct }
 * @returns {{ perMonth: object[], peak: {month, hour, designTotal} }}
 */
function combineRoomLoad12Month(components, safetyFactors) {
  const perMonth = [];

  for (let m = 0; m < 12; m++) {
    const hourlySensible = new Array(24).fill(0);
    const hourlyLatent = new Array(24).fill(0);

    // Opaque surfaces (wall/roof/ceiling/partition/floor) — 100% sensible,
    // already convective+radiant combined in .totalCoolingLoad (confirmed
    // Wa1_Total_CL!M13 / R1_Output!M13 pattern).
    for (const key of ['walls', 'windows', 'roofs', 'ceilings', 'partitions', 'floors']) {
      for (const comp of components[key] || []) {
        for (let h = 0; h < 24; h++) hourlySensible[h] += comp[m].hourly[h].totalCoolingLoad;
      }
    }

    // Occupants — sensible (radiant CL + convective) and latent separate (O_Output!H4/C4)
    for (const comp of components.occupants || []) {
      for (let h = 0; h < 24; h++) {
        hourlySensible[h] += comp[m].hourly[h].sensible;
        hourlyLatent[h] += comp[m].hourly[h].latent;
      }
    }

    // Lighting — 100% sensible (no latent component)
    for (const comp of components.lighting || []) {
      for (let h = 0; h < 24; h++) hourlySensible[h] += comp[m].hourly[h].total;
    }

    // Equipment — sensible (radiant CL + convective) + latent separate
    for (const comp of components.equipment || []) {
      for (let h = 0; h < 24; h++) {
        hourlySensible[h] += comp[m].hourly[h].total - comp[m].hourly[h].latent;
        hourlyLatent[h] += comp[m].hourly[h].latent;
      }
    }

    // Miscellaneous — sensible + latent separate, no RTS delay
    for (const comp of components.miscellaneous || []) {
      for (let h = 0; h < 24; h++) {
        hourlySensible[h] += comp[m].hourly[h].sensible;
        hourlyLatent[h] += comp[m].hourly[h].latent;
      }
    }

    // Outdoor Air — sensible + latent, no RTS delay
    if (components.outdoorAir) {
      for (let h = 0; h < 24; h++) {
        hourlySensible[h] += components.outdoorAir[m].hourly[h].sensible;
        hourlyLatent[h] += components.outdoorAir[m].hourly[h].latent;
      }
    }

    // Markups — applied to the SUM (Output!E20:E22), sensible and latent tracked
    // separately (confirmed: G21 fan-heat-gain markup is sensible-only — Output!G21=0).
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const baseSensible = hourlySensible[h];
      const baseLatent = hourlyLatent[h];
      const ductLossSens = baseSensible * safetyFactors.ductLossPct / 100;
      const ductLossLat = baseLatent * safetyFactors.ductLossPct / 100;
      const fanHeatSens = (baseSensible + ductLossSens) * safetyFactors.fanHeatGainPct / 100; // sensible-only
      const preSafetySens = baseSensible + ductLossSens + fanHeatSens;
      const preSafetyLat = baseLatent + ductLossLat;
      const safetySens = preSafetySens * safetyFactors.overallSafetyFactorPct / 100;
      const safetyLat = preSafetyLat * safetyFactors.overallSafetyFactorPct / 100;

      const designSensible = preSafetySens + safetySens;
      const designLatent = preSafetyLat + safetyLat;
      hourly.push({
        baseSensible, baseLatent,
        designSensible, designLatent,
        designTotal: designSensible + designLatent,
      });
    }

    perMonth.push({ month: m + 1, hourly });
  }

  // Find the annual peak (hour + month) by Design Total — extends Output1's
  // single-month MAX(AA71:AA94) logic across all 12 months.
  let peak = { month: 1, hour: 1, designTotal: -Infinity };
  for (const mo of perMonth) {
    for (let h = 0; h < 24; h++) {
      if (mo.hourly[h].designTotal > peak.designTotal) {
        peak = { month: mo.month, hour: h + 1, designTotal: mo.hourly[h].designTotal };
      }
    }
  }

  return { perMonth, peak };
}



// ===== engine_output_summary.js =====
// ============================================================
// ezyRTS Web — Output Summary Engine (Design Total, RSH, RSHR, TSHR, Supply Air)
//
// Formulas extracted DIRECTLY from ezyRTS.xlsm (Output sheet, rows 24-39).
// This covers everything EXCEPT the Apparatus Dew Point (ADP) / Bypass
// Factor supply-air path (Output!B34:G39, and Tadp itself at L15:L16) —
// that piece uses an iterative LAMBDA-based root-find (locating where the
// RSHR line from room condition intersects the saturation curve) which is
// a separate, more involved psychrometric solver not yet implemented here.
// See note at the bottom for what's still needed.
// ============================================================

/**
 * @param {object} p
 * @param {number} p.designSensible  - combineRoomLoad12Month's peak.designTotal sensible portion
 *   (i.e. the peak hour's designSensible from engine_combine.js)
 * @param {number} p.designLatent    - same, designLatent
 * @param {number} p.roomTemp        - °C
 * @param {number} p.supplyAirTemp   - °C, user-selected SA temp (Output!D32)
 */
function calcOutputSummary(p) {
  const designTotal = p.designSensible + p.designLatent; // Output!E24/F24/G24

  // Room Sensible Heat Ratio — Output!C28 (simplified path: F24/E24, i.e.
  // sensible / total, since this engine does not yet model the "Via Mixing
  // Chamber" OA path separately — see note below).
  const RSHR = designTotal > 0 ? p.designSensible / designTotal : null; // Output!C28

  // Total Sensible Heat Ratio — Output!C29. In this engine's scope (no
  // separate PAU/mixing-chamber OA split modeled yet) this equals RSHR.
  const TSHR = RSHR; // Output!C29

  // Supply air flow rate based on a directly-chosen SA temperature — Output!F32
  // qs = 1.23 * L/s * (Ti - Tsa)  =>  L/s = qs / (1.23 * (Ti - Tsa))
  const deltaT = p.roomTemp - p.supplyAirTemp;
  const supplyAirFlowLs = deltaT > 0 ? p.designSensible / (1.23 * deltaT) : null; // Output!F32

  return {
    designSensible: p.designSensible,
    designLatent: p.designLatent,
    designTotal,
    RSHR,
    TSHR,
    supplyAirFlowLs,
  };
}

// ============================================================
// NOT YET IMPLEMENTED: Apparatus Dew Point (ADP) / Bypass Factor path
// (Output!B34:G39). This is a separate psychrometric calculation: draw a
// line from the room's (DB, RH) condition with slope = RSHR, and find
// where it intersects the saturation curve (100% RH) — that intersection
// point IS Tadp. ezyRTS solves this with an iterative LAMBDA formula
// (Output!L16), not a closed-form equation. Implementing this properly
// needs its own root-finding routine (e.g. bisection on saturation
// humidity ratio vs. the RSHR line) plus the Bypass Factor-based supply
// air formulas at Output!D36/F36. This is substantial enough that it
// should be its own step — flagging rather than guessing at a shortcut.
// ============================================================



// ===== room_state.js =====
// ============================================================
// ezyRTS Web — Unified Room State
//
// This is the single source of truth that the UI reads from / writes
// to, and that the calculation engine consumes. It brings together
// every input group from the mockup (Project, Site Location, Room,
// Wall/Window/Roof/Ceiling/Partition/Floor, Occupants/Lighting/
// Equipment/Miscellaneous, Outdoor Air, Safety Factors, Usage
// Profile) into one object.
//
// Location data (`location.weatherData`) is ALWAYS stored in the same
// shape regardless of source — a province picked from
// a file parsed by weather_parser.js, or an older project file — so the
// calc engine never needs to know or care which path was used.
// See weather_parser.js and the 'Built-in weather databases: REMOVED' note for that shared shape:
//   { name, lat, lon, hemisphere, elev, tz,
//     taub[12], taud[12], hottestMonth,
//     monthlyDesignDB:{p0_4,p2,p5}, monthlyDesignMCWB:{p0_4,p2,p5},
//     mdbr[12], mcwbr[12] }
// (heating / monthlyDBAvg / monthlyDesignWB / monthlyDesignMCDB are
// present when the source is an uploaded file, but not required —
// the RTS cooling calc does not depend on them.)
// ============================================================

// ---------- id generation ----------
// Mirrors the mockup's rowCounter pattern: `${type}${n}`, monotonically
// increasing per component type for the lifetime of one session.
const _counters = {};
function nextId(type) {
  _counters[type] = (_counters[type] || 0) + 1;
  return `${type}${_counters[type]}`;
}

// ---------- component factories ----------
// Each factory returns one row's worth of state, matching exactly the
// fields the mockup UI collects for that component. `uFactor` is never
// pre-filled with a looked-up value (per the confirmed policy: U-factor
// is ALWAYS computed live from `layers` via the U-factor calculator —
// see rts_reference_data.js MATERIALS/COMPONENT_PRESETS).

function newLayer(materialName = '', thicknessMm = null) {
  return { material: materialName, thicknessMm };
}

function newWall() {
  return {
    id: nextId('wall'),
    exposure: 'N',                 // N/NE/E/SE/S/SW/W/NW
    wallTypeName: null,            // legacy field, no longer set/read (was: label for the removed Wall Type dropdown) — CTS is now live-computed from `layers`, see computeCtsFromLayers()
    wallCtsId: null,               // legacy field, no longer set/read (was: WALL_CTS.walls[].id, a table now removed)
    layers: [],                    // [{material, thicknessMm}] — source of truth for U-factor
    uFactor: null,                 // ALWAYS computed from `layers`, never looked up
    area: null,                    // m²
    tilt: 90,                      // degrees; !=90 => tilted (UI warns)
    surfaceColor: 'Dark',          // 'Dark' | 'Light'
  };
}

function newWindow() {
  return {
    id: nextId('window'),
    exposure: 'N',
    glassTypeName: null,           // SHGC_TABLE[].name
    layers: [],
    uFactor: null,                 // computed from layers
    area: null,
    tilt: 90,
    shading: 'w/o shading',        // 'w/shading' | 'w/o shading'
  };
}

function newRoof() {
  return {
    id: nextId('roof'),
    roofTypeName: null,            // legacy field, no longer set/read (was: label for the removed Roof Type dropdown) — CTS is now live-computed from `layers`, see computeCtsFromLayers()
    roofCtsId: null,               // legacy field, no longer set/read (was: ROOF_CTS.roofs[].id, a table now removed)
    layers: [],
    uFactor: null,                 // computed from layers
    area: null,
    surfaceColor: 'Dark',
    tilt: 0,                       // degrees; !=0 => sloped (UI shows roofDirection)
    roofDirection: null,           // only meaningful when tilt != 0
  };
}

function newCeiling() {
  return {
    id: nextId('ceiling'),
    area: null,
    layers: [],
    uFactor: null,
    adjacentSpace: null,           // Dropdown.AdjacentSpace value
    excludeFromBlockLoad: false,
  };
}

function newPartition() {
  return {
    id: nextId('partition'),
    area: null,
    layers: [],
    uFactor: null,
    adjacentSpace: null,
    excludeFromBlockLoad: false,
  };
}

function newFloor() {
  return {
    id: nextId('floor'),
    area: null,
    layers: [],
    uFactor: null,
    adjacentSpace: null,
    excludeFromBlockLoad: false,
  };
}

function newOccupant() {
  return {
    id: nextId('occupant'),
    count: null,
    activityLevel: null,           // Dropdown.ActivityLevel value
    usageProfile: 1,                // 1-6, refs usageProfiles
  };
}

function newLighting() {
  return {
    id: nextId('lighting'),
    lpd: null,                     // W/m²
    watt: null,                    // computed = lpd * room.area
    fixtureType: null,             // Dropdown.Lighting value
    usageProfile: 1,
  };
}

function newEquipment() {
  return {
    id: nextId('equip'),
    sensible: null,                // W
    latent: null,                  // W
    coolingType: null,             // Dropdown."Equipment with cooling" value
    usageProfile: 1,
  };
}

function newMisc() {
  return {
    id: nextId('misc'),
    sensible: null,
    latent: null,
    usageProfile: 1,
  };
}

// ---------- top-level state ----------

/**
 * Create a brand-new, empty room calculation state.
 * One state object = one room = one calculation session (no persistence,
 * per the confirmed scope: single artifact, client-side, no login/DB).
 */
function createDefaultRoomState() {
  return {
    meta: {
      language: 'en',              // 'th' | 'en' — EN is default per confirmed decision
      unit: 'SI',                  // 'SI' | 'IP'
    },

    project: {
      projectName: '',
      buildingName: '',
      roomName: '',
      calculatedBy: '',
    },

    location: {
      source: null,                 // 'province' | 'upload' | null (not yet set)
      country: 'Thailand',
      province: null,               // set when source === 'province'
      uploadedFileName: null,       // set when source === 'upload'
      weatherData: null,            // the shared-shape object described in the header comment above
      calculatedMonth: null,        // 1-12; auto-follows peak load month, user can override (see mockup logic)
    },

    room: {
      length: null,                 // m
      width: null,                  // m
      ceilingHeight: null,          // m
      area: null,                   // computed = length * width
      volume: null,                 // computed = area * ceilingHeight
      roomTemp: 24,                 // °C
      relativeHumidity: 50,         // %
      rtsZoneType: null,            // Dropdown.RTSZoneType value (16 Aug 2026: display label only now — real state is rtsCalcJsonInput's {cls,carpet,glassFrac,nsrts,srts})
      occupancyCategory: null,      // used for ASHRAE 62.1 outdoor air lookup
    },

    walls: [newWall()],
    windows: [newWindow()],
    roofs: [newRoof()],
    ceilings: [],
    partitions: [],
    floors: [],

    occupants: [newOccupant()],
    lighting: [newLighting()],
    equipment: [newEquipment()],
    miscellaneous: [newMisc()],

    outdoorAir: {
      byRegulation: { ratePerArea: null, area: null, flowLs: null },       // m³/h per m² -> L/s (computed)
      by621: { lsPerPerson: null, lsPerM2: null, flowLs: null },            // reference only, per mockup note
      byLeakage: { roomPressurePa: null, leakageAreaM2: null, airLeakageLs: null },
      summary: {
        enteredFlowLs: null,
        usageProfile: 1,
        allOutsideAirSystem: false,
      },
      introductionMethod: null,      // Dropdown."Outdoor Air Introduction Method" value
      treatmentSystem: 'none',       // 'none' | 'doas' | 'erv' | 'hrv'
      treatmentParams: {
        // only the fields relevant to the selected treatmentSystem are used
        temperatureC: null,          // DOAS/PAU
        relativeHumidityPct: null,   // DOAS/PAU
        temperatureEfficiencyPct: null, // ERV, HRV
        enthalpyEfficiencyPct: null, // ERV only
      },
    },

    safetyFactors: {
      ductLossPct: 5,
      fanTotalPressurePa: null,
      overallSafetyFactorPct: 10,
    },

    // 24-hour usage fraction (0-1) per profile, referenced by every component's
    // `usageProfile` field above. Profile 1 defaults to an office-hours-like
    // schedule (matches the mockup's sample data); 2-10 default to always-on (1)
    // and are expected to be edited by the user.
    usageProfiles: {
      1: [0,0,0,0,0,0,0,1,1,1,1,0.5,1,1,1,1,1,0,0,0,0,0,0,0],
      2: Array(24).fill(1),
      3: Array(24).fill(1),
      4: Array(24).fill(1),
      5: Array(24).fill(1),
      6: Array(24).fill(1),
      7: Array(24).fill(1),
      8: Array(24).fill(1),
      9: Array(24).fill(1),
      10: Array(24).fill(1),
    },

    // Populated by the calc engine (future step) — 24hr x 12mo results, per
    // component and totals, plus the auto-selected peak hour/month.
    results: null,
  };
}

// ---------- derived-field recompute (mirrors the mockup's live recalculation) ----------

function recomputeRoomGeometry(state) {
  const { length, width, ceilingHeight } = state.room;
  state.room.area = (length > 0 && width > 0) ? length * width : null;
  state.room.volume = (state.room.area && ceilingHeight > 0) ? state.room.area * ceilingHeight : null;
}

function recomputeLightingWatt(state) {
  state.lighting.forEach((l) => {
    l.watt = (l.lpd > 0 && state.room.area > 0) ? l.lpd * state.room.area : null;
  });
}

// ---------- component add/remove (mirrors mockup's addRow/deleteRow) ----------

const COMPONENT_FACTORIES = {
  wall: newWall, window: newWindow, roof: newRoof,
  ceiling: newCeiling, partition: newPartition, floor: newFloor,
  occupant: newOccupant, lighting: newLighting, equip: newEquipment, misc: newMisc,
};
const COMPONENT_STATE_KEY = {
  wall: 'walls', window: 'windows', roof: 'roofs',
  ceiling: 'ceilings', partition: 'partitions', floor: 'floors',
  occupant: 'occupants', lighting: 'lighting', equip: 'equipment', misc: 'miscellaneous',
};

function addComponent(state, type) {
  const factory = COMPONENT_FACTORIES[type];
  const key = COMPONENT_STATE_KEY[type];
  if (!factory || !key) throw new Error(`Unknown component type: ${type}`);
  const row = factory();
  state[key].push(row);
  return row;
}

/** Remove a component by id; if it's the last one of its type, reset it in place instead (mirrors mockup UI behavior). */
function removeComponent(state, type, id) {
  const key = COMPONENT_STATE_KEY[type];
  const list = state[key];
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) return;
  if (list.length > 1) {
    list.splice(idx, 1);
  } else {
    list[idx] = { ...COMPONENT_FACTORIES[type](), id }; // keep same id, reset fields
  }
}

// Exports (for use as an ES module in the real app build)

// The web application runs this once at start-up; do the same here so
// rts2Compute() uses the material properties from MATERIALS.
buildRts2MaterialsFromDatabase();

// ============================================================
// Public API — CommonJS / Node.js export.
// (Browser: include this file with a <script> tag; every function and
//  constant above is also available as a global.)
// ============================================================
const RTS_COOLING_LOAD_VERSION = '2.0.0';
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RTS_COOLING_LOAD_VERSION,
    shgcTau,
    shgcNormTau,
    shgcHemisphericalShapeIntegral,
    shgcHemispherical,
    rts3PhysicalLayer,
    rts3Grid,
    rts3Thomas,
    rts3TriangularBoundary,
    rts3PulseResponse,
    rts3Fold24,
    rts3Kernel,
    rts3ClearKernelCache,
    rts3CarrollF,
    rts3DenseSolve,
    rts2Compute,
    buildRts2MaterialsFromDatabase,
    parseWeatherFile,
    norm,
    normalizeSheet,
    isNum,
    findRow,
    findCol,
    eq,
    contains,
    findRowWithAll,
    findNextNumericRow,
    extractMonthlyAfterLabel_withAnnualGap,
    extractMonthlyAfterLabel_noGap,
    extractStationInfo,
    extractHeatingDesign,
    extractCoolingDesign,
    extractMonthlyDBAvg,
    extractMonthlyDesignDB_MCWB,
    extractMonthlyDesignWB_MCDB,
    extractMeanDailyRange,
    extractClearSkyOpticalDepths,
    extractWeatherData,
    hourlyOutdoorTempForMonth,
    generateHourlyOutdoorTempAllMonths,
    dayOfYear,
    equationOfTime,
    solarDeclination,
    extraterrestrialIrradiance,
    airMassExponents,
    surfaceIrradiance,
    solAirTemp,
    heatInput,
    convolve24,
    ctsBuildMesh,
    ctsTriangularPulse,
    ctsResolveLayers,
    ctsGrid,
    computeCtsFromLayers,
    calcOpaqueSurfaceCoolingLoad24,
    calcOpaqueSurfaceCoolingLoad12Month,
    shgcAtAngle,
    windowHourGain,
    calcWindowCoolingLoad24,
    calcWindowCoolingLoad12Month,
    calcOccupantLoad24,
    calcLightingLoad24,
    calcEquipmentLoad24,
    calcMiscLoad24,
    pwsExact,
    pws,
    humidityRatio,
    rhFromHumidityRatio,
    atmosphericPressure,
    tadpResidual,
    solveTadp,
    hourlyOutdoorRHForMonth,
    calcOutdoorAirLoad24,
    moistAirEnthalpy,
    calcOutdoorAirLoad24WithTreatment,
    combineRoomLoad12Month,
    calcOutputSummary,
    nextId,
    newLayer,
    newWall,
    newWindow,
    newRoof,
    newCeiling,
    newPartition,
    newFloor,
    newOccupant,
    newLighting,
    newEquipment,
    newMisc,
    createDefaultRoomState,
    recomputeRoomGeometry,
    recomputeLightingWatt,
    addComponent,
    removeComponent,
    SHGC_CURVE_COEFFS,
    SHGC_CURVE_INFO,
    SHGC_TABLE,
    MATERIALS,
    COMPONENT_PRESETS,
    COUNTRY_TZ,
    RTS2_GLAZ,
    RTS2_MAT,
    RTS2_CONSTR,
    RTS2_SIG,
    RTS2_HCV,
    RTS3_CELLS_PER_LAYER,
    RTS3_MAX_ITER,
    RTS3_BOUNDARY_BETA,
    RTS3_STILL_AIR_K,
    REQUIRED_SECTIONS,
    PDR_PROFILE_24,
    DEG,
    toRad,
    toDeg,
    CTS3_CELLS_PER_LAYER,
    CTS3_CUTOFF,
    CTS3_STILL_AIR_K,
    ACTIVITY_LEVELS,
    LIGHTING_FIXTURES,
    EQUIPMENT_COOLING_TYPES,
    COMPONENT_FACTORIES,
    COMPONENT_STATE_KEY
  };
}
