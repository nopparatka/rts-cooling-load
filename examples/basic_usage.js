/**
 * Basic usage of the RTS Cooling Load engine.
 *
 * ALL WEATHER VALUES IN THIS FILE ARE FICTITIOUS. They exist only to show how
 * the functions fit together; do not use the results for design.
 *
 * Steps:
 *   1. conduction time factors (CTS) from a layer assembly + U = 1/R check
 *   2. radiant time factors (RTS) for a zone + energy-balance check
 *   3. angle-dependent SHGC
 *   4. a 12-month, 24-hour cooling load for one wall, one window and lighting
 *
 * Run: node examples/basic_usage.js
 */
'use strict';
const e = require('../rts-cooling-load.js');

const sum = a => a.reduce((x, y) => x + y, 0);
const f = (x, d = 3) => Number(x).toFixed(d);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// 1. Conduction time factors from a layer assembly
// ---------------------------------------------------------------------------
const wallPreset = e.COMPONENT_PRESETS.find(p => p.name === '100 mm Brick wall w/stucco');
const layers = wallPreset.layers.map(l => ({ material: l.material, thickness: l.thk })); // thickness in mm
const cts = e.computeCtsFromLayers(layers);
console.log('1. CTS —', wallPreset.name);
console.log(`   U (from the CTS response) = ${f(cts.uWm2K, 4)} W/m2K, U = 1/R = ${f(cts.uExactWm2K, 4)} W/m2K,` +
            ` relative difference = ${cts.uRelError.toExponential(2)}, converged = ${cts.converged}`);
console.log(`   CTS (%) hours 0-5: ${cts.cts.slice(0, 6).map(v => f(v, 2)).join(', ')} ... sum = ${f(sum(cts.cts), 6)}`);

// ---------------------------------------------------------------------------
// 2. Radiant time factors for a 6 m x 6 m x 3 m zone
//    rts2Compute(constructionClass 'L'|'M'|'H', carpet, furnitureFraction, 'nonsolar'|'solar', options)
// ---------------------------------------------------------------------------
const zone = { W: 6, D: 6, H: 3, glassFrac: 0.3, partFrac: 0.75, dt: 60, iters: 4, maxCyc: 80 };
const nsRts = e.rts2Compute('M', true, 0.5, 'nonsolar', zone);
const sRts = e.rts2Compute('M', true, 0.5, 'solar', zone);
console.log('\n2. RTS — 6 x 6 x 3 m zone, class M, carpet, glazing fraction 0.3');
console.log(`   nonsolar hours 0-5: ${nsRts.rtf.slice(0, 6).map(v => f(v, 2)).join(', ')} (sum ${f(sum(nsRts.rtf), 6)}),` +
            ` energy balance ${f(nsRts.balance, 6)}, converged = ${nsRts.converged}`);
console.log(`   solar    hours 0-5: ${sRts.rtf.slice(0, 6).map(v => f(v, 2)).join(', ')} (sum ${f(sum(sRts.rtf), 6)}),` +
            ` energy balance ${f(sRts.balance, 6)}, converged = ${sRts.converged}`);

// ---------------------------------------------------------------------------
// 3. Angle-dependent SHGC
// ---------------------------------------------------------------------------
const glass = e.SHGC_TABLE.find(g => g.name === 'Dbl 6mm LE CLR');
console.log(`\n3. SHGC — ${glass.name} (SHGC(0) = ${glass.shgc0}, curve ${glass.curve})`);
console.log('   ' + [0, 20, 40, 60, 80].map(t => `SHGC(${t}°) = ${f(e.shgcAtAngle(glass, t), 4)}`).join(', ') +
            `, hemispherical = ${f(e.shgcHemispherical(glass.shgc0, glass.curve), 4)}`);

// ---------------------------------------------------------------------------
// 4. 12-month design-day loads — FICTITIOUS weather data
//    WeatherData shape: see the note at the top of rts-cooling-load.js.
// ---------------------------------------------------------------------------
const fm = m => Math.cos(2 * Math.PI * (m - 3) / 12);               // m = 0..11, peak in April
const r1 = x => Math.round(x * 10) / 10;
const months = [...Array(12).keys()];
const weather = {
  name: 'EXAMPLE STATION (FICTITIOUS DATA)',
  lat: 15.0, lon: 100.0, hemisphere: 'E', elev: 100, tz: 7,
  hottestMonth: 4,
  monthlyDesignDB:   { p0_4: months.map(m => r1(36 + 2 * fm(m))) },
  monthlyDesignMCWB: { p0_4: months.map(m => r1(25 + 0.5 * fm(m))) },
  mdbr:  months.map(m => r1(9 + fm(m))),
  mcwbr: months.map(m => r1(4 + 0.5 * fm(m))),
  taub:  months.map(m => Math.round((0.45 - 0.05 * fm(m)) * 1000) / 1000),
  taud:  months.map(m => Math.round((2.00 + 0.20 * fm(m)) * 1000) / 1000),
};

const roomTemp = 24;                      // deg C
// Usage fraction for hours 1..24 (index 0 = hour 1): on for hours 9-18.
const lightingProfile = Array.from({ length: 24 }, (_, i) => (i + 1 >= 9 && i + 1 <= 18 ? 1 : 0));
const surfaceAzimuth = { S: 0, W: 90, N: 180, E: -90 };  // degrees from south, west positive
const solarFor = (m, azimuth) => ({
  lat: weather.lat, lon: weather.lon, hemisphere: weather.hemisphere, tz: weather.tz,
  taub: weather.taub[m], taud: weather.taud[m],            // per-month values
  surfaceAzimuth: azimuth, tilt: 90, year: 2026, month: m + 1, day: 21,
});

const grid = { wall: [], window: [], lighting: [] };        // [month][hour], W
for (const m of months) {
  const outdoor24 = e.hourlyOutdoorTempForMonth(weather.monthlyDesignDB.p0_4[m], weather.mdbr[m]);
  const wall = e.calcOpaqueSurfaceCoolingLoad24({
    kind: 'wall', uFactor: cts.uExactWm2K, area: 20, roomTemp,
    alphaHo: 0.052,                                          // dark surface
    cts24: cts.cts, nsRts24: nsRts.rtf, outdoorTempHourly24: outdoor24,
    solar: solarFor(m, surfaceAzimuth.S),
  });
  const win = e.calcWindowCoolingLoad24({
    area: 6, uFactor: 2.7, roomTemp, glassEntry: glass, shaded: false,
    srts24: sRts.rtf, nsRts24: nsRts.rtf, outdoorTempHourly24: outdoor24,
    solar: solarFor(m, surfaceAzimuth.W),
  });
  const light = e.calcLightingLoad24({
    watt: 360, fixtureIndex: 2, usageProfile24: lightingProfile, nsRts24: nsRts.rtf,
  });
  grid.wall.push(wall.hourly.map(h => h.totalCoolingLoad));
  grid.window.push(win.hourly.map(h => h.totalCoolingLoad));
  grid.lighting.push(light.hourly.map(h => h.total));
}

// Room peak: add the components at the same month and hour first, then find the maximum.
let peak = { W: -Infinity, m: 0, h: 0 };
for (const m of months) for (let h = 0; h < 24; h++) {
  const t = grid.wall[m][h] + grid.window[m][h] + grid.lighting[m][h];
  if (t > peak.W) peak = { W: t, m, h };
}
console.log('\n4. 12-month loads — S wall 20 m2, W window 6 m2, lighting 360 W (FICTITIOUS weather)');
console.log(`   peak of the sum: ${f(peak.W, 1)} W in ${MONTHS[peak.m]} at hour ${peak.h + 1}` +
            ` (wall ${f(grid.wall[peak.m][peak.h], 1)} W, window ${f(grid.window[peak.m][peak.h], 1)} W,` +
            ` lighting ${f(grid.lighting[peak.m][peak.h], 1)} W)`);
console.log('   Not included here: occupants, equipment, outdoor air, duct loss, fan heat and safety factors.');
