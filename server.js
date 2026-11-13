// agentic-ui: a local web app with agents inside it. Listens on this machine only.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, DATA, ROOT, now, log, bus } = require('./src/db');
const { AGENTS, ACTIONS, MAIN, page } = require('./src/config');
const mode = require('./src/mode');
const runner = require('./src/runner');
const { toolsFor, callTool } = require('./src/tools');
const { decide } = require('./src/policy');
const gates = require('./src/gates');
const ui = require('./src/uistream');

const PORT = Number(process.env.PORT) || 4477;
runner.setPort(PORT);
runner.recover();

const app = express();
app.use(express.json({ limit: '60mb' })); // room for attached images
const wrap = (fn) => (req, res) => {
  try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { res.status(400).json({ error: e.message }); }
};

// ---- agent-facing endpoints. Each run has its own secret token, valid only while it runs. ----
const runOf = (req) => { const t = req.get('x-run-token'); return t ? db.prepare("SELECT * FROM runs WHERE token=? AND status='running'").get(t) : null; };
app.get('/internal/tools', (req, res) => { const r = runOf(req); res.json({ tools: r ? toolsFor(r.agent) : [] }); });
app.post('/internal/call', async (req, res) => {
  const r = runOf(req);
  if (!r) return res.json({ error: 'This run is not active.' });
  try {
    const result = await callTool(r, req.body.name, req.body.args); // ask_agent waits for the worker
    bus.emit('ev', { t: 'data' });
    res.json({ result });
  } catch (e) { res.json({ error: e.userFacing ? e.message : 'Internal error: ' + e.message }); }
});
app.post('/internal/hook', (req, res) => {
  const r = runOf(req);
  if (!r) return res.json({ allow: false, reason: 'This run is not active.' });
  if (req.body.event !== 'PreToolUse') return res.json({});
  let d;
  try { d = decide(r, req.body); } catch (e) { d = { allow: false, reason: 'Policy check failed: ' + e.message }; }
  if (!d.allow) log('blocked', `${AGENTS[r.agent].label} tried ${req.body.tool_name}: ${d.reason}`, r.id);
  res.json(d);
});
// the executor's answer from the outside service, and its end
bus.on('toolresult', ({ run, tool_use_id, is_error, text }) => { if (run && run.kind === 'action') gates.onResult(run, tool_use_id, is_error, text); });
bus.on('done', (run) => { if (run && run.kind === 'action') gates.onRunEnd(run); });

// ---- browser-facing API. Writes need a custom header and a local host name, so another website cannot trigger them. ----
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-agentic') !== '1') return res.status(403).json({ error: 'Forbidden' });
  const host = (req.get('host') || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return res.status(403).json({ error: 'Forbidden' });
  next();
});
app.get('/api/agents', wrap(() => ({ main: MAIN, agents: Object.fromEntries(Object.values(AGENTS).map((a) => [a.name, { label: a.label, icon: a.icon || 'layers', worker: !!a.worker, executor: !!a.executor }])) })));
app.get('/api/where', wrap((req) => { const p = page(req.query.page); return { label: p.label, starters: p.starters || [] }; }));

// ---- gated actions ----
const idsOf = (q) => [...new Set(String(q || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40);
const actionRow = (a) => ({ id: a.id, kind: a.kind, label: (ACTIONS[a.kind] || {}).label || a.kind, title: a.title, status: a.status, version: a.updated_at,
  fields: Object.entries((ACTIONS[a.kind] || {}).fields || {}).map(([k, label]) => ({ key: k, label, value: gates.payloadOf(a)[k] || '' })),
  proposed_by: a.proposed_by, run_at: a.run_at, done_at: a.done_at, problem: a.problem, result: a.result, created_at: a.created_at,
  would_run_at: a.status === 'proposed' ? (() => { try { return gates.nextSlot(a.kind); } catch { return null; } })() : null });
app.get('/api/actions', wrap((req) => {
  const rows = req.query.ids ? idsOf(req.query.ids).map(gates.get).filter(Boolean) : db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 200').all();
  return { actions: rows.map(actionRow) };
}));
app.post('/api/actions/approve', wrap((req) => ({ done: gates.approve((req.body.items || []).map((it) => ({ id: Number(it.id), version: String(it.version || '') }))) })));
app.post('/api/actions/:id/takeback', wrap((req) => { gates.takeBack(Number(req.params.id)); return { ok: true }; }));
app.post('/api/actions/:id/reject', wrap((req) => { gates.reject(Number(req.params.id), String(req.body.reason || '').trim()); return { ok: true }; }));
app.post('/api/actions/:id/resolve', wrap((req) => { gates.resolve(Number(req.params.id), !!req.body.ok); return { ok: true }; }));
app.get('/api/blocklist', wrap(() => ({ kinds: Object.values(ACTIONS).filter((x) => x.blocklist).map((x) => ({ kind: x.kind, field: x.blocklist })), items: db.prepare('SELECT * FROM blocklist ORDER BY kind, value').all() })));
app.post('/api/blocklist', wrap((req) => {
  const kind = String(req.body.kind || ''), value = String(req.body.value || '').trim();
  if (!ACTIONS[kind] || !ACTIONS[kind].blocklist) throw new Error('That action has no blocklist.');
  if (!value) throw new Error('Give a value.');
  db.prepare('INSERT OR IGNORE INTO blocklist(kind,value,reason) VALUES(?,?,?)').run(kind, value, String(req.body.reason || '').trim() || null);
  log('blocklist', `You blocked ${value} for ${kind}`);
  return { ok: true };
}));
app.delete('/api/blocklist/:id', wrap((req) => { db.prepare('DELETE FROM blocklist WHERE id=?').run(req.params.id); return { ok: true }; }));

// ---- threads: your conversations with the main agent. Several can run at once. ----
const newThread = () => db.prepare('INSERT INTO threads(created_at) VALUES(?)').run(now()).lastInsertRowid;
const activeRun = (chatId) => db.prepare("SELECT id, status FROM runs WHERE chat_id=? AND status IN ('queued','running') ORDER BY id LIMIT 1").get(chatId) || null;
app.get('/api/threads', wrap(() => {
  if (!db.prepare('SELECT 1 FROM threads WHERE closed_at IS NULL').get()) newThread();
  const threads = db.prepare(`SELECT t.id, t.title, t.created_at,
      (SELECT COUNT(*) FROM runs r JOIN chats c ON c.id=r.chat_id WHERE c.agent=? AND c.scope='thread' AND c.scope_id=t.id AND r.status IN ('queued','running')) AS busy
    FROM threads t WHERE t.closed_at IS NULL ORDER BY t.id`).all(MAIN);
  const workers = db.prepare("SELECT id, agent, status FROM runs WHERE status IN ('queued','running') AND agent!=? ORDER BY id").all(MAIN).map((r) => ({ ...r, label: AGENTS[r.agent].label }));
  return { threads, workers };
}));
app.post('/api/threads', wrap(() => ({ id: newThread() })));
app.put('/api/threads/:id', wrap((req) => {
  const title = String(req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!title) throw new Error('Give the thread a name.');
  db.prepare('UPDATE threads SET title=?, titled=2 WHERE id=?').run(title, req.params.id); // 2 = named by you; the agent leaves it alone
  return { ok: true };
}));
app.delete('/api/threads/:id', wrap((req) => {
  const chat = db.prepare("SELECT id FROM chats WHERE agent=? AND scope='thread' AND scope_id=?").get(MAIN, req.params.id);
  if (chat && activeRun(chat.id)) throw new Error('The agent is still working in that thread. Stop it first.');
  db.prepare('UPDATE threads SET closed_at=? WHERE id=?').run(now(), req.params.id);
  return { ok: true };
}));
// The workers' own conversations, to read (not to type into).
app.get('/api/workers', wrap(() => db.prepare(`SELECT c.id AS chat, c.agent, c.scope, c.scope_id,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS count, (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id=c.id) AS last_at,
    (SELECT COUNT(*) FROM runs r WHERE r.chat_id=c.id AND r.status IN ('queued','running')) AS busy
  FROM chats c WHERE c.agent!=?`).all(MAIN).filter((c) => (c.count || c.busy) && AGENTS[c.agent])
  .map((c) => ({ ...c, id: `${c.agent}-${c.scope}-${c.scope_id}`, label: AGENTS[c.agent].label }))
  .sort((x, y) => (y.busy - x.busy) || String(y.last_at || '').localeCompare(String(x.last_at || '')))));

// ---- chats: the rail is useChat from the Vercel AI SDK; these speak its stream format ----
// A chat id is agent-scope-id: the main agent's are <main>-thread-<thread id>, a worker's is <worker>-worker-1.
function chatOf(id) {
  const m = /^([a-z][a-z0-9_]*)-(thread|worker)-(\d+)$/.exec(String(id || ''));
  if (!m || !AGENTS[m[1]] || (m[2] === 'thread') !== (m[1] === MAIN)) throw new Error('Unknown chat');
  if (m[2] === 'thread' && !db.prepare('SELECT 1 FROM threads WHERE id=? AND closed_at IS NULL').get(Number(m[3]))) throw new Error('That thread is closed.');
  return runner.getChat(m[1], m[2], Number(m[3]));
}
app.get('/api/ui/chat/:id/messages', wrap((req) => {
  const chat = chatOf(req.params.id);
  return { chat: chat.id, messages: ui.toUIMessages(db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY id').all(chat.id)), run: activeRun(chat.id) };
}));
// Attached images arrive as data: URLs. They are saved under data/uploads and the agent is told where, so it can read them.
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function saveImages(chat, fileParts) {
  if (fileParts.length > 6) throw new Error('Attach at most 6 images to one message.');
  const dir = path.join(DATA, 'uploads', 'c' + chat.id);
  return fileParts.map((p, i) => {
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/s.exec(String(p.url || ''));
    const ext = m && IMAGE_TYPES[m[1]];
    if (!ext) throw new Error('Only PNG, JPEG, WebP and GIF images can be attached.');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw new Error('That image is over 8 MB.');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${i + 1}.${ext}`;
    fs.writeFileSync(path.join(dir, name), bytes);
    return { path: path.join(dir, name), url: `/api/uploads/c${chat.id}/${name}`, mediaType: m[1], name };
  });
}
app.get('/api/uploads/:dir/:name', (req, res) => {
  if (!/^c\d+$/.test(req.params.dir) || !/^\d+-\d+\.(png|jpg|webp|gif)$/.test(req.params.name)) return res.status(404).end();
  res.sendFile(path.join(DATA, 'uploads', req.params.dir, req.params.name), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
// You sent a message: queue the turn and stream the reply back on this same request.
app.post('/api/ui/chat', (req, res) => {
  try {
    const chat = chatOf(req.body.id);
    if (chat.agent !== MAIN) throw new Error('Workers take their jobs from the main agent. Ask it instead.');
    if (req.body.trigger !== 'submit-message') throw new Error('Only new messages are supported.');
    const last = (req.body.messages || []).filter((m) => m && m.role === 'user').pop();
    const typed = ((last && last.parts) || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
    const images = saveImages(chat, ((last && last.parts) || []).filter((p) => p.type === 'file'));
    if (!typed && !images.length) throw new Error('Type a message first.');
    const text = typed || (images.length > 1 ? 'Look at these images.' : 'Look at this image.');
    const parts = images.length ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'file', mediaType: i.mediaType, url: i.url, filename: i.name }))] : null;
    const extra = images.length ? `The person attached ${images.length} image(s). Look at each with the Read tool before you answer: ${images.map((i) => i.path).join(' , ')}` : '';
    const p = page(req.body.page);
    db.prepare('UPDATE threads SET title=? WHERE id=? AND titled=0 AND title IS NULL').run((typed || 'Image').replace(/\s+/g, ' ').slice(0, 44), chat.scope_id);
    ui.attach(runner.ask(chat.agent, chat.scope, chat.scope_id, text, 'user', p.line || '', parts, extra), res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Join a reply already under way (page reload, or a turn the app started). 204 = nothing running.
app.get('/api/ui/chat/:id/stream', (req, res) => {
  try {
    const run = activeRun(chatOf(req.params.id).id);
    if (!run || !ui.attach(run.id, res)) res.status(204).end();
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/runs/:id/cancel', wrap((req) => ({ ok: runner.cancel(Number(req.params.id)) })));

// ---- notebooks and activity ----
app.get('/api/notes', wrap(() => ({ notebooks: ['general', ...Object.values(AGENTS).filter((a) => a.memory).map((a) => a.name)], labels: Object.fromEntries(Object.values(AGENTS).map((a) => [a.name, a.label])), notes: db.prepare('SELECT * FROM notes ORDER BY id').all() })));
app.delete('/api/notes/:id', wrap((req) => { db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id); return { ok: true }; }));
app.get('/api/activity', wrap(() => db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 200').all()));
app.get('/api/state', wrap(() => ({
  mode: mode.MODE,
  counts: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM actions GROUP BY status').all().map((r) => [r.status, r.n])),
  runs: db.prepare("SELECT id, agent, kind, status FROM runs WHERE status IN ('queued','running') ORDER BY id").all(),
})));

// ---- live updates ----
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('ev', send);
  req.on('close', () => { clearInterval(ping); bus.off('ev', send); });
});

// ---- real / demo mode. Switching writes .mode and restarts the app (start.sh starts it again). ----
app.get('/api/mode', wrap(() => ({ mode: mode.MODE, pinned: mode.PINNED })));
app.post('/api/mode', wrap((req, res) => {
  const want = req.body.mode === 'demo' ? 'demo' : 'real';
  if (want === mode.MODE) return { mode: want, restarting: false };
  if (mode.PINNED) throw new Error('The mode is pinned by AGENTIC_MODE for this run.');
  if (runner.live.size || db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get()) throw new Error('Agents are still working. Wait for them, or stop them, then switch.');
  mode.writeMode(want);
  log('mode', `Switching to ${want} mode`);
  res.json({ mode: want, restarting: true });
  setTimeout(() => process.exit(mode.RESTART_CODE), 300);
}));
// the page carries the mode, so the browser keeps demo and real drafts apart
const indexHtml = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('<html lang="en">', `<html lang="en" data-mode="${mode.MODE}">`);
app.get(['/', '/index.html'], (req, res) => res.type('html').send(indexHtml()));
app.use('/vendor/marked.js', express.static(path.join(ROOT, 'node_modules/marked/lib/marked.umd.js')));
app.use('/vendor/purify.js', express.static(path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js')));
app.use(express.static(path.join(ROOT, 'public')));
if (!fs.existsSync(path.join(ROOT, 'public', 'chat.bundle.js'))) console.warn('The chat rail has not been built. Run: npm run build');

app.listen(PORT, '127.0.0.1', () => {
  setInterval(() => { try { gates.tick(); } catch (e) { log('error', 'Scheduler: ' + e.message); } }, 15000);
  console.log(`agentic-ui running at http://127.0.0.1:${PORT}` + (mode.DEMO ? '  [DEMO MODE: mock services, demo data]' : ''));
});
