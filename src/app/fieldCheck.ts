// Range check of a number input as it is typed: outside [min, max] the row turns
// red and says the range, and what "条件を反映" would use instead (the value is
// clamped then). Also used by the material and defect editors.

const fmt = (v: number) => String(+v.toPrecision(4));

/**
 * Watch `input` (inside `row`) against the range the getters give (they may depend on
 * other conditions, like the sheet length). Returns a function that re-checks.
 */
export function checkRange(
  input: HTMLInputElement,
  row: HTMLElement,
  range: () => [number, number],
  unit = '',
): () => void {
  const why = document.createElement('span');
  why.className = 'why';
  why.setAttribute('aria-live', 'polite');
  row.append(why);
  const check = () => {
    const [lo, hi] = range();
    const v = parseFloat(input.value);
    const bad = !Number.isFinite(v) || v < lo || v > hi;
    row.classList.toggle('bad', bad);
    input.setAttribute('aria-invalid', String(bad));
    const u = unit ? ` ${unit}` : '';
    why.textContent = !bad
      ? ''
      : Number.isFinite(v)
        ? `${fmt(lo)}〜${fmt(hi)}${u} の範囲で（このままだと ${fmt(Math.min(hi, Math.max(lo, v)))}${u} で計算する）`
        : `数を入れる（${fmt(lo)}〜${fmt(hi)}${u}）`;
  };
  input.addEventListener('input', check);
  return check;
}
