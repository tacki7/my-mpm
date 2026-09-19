// The conditions tools/run.mjs runs: a preset (or the defaults), then only the options given on
// the command line. An option left out keeps the preset's value exactly (the front-tension preset
// keeps its 615 MPa; converting to mm and back is not exact, so nothing is rewritten unless given).
//
// Lengths in mm, tensions in MPa, the reduction as a fraction.
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { presetById } from '../src/mpm/presets.ts';

export function runParams(args) {
  const has = (name) => args.includes(`--${name}`);
  const opt = (name) => args[args.indexOf(`--${name}`) + 1];
  const num = (name, set) => {
    if (has(name)) set(+opt(name));
  };
  const text = (name, set) => {
    if (has(name)) set(opt(name));
  };

  const P = has('preset') ? presetById(opt('preset')).build() : defaultParams();
  const r = P.rolling;
  num('h0', (v) => (r.h0 = v * 1e-3));
  num('r', (v) => (r.reduction = v));
  num('R', (v) => (r.rollRadius = v * 1e-3));
  num('L', (v) => (r.sheetLength = v * 1e-3));
  num('mu', (v) => (r.mu = v));
  num('tb', (v) => (r.backTension = v * 1e6));
  num('tf', (v) => (r.frontTension = v * 1e6));
  num('cells', (v) => (P.numerics.cellsThrough = v));
  num('ms', (v) => (P.numerics.massScale = v));
  if (has('nojbar')) P.numerics.jbar = false;
  // 'stencil': the contact of before (a band 1.5 cells deep); the same as before only with --vrc 5 as well
  text('contact', (v) => (P.numerics.contact = v));
  num('vrc', (v) => (P.numerics.volRelaxContact = v)); // relaxation near the rolls ('rate')
  text('mat', (v) => (P.material = { ...MATERIALS[v] }));
  text('damage', (v) => (P.damage.model = v));
  text('yield', (v) => (P.damage.yield = v));
  num('chi', (v) => (P.material.chi = v)); // Taylor-Quinney coefficient: 0 = no heating
  num('nonlocal', (v) => (P.damage.nonlocalLength = v * 1e-3)); // mm
  text('nucleation', (v) => (P.damage.gtn.nucleation = v));
  text('crack', (v) => (P.numerics.crackFields = v)); // the faces of a crack: none | dfg
  return P;
}
