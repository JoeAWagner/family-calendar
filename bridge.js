// iPad bridge for shared Apple Reminders lists.
//
// Apple's shared reminder lists aren't reachable off-device (CalDAV can't see
// them). So an always-on iPad running a Shortcuts loop is the go-between:
//   - it PUSHES the current Reminders state here (so the wall can display it), and
//   - it PULLS the wall's edits from here and applies them back to Reminders.
//
// This module holds the in-memory mirror + a queue of pending wall->Reminders ops.
// Items are keyed by title (Shortcuts has no stable per-reminder id), which is
// fine for shopping lists.

const CONFIGURED_NAMES = (process.env.REMINDERS_LISTS || 'Shopping,Costco')
  .split(',').map((s) => s.trim()).filter(Boolean);

const mirror = {};   // { listName: [ { title, done } ] }
let ops = [];        // pending wall->Reminders operations, each { id, op, list, title, done? }
let seq = 1;
let lastPushAt = 0;

function applyOpToMirror(o) {
  const list = (mirror[o.list] ||= []);
  if (o.op === 'add') {
    if (!list.some((i) => i.title === o.title)) list.push({ title: o.title, done: false });
  } else if (o.op === 'complete') {
    const it = list.find((i) => i.title === o.title);
    if (it) it.done = o.done;
  } else if (o.op === 'remove') {
    mirror[o.list] = list.filter((i) => i.title !== o.title);
  }
}

export const bridgeConfigured = () => true;

export function listNames() {
  const pushed = Object.keys(mirror);
  return pushed.length ? pushed : CONFIGURED_NAMES;
}

// The iPad reports the authoritative Reminders state. We replace the mirror, then
// re-apply any not-yet-acked wall edits so optimistic changes don't flicker away.
// Accept items as {title,done} objects OR plain strings (simpler for Shortcuts).
function normItem(i) {
  return typeof i === 'string' ? { title: i, done: false } : { title: String(i.title), done: !!i.done };
}

export function setMirror(lists) {
  for (const [name, items] of Object.entries(lists || {})) {
    mirror[name] = (items || []).map(normItem);
  }
  for (const o of ops) applyOpToMirror(o);
  lastPushAt = Date.now();
}

// Replace just one list (used by the simple newline-text endpoint).
export function setListMirror(name, items) {
  mirror[name] = (items || []).map(normItem);
  for (const o of ops) if (o.list === name) applyOpToMirror(o);
  lastPushAt = Date.now();
}

// ---- Wall-facing API (same shape as caldav.js) ----------------------------
export function getItems(name) {
  return (mirror[name] || []).map((i) => ({ uid: i.title, title: i.title, done: i.done }));
}
export function addItem(name, title) {
  const o = { id: seq++, op: 'add', list: name, title };
  ops.push(o); applyOpToMirror(o);
  return { uid: title, title, done: false };
}
export function setDone(name, uid, done) {
  const o = { id: seq++, op: 'complete', list: name, title: uid, done };
  ops.push(o); applyOpToMirror(o);
  return { uid, done };
}
export function removeItem(name, uid) {
  const o = { id: seq++, op: 'remove', list: name, title: uid };
  ops.push(o); applyOpToMirror(o);
  return { ok: true };
}

// ---- iPad-facing API ------------------------------------------------------
export function pullOps() {
  return { ops: ops.slice(), token: ops.length ? ops[ops.length - 1].id : 0 };
}
export function ackOps(token) {
  ops = ops.filter((o) => o.id > token); // drop everything the iPad confirmed applying
  return { remaining: ops.length };
}
export function status() {
  return {
    lastPushAt,
    lastPushAgoSec: lastPushAt ? Math.round((Date.now() - lastPushAt) / 1000) : null,
    pending: ops.length,
    lists: listNames(),
  };
}
