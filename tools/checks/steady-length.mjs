// The sheet length a stand needs to get to a 'steady' handoff under a front tension (src/mpm/tandem.ts
// steadyLength, src/mpm/solid/tandem3.ts steadyLength3), pure and well under a second: with the default ramp
// (10 L / c) the length holds its own ramp, L = base / (1 − 10 vIn / c), while the ramp's stretch is at most
// RAMP_SHARE_MAX of the sheet, and is base / (1 − RAMP_SHARE_MAX) beyond — with a mass scaling large enough for
// the wave speed c to come near 10 vIn it ran away, and past c = 10 vIn it was negative (ms 1e6: −54 mm, and
// that reached new Sim; 2026-09-30). A ramp given is added as it is, and with no front tension the length is base.
// @check
import { ok, near, between, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { elasticConstants } from '../../src/mpm/material.ts';
import { RAMP_SHARE_MAX, READ_STEPS, steadyLength } from '../../src/mpm/tandem.ts';
import { TAIL_PER_WIDTH, steadyLength3 } from '../../src/mpm/solid/tandem3.ts';
import { solidParams } from '../../src/mpm/solid/sim3.ts';

const P = (ms, tf = 100e6, ramp = 0) => {
  const Q = defaultParams();
  Q.numerics.cellsThrough = 4;
  Q.numerics.massScale = ms;
  Q.rolling.frontTension = tf;
  if (ramp > 0) Q.rolling.tensionRamp = ramp;
  return Q;
};
/** the sheet the default ramp takes over the sheet: 10 vIn / c */
const share = (Q) => {
  const el = elasticConstants(Q.material);
  const c = Math.sqrt((el.K + (4 / 3) * el.G) / (Q.material.rho * Q.numerics.massScale));
  return (10 * Q.rolling.rollSpeed * (1 - Q.rolling.reduction)) / c;
};
const vIn = defaultParams().rolling.rollSpeed * (1 - defaultParams().rolling.reduction);

between(RAMP_SHARE_MAX, 0.1, 0.9, 'RAMP_SHARE_MAX is a share');
between(share(P(1e4)), 0.1, 0.2, 'ms 1e4: the ramp takes about an eighth of the sheet (10 vIn / c)');
ok(share(P(1e6)) > 1, 'ms 1e6: c < 10 vIn, no length holds its own ramp', `10 vIn / c = ${share(P(1e6)).toFixed(3)}`);

for (const [name, L] of [
  ['section', (Q) => steadyLength(Q, READ_STEPS)],
  ['3D', (Q) => steadyLength3(solidParams(Q, { width: 4e-3 }))],
]) {
  const base = (ms) => L(P(ms, 0));
  ok(base(1e4) > 0 && base(1e6) > base(1e4), `${name}: base is positive (and longer with a larger mass scaling: the readings cover more sheet)`, `${(base(1e4) * 1e3).toFixed(2)}, ${(base(1e6) * 1e3).toFixed(2)} mm`);
  near(L(P(1e4)), base(1e4) / (1 - share(P(1e4))), 1e-12, `${name}, ms 1e4: base / (1 − 10 vIn / c)`);
  const L6 = L(P(1e6));
  ok(Number.isFinite(L6) && L6 > 0, `${name}, ms 1e6: finite and positive`, `${(L6 * 1e3).toFixed(2)} mm`);
  near(L6, base(1e6) / (1 - RAMP_SHARE_MAX), 1e-12, `${name}, ms 1e6: the cap base / (1 − RAMP_SHARE_MAX)`);
  let bad = [];
  let prev = 0;
  for (const ms of [1e4, 3e4, 1e5, 2e5, 5e5, 1e6, 1e7, 1e8]) {
    const r = L(P(ms)) / base(ms);
    if (!(r >= 1 && r <= 1 / (1 - RAMP_SHARE_MAX) + 1e-12 && r >= prev - 1e-12)) bad.push(`ms ${ms}: ${r.toFixed(3)}`);
    prev = r;
  }
  ok(bad.length === 0, `${name}: L / base is between 1 and the cap and never falls as the mass scaling grows`, bad.join(', '));
  near(L(P(1e6, 100e6, 2e-3)), base(1e6) + 2e-3 * vIn, 1e-12, `${name}: a ramp given adds ramp × vIn whatever the mass scaling`);
  near(L(P(1e6, 0, 2e-3)), base(1e6), 0, `${name}: with no front tension the ramp given changes nothing`);
}
// the 3D length carries a tail of TAIL_PER_WIDTH × the width (a strip wider than it is long bows in plane instead of
// coming out with the elongation difference its crown rolled: docs/model.md「板の長さ「定常状態になるまで」」)
{
  const L3 = (w) => steadyLength3(solidParams(P(1e4, 0), { width: w }));
  between(TAIL_PER_WIDTH, 0.3, 1, 'the tail is a good share of the width');
  near(L3(60e-3) - L3(4e-3), TAIL_PER_WIDTH * 56e-3, 1e-12, '3D: a strip 56 mm wider is TAIL_PER_WIDTH × 56 mm longer');
  ok(L3(4e-3) - TAIL_PER_WIDTH * 4e-3 > 5e-3, '3D: the width-free part is the bite and the head out, several mm', `${((L3(4e-3) - TAIL_PER_WIDTH * 4e-3) * 1e3).toFixed(2)} mm`);
  const Q = P(1e4);
  near(steadyLength3(solidParams(Q, { width: 60e-3 })) - steadyLength3(solidParams(Q, { width: 4e-3 })), (TAIL_PER_WIDTH * 56e-3) / (1 - share(Q)), 1e-12, '3D: under a front tension the tail holds its share of the ramp too');
}
done();
