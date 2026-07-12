// ---- Small helpers ---------------------------------------------------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const api = (url, opts) => fetch(url, opts).then((r) => r.json());

let config = { authed: false, idleMinutes: 3 };
let events = [];
let monthCursor = new Date();
let weekOffset = 0; // weeks away from the current week

// ---- Clock + auto day/night theme ------------------------------------------
function tickClock() {
  const now = new Date();
  $('#time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const ss = $('#ssClock');
  if (ss) ss.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  updateTheme();
}
// Theme: auto (dark in evening), or manually forced light/dark via the toggle.
let themeMode = localStorage.getItem('themeMode') || 'auto'; // auto | light | dark
const isNightNow = () => { const h = new Date().getHours(); return h >= 20 || h < 7; };
function updateTheme() {
  const night = themeMode === 'dark' || (themeMode === 'auto' && isNightNow());
  document.body.classList.toggle('night', night);
  const btn = $('#themeToggle');
  if (btn) btn.textContent = themeMode === 'auto' ? '🌗' : themeMode === 'dark' ? '🌙' : '☀️';
}
function cycleTheme() {
  themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
  localStorage.setItem('themeMode', themeMode);
  updateTheme();
}
$('#themeToggle')?.addEventListener('click', cycleTheme);
setInterval(tickClock, 1000);
tickClock();

// ---- View switching --------------------------------------------------------
$$('nav button[data-view]').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view))
);
function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === name));
  $$('nav button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'month') renderMonth();
  if (name === 'week') renderWeek();
  if (name === 'list') renderList();
  if (name === 'doodle') fitCanvas();
}

// Week / month navigation arrows.
$('#weekPrev')?.addEventListener('click', () => { weekOffset -= 1; renderWeek(); });
$('#weekNext')?.addEventListener('click', () => { weekOffset += 1; renderWeek(); });
$('#weekToday')?.addEventListener('click', () => { weekOffset = 0; renderWeek(); });
$('#monthPrev')?.addEventListener('click', () => { monthCursor.setMonth(monthCursor.getMonth() - 1); renderMonth(); });
$('#monthNext')?.addEventListener('click', () => { monthCursor.setMonth(monthCursor.getMonth() + 1); renderMonth(); });
$('#monthToday')?.addEventListener('click', () => { monthCursor = new Date(); renderMonth(); });

// ---- Load events -----------------------------------------------------------
async function loadEvents() {
  if (!config.authed) return;
  // Wide window so week/month navigation has events: ~1 month back, ~6 ahead.
  const timeMin = new Date();
  timeMin.setHours(0, 0, 0, 0);
  timeMin.setDate(timeMin.getDate() - 31);
  const timeMax = new Date();
  timeMax.setHours(0, 0, 0, 0);
  timeMax.setDate(timeMax.getDate() + 183);
  try {
    events = await api(`/api/events?timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}`);
    if (!Array.isArray(events)) events = [];
  } catch { events = []; }
  renderAgenda();
  renderWeek();
  if ($('#month').classList.contains('active')) renderMonth();
}

function evStart(e) { return new Date(e.start.dateTime || e.start.date + 'T00:00:00'); }
function evIsAllDay(e) { return !e.start.dateTime; }

// Stable color per event title, so recurring items keep their color.
const PALETTE = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)', 'var(--p5)', 'var(--p6)'];
function evColor(e) {
  const s = e.summary || '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ---- Weather rendering helpers --------------------------------------------
const PART_SHORT = { morning: 'AM', midday: 'Noon', evening: 'PM', night: 'Night' };

// Hourly temperature sparkline (area + line + rain bars + "now" marker).
// preserveAspectRatio=none lets it stretch to fill its container width.
function wxSparkline(day, W, H) {
  const hrs = day.hourly || [];
  if (hrs.length < 2) return '';
  const temps = hrs.map((x) => x.t);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const range = Math.max(1, tmax - tmin);
  const padX = 4, padTop = 8, padBot = 6;
  const X = (h) => padX + (h / 23) * (W - 2 * padX);
  const Y = (t) => padTop + (1 - (t - tmin) / range) * (H - padTop - padBot);
  const pts = hrs.map((x) => `${X(x.h).toFixed(1)},${Y(x.t).toFixed(1)}`);
  const area = `M${X(0).toFixed(1)},${(H - padBot).toFixed(1)} L${pts.join(' L')} L${X(23).toFixed(1)},${(H - padBot).toFixed(1)} Z`;
  const bars = hrs.filter((x) => x.p > 5).map((x) => {
    const bh = (x.p / 100) * (H - padTop - padBot);
    return `<rect class="wx-rain" x="${(X(x.h) - 2.4).toFixed(1)}" y="${(H - padBot - bh).toFixed(1)}" width="4.8" height="${bh.toFixed(1)}" rx="1"/>`;
  }).join('');
  let now = '';
  if (day.date === wxKey(new Date())) {
    const nx = X(new Date().getHours()).toFixed(1);
    now = `<line class="wx-now" x1="${nx}" y1="0" x2="${nx}" y2="${H}"/>`;
  }
  return `<svg class="wx-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${bars}<path class="wx-area" d="${area}"/><polyline class="wx-line" points="${pts.join(' ')}"/>${now}
  </svg>`;
}

function wxPartChip(p) {
  const rain = p.pop >= 20 ? `<span class="wx-pp">💧${p.pop}%</span>` : '';
  return `<div class="wx-part"><span class="wx-pe">${p.emoji}</span>` +
    `<span class="wx-pl">${p.label}</span><span class="wx-pt">${p.temp}°</span>${rain}</div>`;
}

// Full-width weather panel for the Agenda day headers.
function wxAgendaPanel(day) {
  if (!day) return '';
  const parts = (day.parts || []).map(wxPartChip).join('');
  return `<div class="wx-detail">
    <div class="wx-top">
      <span class="wx-big">${day.emoji}</span>
      <span class="wx-hilo"><b>${Math.round(day.hi)}°</b><i>${Math.round(day.lo)}°</i></span>
      <div class="wx-spark-wrap">${wxSparkline(day, 360, 46)}</div>
    </div>
    <div class="wx-parts">${parts}</div>
  </div>`;
}

// Compact weather block for the narrow Week columns.
function wxWeekPanel(day) {
  if (!day) return '';
  const rows = (day.parts || []).map((p) => {
    const rain = p.pop >= 25 ? `<em>${p.pop}%</em>` : '';
    return `<div class="wx-wp"><span class="k">${PART_SHORT[p.key]}</span>` +
      `<span class="e">${p.emoji}</span><span class="t">${p.temp}°</span>${rain}</div>`;
  }).join('');
  return `<div class="wx-wk">
    <div class="wx-wk-hilo">${day.emoji} <b>${Math.round(day.hi)}°</b> ${Math.round(day.lo)}°</div>
    <div class="wx-wk-spark">${wxSparkline(day, 150, 30)}</div>
    <div class="wx-wk-parts">${rows}</div>
  </div>`;
}

// ---- Agenda view -----------------------------------------------------------
function renderAgenda() {
  const el = $('#agenda');
  if (!config.authed) { el.innerHTML = ''; return; }
  // Agenda is upcoming-only (the fetch window also includes past events for the
  // week/month views).
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const upcoming = events.filter((e) => {
    const d = evStart(e); const day = new Date(d); day.setHours(0, 0, 0, 0);
    return day >= startOfToday;
  });
  if (!upcoming.length) { el.innerHTML = '<div class="empty">No upcoming events 🎉</div>'; return; }

  const groups = {};
  for (const e of upcoming) {
    const d = evStart(e);
    const key = d.toDateString();
    (groups[key] ||= []).push(e);
  }
  el.innerHTML = Object.entries(groups).map(([key, evs]) => {
    const d = new Date(key);
    const header = d.toLocaleDateString([], { weekday: 'long' });
    const sub = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const wx = weatherByDate[wxKey(d)];
    const rows = evs.map((e) => {
      const time = evIsAllDay(e) ? 'All day'
        : evStart(e).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="event" data-id="${e.id}" style="--evc:${evColor(e)}">
        <span class="dot"></span>
        <span class="time">${time}</span>
        <span class="title">${escapeHtml(e.summary || '(no title)')}</span>
      </div>`;
    }).join('');
    return `<div class="day-group"><div class="day-header">${header} <small>${sub}</small></div>${wxAgendaPanel(wx)}${rows}</div>`;
  }).join('');

  $$('#agenda .event').forEach((row) =>
    row.addEventListener('click', () => openEvent(events.find((e) => e.id === row.dataset.id)))
  );
}

// ---- Week view (7 day columns) --------------------------------------------
function renderWeek() {
  const el = $('#weekGrid');
  if (!config.authed) { el.innerHTML = ''; return; }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + weekOffset * 7); // Sunday of the shown week
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  $('#weekLabel').textContent = `${fmt(start)} – ${fmt(end)}`;

  let html = '';
  for (let i = 0; i < 7; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const isToday = day.getTime() === today.getTime();
    const dayEvents = events
      .filter((e) => { const d = evStart(e); d.setHours(0,0,0,0); return d.getTime() === day.getTime(); })
      .sort((a, b) => evStart(a) - evStart(b));
    const items = dayEvents.map((e) => {
      const t = evIsAllDay(e) ? 'All day'
        : evStart(e).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<div class="wk-ev" data-id="${e.id}" style="--evc:${evColor(e)}">
        <span class="t">${t}</span>${escapeHtml(e.summary || '')}</div>`;
    }).join('');
    const wx = weatherByDate[wxKey(day)];
    html += `<div class="weekcol ${isToday ? 'today' : ''}">
      <h3><span class="dow">${day.toLocaleDateString([], { weekday: 'short' })}</span>
      <span class="dnum">${day.getDate()}</span></h3>
      ${wxWeekPanel(wx)}
      <div class="col-scroll">${items}</div>
    </div>`;
  }
  el.innerHTML = html;
  $$('#weekGrid .wk-ev').forEach((row) =>
    row.addEventListener('click', () => openEvent(events.find((e) => e.id === row.dataset.id)))
  );
}

// ---- Month view ------------------------------------------------------------
function renderMonth() {
  const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
  $('#monthLabel').textContent =
    monthCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const first = new Date(y, m, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();

  $('#monthDow').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map((d) => `<div class="dow">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < startDay; i++) cells += '<div class="cell empty-cell"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEvents = events
      .filter((e) => { const d = evStart(e); return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day; })
      .sort((a, b) => evStart(a) - evStart(b));
    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === day;
    const shown = dayEvents.slice(0, 3);
    const pills = shown.map((e) => {
      const t = evIsAllDay(e) ? '' : `<span class="pt">${evStart(e).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '')}</span> `;
      return `<div class="pill" data-id="${e.id}" style="--evc:${evColor(e)}">${t}${escapeHtml(e.summary || '')}</div>`;
    }).join('');
    const more = dayEvents.length > 3 ? `<div class="more">+${dayEvents.length - 3} more</div>` : '';
    cells += `<div class="cell ${isToday ? 'today' : ''}"><div class="num">${day}</div>${pills}${more}</div>`;
  }
  $('#monthGrid').innerHTML = cells;
  $$('#monthGrid .pill[data-id]').forEach((p) =>
    p.addEventListener('click', () => openEvent(events.find((e) => e.id === p.dataset.id))));
}

// ---- Event modal -----------------------------------------------------------
let editingId = null;
$('#addBtn').addEventListener('click', () => openEvent(null));
$('#evCancel').addEventListener('click', closeEvent);
$('#evAllDay').addEventListener('change', () =>
  $('#timeRow').classList.toggle('hidden', $('#evAllDay').checked));

function openEvent(e) {
  editingId = e ? e.id : null;
  $('#eventModalTitle').textContent = e ? 'Event' : 'New event';
  $('#evDelete').classList.toggle('hidden', !e);
  const d = e ? evStart(e) : new Date();
  $('#evTitle').value = e ? (e.summary || '') : '';
  $('#evAllDay').checked = e ? evIsAllDay(e) : false;
  $('#timeRow').classList.toggle('hidden', $('#evAllDay').checked);
  $('#evDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#evStart').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const endD = new Date(d.getTime() + 60 * 60 * 1000);
  $('#evEnd').value = e && e.end?.dateTime
    ? new Date(e.end.dateTime).toTimeString().slice(0, 5)
    : `${pad(endD.getHours())}:${pad(endD.getMinutes())}`;
  $('#eventModal').classList.remove('hidden');
}
function closeEvent() { $('#eventModal').classList.add('hidden'); }

$('#evSave').addEventListener('click', async () => {
  const title = $('#evTitle').value.trim();
  if (!title) return;
  const date = $('#evDate').value;
  const allDay = $('#evAllDay').checked;
  let body;
  if (allDay) {
    const next = new Date(date + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    body = { summary: title, allDay: true, start: date,
             end: `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}` };
  } else {
    body = { summary: title, allDay: false,
             start: new Date(`${date}T${$('#evStart').value}`).toISOString(),
             end: new Date(`${date}T${$('#evEnd').value}`).toISOString() };
  }
  // If editing, delete + recreate (simple + reliable for a kiosk).
  if (editingId) await fetch('/api/events/' + editingId, { method: 'DELETE' });
  await fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  closeEvent();
  loadEvents();
});

$('#evDelete').addEventListener('click', async () => {
  if (!editingId) return;
  await fetch('/api/events/' + editingId, { method: 'DELETE' });
  closeEvent();
  loadEvents();
});

// ---- Doodle board ----------------------------------------------------------
const canvas = $('#doodleCanvas');
const ctx = canvas.getContext('2d');
let drawing = false, color = '#111', erasing = false;

function fitCanvas() {
  // Preserve drawing across resize.
  const prev = canvas.width ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (prev) ctx.putImageData(prev, 0, 0);
}
window.addEventListener('resize', () => { if ($('#doodle').classList.contains('active')) fitCanvas(); });

function pos(ev) {
  const r = canvas.getBoundingClientRect();
  const p = ev.touches ? ev.touches[0] : ev;
  return { x: p.clientX - r.left, y: p.clientY - r.top };
}
function startDraw(ev) { drawing = true; const { x, y } = pos(ev); ctx.beginPath(); ctx.moveTo(x, y); }
function moveDraw(ev) {
  if (!drawing) return;
  ev.preventDefault();
  const { x, y } = pos(ev);
  ctx.strokeStyle = erasing ? '#fff' : color;
  ctx.lineWidth = erasing ? 40 : 5;
  ctx.lineTo(x, y); ctx.stroke();
}
function endDraw() { drawing = false; }
['mousedown', 'touchstart'].forEach((e) => canvas.addEventListener(e, startDraw));
['mousemove', 'touchmove'].forEach((e) => canvas.addEventListener(e, moveDraw, { passive: false }));
['mouseup', 'touchend', 'mouseleave'].forEach((e) => canvas.addEventListener(e, endDraw));

$$('#doodleTools button[data-color]').forEach((b) =>
  b.addEventListener('click', () => { color = b.dataset.color; erasing = false; }));
$('#eraser').addEventListener('click', () => { erasing = true; });
$('#clearDoodle').addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));

// ---- Photo screensaver -----------------------------------------------------
let idleTimer = null, ssTimer = null, photos = [], photoIdx = 0;

async function loadPhotos() { try { photos = await api('/api/photos'); } catch { photos = []; } }

function resetIdle() {
  clearTimeout(idleTimer);
  if ($('#screensaver').classList.contains('hidden') === false) stopScreensaver();
  idleTimer = setTimeout(startScreensaver, config.idleMinutes * 60 * 1000);
}
function startScreensaver() {
  $('#screensaver').classList.remove('hidden');
  updateScreensaverInfo();
  // Cycle photos if any exist; otherwise it's a calm black standby with the
  // clock, weather, and next event.
  if (photos.length) {
    showNextPhoto();
    ssTimer = setInterval(showNextPhoto, 8000);
  }
}
function showNextPhoto() {
  const img = $('#ssImg');
  img.style.opacity = 0;
  setTimeout(() => { img.src = photos[photoIdx % photos.length]; photoIdx++; img.style.opacity = 1; }, 400);
  updateScreensaverInfo();
}
// The next few time-of-day forecast slots (today, rolling into tomorrow).
function upcomingParts(max) {
  const now = new Date();
  const todayKey = wxKey(now);
  const out = [];
  for (const d of (weatherFull?.daily || [])) {
    for (const p of (d.parts || [])) {
      const dt = new Date(d.date + 'T00:00:00'); dt.setHours(PART_HOUR[p.key] || 12);
      if (dt >= now) { out.push({ ...p, today: d.date === todayKey }); if (out.length >= max) return out; }
    }
  }
  return out;
}

// Glanceable info shown over the photos: temp, next event, and a mini forecast.
function updateScreensaverInfo() {
  if (weatherFull) $('#ssWeather').textContent = `${weatherFull.emoji} ${Math.round(weatherFull.temp)}°`;
  const now = new Date();
  const upcoming = (events || []).find((e) => {
    const s = evStart(e);
    if (evIsAllDay(e)) { const d = new Date(s); d.setHours(23, 59, 59); return d >= now; }
    return s >= now;
  });
  if (upcoming) {
    const when = evIsAllDay(upcoming) ? evStart(upcoming).toLocaleDateString([], { weekday: 'short' })
      : evStart(upcoming).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#ssNext').textContent = `Next · ${upcoming.summary} · ${when}`;
  } else {
    $('#ssNext').textContent = '';
  }
  const soon = upcomingParts(4);
  $('#ssForecast').innerHTML = soon.map((p) =>
    `<span class="ss-fc"><b>${p.today ? p.label : 'Tmrw ' + p.label}</b> ${p.emoji} ${p.temp}°` +
    `${p.pop >= 25 ? ` <i>💧${p.pop}%</i>` : ''}</span>`).join('');
}
function stopScreensaver() {
  $('#screensaver').classList.add('hidden');
  clearInterval(ssTimer);
}
['mousedown', 'touchstart', 'keydown'].forEach((e) =>
  document.addEventListener(e, resetIdle, { passive: true }));

// Manual "sleep" button. clearTimeout stops resetIdle (fired by this same tap)
// from immediately dismissing it; the next touch anywhere wakes it as usual.
$('#sleepBtn')?.addEventListener('click', () => {
  clearTimeout(idleTimer);
  startScreensaver();
});

// ---- Utils -----------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Reminders lists (Shopping / Costco / …) -------------------------------
let listData = { items: [] };
let listNames = [];
let currentList = null;

// Build the list selector once we know the available lists.
async function initLists() {
  try {
    const info = await api('/api/lists');
    listNames = info.names || [];
  } catch { listNames = []; }
  if (!currentList && listNames.length) currentList = listNames[0];
  const sel = $('#listSelector');
  sel.innerHTML = listNames.map((n) =>
    `<button class="list-chip ${n === currentList ? 'active' : ''}" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`
  ).join('');
  $$('#listSelector .list-chip').forEach((chip) =>
    chip.addEventListener('click', () => { currentList = chip.dataset.name; renderList(); })
  );
}

const listPath = () => '/api/list/' + encodeURIComponent(currentList);

// Fetch the current list from the server, then paint.
async function renderList() {
  await initLists();
  if (!currentList) {
    $('#listItems').innerHTML = '<div class="empty">Add your Apple ID + app password in .env to connect your Reminders lists.</div>';
    $('#listCount').textContent = ''; $('#listTitle').textContent = 'Lists';
    return;
  }
  try { listData = await api(listPath()); } catch { listData = { items: [] }; }
  $('#listTitle').textContent = listData.name || currentList;
  if (listData.error) { $('#listItems').innerHTML = `<div class="empty">${escapeHtml(listData.error)}</div>`; return; }
  paintList();
}

// Paint from the current in-memory listData (used for optimistic updates too).
function paintList() {
  const items = (listData.items || []).slice().sort((a, b) => Number(a.done) - Number(b.done));
  listData.items = items;
  const wrap = $('#listItems');
  const remaining = items.filter((i) => !i.done).length;
  $('#listCount').textContent = items.length ? `${remaining} to get` : '';
  if (!items.length) { wrap.innerHTML = '<div class="empty">List is empty 🛒</div>'; return; }
  wrap.innerHTML = items.map((i) => `
    <div class="item ${i.done ? 'done' : ''}" data-uid="${i.uid}">
      <div class="check">${i.done ? '✓' : ''}</div>
      <div class="label">${escapeHtml(i.title)}</div>
      <button class="del" title="Remove">✕</button>
    </div>`).join('');
  $$('#listItems .item').forEach((row) => {
    const uid = row.dataset.uid;
    row.querySelector('.check').addEventListener('click', () => toggleItem(uid));
    row.querySelector('.label').addEventListener('click', () => toggleItem(uid));
    row.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteItem(uid); });
  });
}

async function toggleItem(uid) {
  const item = (listData.items || []).find((i) => i.uid === uid);
  if (!item) return;
  const done = !item.done;
  item.done = done; // optimistic
  paintList();
  await fetch(listPath() + '/' + uid, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }),
  }).catch(() => {});
}
async function deleteItem(uid) {
  listData.items = (listData.items || []).filter((i) => i.uid !== uid);
  paintList();
  await fetch(listPath() + '/' + uid, { method: 'DELETE' }).catch(() => {});
}
async function addItem() {
  const input = $('#newItem');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  const item = await fetch(listPath(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }).then((r) => r.json()).catch(() => null);
  if (item && item.uid) (listData.items ||= []).push(item);
  paintList();
}

$('#addItemBtn').addEventListener('click', addItem);
$('#newItem').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });

// ---- Weather ---------------------------------------------------------------
let weatherByDate = {}; // 'YYYY-MM-DD' -> full day object
let weatherFull = null; // last full /api/weather response

function wxKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Subtle header tint driven by current conditions.
const PART_HOUR = { morning: 8, midday: 13, evening: 18, night: 22 };
const SKY = { clear: '#ffefcf', cloud: '#e9eff6', fog: '#e9ecef', rain: '#dde9f6', snow: '#e7f1fa', storm: '#e6e1f2' };
function skyCategory(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloud';
  if ([45, 48].includes(code)) return 'fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'cloud';
}
function applySky(code) {
  document.body.style.setProperty('--sky', SKY[skyCategory(code)] || 'transparent');
}

async function loadWeather() {
  try {
    const w = await api('/api/weather');
    if (!w || w.unavailable) return;
    weatherFull = w;
    if (w.code != null) applySky(w.code);
    $('#wIcon').textContent = w.emoji;
    $('#wTemp').textContent = Math.round(w.temp) + '°';
    const feels = w.feels != null ? ` · feels ${Math.round(w.feels)}°` : '';
    $('#wHiLo').textContent = `H ${Math.round(w.hi)}° L ${Math.round(w.lo)}°${feels}`;
    $('#weather').classList.remove('hidden');
    weatherByDate = {};
    (w.daily || []).forEach((d) => { weatherByDate[d.date] = d; }); // full day incl. parts/hourly
    // Forecast may arrive after events render — repaint the day-based views.
    renderAgenda();
    renderWeek();
    if (!$('#weatherScreen').classList.contains('hidden')) renderWeatherScreen();
  } catch {}
}

// ---- Full-screen weather (tap the header weather) --------------------------
function renderWeatherScreen() {
  const body = $('#weatherScreenBody');
  if (!weatherFull || !weatherFull.daily) {
    body.innerHTML = '<div class="empty">Weather unavailable</div>';
    return;
  }
  const w = weatherFull;
  const today = w.daily[0];
  const now = `<div class="ws-now">
    <div class="ws-now-emoji">${w.emoji}</div>
    <div class="ws-now-main">
      <div class="ws-now-temp">${Math.round(w.temp)}°</div>
      <div class="ws-now-cond">${w.text}</div>
    </div>
    <div class="ws-now-meta">
      ${w.feels != null ? `<div>Feels like <b>${Math.round(w.feels)}°</b></div>` : ''}
      <div>High <b>${Math.round(today.hi)}°</b> · Low <b>${Math.round(today.lo)}°</b></div>
    </div>
  </div>`;

  const days = w.daily.map((d, i) => {
    const dd = new Date(d.date + 'T00:00:00');
    const name = i === 0 ? 'Today' : dd.toLocaleDateString([], { weekday: 'long' });
    const sub = dd.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const parts = (d.parts || []).map(wxPartChip).join('');
    return `<div class="ws-day">
      <div class="ws-day-head">
        <span class="ws-emoji">${d.emoji}</span>
        <span class="ws-name">${name} <small>${sub}</small></span>
        <span class="ws-hilo"><b>${Math.round(d.hi)}°</b> <i>${Math.round(d.lo)}°</i></span>
      </div>
      <div class="ws-spark">${wxSparkline(d, 600, 64)}</div>
      <div class="ws-parts">${parts}</div>
    </div>`;
  }).join('');

  body.innerHTML = now + days;
}

function openWeatherScreen() {
  if (!weatherFull) return;
  renderWeatherScreen();
  $('#weatherScreen').classList.remove('hidden');
}
function closeWeatherScreen() { $('#weatherScreen').classList.add('hidden'); }

$('#weather').addEventListener('click', openWeatherScreen);
$('#wsClose').addEventListener('click', closeWeatherScreen);

// ---- On-screen keyboard ----------------------------------------------------
// Kiosk Chromium has no native touch keyboard, so we build our own. It attaches
// to text inputs marked inputmode="none".
let activeInput = null;
let oskShift = false;

function buildKeyboard() {
  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
    ['space', 'done'],
  ];
  const osk = document.createElement('div');
  osk.id = 'osk';
  const letterKeys = [];

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'osk-row';
    for (const key of row) {
      const b = document.createElement('button');
      b.className = 'osk-key';
      if (key === 'space') { b.classList.add('space'); b.textContent = 'space'; b.dataset.act = 'space'; }
      else if (key === 'done') { b.classList.add('wide', 'accent'); b.textContent = 'Done'; b.dataset.act = 'done'; }
      else if (key === '⌫') { b.classList.add('wide', 'util'); b.textContent = '⌫'; b.dataset.act = 'back'; }
      else if (key === '⇧') { b.classList.add('wide', 'util'); b.textContent = '⇧'; b.dataset.act = 'shift'; }
      else { b.textContent = key; b.dataset.char = key; if (/[a-z]/.test(key)) letterKeys.push(b); }
      rowEl.appendChild(b);
    }
    osk.appendChild(rowEl);
  }
  document.body.appendChild(osk);

  const refreshCase = () => {
    letterKeys.forEach((b) => { b.textContent = oskShift ? b.dataset.char.toUpperCase() : b.dataset.char; });
    osk.querySelector('[data-act="shift"]').classList.toggle('active', oskShift);
  };

  // preventDefault on press keeps the text input focused (no blur / caret loss).
  osk.addEventListener('mousedown', (e) => e.preventDefault());
  osk.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  osk.addEventListener('click', (e) => {
    const b = e.target.closest('.osk-key');
    if (!b || !activeInput) return;
    const act = b.dataset.act;
    if (b.dataset.char != null) {
      oskType(oskShift ? b.dataset.char.toUpperCase() : b.dataset.char);
      if (oskShift) { oskShift = false; refreshCase(); }
    } else if (act === 'space') oskType(' ');
    else if (act === 'back') oskBackspace();
    else if (act === 'shift') { oskShift = !oskShift; refreshCase(); }
    else if (act === 'done') {
      if (activeInput && activeInput.id === 'newItem') addItem();
      hideKeyboard();
    }
  });

  // Attach to inputs that opt out of the native keyboard. Listen for focus AND
  // click/pointer so it opens reliably on a touchscreen tap.
  const openFor = (inp) => { activeInput = inp; showKeyboard(); };
  $$('input[inputmode="none"]').forEach((inp) => {
    inp.addEventListener('focus', () => openFor(inp));
    inp.addEventListener('pointerdown', () => openFor(inp));
    inp.addEventListener('click', () => openFor(inp));
    inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT') hideKeyboard(); }, 120));
  });
}

function oskType(ch) {
  const el = activeInput; if (!el) return;
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + ch + el.value.slice(e);
  const p = s + ch.length;
  try { el.setSelectionRange(p, p); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function oskBackspace() {
  const el = activeInput; if (!el) return;
  let s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  if (s === e) { if (s === 0) return; s -= 1; }
  el.value = el.value.slice(0, s) + el.value.slice(e);
  try { el.setSelectionRange(s, s); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function showKeyboard() { $('#osk')?.classList.add('show'); }
function hideKeyboard() { $('#osk')?.classList.remove('show'); oskShift = false; }

// ---- Boot ------------------------------------------------------------------
async function boot() {
  try { config = await api('/api/config'); } catch {}
  if (!config.authed) $('#connect').classList.remove('hidden');
  else $('#connect').classList.add('hidden');
  buildKeyboard();
  await loadPhotos();
  await loadEvents();
  loadWeather();
  resetIdle();
  // Re-sync with Google every 2 minutes; weather every 15.
  setInterval(loadEvents, 2 * 60 * 1000);
  setInterval(loadWeather, 15 * 60 * 1000);
}
boot();
