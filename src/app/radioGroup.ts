// A row of role="radio" buttons as one radio group for the keyboard (WAI-ARIA APG, radio group): one Tab stop,
// the checked button (or the first that can be chosen), and the arrow keys move the choice, Home and End to the
// ends, wrapping round, skipping the disabled ones; each move clicks the button it lands on, so the choice goes
// through the same handler as a click. The Tab stop follows aria-checked and disabled wherever they are set.
export function radioGroup(group: HTMLElement): void {
  const buttons = () => [...group.querySelectorAll<HTMLButtonElement>('[role=radio]')];
  const roving = () => {
    const all = buttons();
    const on = all.find((b) => b.getAttribute('aria-checked') === 'true' && !b.disabled) ?? all.find((b) => !b.disabled);
    for (const b of all) b.tabIndex = b === on ? 0 : -1;
  };
  new MutationObserver(roving).observe(group, { subtree: true, childList: true, attributeFilter: ['aria-checked', 'disabled'] });
  roving();
  group.addEventListener('keydown', (e) => {
    const all = buttons().filter((b) => !b.disabled);
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const n = all.length;
    const moves: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const b = all[(to + n) % n];
    b.focus();
    b.click();
  });
}
