// The faces of a crack in the plan view (numerics.crackFields 'dfg' in src/mpm/planview/sim.ts, as the section
// model's, docs/model.md「亀裂の面」): near a crack the points split into two velocity fields by the side they are
// on, and the fields meet by frictionless contact. On a coarse 10 mm wide strip, about 20 s:
// - no failed point: 'dfg' is the single field bit for bit (both tensions on, so the pusher, the grips and the
//   friction all act)
// - a cut from the edge to half the half width, in the incoming strip, pulled by a back tension against the rolls:
//   the points next to its faces unload (with one field the grid joins the faces: a cut narrower than the
//   stencil carries the tension across; a cut through the bite opens by itself, the exit being faster, so the
//   check is on the entry side)
// - the same from the mid-width plane: the rows next to the symmetry plane unload too (the failed points' mirror
//   images count in G and C)
// - the contact between the fields keeps the momentum at every node
// Calibrated on copies: the contact normal alone reversed (the faces held together when they separate) fails both
// cuts (edge ratio 0.93, 171 MPa by the plane); the single field ('dfg' taken as 'none') fails three items; G and C
// not folded across the symmetry plane fails the mid-width cut (105 MPa by the plane). The bounds sit between the
// working values (edge ratio 0.36, 10 MPa by the plane) and those copies
// @check
import { ok, between, done } from './lib.mjs';
import { PlanSim, planParams } from '../../src/mpm/planview/sim.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const W = 10e-3;

// ── no failed point: the second field never exists
{
  const run = (mode) => {
    const b = defaultParams();
    b.rolling.sheetLength = 6e-3;
    b.rolling.backTension = 50e6;
    b.rolling.frontTension = 50e6;
    b.damage.model = 'none';
    b.numerics.crackFields = mode;
    const s = new PlanSim(planParams(b, W, 10));
    const reads = [];
    while (s.phase() !== 'done' && s.step < 20000) {
      for (let k = 0; k < 500; k++) s.advance();
      reads.push(s.readForce(), s.frictionNow, s.backNow, s.frontNow);
    }
    return { s, reads };
  };
  const a = run('none');
  const b = run('dfg');
  const arrays = ['px', 'pz', 'vx', 'vz', 'f00', 'f01', 'f10', 'f11', 'thick', 'sxx', 'szz', 'sxz', 'syy', 'pres', 'ep', 'dCL', 'fricX'];
  const diff = arrays.filter((k) => a.s[k].some((v, i) => !Object.is(v, b.s[k][i])));
  const reads = a.reads.every((v, i) => Object.is(v, b.reads[i])) && a.reads.length === b.reads.length;
  ok(diff.length === 0 && reads && b.s.fieldContacts === 0, "no crack: 'dfg' is the single field bit for bit", diff.join(' ') || `${a.s.step} steps`);
}

// a cut through lattice columns i0, i0 + 1 and rows [k0, k1) (failed at the start), a fifth of the strip from the
// tail; back tension 100 MPa. σxx of the points next to its faces (columns i0 − 1 and i0 + 2) per row, averaged
// over the looks every 50 steps while the rolls pull against the tension (the pusher off, the tension on) and the
// cut is still 1 mm before the entry
const TB = 100e6;
function cut(mode, edge, watch) {
  const b = defaultParams();
  b.rolling.sheetLength = 12e-3;
  b.rolling.backTension = TB;
  b.damage.model = 'none';
  b.numerics.crackFields = mode;
  const s = new PlanSim(planParams(b, W, 10));
  if (watch) watch(s);
  const { NI, NK, lattice } = s;
  const i0 = Math.floor(NI / 5);
  const k0 = edge ? Math.round(NK / 2) : 0;
  const k1 = edge ? NK : Math.round(NK / 2);
  for (const i of [i0, i0 + 1]) {
    for (let k = k0; k < k1; k++) {
      const q = lattice[i * NK + k];
      s.failed[q] = 1;
      s.crackId[q] = 0;
    }
  }
  s.cracks.push({ id: 0, t: 0, step: 0, x: 0, z: 0, sheetX: 0, sheetZ: 0, eta: 0, s1: 0, seq: 0, ep: 0, criterion: 'none', count: 2 * (k1 - k0) });
  const rows = new Float64Array(k1 - k0);
  let looks = 0;
  let contacts = 0;
  while (s.step < 20000) {
    for (let k = 0; k < 50; k++) {
      s.advance();
      contacts += s.fieldContacts;
    }
    let x = 0;
    for (let k = k0; k < k1; k++) x += s.px[lattice[i0 * NK + k]] / (k1 - k0);
    if (x > -s.contactLength - 1e-3) break;
    if (s.pusherActive || s.backNow < 0.99 * TB) continue;
    looks++;
    for (const i of [i0 - 1, i0 + 2]) {
      for (let k = k0; k < k1; k++) {
        const q = lattice[i * NK + k];
        rows[k - k0] += (s.sxx[q] - s.pres[q]) / 2;
      }
    }
  }
  for (let j = 0; j < rows.length; j++) rows[j] /= Math.max(1, looks);
  return { face: rows.reduce((a, v) => a + v, 0) / rows.length, rows, looks, contacts };
}

// ── pulled apart by the back tension: the faces unload; the contact keeps the momentum
{
  const one = cut('none', true);
  let worst = 0;
  const two = cut('dfg', true, (s) => {
    const contact = s.fieldContact;
    s.fieldContact = function (from, to, mMin) {
      const N = s.nxN * s.nzN;
      const before = [];
      for (let i = from; i < to; i++) before.push([s.gvx[i] + s.gvx[i + N], s.gvz[i] + s.gvz[i + N], Math.abs(s.gvx[i]) + Math.abs(s.gvx[i + N]) + Math.abs(s.gvz[i]) + Math.abs(s.gvz[i + N])]);
      contact.call(this, from, to, mMin);
      for (let i = from, k = 0; i < to; i++, k++) {
        const [x, z, scale] = before[k];
        if (scale > 0) worst = Math.max(worst, (Math.abs(s.gvx[i] + s.gvx[i + N] - x) + Math.abs(s.gvz[i] + s.gvz[i + N] - z)) / scale);
      }
    };
  });
  ok(one.looks >= 10 && one.face > 100e6, 'a cut from the edge pulled by the back tension, single field: the faces carry it (the case this checks)', `mean σxx next to the faces ${(one.face * 1e-6).toFixed(0)} MPa over ${one.looks} looks`);
  between(two.face / one.face, -0.5, 0.7, "the same, 'dfg': mean σxx next to the faces over the single field's");
  ok(two.contacts > 0 && worst < 1e-12, 'the contact between the fields keeps the momentum at every node', `${two.contacts} node-steps in contact, largest relative change ${worst.toExponential(1)}`);
}

// ── from the mid-width plane to half the half width, 'dfg': the two rows next to the symmetry plane unload too
{
  const mid = cut('dfg', false);
  between(((mid.rows[0] + mid.rows[1]) / 2) * 1e-6, -50, 50, `a cut from the mid-width, 'dfg': mean σxx next to the faces in the two rows by the symmetry plane [MPa] (back tension ${TB * 1e-6} MPa; the cut's mean ${(mid.face * 1e-6).toFixed(0)} MPa)`);
}
done();
