// Gated actions: an agent proposes, a human approves, and only then does an executor agent carry it out.
// This is plain code on purpose: no agent decides what is allowed to happen.
//
//   proposed --(you approve on a card, text unchanged)--> approved, with a time slot
//   approved --(slot reached, in the window, under the rate limit)--> the executor is started
//   executor's one tool call --(arguments match what you approved, exactly)--> running --> done | failed
const { db, now, log, bus } = require('./db');
const { ACTIONS, rules } = require('./config');

const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
const fail = (m) => { const e = new Error(m); e.userFacing = true; throw e; };
const get = (id) => db.prepare('SELECT * FROM actions WHERE id=?').get(id);
const payloadOf = (a) => { try { return JSON.parse(a.payload); } catch { return {}; } };

// ---- time rules ----
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function wall(d, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: DAYS[p.weekday], mins: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
function inWindow(d, w) {
  if (!w) return true;
  const l = wall(d, w.timeZone);
  if (Array.isArray(w.days) && !w.days.includes(l.day)) return false;
  return l.mins >= mins(w.start || '00:00') && l.mins <= mins(w.end || '23:59');
}
// Actions of this kind that have gone (or are going) out on a given day, and the latest one.
function doneOn(kind, date, timeZone) {
  return db.prepare("SELECT done_at FROM actions WHERE kind=? AND status IN ('running','done') AND done_at IS NOT NULL").all(kind)
    .filter((r) => wall(new Date(r.done_at), timeZone).date === date).length;
}
const lastGone = (kind) => db.prepare("SELECT MAX(done_at) m FROM actions WHERE kind=? AND status IN ('running','done')").get(kind).m;

// The earliest time an action of this kind may run: inside the window, a gap after the last one, under the daily cap.
function nextSlot(kind, from = new Date()) {
  const r = rules(kind);
  const tz = r.window && r.window.timeZone;
  const taken = db.prepare("SELECT run_at FROM actions WHERE kind=? AND status='approved' AND run_at IS NOT NULL ORDER BY run_at").all(kind).map((x) => Date.parse(x.run_at));
  const last = Math.max(Date.parse(lastGone(kind) || 0) || 0, ...taken);
  let t = Math.max(from.getTime(), last ? last + r.gapMinutes * 60000 : 0);
  t = Math.ceil(t / 15000) * 15000;
  for (let guard = 0; guard < 14 * 24 * 60; guard++, t += 60000) {
    const d = new Date(t);
    const day = wall(d, tz).date;
    const planned = taken.filter((x) => wall(new Date(x), tz).date === day).length;
    if (inWindow(d, r.window) && doneOn(kind, day, tz) + planned < r.perDay) return d.toISOString();
  }
  fail('No free slot in the next two weeks. Check the window and the daily limit.');
}

// ---- the blocklist ----
function blockedBy(kind, payload) {
  const field = (ACTIONS[kind] || {}).blocklist;
  if (!field) return null;
  const v = norm(payload[field]).toLowerCase();
  return db.prepare('SELECT * FROM blocklist WHERE kind=?').all(kind).find((b) => b.value.toLowerCase() === v) || null;
}

// ---- propose, approve, take back ----
function propose(kind, fields, by) {
  const x = ACTIONS[kind];
  if (!x) fail(`Unknown action "${kind}". Known: ${Object.keys(ACTIONS).join(', ')}.`);
  const payload = {};
  for (const k of Object.keys(x.fields)) if (fields[k] != null) payload[k] = norm(fields[k]).slice(0, 20000);
  for (const k of x.required) if (!payload[k]) fail(`Give ${k}.`);
  const b = blockedBy(kind, payload);
  if (b) fail(`Refused: "${b.value}" is on the blocklist${b.reason ? ' (' + b.reason + ')' : ''}.`);
  const title = payload.title || payload[x.required[0]] || kind;
  const t = now();
  const id = db.prepare('INSERT INTO actions(kind,title,payload,status,proposed_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(kind, String(title).slice(0, 140), JSON.stringify(payload), 'proposed', by, t, t).lastInsertRowid;
  log('action', `${by} proposed ${x.label || kind} ${id}: ${title}`, id);
  return id;
}
// You pressed Approve on a card. Each action must still read exactly as it did when the card was drawn.
function approve(items, from = new Date()) {
  const done = [];
  const tx = db.transaction(() => {
    for (const it of items) {
      const a = get(Number(it.id));
      if (!a) fail(`No action ${it.id}.`);
      if (a.status !== 'proposed') fail(`Action ${a.id} is ${a.status} now, so it cannot be approved here.`);
      if (a.updated_at !== String(it.version || '')) fail('An action changed after this card was drawn. Read it again, then approve.');
      const b = blockedBy(a.kind, payloadOf(a));
      if (b) fail(`Action ${a.id} is blocked: "${b.value}" is on the blocklist.`);
      const runAt = nextSlot(a.kind, from);
      db.prepare("UPDATE actions SET status='approved', run_at=?, approved_at=?, updated_at=? WHERE id=?").run(runAt, now(), now(), a.id);
      done.push({ id: a.id, run_at: runAt });
    }
  });
  tx();
  if (done.length) log('approve', `You approved ${done.map((d) => d.id).join(', ')}`);
  bus.emit('ev', { t: 'data' });
  return done;
}
function takeBack(id) {
  const ch = db.prepare("UPDATE actions SET status='proposed', run_at=NULL, approved_at=NULL, updated_at=? WHERE id=? AND status='approved'").run(now(), id).changes;
  if (!ch) fail('Only an approved action that has not started can be taken back.');
  log('approve', `You took back action ${id}`, id);
}
function reject(id, reason) {
  const ch = db.prepare("UPDATE actions SET status='rejected', problem=?, run_at=NULL, updated_at=? WHERE id=? AND status IN ('proposed','approved')").run(reason || null, now(), id).changes;
  if (!ch) fail('That action can no longer be rejected.');
  log('action', `You rejected action ${id}${reason ? ': ' + reason : ''}`, id);
}
// An agent may change an action only while it is still a proposal; the card then needs a fresh look.
function revise(id, fields, by) {
  const a = get(id);
  if (!a || a.status !== 'proposed') fail('Only a proposed action can be changed.');
  const x = ACTIONS[a.kind];
  const payload = { ...payloadOf(a) };
  for (const k of Object.keys(x.fields)) if (fields[k] != null) payload[k] = norm(fields[k]).slice(0, 20000);
  const b = blockedBy(a.kind, payload);
  if (b) fail(`Refused: "${b.value}" is on the blocklist.`);
  db.prepare('UPDATE actions SET payload=?, title=?, updated_at=? WHERE id=?').run(JSON.stringify(payload), String(payload.title || a.title).slice(0, 140), now(), id);
  log('action', `${by} revised action ${id}`, id);
}

// ---- the scheduler: starts the executor for the next due action ----
function executorPrompt(a) {
  const x = ACTIONS[a.kind], p = payloadOf(a);
  const args = Object.fromEntries(Object.entries(x.match).map(([arg, field]) => [arg, p[field]]));
  return `Carry out this approved action. Call ${x.tool} exactly once, with exactly these arguments (copy every character, add nothing):\n\n${JSON.stringify(args, null, 2)}\n\nThen reply with one line: what the service answered.`;
}
function tick(at = new Date()) {
  const runner = require('./runner');
  for (const x of Object.values(ACTIONS)) {
    if (db.prepare("SELECT 1 FROM runs WHERE agent=? AND status IN ('queued','running')").get(x.executor)) continue;
    const a = db.prepare("SELECT * FROM actions WHERE kind=? AND status='approved' AND run_at<=? ORDER BY run_at LIMIT 1").get(x.kind, at.toISOString());
    if (!a || !inWindow(at, rules(x.kind).window)) continue;
    runner.enqueue({ agent: x.executor, kind: 'action', prompt: executorPrompt(a), payload: { action_id: a.id } });
  }
}

// ---- the gate: checks the executor's one call ----
function check(run, ev, at = new Date()) {
  const p = run.payload ? JSON.parse(run.payload) : {};
  const a = p.action_id && get(p.action_id);
  if (!a) return { allow: false, reason: 'Blocked: no approved action is attached to this run.' };
  const x = ACTIONS[a.kind];
  if (ev.tool_name !== x.tool) return { allow: false, reason: `Blocked: this run may only call ${x.tool}.` };
  if (p.used) return { allow: false, reason: 'Blocked: this run has already made its one call.' };
  if (a.status !== 'approved') return { allow: false, reason: `Blocked: action ${a.id} is ${a.status}, not approved.` };
  if (!a.run_at || Date.parse(a.run_at) > at.getTime()) return { allow: false, reason: 'Blocked: it is not time for this action yet.' };
  const r = rules(a.kind);
  if (!inWindow(at, r.window)) return { allow: false, reason: 'Blocked: outside the allowed time window.' };
  const tz = r.window && r.window.timeZone;
  if (doneOn(a.kind, wall(at, tz).date, tz) >= r.perDay) return { allow: false, reason: 'Blocked: the daily limit is reached.' };
  const last = lastGone(a.kind);
  if (last && at.getTime() - Date.parse(last) < r.gapMinutes * 60000) return { allow: false, reason: 'Blocked: too soon after the last one.' };
  const payload = payloadOf(a);
  const b = blockedBy(a.kind, payload);
  if (b) return { allow: false, reason: `Blocked: "${b.value}" is on the blocklist.` };
  const inp = ev.tool_input || {};
  const extra = Object.keys(inp).filter((k) => !(k in x.match));
  if (extra.length) return { allow: false, reason: `Blocked: unexpected arguments ${extra.join(', ')}. Pass exactly the arguments given.` };
  for (const [arg, field] of Object.entries(x.match)) {
    if (norm(inp[arg]) !== norm(payload[field])) return { allow: false, reason: `Blocked: ${arg} differs from what was approved. Copy it exactly, character for character.` };
  }
  // one shot: mark it before the call goes out so it can never run twice
  p.used = true; p.tool_use_id = ev.tool_use_id;
  db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(p), run.id);
  db.prepare("UPDATE actions SET status='running', done_at=?, updated_at=? WHERE id=? AND status='approved'").run(now(), now(), a.id);
  log('gate', `Allowed: ${x.label || a.kind} ${a.id} matches what you approved`, a.id);
  return { allow: true };
}
// The service answered the executor's call.
function onResult(run, toolUseId, isError, text) {
  const p = run.payload ? JSON.parse(run.payload) : {};
  if (!p.used || p.tool_use_id !== toolUseId) return;
  const a = get(p.action_id);
  if (!a) return;
  const x = ACTIONS[a.kind];
  const outcome = isError ? 'failed' : (x.outcome ? x.outcome(text) : 'done');
  db.prepare('UPDATE actions SET status=?, result=?, problem=?, updated_at=? WHERE id=?')
    .run(outcome === 'done' ? 'done' : 'failed', String(text).slice(0, 2000), outcome === 'done' ? null : 'The service did not confirm it: ' + String(text).slice(0, 300), now(), a.id);
  log('action', `${x.label || a.kind} ${a.id} ${outcome === 'done' ? 'done' : 'FAILED'}`, a.id);
}
// The executor stopped. If it never made its call, or the answer never came, say so plainly.
function onRunEnd(run) {
  const p = run.payload ? JSON.parse(run.payload) : {};
  const a = p.action_id && get(p.action_id);
  if (!a) return;
  if (a.status === 'approved' && !p.used) {
    db.prepare("UPDATE actions SET status='failed', problem=?, updated_at=? WHERE id=?").run('The executor stopped without making the call: ' + (run.error || run.output || '').slice(0, 300), now(), a.id);
  } else if (a.status === 'running') {
    db.prepare("UPDATE actions SET status='check', problem=?, updated_at=? WHERE id=?").run('The call went out but no answer came back. Check the service, then mark it done or failed.', now(), a.id);
  }
}
function resolve(id, ok) {
  const ch = db.prepare("UPDATE actions SET status=?, problem=NULL, updated_at=? WHERE id=? AND status='check'").run(ok ? 'done' : 'failed', now(), id).changes;
  if (!ch) fail('Nothing to resolve.');
}

module.exports = { propose, approve, takeBack, reject, revise, resolve, nextSlot, inWindow, tick, check, onResult, onRunEnd, executorPrompt, payloadOf, get, norm };
