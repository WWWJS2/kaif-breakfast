import { ORIGINAL as T, FUNCTIONAL as F } from './strings.js';
import { getAvailability, createBooking, uuid, configured } from './api.js';
import { createDropdown, createCalendar } from './dropdown.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- formatting (keeps the original "06:30 ص - 07:30 ص" shape) ----------
const meridiem = (h) => (h < 12 ? T.am : F.pm);
const fmtSlot = (t) => { const [h, m] = t.split(':').map(Number); const hh = h % 12 || 12; return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')} ${meridiem(h)}`; };
const fmtShort = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')}`; };
const slotText = (s) => `${fmtSlot(s.starts_at)} - ${fmtSlot(s.ends_at)}`;
const fmtDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '');

// ---------- state ----------
const state = { av: null, day: null, slot: null, party: null, busy: false, token: null };
const form = $('#booking'), nameInput = $('#guest'), cta = $('[data-cta]'), notice = $('[data-notice]');

const dayDD = createCalendar($('[data-dd="day"]'), {
  renderValue: (it) => `<small>${T.dayPrefix}</small><span>${esc(it.label)}</span><small class="num">${fmtDate(it.date)}</small><span class="opt__pill">${T.dayAvailable}</span>`,
  onChange: (v) => { state.day = v; clearInvalid(2); syncPeople(); hideNotice(); },
});
const timeDD = createDropdown($('[data-dd="time"]'), {
  renderValue: (it) => `<span class="tnum">${it.text}</span>`,
  onChange: (v) => { state.slot = v; clearInvalid(3); },
});

function render(av) {
  state.av = av;
  // days
  dayDD.setItems(av.days.map((d) => ({ value: d.id, label: d.label, date: d.event_date, disabled: !d.available || !av.open })));
  // times
  timeDD.setItems(av.slots.map((s) => ({ value: s.id, text: slotText(s) })), (it) => `<span class="opt__main tnum">${it.text}</span>`);
  // the time-window label + the hero's monumental hours
  if (av.slots.length) {
    const from = av.slots.map((s) => s.starts_at).sort()[0];
    const to = av.slots.map((s) => s.ends_at).sort().at(-1);
    $('[data-time-label]').textContent = T.timeLabel(fmtShort(from), fmtShort(to));
    $('[data-hour-from]').textContent = fmtShort(from);
    $('[data-hour-to]').textContent = fmtShort(to);
  }

  const anyOpen = av.open && av.days.some((d) => d.available);
  cta.disabled = !anyOpen;
  if (!anyOpen) showNotice(F.bookingClosed); else if (notice.dataset.kind === 'closed') hideNotice();
  if (!anyOpen) notice.dataset.kind = 'closed';
  syncPeople();
}

const peopleDD = createDropdown($('[data-dd="people"]'), {
  renderValue: (it) => `<span>${it.text}</span>`,
  onChange: (v) => { state.party = v; if (v) clearInvalid(4); },
});
function syncPeople() {
  const av = state.av; if (!av) return;
  const d = av.days.find((x) => x.id === state.day);
  const limit = Math.min(av.max_party, d ? d.remaining : av.max_party);
  peopleDD.setItems(Array.from({ length: av.max_party }, (_, i) => ({ value: i + 1, text: T.people(i + 1), disabled: i + 1 > limit })),
    (it) => `<span class="opt__lead opt__lead--row"><span class="opt__main tnum">${it.value}</span><span class="opt__pre">${it.text}</span></span>`);
  $('[data-people-note]').textContent = T.peopleNote(av.max_party);
}
function setParty(n) { state.party = n; peopleDD.value = n; }

nameInput.addEventListener('input', () => { nameInput.closest('.namefield').classList.toggle('has-value', !!nameInput.value.trim()); clearInvalid(1); });

// ---------- notices ----------
function showNotice(text) { notice.textContent = text; notice.hidden = false; }
function hideNotice() { notice.hidden = true; notice.textContent = ''; delete notice.dataset.kind; }
function clearInvalid(n) { $(`.step[data-step="${n}"]`).classList.remove('is-invalid'); }
function markInvalid(n) {
  const s = $(`.step[data-step="${n}"]`);
  s.classList.add('is-invalid'); s.classList.remove('shake'); void s.offsetWidth; s.classList.add('shake');
}

// ---------- availability (refreshes so a full day closes for everyone) ----------
async function refresh() {
  try { render(await getAvailability()); }
  catch (e) { if (!state.av) { cta.disabled = true; showNotice(F.networkError); } }
}

// ---------- submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const name = nameInput.value.trim();
  const missing = [];
  if (name.length < 2) missing.push(1);
  if (!state.day) missing.push(2);
  if (!state.slot) missing.push(3);
  if (!state.party) missing.push(4);
  if (missing.length) {
    missing.forEach(markInvalid);
    $(`.step[data-step="${missing[0]}"]`).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    if (missing[0] === 1) setTimeout(() => nameInput.focus({ preventScroll: true }), 400);
    return;
  }
  state.busy = true; cta.classList.add('is-busy'); cta.setAttribute('aria-busy', 'true'); hideNotice();
  state.token ||= uuid();
  try {
    const r = await createBooking({ name, day: state.day, slot: state.slot, party: state.party, token: state.token });
    if (r?.ok) {
      const day = state.av.days.find((d) => d.id === state.day);
      const slot = state.av.slots.find((s) => s.id === state.slot);
      const ticket = { name, day: `${T.dayPrefix} ${day.label}`, time: slotText(slot), people: T.people(state.party),
        timeLabel: $('[data-time-label]').textContent, id: r.booking?.id };
      try { localStorage.setItem('kaif-ticket', JSON.stringify(ticket)); } catch {}
      state.token = null;
      openTicket(ticket);
      form.reset(); nameInput.closest('.namefield').classList.remove('has-value');
      dayDD.value = null; timeDD.value = null; state.day = state.slot = null; setParty(null);
    } else {
      const msg = { day_full: F.dayFullError, day_closed: F.dayFullError, not_enough_seats: F.notEnoughSeats, closed: F.bookingClosed }[r?.error] || F.networkError;
      showNotice(msg);
      if (r?.error !== 'invalid_name') state.token = null;
    }
  } catch {
    showNotice(F.networkError); // token kept: a retry cannot create a second booking
  } finally {
    state.busy = false; cta.classList.remove('is-busy'); cta.removeAttribute('aria-busy');
    refresh();
  }
});

// ---------- ticket ----------
const dlg = $('[data-ticket]');
function openTicket(t) {
  $$('[data-t]', dlg).forEach((el) => (el.textContent = t[el.dataset.t] ?? ''));
  const title = $('[data-ticket-title]');
  if (F.CONFIRM_TITLE) { title.textContent = F.CONFIRM_TITLE; title.hidden = false; }
  if (!dlg.open) dlg.showModal();
}
$('[data-ticket-close]').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ---------- progress rail: which choices are made ----------
function syncRail() {
  const done = { 1: nameInput.value.trim().length >= 2, 2: !!state.day, 3: !!state.slot, 4: !!state.party };
  $$('.step').forEach((s) => s.classList.toggle('is-done', !!done[s.dataset.step]));
}
['input', 'change', 'keyup'].forEach((ev) => form.addEventListener(ev, syncRail));
form.addEventListener('click', () => setTimeout(syncRail, 0));

// ---------- the photograph beside the form follows the current step ----------
const media = $$('.media');
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    const step = en.target;
    media.forEach((im) => im.classList.toggle('is-on', im.dataset.key === step.dataset.img));
    $$('.step').forEach((s) => s.classList.toggle('is-current', s === step));
  });
}, { rootMargin: '-45% 0px -45% 0px' });
$$('.step').forEach((s) => io.observe(s));
form.addEventListener('focusin', (e) => {
  const step = e.target.closest('.step'); if (!step) return;
  media.forEach((im) => im.classList.toggle('is-on', im.dataset.key === step.dataset.img));
  $$('.step').forEach((s) => s.classList.toggle('is-current', s === step));
});

// ---------- motion ----------
function motion() {
  document.body.classList.remove('is-loading');
  const gsap = window.gsap;
  const curtains = $$('.hero__curtain');
  if (!gsap || reduce) { curtains.forEach((c) => c.classList.add('is-gone')); return; }
  gsap.registerPlugin(window.ScrollTrigger);
  const desktop = matchMedia('(min-width: 901px)').matches;

  // opening: the frame opens like a letterbox at first light
  gsap.timeline({ defaults: { ease: 'expo.inOut' }, onComplete: () => curtains.forEach((c) => c.classList.add('is-gone')) })
    .to('.hero__curtain', { scaleY: 0, duration: 1.5 }, 0.15)
    .fromTo('.hero__photo img', { scale: 1.3 }, { scale: 1.04, duration: 2.6, ease: 'expo.out' }, 0.2)
    .from('.hero__seal', { y: -30, scale: 0.7, opacity: 0, duration: 1.2, ease: 'back.out(1.6)' }, 1.1)
    .from('.hero__meta > *', { y: 24, opacity: 0, duration: 1, stagger: 0.12, ease: 'expo.out' }, 1.25)
    .from('.hero__cue', { scale: 0, duration: 0.9, ease: 'back.out(2)' }, 1.5);

  if (desktop) {
    // scroll: the photograph slides aside and becomes the panel beside the form
    gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: '+=90%', scrub: 0.6, pin: true, anticipatePin: 1 } })
      .fromTo('.hero__photo', { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(0% 50% 0% 0%)', ease: 'none', immediateRender: false }, 0)
      .to('.hero__photo img', { scale: 1, ease: 'none' }, 0)
      .to(['.hero__seal', '.hero__meta', '.hero__cue', '.hero__veil'], { opacity: 0, ease: 'none', duration: 0.35 }, 0);
  } else {
    // phone: the photo drifts while the white sheet rises over it
    gsap.to('.hero__photo img', { yPercent: 12, scale: 1.12, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  }

  // each step settles into place
  $$('.step, .submit').forEach((s) => gsap.from(s, { y: 28, opacity: 0, duration: 1, ease: 'expo.out', clearProps: 'transform,opacity',
    scrollTrigger: { trigger: s, start: 'top 88%', once: true } }));
}

// ---------- boot ----------
function boot() {
  motion();
  if (!configured) { cta.disabled = true; showNotice(F.networkError); return; }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  try { const t = JSON.parse(localStorage.getItem('kaif-ticket') || 'null'); if (t) openTicket(t); } catch {}
}
boot();
