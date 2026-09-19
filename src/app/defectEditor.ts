// The defects of the conditions panel: voids (no material) and weak regions (damage
// accumulates faster), each an ellipse placed in the undeformed sheet — from the head
// end backwards and from the mid-plane — with its half sizes. Shown in mm.
import type { Defect, SimParams } from '../mpm/params.ts';
import { checkRange } from './fieldCheck.ts';

const mm = 1e-3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface DefectEditor {
  root: HTMLElement;
  show(p: SimParams): void;
  /** the defects typed, clamped into the sheet of p */
  read(p: SimParams): Defect[];
}

interface Row {
  el: HTMLElement;
  kind: HTMLSelectElement;
  num: Record<'x' | 'y' | 'ax' | 'ay' | 'ductility', HTMLInputElement>;
  checks: (() => void)[];
}

export function buildDefectEditor(onEdit: () => void): DefectEditor {
  const root = el('fieldset', 'group defects');
  root.append(el('legend', undefined, '欠陥'));
  const list = el('ol', 'defect-list');
  const empty = el('p', 'hint', '欠陥は無い。空洞（材料の無い穴）か弱い部分（損傷が早く進む）を置ける。');
  const add = el('button', 'add-defect', '欠陥を追加');
  add.type = 'button';
  root.append(empty, list, add);

  let rows: Row[] = [];
  // the sheet the ranges refer to (updated by show; the length and thickness can change in the panel)
  let sheet = { L: 16 * mm, h0: 1 * mm };

  const ranges: Record<keyof Row['num'], () => [number, number]> = {
    x: () => [0, sheet.L / mm],
    y: () => [-sheet.h0 / 2 / mm, sheet.h0 / 2 / mm],
    ax: () => [0.01, sheet.L / mm],
    ay: () => [0.01, sheet.h0 / mm],
    ductility: () => [0.01, 1],
  };
  const clamp = (k: keyof Row['num'], v: number) => {
    const [lo, hi] = ranges[k]();
    return Math.min(hi, Math.max(lo, v));
  };

  const refresh = () => {
    empty.hidden = rows.length > 0;
    rows.forEach((r, i) => {
      (r.el.querySelector('.defect-name') as HTMLElement).textContent = `欠陥 ${i + 1}`;
      r.num.ductility.closest('label')!.hidden = r.kind.value !== 'weak';
    });
  };

  const addRow = (d: Defect) => {
    const li = el('li', 'defect');
    const head = el('div', 'defect-head');
    head.append(el('span', 'defect-name'));
    const kind = el('select');
    kind.name = 'defect-kind';
    kind.setAttribute('aria-label', '欠陥の種類');
    for (const [v, t] of [
      ['void', '空洞'],
      ['weak', '弱い部分'],
    ]) {
      const o = el('option', undefined, t);
      o.value = v;
      kind.append(o);
    }
    kind.value = d.kind;
    const del = el('button', 'remove-defect', '削除');
    del.type = 'button';
    head.append(kind, del);
    li.append(head);

    const field = (k: keyof Row['num'], label: string, unit: string, value: number, step: number) => {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', label));
      const box = el('span', 'field-input');
      const input = el('input');
      input.type = 'number';
      input.name = `defect-${k}`;
      input.step = String(step);
      input.value = String(+value.toPrecision(6));
      box.append(input);
      if (unit) box.append(el('span', 'unit', unit));
      row.append(box);
      li.append(row);
      input.addEventListener('input', onEdit);
      return { input, check: checkRange(input, row, ranges[k], unit) };
    };
    const fx = field('x', '先端からの距離', 'mm', d.x / mm, 0.1);
    const fy = field('y', '板厚中心からの距離', 'mm', d.y / mm, 0.01);
    const fax = field('ax', '圧延方向の半径', 'mm', d.ax / mm, 0.01);
    const fay = field('ay', '板厚方向の半径', 'mm', d.ay / mm, 0.01);
    const fd = field('ductility', '延性の倍率', '', d.ductility ?? 0.3, 0.05);
    const row: Row = {
      el: li,
      kind,
      num: { x: fx.input, y: fy.input, ax: fax.input, ay: fay.input, ductility: fd.input },
      checks: [fx.check, fy.check, fax.check, fay.check, fd.check],
    };
    kind.addEventListener('change', () => {
      refresh();
      onEdit();
    });
    del.addEventListener('click', () => {
      rows = rows.filter((r) => r !== row);
      li.remove();
      refresh();
      onEdit();
    });
    rows.push(row);
    list.append(li);
    for (const c of row.checks) c();
  };

  add.addEventListener('click', () => {
    // a small void at the middle of the sheet, on the mid-plane
    addRow({ kind: 'void', x: sheet.L / 2, y: 0, ax: Math.min(0.4 * mm, sheet.L / 8), ay: Math.min(0.12 * mm, sheet.h0 / 6) });
    refresh();
    onEdit();
    rows[rows.length - 1].num.x.focus();
  });

  return {
    root,
    show(p) {
      sheet = { L: p.rolling.sheetLength, h0: p.rolling.h0 };
      rows = [];
      list.replaceChildren();
      for (const d of p.defects) addRow(d);
      refresh();
    },
    read(p) {
      sheet = { L: p.rolling.sheetLength, h0: p.rolling.h0 };
      return rows.map((r) => {
        const v = (k: keyof Row['num'], fallback: number) => {
          const x = parseFloat(r.num[k].value);
          return clamp(k, Number.isFinite(x) ? x : fallback);
        };
        const d: Defect = {
          kind: r.kind.value as Defect['kind'],
          x: v('x', sheet.L / 2 / mm) * mm,
          y: v('y', 0) * mm,
          ax: v('ax', 0.4) * mm,
          ay: v('ay', 0.12) * mm,
        };
        if (d.kind === 'weak') d.ductility = v('ductility', 0.3);
        return d;
      });
    },
  };
}
