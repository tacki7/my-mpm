// The faces of a crack in the plan view (numerics.crackFields 'dfg' in src/mpm/planview/sim.ts, as the section
// model's, docs/model.md「亀裂の面」): near a crack the points split into two velocity fields by the side they are
// on, and the fields meet by frictionless contact. On a coarse 10 mm wide strip, about 15 s:
// - no failed point: 'dfg' is the single field bit for bit (both tensions on, so the pusher, the grips and the
//   friction all act)
// - a cut from the edge to half the half width, in the incoming strip, pulled by a back tension against the rolls:
//   the points next to its faces unload (with one field the grid joins the faces: a cut narrower than the
//   stencil carries the tension across; a cut through the bite opens by itself, the exit being faster, so the
//   check is on the entry side)
// - the same from the mid-width plane: the rows next to the symmetry plane unload too (the failed points' mirror
//   images count in G and C)
// - the contact between the fields keeps the momentum at every node
// - the 'dfg' runs are looked at and stay finite; run on through the bite, the second field is handled as the first:
//   the grid friction adds up (points to nodes, capacity to points), the second field's nodes take a capacity, the
//   grid's mass after the fold is the points', the fields do not approach again where neither friction nor the pusher
//   acts; and a cut next to the pusher's column keeps the tail at the entry speed while it pushes
// Calibrated on copies: the contact normal alone reversed (the faces held together when they separate) fails three
// items (edge ratio 0.93, 171 MPa by the plane, the fields approaching again); the single field ('dfg' taken as
// 'none') fails eight; G and C not folded across the symmetry plane fails two (105 MPa by the plane); the copies of
// the second review each fail their items (at the end). The bounds sit between the working values (edge ratio 0.36,
// 10 MPa by the plane) and those copies
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

// a cut through lattice columns i0, i0 + 1 and rows [k0, k1) (failed at the start): a fifth of the strip from the tail,
// from the edge ('edge') or from the mid-width ('mid') to half the half width, or from the edge next to the pusher's
// column ('tail', run only while the pusher pushes); back tension 100 MPa. σxx of the points next to its faces
// (columns i0 − 1 and i0 + 2) per row, averaged over the looks every 50 steps while the rolls pull against the
// tension (the pusher off, the tension on) and the cut is still 1 mm before the entry. `through` runs on to the end of
// the pass for the watch; `finite`: every point's position and velocity finite and under ten times the roll speed
const TB = 100e6;
function cut(mode, where, { through = false, watch } = {}) {
  const b = defaultParams();
  b.rolling.sheetLength = 12e-3;
  b.rolling.backTension = TB;
  b.damage.model = 'none';
  b.numerics.crackFields = mode;
  const s = new PlanSim(planParams(b, W, 10));
  watch?.start?.(s);
  const { NI, NK, lattice } = s;
  const i0 = where === 'tail' ? 2 : Math.floor(NI / 5);
  const k0 = where === 'mid' ? 0 : Math.round(NK / 2);
  const k1 = where === 'mid' ? Math.round(NK / 2) : NK;
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
  let measuring = where !== 'tail';
  let finite = true;
  const vMax = 10 * b.rolling.rollSpeed;
  while (s.phase() !== 'done' && s.step < 30000) {
    for (let k = 0; k < 50; k++) {
      watch?.before?.(s);
      s.advance();
      contacts += s.fieldContacts;
      watch?.after?.(s);
    }
    for (let p = 0; p < s.n && finite; p++) {
      if (s.active[p] && !(Number.isFinite(s.px[p]) && Number.isFinite(s.pz[p]) && Math.hypot(s.vx[p], s.vz[p]) < vMax)) finite = false;
    }
    if (where === 'tail' && !s.pusherActive) break;
    if (!measuring) continue;
    let x = 0;
    for (let k = k0; k < k1; k++) x += s.px[lattice[i0 * NK + k]] / (k1 - k0);
    if (x > -s.contactLength - 1e-3) {
      measuring = false;
      if (!through) break;
      continue;
    }
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
  return { face: rows.reduce((a, v) => a + v, 0) / rows.length, rows, looks, contacts, finite, steps: s.step };
}

// the real nodes (k ≥ kSym) of both fields after the fold, and the second field's offset
const realNodes = (s) => {
  const kSym = Math.round(-s.oz / s.h);
  const N = s.nxN * s.nzN;
  const out = [];
  for (let i = 0; i < s.nxN; i++) for (let k = kSym; k < s.nzN; k++) out.push(i * s.nzN + k);
  return { nodes: out, N };
};

// ── pulled apart by the back tension: the faces unload; the contact keeps the momentum; run on through the bite, the
//    grid friction adds up on both fields: the points' friction to the nodes' (A), the nodes' capacity to the
//    points' (B), and the second field's nodes do get a capacity (C)
{
  const one = cut('none', 'edge');
  let worst = 0;
  const fr = { steps: 0, sum: 0, cap: 0, second: 0 };
  let grid;
  const two = cut('dfg', 'edge', {
    through: true,
    watch: {
      start(s) {
        grid = realNodes(s);
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
      },
      after(s) {
        if (!s.pf) return;
        const { nodes, N } = grid;
        let second = false;
        for (let i = N; i < 2 * N && !second; i++) if (s.gcap[i] > 0) second = true;
        if (second) fr.second++;
        let fp = 0;
        let fcap = 0;
        for (let p = 0; p < s.n; p++) {
          if (!s.active[p]) continue;
          fp += s.fricX[p];
          fcap += s.fcap[p];
        }
        if (!(fcap > 0) || s.frictionNow === 0) return;
        let gc = 0;
        for (const i of nodes) gc += s.gcap[i] + s.gcap[i + N];
        fr.steps++;
        fr.sum = Math.max(fr.sum, Math.abs(fp - s.frictionNow) / Math.abs(s.frictionNow));
        fr.cap = Math.max(fr.cap, Math.abs(gc - fcap) / fcap);
      },
    },
  });
  ok(one.looks >= 10 && one.face > 100e6, 'a cut from the edge pulled by the back tension, single field: the faces carry it (the case this checks)', `mean σxx next to the faces ${(one.face * 1e-6).toFixed(0)} MPa over ${one.looks} looks`);
  ok(two.looks >= 10 && two.finite, "the same, 'dfg': looked at, and every point finite and under ten times the roll speed to the end of the pass", `${two.looks} looks, ${two.steps} steps`);
  between(two.face / one.face, -0.5, 0.7, "the same, 'dfg': mean σxx next to the faces over the single field's");
  ok(two.contacts > 0 && worst < 1e-12, 'the contact between the fields keeps the momentum at every node', `${two.contacts} node-steps in contact, largest relative change ${worst.toExponential(1)}`);
  ok(fr.steps > 1000 && fr.sum < 1e-9 && fr.cap < 1e-9, "the same through the bite: the points' friction adds up to the nodes' and the nodes' capacity to the points', on both fields", `over ${fr.steps} steps: friction ${fr.sum.toExponential(1)}, capacity ${fr.cap.toExponential(1)}`);
  ok(fr.second >= 100, "the same: the second field's nodes take a friction capacity (from the points on it in contact)", `${fr.second} steps`);
}

// ── from the mid-width plane to half the half width, 'dfg': the two rows next to the symmetry plane unload too; run on
//    through the bite, the grid's mass after the fold is the points' (E), and where neither friction nor the pusher acts
//    after the contact, the two fields do not approach again (F)
{
  const g = { massSteps: 0, mass: 0, again: 0, both: 0, m0: 0, n0: 0 };
  let grid;
  const mid = cut('dfg', 'mid', {
    through: true,
    watch: {
      start(s) {
        grid = realNodes(s);
      },
      before(s) {
        g.m0 = 0;
        g.n0 = 0;
        for (let p = 0; p < s.n; p++) {
          if (!s.active[p]) continue;
          g.m0 += s.mass[p];
          g.n0++;
        }
      },
      after(s) {
        if (!s.pf) return;
        const { nodes, N } = grid;
        let n = 0;
        for (let p = 0; p < s.n; p++) n += s.active[p];
        if (n === g.n0) {
          let m = 0;
          for (const i of nodes) m += s.gm[i] + s.gm[i + N];
          g.massSteps++;
          g.mass = Math.max(g.mass, Math.abs(m - g.m0) / g.m0);
        }
        const mMin = 1e-12 * s.mass[0];
        const vR = s.params.rolling.rollSpeed;
        for (const i of nodes) {
          if (!(s.gm[i] > mMin && s.gm[i + N] > mMin)) continue;
          const G = Math.hypot(s.gGx[i], s.gGz[i]);
          if (G === 0) continue;
          if (s.gcap[i] > 0 || s.gcap[i + N] > 0 || s.gpush[i] || s.gpush[i + N]) continue;
          g.both++;
          if (((s.gvx[i] - s.gvx[i + N]) * s.gGx[i] + (s.gvz[i] - s.gvz[i + N]) * s.gGz[i]) / G > 1e-9 * vR) g.again++;
        }
      },
    },
  });
  ok(mid.looks >= 10 && mid.finite, "a cut from the mid-width, 'dfg': looked at, and every point finite to the end of the pass", `${mid.looks} looks, ${mid.steps} steps`);
  between(((mid.rows[0] + mid.rows[1]) / 2) * 1e-6, -14, 14, `the same: mean σxx next to the faces in the two rows by the symmetry plane [MPa] (back tension ${TB * 1e-6} MPa; the cut's mean ${(mid.face * 1e-6).toFixed(0)} MPa)`);
  ok(g.massSteps > 1000 && g.mass < 1e-12, "the same: the grid's mass after the fold across the symmetry plane is the points' (both fields)", `largest relative difference ${g.mass.toExponential(1)} over ${g.massSteps} steps`);
  ok(g.both > 1000 && g.again === 0, 'the same: where neither friction nor the pusher acts after the contact, the two fields do not approach again', `${g.again} of ${g.both} node-steps`);
}

// ── a cut from the edge next to the pusher's column, 'dfg': while the pusher pushes, the tail column keeps at least the
//    entry speed (the pusher's marks on the field each point is on) (D)
{
  let slow = 0;
  let looked = 0;
  const tail = cut('dfg', 'tail', {
    watch: {
      after(s) {
        if (!s.pf || !s.pusherActive) return;
        for (let p = 0; p < s.n; p++) {
          if (!s.active[p] || s.li[p] !== 0) continue;
          looked++;
          if (s.vx[p] < s.vIn * (1 - 1e-9)) slow++;
        }
      },
    },
  });
  ok(tail.finite && looked > 1000 && slow === 0, "a cut next to the pusher's column, 'dfg': while it pushes, no point of the tail column is slower than the entry speed", `${slow} of ${looked} point-steps`);
}

// Calibrated on copies, each broken in one place (the second review): the second field's node arrays never cleared
// (diverges within 50 steps: 'finite' and the looks), the friction total of the first field only and the second
// field's friction share read from the first (A), the capacity scattered to the first field only (A, C), the second
// field's capacity never cleared (B), the pusher's marks on the first field only (D), the mirror fold of the first
// field only (E), the field contact skipping the symmetry plane's row (F), the fold of G_z and C_z with the wrong sign
// (the plane's rows 17 MPa; here 10). No item sees these, and they change nothing that matters: the second field's
// pusher marks never cleared (the contact counts a little different), G and C cleared over this step's columns instead
// of last step's, pfAny not reset (bit for bit the same)
done();
