/** A fixed number of table rows (the list's --rows, 8 by default). Navigation changes their contents without moving the table. */
const DOT = 8; // rail dot pitch in px, matching the .matrix-rail background

export function stepScroll(list: HTMLElement, rail: HTMLElement) {
  const thumb = rail.firstElementChild as HTMLElement;
  let count = 0;
  let first = 0;
  let render = (_first: number, _end: number) => {};
  const rowsFromCss = () => Number(getComputedStyle(list).getPropertyValue("--rows")) || 8;
  let visible = rowsFromCss();
  const maxStep = () => Math.max(0, count - visible);

  function paint() {
    const max = maxStep();
    rail.hidden = max === 0;
    if (!max) return;
    const dots = Math.floor(rail.clientHeight / DOT);
    const size = Math.min(dots, Math.max(2, Math.round(dots * visible / count)));
    thumb.style.height = `${size * DOT}px`;
    thumb.style.top = `${Math.round(first / max * (dots - size)) * DOT}px`;
  }

  function go(n: number): boolean {
    const next = Math.min(maxStep(), Math.max(0, n));
    if (next === first) return false;
    first = next;
    render(first, Math.min(count, first + visible));
    paint();
    return true;
  }

  let wheel = 0;
  list.addEventListener("wheel", (e) => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * 400 : e.deltaY;
    if ((delta < 0 && first === 0) || (delta > 0 && first === maxStep())) {
      wheel = 0;
      return;
    }
    wheel += delta;
    const rows = Math.trunc(wheel / 50);
    if (rows) {
      wheel -= rows * 50;
      go(first + rows);
    }
  }, { passive: false });

  let touchPointer = -1;
  let touchY = 0;
  let touchX = 0;
  list.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || touchPointer !== -1) return;
    touchPointer = e.pointerId;
    touchX = e.clientX;
    touchY = e.clientY;
  });
  list.addEventListener("pointermove", (e) => {
    if (e.pointerId !== touchPointer) return;
    const dx = e.clientX - touchX;
    const dy = e.clientY - touchY;
    if (Math.abs(dx) > Math.abs(dy) || Math.abs(dy) < 6) return;
    // Rows are replaced during a swipe, so capture on the list before removing
    // the touched row. Subsequent moves still reach this stable element.
    if (!list.hasPointerCapture(e.pointerId)) list.setPointerCapture(e.pointerId);
    const pitch = list.clientHeight / visible;
    const rows = Math.trunc(-dy / (pitch * 0.6));
    if (rows && go(first + rows)) touchY = e.clientY;
  });
  const endTouch = (e: PointerEvent) => {
    if (e.pointerId === touchPointer) touchPointer = -1;
  };
  list.addEventListener("pointerup", endTouch);
  list.addEventListener("pointercancel", endTouch);

  list.addEventListener("keydown", (e) => {
    if (e.target !== list) return;
    const to = { ArrowDown: first + 1, ArrowUp: first - 1,
      PageDown: first + visible - 1, PageUp: first - visible + 1,
      Home: 0, End: maxStep() }[e.key];
    if (to !== undefined) {
      go(to);
      e.preventDefault();
    }
  });

  const seek = (e: PointerEvent) => {
    const r = rail.getBoundingClientRect();
    go(Math.round((e.clientY - r.top) / r.height * maxStep()));
  };
  rail.addEventListener("pointerdown", (e) => {
    rail.setPointerCapture(e.pointerId);
    seek(e);
  });
  rail.addEventListener("pointermove", (e) => {
    if (rail.hasPointerCapture(e.pointerId)) seek(e);
  });
  new ResizeObserver(paint).observe(rail);
  // The row count changes with the layout (fewer, taller rows on small screens).
  new ResizeObserver(() => {
    const next = rowsFromCss();
    if (next === visible) return;
    visible = next;
    first = Math.min(first, maxStep());
    render(first, Math.min(count, first + visible));
    paint();
  }).observe(list);

  return {
    setRows(nextCount: number, nextRender: (first: number, end: number) => void) {
      count = nextCount;
      render = nextRender;
      first = Math.min(first, maxStep());
      render(first, Math.min(count, first + visible));
      paint();
    },
  };
}
