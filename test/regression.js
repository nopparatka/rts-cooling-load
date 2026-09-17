// Regression checks for the RTS Cooling Load engine (no external data needed).
// Reference values were produced by the same solvers in the ezyRTS web
// application and are used here only to detect unintended changes.
// Run: node test/regression.js
'use strict';
const e = require('../rts-cooling-load.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const sum = a => a.reduce((x, y) => x + y, 0);

// Radiant time factors — long narrow zone, construction class M, no carpet
const optA = { W: 22, D: 2, H: 2.6, glassFrac: 0.12, partFrac: 0.75, dt: 60, iters: 4, maxCyc: 80 };
const ns = e.rts2Compute('M', false, 0, 'nonsolar', optA);
const so = e.rts2Compute('M', false, 0, 'solar', optA);
ok(ns.rtf[0].toFixed(3) === '14.410', `nonsolar RTF hour 0 = ${ns.rtf[0].toFixed(3)} % (ref 14.410)`);
ok(so.rtf[0].toFixed(3) === '16.243', `solar RTF hour 0 = ${so.rtf[0].toFixed(3)} % (ref 16.243)`);
ok(ns.balance.toFixed(6) === '1.000136' && so.balance.toFixed(6) === '1.000731',
   `energy balance ${ns.balance.toFixed(6)} / ${so.balance.toFixed(6)} (ref 1.000136 / 1.000731)`);
ok(Math.abs(sum(ns.rtf) - 100) < 1e-6 && Math.abs(sum(so.rtf) - 100) < 1e-6, 'each RTF series sums to 100 %');

// 6 m x 6 m x 3 m zone, 50 % glazing, furniture fraction 0.5
const ref = { L: [44.0, 35.6], M: [28.5, 22.6], H: [24.4, 19.5] };
for (const c of ['L', 'M', 'H']) for (const [k, carpet] of [[0, true], [1, false]]) {
  const r = e.rts2Compute(c, carpet, 0.5, 'nonsolar',
    { W: 6, D: 6, H: 3, glassFrac: 0.5, partFrac: 0.75, dt: 60, iters: 4, maxCyc: 80 });
  ok(r.rtf[0].toFixed(1) === ref[c][k].toFixed(1),
     `6x6x3 class ${c}, carpet=${carpet}: RTF hour 0 = ${r.rtf[0].toFixed(1)} % (ref ${ref[c][k]})`);
}

// Angle-dependent SHGC, curve D
const g = { name: 'Dbl 6mm LE CLR', shgc0: 0.35, curve: 'D' };
ok(e.shgcAtAngle(g, 40).toFixed(15) === '0.332692405831735', `SHGC(40 deg) = ${e.shgcAtAngle(g, 40).toFixed(15)}`);
ok(e.shgcNormTau('D', 40).toFixed(15) === '0.950549730947814', `normalised tau_D(40 deg) = ${e.shgcNormTau('D', 40).toFixed(15)}`);
ok(e.shgcHemisphericalShapeIntegral('D').toFixed(15) === '0.434647093771825',
   `hemispherical shape integral S(D) = ${e.shgcHemisphericalShapeIntegral('D').toFixed(15)}`);

// Conduction time factors — U identity and sum = 100 % for every preset assembly
let worst = 0, best = Infinity, worstName = '', n = 0, sums = true;
for (const p of e.COMPONENT_PRESETS) {
  const r = e.computeCtsFromLayers(p.layers.map(l => ({ material: l.material, thickness: l.thk })));
  if (!r) continue; n++;
  const err = Math.abs(r.uRelError);
  if (err > worst) { worst = err; worstName = p.name; }
  best = Math.min(best, err);
  if (Math.abs(sum(r.cts) - 100) > 1e-6) sums = false;
}
ok(n === e.COMPONENT_PRESETS.length && worst < 1e-3,
   `CTS U = 1/R identity over ${n} presets: |relative error| ${best.toExponential(2)} to ${worst.toExponential(2)}` +
   ` (largest: ${worstName}; acceptance tolerance 1e-3)`);
ok(sums, 'each CTS series sums to 100 %');

console.log(`TOTAL pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
