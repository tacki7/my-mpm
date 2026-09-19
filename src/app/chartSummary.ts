// A few words for a screen reader under each chart (the charts are canvases, their lines are not read): the steady
// load against the slab method's, the steady friction hill's peak pressure and the slab method's neutral point, and
// the point shown on the fracture locus. Written when a stand's steady reading first comes and when the pass is
// over, not at every frame; each says which of the two moments it is.
import type { Track, TrackRole } from './protocol.ts';
import { slabRatio, type Profile, type SlabReference } from './slabOverlay.ts';

export interface ChartFacts {
  /** the steady mean load [N/m] (null before the steady reading) */
  force: number | null;
  slab: SlabReference;
  /** the steady mean friction hill (null before it) */
  profile: Profile | null;
  /** the point shown in the stress state (null: none yet) */
  point: Track | null;
}

const ROLE: Record<TrackRole, string> = { selected: '選んだ点', 'first-crack': '最初の亀裂', 'max-damage': '損傷最大' };

export class ChartSummary {
  private readonly force: HTMLElement;
  private readonly hill: HTMLElement;
  private readonly locus: HTMLElement;
  private moment = '';

  /** the three figures (荷重, フリクションヒル, 破断軌跡): a visually hidden line is added to each */
  constructor(force: HTMLElement, hill: HTMLElement, locus: HTMLElement) {
    const line = (figure: HTMLElement) => {
      const p = document.createElement('p');
      p.className = 'sr-only chart-summary';
      figure.append(p);
      return p;
    };
    this.force = line(force);
    this.hill = line(hill);
    this.locus = line(locus);
  }

  /** a new run: nothing to say yet */
  clear(): void {
    this.moment = '';
    for (const p of [this.force, this.hill, this.locus]) p.textContent = '';
  }

  /**
   * moment: the pass is over ('done'), a stand's steady reading has come (`steady <stand>`), or neither (null);
   * the facts are read and the words written only when the moment is a new one. stands: the run's number of stands.
   */
  update(moment: string | null, stands: number, facts: () => ChartFacts): void {
    if (moment === null || moment === this.moment) return;
    this.moment = moment;
    const f = facts();
    const stand = moment.startsWith('steady ') ? Number(moment.slice(7)) : null;
    const when = stand === null ? 'パスの終わり' : stands > 1 ? `#${stand + 1} の定常の読みが出たとき` : '定常の読みが出たとき';
    const kN = (v: number) => `${(v * 1e-6).toFixed(2)} kN/mm`;
    const ratio = slabRatio(f.slab, f.force);
    this.force.textContent =
      `（${when}）` +
      (f.force == null ? '定常の荷重の読みは無い' : `定常の荷重（グラフの平均）${kN(f.force)}`) +
      (f.slab.outside ? `。スラブ法は方法の外（${f.slab.outside}）` : `。スラブ法 ${kN(f.slab.force)}${ratio != null ? `、比 ${ratio.toFixed(2)}` : ''}`);
    let peak = -Infinity;
    let at = 0;
    if (f.profile) for (let i = 0; i < f.profile.p.length; i++) if (f.profile.p[i] > peak) [peak, at] = [f.profile.p[i], f.profile.x[i]];
    this.hill.textContent =
      `（${when}）` +
      (f.profile && peak > 0 ? `定常の平均の圧力のピーク ${(peak * 1e-6).toFixed(0)} MPa（出口から x = ${(at * 1e3).toFixed(2)} mm）` : '定常の平均の圧力は無い') +
      (f.slab.outside ? '' : `。スラブ法の中立点 x = ${(f.slab.xNeutral * 1e3).toFixed(2)} mm`);
    const s = f.point?.state;
    this.locus.textContent =
      `（${when}）` +
      (f.point && s ? `${ROLE[f.point.role]}: 三軸度 η ${s.eta.toFixed(3)}、塑性ひずみ εp ${s.ep.toFixed(4)}、損傷 ${s.damage.toFixed(3)}` : '表示中の点は無い');
  }
}
