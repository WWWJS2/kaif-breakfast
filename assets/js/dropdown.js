// Accessible listbox dropdown. Desktop: floating panel. Phone: bottom sheet.
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
let openOne = null;

export function createDropdown(root, { renderValue, onChange }) {
  const id = 'dd-' + Math.random().toString(36).slice(2, 8);
  const labelledby = root.getAttribute('aria-labelledby');
  root.innerHTML = `
    <button type="button" class="dd__trigger" aria-haspopup="listbox" aria-expanded="false"
            aria-controls="${id}" aria-labelledby="${labelledby} ${id}-v">
      <span class="dd__value" id="${id}-v"><span class="dd__ph" aria-hidden="true">—</span></span>
      <span class="dd__chev">${chevron}</span>
    </button>
    <span class="dd__scrim" aria-hidden="true"></span>
    <div class="dd__panel"><span class="dd__sheet-bar" aria-hidden="true"></span>
      <ul class="dd__list" role="listbox" id="${id}" tabindex="-1" aria-labelledby="${labelledby}"></ul>
    </div>`;
  const trigger = root.querySelector('.dd__trigger');
  const valueEl = root.querySelector('.dd__value');
  const list = root.querySelector('.dd__list');
  const scrim = root.querySelector('.dd__scrim');
  let items = [], value = null, active = -1;

  const optEls = () => [...list.querySelectorAll('.dd__opt')];
  const setActive = (i) => {
    const els = optEls(); if (!els.length) return;
    active = (i + els.length) % els.length;
    els.forEach((el, k) => el.classList.toggle('is-active', k === active));
    list.setAttribute('aria-activedescendant', els[active].id);
    els[active].scrollIntoView({ block: 'nearest' });
  };
  function open() {
    if (openOne && openOne !== api) openOne.close();
    root.classList.add('is-open'); root.closest('.step')?.classList.add('is-raised'); trigger.setAttribute('aria-expanded', 'true'); openOne = api;
    const sel = items.findIndex((x) => x.value === value);
    setActive(sel >= 0 ? sel : Math.max(0, items.findIndex((x) => !x.disabled)));
    requestAnimationFrame(() => list.focus({ preventScroll: true }));
  }
  function close(focus = false) {
    root.classList.remove('is-open'); root.closest('.step')?.classList.remove('is-raised'); trigger.setAttribute('aria-expanded', 'false');
    if (openOne === api) openOne = null;
    if (focus) trigger.focus({ preventScroll: true });
  }
  function choose(i) {
    const it = items[i]; if (!it || it.disabled) return;
    value = it.value; paint(); close(true); onChange?.(it.value, it);
  }
  function paint() {
    optEls().forEach((el, k) => el.setAttribute('aria-selected', String(items[k].value === value)));
    const it = items.find((x) => x.value === value);
    root.classList.toggle('has-value', !!it);
    valueEl.innerHTML = it ? renderValue(it) : '<span class="dd__ph" aria-hidden="true">—</span>';
  }

  trigger.addEventListener('click', () => (root.classList.contains('is-open') ? close() : open()));
  trigger.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
  scrim.addEventListener('click', () => close(true));
  list.addEventListener('click', (e) => { const el = e.target.closest('.dd__opt'); if (el) choose(optEls().indexOf(el)); });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { close(e.key === 'Escape'); }
  });
  document.addEventListener('pointerdown', (e) => { if (openOne === api && !root.contains(e.target)) close(); });

  const api = {
    setItems(next, renderOption) {
      items = next;
      list.innerHTML = items.map((it, k) =>
        `<li class="dd__opt" role="option" id="${id}-o${k}" aria-selected="false"${it.disabled ? ' aria-disabled="true"' : ''}>${renderOption(it)}</li>`).join('');
      if (value !== null && !items.some((x) => x.value === value && !x.disabled)) { value = null; onChange?.(null); }
      paint();
    },
    get value() { return value; },
    set value(v) { value = v; paint(); },
    focus() { trigger.focus(); },
    close,
  };
  return api;
}

// ---------------------------------------------------------------------
// Date box: a month grid where only the event days can be chosen.
// items: [{ value, date: 'YYYY-MM-DD', label, disabled }]
// ---------------------------------------------------------------------
const LOC = 'ar-SA-u-ca-gregory-nu-latn';
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const arrow = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

export function createCalendar(root, { renderValue, onChange, onMonthChange }) {
  const id = 'cal-' + Math.random().toString(36).slice(2, 8);
  const labelledby = root.getAttribute('aria-labelledby');
  root.classList.add('dd', 'dd--cal');
  root.innerHTML = `
    <button type="button" class="dd__trigger" aria-haspopup="dialog" aria-expanded="false"
            aria-controls="${id}" aria-labelledby="${labelledby} ${id}-v">
      <span class="dd__value" id="${id}-v"><span class="dd__ph" aria-hidden="true">—</span></span>
      <span class="dd__chev"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M4 10h16M9 3.5v4M15 3.5v4"/></svg></span>
    </button>
    <span class="dd__scrim" aria-hidden="true"></span>
    <div class="dd__panel" id="${id}" role="dialog" aria-labelledby="${labelledby}"><span class="dd__sheet-bar" aria-hidden="true"></span>
      <div class="cal">
        <div class="cal__head">
          <button type="button" class="cal__nav" data-nav="-1" aria-label="‹">${arrow('M9 6l6 6-6 6')}</button>
          <span class="cal__month" aria-live="polite"></span>
          <button type="button" class="cal__nav" data-nav="1" aria-label="›">${arrow('M15 6l-6 6 6 6')}</button>
        </div>
        <div class="cal__week" aria-hidden="true"></div>
        <div class="cal__grid" role="grid"></div>
      </div>
    </div>`;
  const trigger = root.querySelector('.dd__trigger');
  const valueEl = root.querySelector('.dd__value');
  const grid = root.querySelector('.cal__grid');
  const monthEl = root.querySelector('.cal__month');
  let items = [], value = null, view = null;

  // weekday header (Sunday first)
  const sun = new Date(2026, 10, 1); // a Sunday
  root.querySelector('.cal__week').innerHTML = Array.from({ length: 7 }, (_, i) =>
    `<span>${new Intl.DateTimeFormat(LOC, { weekday: 'short' }).format(new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + i))}</span>`).join('');

  const byDate = () => Object.fromEntries(items.map((it) => [it.date, it]));
  function draw() {
    if (!view) return;
    const y = view.getFullYear(), m = view.getMonth();
    monthEl.textContent = new Intl.DateTimeFormat(LOC, { month: 'long', year: 'numeric' }).format(view);
    const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), map = byDate();
    const sel = items.find((x) => x.value === value)?.date;
    let html = '<span class="cal__blank"></span>'.repeat(first);
    for (let d = 1; d <= days; d++) {
      const key = iso(new Date(y, m, d)), it = map[key];
      const on = it && !it.disabled;
      const cls = ['cal__day', it ? 'is-event' : '', it && it.disabled ? 'is-full' : '', key === sel ? 'is-selected' : ''].join(' ');
      const reason = it?.full ? '، مكتمل' : it && it.disabled ? '، مغلق' : '';
      html += `<button type="button" role="gridcell" class="${cls}" data-date="${key}"${on ? '' : ' aria-disabled="true" tabindex="-1"'}
        aria-selected="${key === sel}" aria-label="${new Intl.DateTimeFormat(LOC, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y, m, d))}${reason}"><span>${d}</span>${it?.full ? '<small>مكتمل</small>' : ''}</button>`;
    }
    grid.innerHTML = html;
    const months = [...new Set(items.map((x) => x.date.slice(0, 7)))].sort();
    const cur = `${y}-${String(m + 1).padStart(2, '0')}`;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' }).format(new Date());
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const minMonth = parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value;
    root.querySelector('[data-nav="-1"]').disabled = onMonthChange ? cur <= minMonth : !months.some((x) => x < cur);
    root.querySelector('[data-nav="1"]').disabled = onMonthChange ? false : !months.some((x) => x > cur);
  }
  const enabled = () => [...grid.querySelectorAll('.cal__day:not([aria-disabled])')];
  function open() {
    if (openOne && openOne !== api) openOne.close();
    root.classList.add('is-open'); root.closest('.step')?.classList.add('is-raised'); trigger.setAttribute('aria-expanded', 'true'); openOne = api;
    draw();
    requestAnimationFrame(() => (grid.querySelector('.is-selected:not([aria-disabled])') || enabled()[0] || grid)?.focus({ preventScroll: true }));
  }
  function close(focus = false) {
    root.classList.remove('is-open'); root.closest('.step')?.classList.remove('is-raised'); trigger.setAttribute('aria-expanded', 'false');
    if (openOne === api) openOne = null;
    if (focus) trigger.focus({ preventScroll: true });
  }
  function paint() {
    const it = items.find((x) => x.value === value);
    root.classList.toggle('has-value', !!it);
    valueEl.innerHTML = it ? renderValue(it) : '<span class="dd__ph" aria-hidden="true">—</span>';
    draw();
  }
  function chooseDate(key) {
    const it = byDate()[key]; if (!it || it.disabled) return;
    value = it.value; paint(); close(true); onChange?.(it.value, it);
  }

  trigger.addEventListener('click', () => (root.classList.contains('is-open') ? close() : open()));
  root.querySelector('.dd__scrim').addEventListener('click', () => close(true));
  root.querySelectorAll('.cal__nav').forEach((b) => b.addEventListener('click', () => {
    view = new Date(view.getFullYear(), view.getMonth() + Number(b.dataset.nav), 1);
    if (onMonthChange) { items = []; value = null; onChange?.(null); onMonthChange(iso(view)); }
    draw();
  }));
  grid.addEventListener('click', (e) => { const b = e.target.closest('.cal__day'); if (b) chooseDate(b.dataset.date); });
  grid.addEventListener('keydown', (e) => {
    const list = enabled(), i = list.indexOf(document.activeElement);
    if (['ArrowLeft', 'ArrowDown'].includes(e.key)) { e.preventDefault(); list[Math.min(i + 1, list.length - 1)]?.focus(); }
    else if (['ArrowRight', 'ArrowUp'].includes(e.key)) { e.preventDefault(); list[Math.max(i - 1, 0)]?.focus(); }
    else if (e.key === 'Escape') close(true);
  });
  root.querySelector('.dd__panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') close(true); });
  document.addEventListener('pointerdown', (e) => { if (openOne === api && !root.contains(e.target)) close(); });

  const api = {
    setItems(next) {
      items = next.filter((x) => x.date);
      if (!view && items.length) {
        const firstOpen = items[0];
        const d = new Date(firstOpen.date + 'T00:00:00'); view = new Date(d.getFullYear(), d.getMonth(), 1);
      }
      if (value !== null && !items.some((x) => x.value === value && !x.disabled)) { value = null; onChange?.(null); }
      paint();
    },
    get value() { return value; },
    set value(v) { value = v; paint(); },
    close,
  };
  return api;
}
