// iCloud Reminders integration over CalDAV.
// Apple has no public Reminders API; iCloud stores reminders as VTODO items in
// CalDAV. We authenticate with an Apple ID + app-specific password.
// Supports multiple named lists (e.g. Shopping, Costco).
import { DAVClient } from 'tsdav';
import { randomUUID } from 'node:crypto';

const APPLE_ID = process.env.ICLOUD_APPLE_ID;
const APP_PASSWORD = process.env.ICLOUD_APP_PASSWORD;
// Comma-separated list names; REMINDERS_LIST_NAME kept for back-compat.
const LIST_NAMES = (process.env.REMINDERS_LISTS || process.env.REMINDERS_LIST_NAME || 'Shopping')
  .split(',').map((s) => s.trim()).filter(Boolean);

export const caldavConfigured = () => !!APPLE_ID && !!APP_PASSWORD;
export const listNames = () => LIST_NAMES;

let _client = null;
const _lists = new Map(); // name(lower) -> DAV calendar

async function getClient() {
  if (_client) return _client;
  _client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: APPLE_ID, password: APP_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  await _client.login();
  return _client;
}

async function getList(name) {
  const key = name.toLowerCase();
  if (_lists.has(key)) return { client: await getClient(), list: _lists.get(key) };
  const client = await getClient();
  const calendars = await client.fetchCalendars();
  const list = calendars.find((c) => (c.displayName || '').toLowerCase() === key);
  if (!list) {
    const names = calendars.map((c) => c.displayName).filter(Boolean).join(', ');
    throw new Error(`Reminders list "${name}" not found. Available: ${names}`);
  }
  _lists.set(key, list);
  return { client, list };
}

// ---- ICS helpers -----------------------------------------------------------
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, ''); // undo line folding
}
function unescape(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function escapeText(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function getProp(block, name) {
  const m = block.match(new RegExp('^' + name + '(?:;[^:]*)?:(.*)$', 'mi'));
  return m ? unescape(m[1].trim()) : null;
}

function parseTodos(objects) {
  const items = [];
  for (const obj of objects) {
    const data = unfold(obj.data || '');
    const m = data.match(/BEGIN:VTODO[\s\S]*?END:VTODO/i);
    if (!m) continue;
    const block = m[0];
    const uid = getProp(block, 'UID');
    const summary = getProp(block, 'SUMMARY');
    const status = (getProp(block, 'STATUS') || '').toUpperCase();
    const completed = status === 'COMPLETED' || !!getProp(block, 'COMPLETED');
    if (!uid || summary == null) continue;
    items.push({ uid, title: summary, done: completed, url: obj.url });
  }
  return items.sort((a, b) => Number(a.done) - Number(b.done));
}

// ---- Public API (all take the list name) -----------------------------------
export async function getItems(name) {
  const { client, list } = await getList(name);
  const objects = await client.fetchCalendarObjects({ calendar: list });
  return parseTodos(objects);
}

export async function addItem(name, title) {
  const { client, list } = await getList(name);
  const uid = randomUUID();
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyCalendar//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${stamp()}`,
    `SUMMARY:${escapeText(title)}`,
    'STATUS:NEEDS-ACTION',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  await client.createCalendarObject({ calendar: list, filename: `${uid}.ics`, iCalString: ics });
  return { uid, title, done: false };
}

async function findObject(client, list, uid) {
  const objects = await client.fetchCalendarObjects({ calendar: list });
  const target = objects.find((o) => unfold(o.data || '').includes(`UID:${uid}`));
  if (!target) throw new Error('Item not found');
  return target;
}

export async function setDone(name, uid, done) {
  const { client, list } = await getList(name);
  const target = await findObject(client, list, uid);

  // Surgically rewrite STATUS / COMPLETED / PERCENT-COMPLETE inside the VTODO.
  let data = unfold(target.data);
  data = data.replace(/^(STATUS|COMPLETED|PERCENT-COMPLETE):.*$/gim, '').replace(/\n{2,}/g, '\n');
  const inject = done
    ? `STATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\nCOMPLETED:${stamp()}\r\n`
    : 'STATUS:NEEDS-ACTION\r\n';
  data = data.replace(/END:VTODO/i, inject + 'END:VTODO');

  await client.updateCalendarObject({ calendarObject: { url: target.url, data, etag: target.etag } });
  return { uid, done };
}

export async function removeItem(name, uid) {
  const { client, list } = await getList(name);
  const target = await findObject(client, list, uid);
  await client.deleteCalendarObject({ calendarObject: { url: target.url, etag: target.etag } });
  return { ok: true };
}
