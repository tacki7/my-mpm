// The conditions tools/run.mjs runs: a preset (or the defaults), then only the options given on
// the command line. An option left out keeps the preset's value exactly (the front-tension preset
// keeps its 615 MPa; converting to mm and back is not exact, so nothing is rewritten unless given).
//
// Lengths in mm, tensions in MPa, the reduction as a fraction.
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { presetById } from '../src/mpm/presets.ts';
import { withSteadyLength } from '../src/mpm/tandem.ts';

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
  // the faces of a crack (docs/model.md「亀裂の面」); an unknown value is an error, not a silent 'none'
  text('crack', (v) => {
    if (v !== 'none' && v !== 'dfg') throw new Error(`--crack ${v}: none or dfg`);
    P.numerics.crackFields = v;
  });
  // the rolls adjusted while the pass runs (docs/model.md「ロール偏平と圧下率一定」)
  text('flatten', (v) => {
    if (v !== 'none' && v !== 'hitchcock') throw new Error(`--flatten ${v}: none or hitchcock`);
    r.flattening = v;
  });
  num('rollE', (v) => (r.rollE = v * 1e9)); // GPa
  text('control', (v) => {
    if (v !== 'gap' && v !== 'reduction') throw new Error(`--control ${v}: gap or reduction`);
    r.gapControl = v;
  });
  // --half: only the top half of the thickness, y = 0 a symmetry plane (docs/model.md「板厚方向の対称モデル（2 次元）」)
  if (has('half')) r.halfThickness = true;
  // --length steady: the sheet as long as the (first) stand needs to get to the steady state (--L is then not used)
  text('length', (v) => {
    if (v !== 'fixed' && v !== 'steady') throw new Error(`--length ${v}: fixed or steady`);
    r.lengthMode = v;
  });
  return withSteadyLength(P);
}
