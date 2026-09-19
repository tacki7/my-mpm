// The faces of a crack (numerics.crackFields 'dfg', docs/model.md「亀裂の面」): near a crack the points split into
// two velocity fields by the side they are on, and the fields meet by frictionless contact. About 20 s:
// - no failed point: 'dfg' is the single field bit for bit (point arrays and every diagnostics read)
// - centreline cracks (central-burst, 8 cells, band ductility 1/100): the faces carry no tension across the crack
//   (the single field carries 175 MPa on average there)
// - a cut through the thickness pulled by a front tension (200 MPa, 4 cells): the points next to the faces unload
// - the same cut closed through the bite: the faces do not go through each other (with the contact normal the
//   wrong way round they did in the prototype: the band collapsed to a third)
// - the contact between the fields keeps the momentum at every node
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';

// ── no failed point: the second field never exists
{
  const run = (mode) => {
    const P = defaultParams();
    P.numerics.cellsThrough = 4;
    P.rolling.sheetLength = 4e-3;
    P.numerics.crackFields = mode;
    const s = new Sim(P);
    const reads = [];
    do {
      for (let k = 0; k < 1000; k++) s.advance();
      reads.push(JSON.stringify(s.diagnostics()));
    } while (s.phase() !== 'done');
    return { s, reads };
  };
  const a = run('none');
  const b = run('dfg');
  const arrays = ['px', 'py', 'vx', 'vy', 'f00', 'f11', 'sxx', 'syy', 'pres', 'ep', 'dJC'];
  const diff = arrays.filter((k) => a.s[k].some((v, i) => !Object.is(v, b.s[k][i])));
  ok(diff.length === 0 && a.reads.join() === b.reads.join() && b.s.fieldContacts === 0, "no crack: 'dfg' is the single field bit for bit", diff.join(' ') || `${a.s.step} steps`);
}

// the points right above and below the failed ones of each cracked column: σyy across the faces
function faceSyy(sim) {
  const { NI, NJ, lattice } = sim;
  const out = [];
  for (let i = 0; i < NI; i++) {
    let lo = NJ;
    let hi = -1;
    for (let j = 0; j < NJ; j++) {
      const q = lattice[i * NJ + j];
      if (q >= 0 && sim.failed[q]) {
        lo = Math.min(lo, j);
        hi = Math.max(hi, j);
      }
    }
    if (hi < 0 || lo === 0 || hi === NJ - 1) continue;
    for (const q of [lattice[i * NJ + lo - 1], lattice[i * NJ + hi + 1]]) if (q >= 0 && !sim.failed[q]) out.push(sim.syy[q] - sim.pres[q]);
  }
  return out;
}

// ── centreline cracks: the faces carry no tension
{
  const burst = (mode) => {
    const P = presetById('central-burst').build();
    P.numerics.cellsThrough = 8;
    P.defects[0].ductility = 0.01;
    P.numerics.crackFields = mode;
    const s = new Sim(P);
    // the contact between the fields keeps the momentum at each node it acts on
    let worst = 0;
    const contact = s.fieldContact;
    s.fieldContact = function (mMin) {
      const N = s.nxN * s.nyN;
      const before = [];
      for (let i = s.gLo; i < s.gHi; i++) before.push([s.gvx[i] + s.gvx[i + N], s.gvy[i] + s.gvy[i + N], Math.abs(s.gvx[i]) + Math.abs(s.gvx[i + N]) + Math.abs(s.gvy[i]) + Math.abs(s.gvy[i + N])]);
      contact.call(this, mMin);
      for (let i = s.gLo, k = 0; i < s.gHi; i++, k++) {
        const [x, y, scale] = before[k];
        if (scale > 0) worst = Math.max(worst, (Math.abs(s.gvx[i] + s.gvx[i + N] - x) + Math.abs(s.gvy[i] + s.gvy[i + N] - y)) / scale);
      }
    };
    let contacts = 0;
    while (s.phase() !== 'done' && s.step < 100000) {
      s.advance();
      contacts += s.fieldContacts;
    }
    const f = faceSyy(s);
    return { f, mean: f.reduce((a, b) => a + b, 0) / Math.max(1, f.length), max: Math.max(...f), worst, contacts };
  };
  const one = burst('none');
  const two = burst('dfg');
  ok(one.f.length >= 4 && one.mean > 100e6, 'centreline cracks, single field: tension across the faces (the case this checks)', `${one.f.length} face points, mean ${(one.mean * 1e-6).toFixed(0)} MPa, max ${(one.max * 1e-6).toFixed(0)} MPa`);
  ok(two.f.length >= 4, "centreline cracks, 'dfg': cracked columns with faces", `${two.f.length} face points`);
  between(two.max * 1e-6, -1000, 60, "centreline cracks, 'dfg': the largest σyy across the faces [MPa] (no tension carried)");
  ok(two.contacts > 0 && two.worst < 1e-12, 'the contact between the fields keeps the momentum at every node', `${two.contacts} node-steps in contact, largest relative change ${two.worst.toExponential(1)}`);
}

// a cut through the thickness at the middle of the sheet (2 columns failed at the start), 4 cells, 6 mm
function cut(mode, tf) {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.damage = { ...P.damage, model: 'none' };
  P.rolling.frontTension = tf;
  P.numerics.crackFields = mode;
  const s = new Sim(P);
  const { NI, NJ, lattice } = s;
  const i0 = Math.floor(NI / 2) - 1;
  for (const i of [i0, i0 + 1]) {
    for (let j = 0; j < NJ; j++) {
      const q = lattice[i * NJ + j];
      s.failed[q] = 1;
      s.crackId[q] = 0;
      s.sxx[q] = s.syy[q] = s.szz[q] = s.sxy[q] = 0;
    }
  }
  s.cracks.push({ id: 0, t: 0, step: 0, x: 0, y: 0, sheetX: 0, sheetY: 0, eta: 0, s1: 0, seq: 0, ep: 0, criterion: 'none', count: 2 * NJ });
  let across = Infinity;
  let face = -Infinity;
  while (s.phase() !== 'done' && s.step < 60000) {
    for (let k = 0; k < 50; k++) s.advance();
    let bx = 0;
    for (let j = 0; j < NJ; j++) {
      bx += s.px[lattice[i0 * NJ + j]] / NJ;
      across = Math.min(across, (s.px[lattice[(i0 + 2) * NJ + j]] - s.px[lattice[(i0 - 1) * NJ + j]]) / s.dp);
    }
    if (bx > 1.5e-3) for (const i of [i0 - 1, i0 + 2]) for (let j = 0; j < NJ; j++) face = Math.max(face, s.sxx[lattice[i * NJ + j]] - s.pres[lattice[i * NJ + j]]);
  }
  return { across, face };
}

// ── pulled apart by a front tension: the faces unload
{
  const one = cut('none', 200e6);
  const two = cut('dfg', 200e6);
  between(two.face / one.face, 0, 0.7, `a cut pulled apart (front tension 200 MPa): largest σxx next to the faces, 'dfg' over the single field (${(one.face * 1e-6).toFixed(0)} MPa)`);
}

// ── closed through the bite: the faces hold each other off
{
  const two = cut('dfg', 0);
  between(two.across, 2.9, 10, "a cut closed through the bite, 'dfg': the smallest spacing of the points across it [dp] (3 at the start)");
}
done();
