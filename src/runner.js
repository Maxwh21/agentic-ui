// Starts agents, one process per turn, and keeps their conversations. Each chat keeps its session id,
// so an agent remembers the conversation across turns. Runs queue up; workers share a parallel limit.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA, ROOT, now, log, bus } = require('./db');
const { cfg, AGENTS, MAIN } = require('./config');
const { DEMO } = require('./mode');
const ui = require('./uistream');
const adapter = require(process.env.AGENTIC_ADAPTER ? path.resolve(process.env.AGENTIC_ADAPTER) : './adapters/claude-code');

const live = new Map(); // run id -> { stop, agent }
let PORT = 4477;
const setPort = (p) => { PORT = p; };

// ---- notebooks: what each agent remembers across all its conversations ----
function notebooksText(agent) {
  const all = db.prepare('SELECT * FROM notes ORDER BY id').all();
  const part = (nb, title) => {
    const rows = all.filter((n) => n.notebook === nb).slice(-60);
    return `## ${title}\n` + (rows.length ? rows.map((n) => `- [note ${n.id}] ${n.text}`).join('\n') : '- (empty)');
  };
  return part(agent, 'Your own notebook') + '\n\n' + part('general', 'The general notebook (shared by every agent)');
}

function systemPrompt(run) {
  const a = AGENTS[run.agent];
  const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
  const memory = a.memory ? '# What you remember\nThese notebooks carry over between your conversations. Use remember and forget to keep them useful.\n\n' + notebooksText(run.agent) : '';
  const demo = DEMO ? '# Demo mode\nThe app is in demo mode: outside services are mock versions that return made-up data, and nothing real happens. Treat what they return as real records, and do the work as usual.' : '';
  return [read(a.prompt), read('prompts/rules.md'), memory, demo, `# Facts\nToday is ${new Date().toISOString().slice(0, 10)}.`].filter(Boolean).join('\n\n');
}

function getChat(agent, scope, scopeId) {
  let c = db.prepare('SELECT * FROM chats WHERE agent=? AND scope=? AND scope_id=?').get(agent, scope, scopeId);
  if (!c) {
    const id = db.prepare('INSERT INTO chats(agent,scope,scope_id) VALUES(?,?,?)').run(agent, scope, scopeId).lastInsertRowid;
    c = db.prepare('SELECT * FROM chats WHERE id=?').get(id);
  }
  return c;
}
function addMessage(chatId, role, text, parts = null, runId = null) {
  db.prepare('INSERT INTO messages(chat_id,role,text,parts,run_id,created_at) VALUES(?,?,?,?,?,?)').run(chatId, role, text, parts ? JSON.stringify(parts) : null, runId, now());
  bus.emit('ev', { t: 'msg', chat: chatId });
}

// Queue a turn in a conversation. role 'user' = you typed it; 'auto' = the app or another agent asked.
// context = a line only the agent sees (e.g. which page you are on); extra = more lines only the agent sees.
function ask(agent, scope, scopeId, text, role = 'user', context = '', parts = null, extra = '') {
  const chat = getChat(agent, scope, scopeId);
  addMessage(chat.id, role, text, parts);
  const prompt = (context ? `[${context}]\n\n` : '') + text + (extra ? `\n\n[${extra}]` : '');
  return enqueue({ agent, kind: 'chat', chat_id: chat.id, scope, scope_id: scopeId, prompt });
}
function enqueue({ agent, kind, chat_id = null, scope = null, scope_id = null, prompt, payload = null }) {
  const id = db.prepare('INSERT INTO runs(chat_id,agent,kind,scope,scope_id,status,prompt,payload,token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(chat_id, agent, kind, scope, scope_id, 'queued', prompt, payload ? JSON.stringify(payload) : null, crypto.randomBytes(24).toString('hex'), now()).lastInsertRowid;
  if (kind === 'chat' && chat_id) ui.open(id); // the chat rail follows this run live
  bus.emit('ev', { t: 'run' });
  setImmediate(pump);
  return id;
}

function pump() {
  const max = Number(cfg.maxParallel) || 3;
  for (const r of db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY id").all()) {
    // the main agent never waits for a slot and does not use one up: it waits on the workers it calls
    if (r.agent !== MAIN && [...live.values()].filter((x) => x.agent !== MAIN).length >= max) continue;
    if (r.chat_id && db.prepare("SELECT 1 FROM runs WHERE status='running' AND chat_id=?").get(r.chat_id)) continue; // one turn at a time per chat
    if (AGENTS[r.agent].executor && db.prepare("SELECT 1 FROM runs WHERE status='running' AND agent=?").get(r.agent)) continue; // one action at a time
    start(r);
  }
}

// The MCP servers an agent gets: the app's own tools, plus the outside services its tool list names.
function mcpServersFor(agent, token) {
  const node = process.execPath;
  const servers = { app: { command: node, args: [path.join(ROOT, 'mcp', 'app-mcp.js')], env: { APP_URL: `http://127.0.0.1:${PORT}`, APP_TOKEN: token } } };
  const wanted = new Set(AGENTS[agent].tools.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__')[1]));
  for (const [name, s] of Object.entries(cfg.services || {})) {
    if (!wanted.has(name)) continue;
    const use = DEMO ? s.mock : s;
    if (!use) continue; // a service with no mock is simply absent in demo mode
    const command = use.command === 'node' ? node : use.command;
    servers[name] = { command, args: (use.args || []).map((x) => (/^[\w./-]+\.(m?js|py)$/.test(x) ? path.join(ROOT, x) : x)), env: { DATA_DIR: DATA, ...(use.env || {}) } };
  }
  return servers;
}

function start(run) {
  const a = AGENTS[run.agent];
  const chat = run.chat_id ? db.prepare('SELECT * FROM chats WHERE id=?').get(run.chat_id) : null;
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER || '', LANG: process.env.LANG || 'en_GB.UTF-8',
    APP_URL: `http://127.0.0.1:${PORT}`, APP_TOKEN: run.token }; // no API key is passed: agents run on your Claude login
  if (DEMO) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(now(), run.id);
  const st = { agent: run.agent, texts: [], result: null, ui: ui.has(run.id) ? ui.translator(run.id) : null };
  const handle = adapter.start({
    prompt: run.prompt, system: systemPrompt(run), model: a.model, tools: a.tools, sessionId: chat && chat.session_id,
    hookCommand: `"${process.execPath}" "${path.join(ROOT, 'mcp', 'hook.js')}"`, mcpServers: mcpServersFor(run.agent, run.token),
    cwd: a.cwd ? path.resolve(ROOT, a.cwd) : path.join(DATA, 'agent-home'), env,
    onEvent: (m) => onEvent(run, chat, st, m),
    onExit: (code, err) => finish(run, chat, st, code, err),
  });
  st.stop = handle.stop;
  st.timer = setTimeout(() => { st.why = 'Stopped: ran longer than 25 minutes.'; handle.stop(); }, 25 * 60 * 1000);
  live.set(run.id, st);
  ui.push(run.id, { type: 'message-metadata', messageMetadata: { runId: run.id, queued: false } });
  bus.emit('ev', { t: 'run' });
}

function onEvent(run, chat, st, m) {
  if (st.ui) st.ui.onEvent(m); // live text, thinking and tool calls for the chat rail
  if (m.type === 'system' && m.subtype === 'init' && chat && m.session_id) db.prepare('UPDATE chats SET session_id=? WHERE id=?').run(m.session_id, chat.id);
  else if (m.type === 'assistant') { for (const c of m.message.content || []) if (c.type === 'text' && c.text.trim()) st.texts.push(c.text.trim()); }
  else if (m.type === 'user') {
    for (const c of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) {
      if (c.type === 'tool_result') bus.emit('toolresult', { run: db.prepare('SELECT * FROM runs WHERE id=?').get(run.id), tool_use_id: c.tool_use_id, is_error: !!c.is_error, text: ui.resultText(c.content) });
    }
  } else if (m.type === 'result') st.result = m;
}

function finish(run, chat, st, code, err) {
  clearTimeout(st.timer);
  live.delete(run.id);
  const res = st.result;
  const ok = res && !res.is_error && code === 0;
  const text = st.texts.join('\n\n').trim() || (res && typeof res.result === 'string' ? res.result : '');
  const error = ok ? null : (st.why || (res && res.is_error && String(res.result)) || String(err || '').trim().slice(-600) || `Agent stopped (code ${code}).`);
  db.prepare('UPDATE runs SET status=?, error=?, output=?, ended_at=? WHERE id=?').run(ok ? 'done' : 'error', error, text.slice(0, 4000), now(), run.id);
  const parts = st.ui ? st.ui.finish() : null;
  if (chat) {
    if (text || (parts && parts.some((p) => p.type === 'dynamic-tool'))) addMessage(chat.id, 'assistant', text, parts, run.id);
    if (!ok) addMessage(chat.id, 'error', /limit|quota|rate/i.test(error) ? 'Claude usage limit reached, or the service is busy. Try again later.\n\n' + error : 'The agent stopped with an error.\n\n' + error);
  }
  ui.end(run.id); // after the messages are saved, so the rail finds them when it reloads
  if (!ok) log('run_error', `${AGENTS[run.agent].label}: ${error}`, run.id);
  bus.emit('ev', { t: 'run' });
  bus.emit('done', db.prepare('SELECT * FROM runs WHERE id=?').get(run.id));
  pump();
}

function cancel(runId) {
  const st = live.get(runId);
  if (st) { st.why = 'Stopped by you.'; st.stop(); return true; }
  const q = db.prepare("UPDATE runs SET status='error', error='Cancelled before it started', ended_at=? WHERE id=? AND status='queued'").run(now(), runId);
  ui.end(runId);
  bus.emit('ev', { t: 'run' });
  return q.changes > 0;
}
// After a restart nothing is really running: clear stale rows.
function recover() {
  db.prepare("UPDATE runs SET status='error', error='App restarted while this was running', ended_at=? WHERE status IN ('running','queued')").run(now());
}

module.exports = { ask, enqueue, getChat, addMessage, cancel, recover, setPort, pump, live, systemPrompt, mcpServersFor };
