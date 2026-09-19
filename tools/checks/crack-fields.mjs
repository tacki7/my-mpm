// The faces of a crack (numerics.crackFields 'dfg', docs/model.md「亀裂の面」): near a crack the points split into
// two velocity fields by the side they are on, and the fields meet by frictionless contact. About 10 s:
// - no failed point: 'dfg' is the single field bit for bit (point arrays and every diagnostics read)
// - centreline cracks (central-burst, 8 cells, band ductility 1/100): the faces carry no tension across the crack
//   (the single field carries 175 MPa on average there)
// - a cut through the thickness pulled by a front tension (200 MPa, 4 cells): the points next to the faces unload
// - the same cut closed through the bite: the faces do not go through each other (with the contact normal the
//   wrong way round they did in the prototype: the band collapsed to a third)
// - the contact between the fields keeps the momentum at every node
// - on the closed cut, the second field as the first where the rolls and the volume are concerned: the rolls' impulse
//   on both fields is in the load (the momentum across the thickness balances), no contact mark left on the second
//   field, followRoll holds the second field's edges, the second field keeps its own volume averages (fieldWatch)
// Calibrated on copies: the contact normal alone reversed (the prototype's error: its side rule did not depend on
// the sign of G, its normal did) fails three items; the contact off four, the single field six; the four copies of
// the second review each fail their own item (fieldWatch). Reversing G throughout does not
// fail, and should not: with the 'centroid' side the assignment and the normal both follow G and stay consistent.
// The bounds sit between the working values and those copies: the largest σyy across the faces is 13 MPa here,
// 54 MPa with the contact off; the closed cut keeps 3.000 dp here, 2.98 on the single field, 2.14 with the contact
// off
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
  between(two.max * 1e-6, -1000, 30, "centreline cracks, 'dfg': the largest σyy across the faces [MPa] (no tension carried)");
  ok(two.contacts > 0 && two.worst < 1e-12, 'the contact between the fields keeps the momentum at every node', `${two.contacts} node-steps in contact, largest relative change ${two.worst.toExponential(1)}`);
}

// a cut through the thickness at the middle of the sheet (2 columns failed at the start), 4 cells, 6 mm
function cut(mode, tf, watch) {
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
  watch?.start(s);
  while (s.phase() !== 'done' && s.step < 60000) {
    for (let k = 0; k < 50; k++) {
      watch?.before(s);
      s.advance();
      watch?.after(s);
    }
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

// ── closed through the bite: the faces hold each other off; and the second field is handled as the first where the
//    load and the volume are concerned (these items see the second field's nodes touch the rolls)
{
  const w = fieldWatch();
  const two = cut('dfg', 0, w);
  between(two.across, 2.995, 10, "a cut closed through the bite, 'dfg': the smallest spacing of the points across it [dp] (3 at the start)");
  ok(w.balanceSteps > 1000 && w.balance < 1e-8, "the same: the sheet's momentum across the thickness changes by the rolls' impulse the load counts, every step (both fields)", `largest relative mismatch ${w.balance.toExponential(1)} over ${w.balanceSteps} steps`);
  ok(w.marked > 0 && w.stale === 0, "the same: a node marked in contact with a roll has mass in its field (the second field's marks are cleared)", `${w.stale} of ${w.marked} marks on massless nodes`);
  between(w.approachAfter / w.approachBefore, 0, 0.01, "the same: followRoll stops the edges of the points on the second field approaching the rolls (approach after / before)");
  between(w.averaged / w.mass, 0.1, 1, "the same: the second field's nodes carry its own volume averages (averaged mass / mass on the second field)");
}

// Per step of the closed cut: the momentum across the thickness against the rolls' impulse (−Δt Σ the roll forces the
// load reads), the contact marks on massless nodes, followRoll's own condition on the second field's points, and the
// mass in the second field's volume averages. The copies that passed the other items fail these: the second field's
// roll impulse left out of the load (mismatch 8.9e-3; here 7e-11), followRoll on the first field only (approach ratio
// 0.044; here 0.0014), the second field's marks not cleared (490 462 marks on massless nodes; here 0), the averages
// across the crack (no averaged mass on the second field; here 0.29). Each fails its own item and passes the rest. The last is read from the averages' own mass: at this grid the volume rates on the two
// sides of a cut are elastic and differ too little for a physical quantity to show the mixing
function fieldWatch() {
  const w = { balance: 0, balanceSteps: 0, marked: 0, stale: 0, approachBefore: 0, approachAfter: 0, averaged: 0, mass: 0, p: 0, n: 0, fy: [0, 0] };
  const momentum = (s) => {
    let py = 0;
    let n = 0;
    for (let p = 0; p < s.n; p++) {
      if (!s.active[p]) continue;
      py += s.mass[p] * s.vy[p];
      n++;
    }
    return [py, n];
  };
  w.start = (s) => {
    const N = s.nxN * s.nyN;
    const grid = s.gridUpdate;
    s.gridUpdate = function () {
      for (let k = 0; k < 2; k++) {
        for (let i = 0; i < s.NN; i++) {
          if (!(s.gpen[k][i] < 0)) continue;
          w.marked++;
          if (!(s.gm[i] > 0)) w.stale++;
        }
      }
      return grid.call(this);
    };
    const follow = s.followRoll;
    s.followRoll = function (fy, tq) {
      w.approachBefore += approach(s);
      follow.call(this, fy, tq);
      w.approachAfter += approach(s);
    };
    const update = s.g2pUpdate;
    s.g2pUpdate = function () {
      if (s.pf) {
        for (let i = N; i < 2 * N; i++) {
          w.averaged += s.gMv[i];
          w.mass += s.gm[i];
        }
      }
      return update.call(this);
    };
  };
  w.before = (s) => {
    [w.p, w.n] = momentum(s);
    w.fy = [s.accFy[0], s.accFy[1]];
  };
  w.after = (s) => {
    const [p, n] = momentum(s);
    const j0 = -s.dt * (s.accFy[0] - w.fy[0]);
    const j1 = -s.dt * (s.accFy[1] - w.fy[1]);
    const scale = Math.abs(j0) + Math.abs(j1);
    // a step where a point left the grid, or the rolls did nothing, says nothing
    if (n !== w.n || !(scale > 0)) return;
    w.balance = Math.max(w.balance, Math.abs(p - w.p - j0 - j1) / scale);
    w.balanceSteps++;
  };
  return w;
}

// followRoll's condition (solver.ts): over the points touching a roll that sit on the second field at a node, the
// edge's approach to the roll, Σ max(0, −edge) where edge = Σ w (v_i − u)·n − (half the point's height) n·L·n from
// the nodes of the field the point is on. It copies followRoll's edge: when followRoll changes, change this with it
function approach(s) {
  const { px, py, gvx, gvy, gcon, invH, ox, oy, nyN, h, pf, pfAny } = s;
  if (!pf) return 0;
  const N = s.nxN * nyN;
  const k4 = 4 * invH * invH;
  let sum = 0;
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p] || !s.touch[p] || !pfAny[p]) continue;
    const gx = (px[p] - ox) * invH;
    const gy = (py[p] - oy) * invH;
    const bx = Math.floor(gx - 0.5);
    const by = Math.floor(gy - 0.5);
    const fx = gx - bx;
    const fy = gy - by;
    const wx = [0.5 * (1.5 - fx) ** 2, 0.75 - (fx - 1) ** 2, 0.5 * (fx - 0.5) ** 2];
    const wy = [0.5 * (1.5 - fy) ** 2, 0.75 - (fy - 1) ** 2, 0.5 * (fy - 0.5) ** 2];
    for (let k = 0; k < 2; k++) {
      if (!(s.touch[p] & (1 << k))) continue;
      const roll = s.rolls[k];
      const rx = px[p] - roll.cx;
      const ry = py[p] - roll.cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      const ux = -roll.omega * roll.R * ny;
      const uy = roll.omega * roll.R * nx;
      let e = 0;
      let W = 0;
      let dnn = 0;
      for (let a = 0; a < 3; a++) {
        for (let c = 0; c < 3; c++) {
          const idx = (bx + a) * nyN + by + c + (pf[9 * p + 3 * a + c] ? N : 0);
          const wi = wx[a] * wy[c];
          e += wi * ((gvx[idx] - ux) * nx + (gvy[idx] - uy) * ny);
          dnn += wi * (gvx[idx] * nx + gvy[idx] * ny) * ((a - fx) * nx + (c - fy) * ny) * h;
          if (gcon[idx] & (1 << k)) W += wi;
        }
      }
      const edge = e - 0.5 * s.dp * Math.hypot(s.f01[p], s.f11[p]) * k4 * dnn;
      if (W > 0 && edge < 0) sum -= edge;
    }
  }
  return sum;
}

done();
