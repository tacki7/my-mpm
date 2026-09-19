// Whether the pass's shape puts the middle of the thickness into hydrostatic tension, from the condition alone:
// Δ = mean thickness / contact length against the central-burst map (docs/validation.md「中心割れの地図」, T53 and
// T65): the mid-plane η in the bite turns positive at Δ 2.1–2.9 for 4340 and 2.2–3.7 for SPCC (grids of 8 to 20
// cells, R 15 mm, μ 0.2, no tension; the reductions of 5 and 10 % gave nearly the same). A finer grid turns the
// middle tensile at a smaller Δ and the sequence has not settled by 20 cells, so the band's low end is the finest
// grid measured, not a converged value. A material is read against the map
// of the one it hardens like: the flow stress at εp 0.5 over the one at 0 (4340 1.5, SPCC 2.4; AL6061 1.3 goes with
// 4340). With it, once the stand is steady, the mid-plane η measured the map's way (src/mpm/midplane.ts).
// Δ here is the page's (thicknessRatio: the contact length on the arc); the map wrote it (1 − r/2) √(h0 / (r R)),
// about 0.4 % less at the preset's point (3.56 against 3.58), well inside the map's grid spread.
import type { SimParams } from '../mpm/params.ts';
import { flowStress } from '../mpm/material.ts';
import { thicknessRatio } from './slabOverlay.ts';

/** where the mid-plane η turns positive, over the grids of the map (Δ from lo to hi; 8 to 20 cells) */
export const BURST_DELTA = {
  weak: { lo: 2.1, hi: 2.9, name: '4340 系（加工硬化が弱い）' },
  strong: { lo: 2.2, hi: 3.7, name: 'SPCC 系（加工硬化が強い）' },
} as const;

export type BurstKind = 'compressive' | 'near' | 'tensile';

/** the flow stress at εp 0.5 over the one at 0 (static rate, room temperature): 2 and more reads as SPCC */
export function hardeningRatio(P: SimParams): number {
  const m = P.material;
  const at = (ep: number) => flowStress(m, ep, m.epsDot0, m.tRoom).sy;
  return at(0.5) / at(0);
}

export function burstBand(P: SimParams): (typeof BURST_DELTA)[keyof typeof BURST_DELTA] {
  return hardeningRatio(P) < 2 ? BURST_DELTA.weak : BURST_DELTA.strong;
}

export function burstKind(delta: number, band: { lo: number; hi: number }): BurstKind {
  return delta < band.lo ? 'compressive' : delta <= band.hi ? 'near' : 'tensile';
}

const HEAD: Record<BurstKind, string> = {
  compressive: '板厚中心は圧縮',
  near: '板厚中心が引張に変わる境目の近く',
  tensile: '板厚中心が静水圧の引張になる形（中心割れが出やすい）',
};

export class BurstHint {
  private readonly el: HTMLElement;
  private key = '';

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** P: the stand on show's condition (its entry thickness); eta: its steady mid-plane η so far (null before) */
  update(P: SimParams, eta: number | null): void {
    const delta = thicknessRatio(P.rolling);
    const band = burstBand(P);
    const kind = burstKind(delta, band);
    const key = `${delta}|${band.lo}|${eta}`;
    if (key === this.key) return;
    this.key = key;
    const d = delta.toFixed(2);
    const el = this.el;
    el.dataset.delta = String(delta);
    el.dataset.kind = kind;
    el.dataset.eta = eta != null ? String(eta) : '';
    const head = document.createElement('strong');
    head.textContent = `${HEAD[kind]}（Δ = ${d}）`;
    const measured = document.createElement('span');
    measured.className = 'burst-eta';
    measured.textContent =
      eta != null ? `定常の板厚中心の η（実測）: ${eta >= 0 ? '+' : ''}${eta.toFixed(3)}` : '板厚中心の η の実測は、定常に入ると出る';
    const note = document.createElement('span');
    note.className = 'burst-note';
    note.textContent =
      `Δ = 平均板厚 / 接触長。${band.name}の地図では Δ ${band.lo}〜${band.hi} で板厚中心の η が正に変わる` +
      '（張力なし・μ 0.2、格子 8〜20 セルの幅。細かい格子ほど小さい Δ で変わる。張力・摩擦・格子で変わる）';
    el.replaceChildren(head, measured, note);
  }
}
