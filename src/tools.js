// The app's own tools, served to agents over MCP (mcp/app-mcp.js). Each agent gets only the ones its
// `appTools` list names in agents.config.js. Every write is checked here, not left to the agent.
const { db, now, log } = require('./db');
const { cfg, AGENTS, ACTIONS, MAIN } = require('./config');
const gates = require('./gates');

const T = {};
const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const fail = (m) => { const e = new Error(m); e.userFacing = true; throw e; };
const def = (name, description, properties, required, handler) => { T[name] = { name, description, inputSchema: { type: 'object', properties: properties || {}, required: required || [] }, handler }; };
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

// ---- notebooks: lasting memory across conversations ----
def('remember', 'Write one lasting note. "mine" is about how you do your own job; "general" is something every agent should know. One short sentence per note.',
  { note: S, notebook: { type: 'string', enum: ['mine', 'general'] } }, ['note', 'notebook'], (ctx, a) => {
    const text = String(a.note || '').replace(/\s+/g, ' ').trim();
    if (text.length < 8) fail('That note is too short to be useful.');
    if (text.length > 400) fail('Keep a note under 400 characters.');
    const nb = a.notebook === 'general' ? 'general' : ctx.agent;
    if (db.prepare('SELECT 1 FROM notes WHERE notebook=? AND lower(text)=?').get(nb, text.toLowerCase())) fail('That exact note is already there.');
    if (db.prepare('SELECT COUNT(*) n FROM notes WHERE notebook=?').get(nb).n >= 80) fail('This notebook is full (80 notes). Remove an out-of-date note first.');
    const id = db.prepare('INSERT INTO notes(notebook,text,written_by,created_at) VALUES(?,?,?,?)').run(nb, text, ctx.agent, now()).lastInsertRowid;
    log('note', `${AGENTS[ctx.agent].label} noted: ${text}`, id);
    return { ok: true, note_id: id };
  });
def('forget', 'Remove a note that is wrong or out of date, from your own notebook or the general one.', { note_id: N }, ['note_id'], (ctx, a) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(a.note_id);
  if (!n) fail('No note with that id.');
  if (n.notebook !== ctx.agent && n.notebook !== 'general') fail("That note is in another agent's notebook.");
  db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
  return { ok: true };
});

// ---- hand work to a worker ----
function waitForRun(runId, ms = 240000) {
  const { bus } = require('./db');
  const answer = (r) => (r.status === 'done' ? { status: 'done', reply: r.output || '(finished without a reply)' } : { status: 'failed', error: r.error || 'The agent stopped.', reply: r.output || '' });
  return new Promise((resolve) => {
    const r = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    if (!r) return resolve({ status: 'failed', error: 'No such run.' });
    if (r.status === 'done' || r.status === 'error') return resolve(answer(r));
    const onDone = (run) => { if (run.id === runId) { clearTimeout(timer); bus.off('done', onDone); resolve(answer(run)); } };
    const timer = setTimeout(() => { bus.off('done', onDone); resolve({ status: 'working', run_id: runId, next: 'Still working. Call agent_result with this run_id to keep waiting.' }); }, ms);
    bus.on('done', onDone);
  });
}
const WORKERS = Object.values(AGENTS).filter((a) => a.worker).map((a) => a.name);
def('ask_agent', `Hand a job to a worker and wait for its reply. Workers: ${WORKERS.join(', ') || 'none'}. The worker does not see your conversation, so the message must contain everything it needs. You can read what it did in its log.`,
  { agent: { type: 'string', enum: WORKERS }, message: S }, ['agent', 'message'], (ctx, a) => {
    if (!WORKERS.includes(a.agent)) fail(`Unknown worker. Use one of: ${WORKERS.join(', ')}.`);
    const text = String(a.message || '').trim();
    if (text.length < 5) fail('Say what you want the worker to do.');
    const runId = require('./runner').ask(a.agent, 'worker', 1, 'From the assistant, on your behalf:\n' + text, 'auto');
    log('handoff', `${AGENTS[ctx.agent].label} asked ${AGENTS[a.agent].label}: ${text.slice(0, 300)}`, runId);
    return waitForRun(runId);
  });
def('agent_result', 'Keep waiting for a worker that was still working when ask_agent returned.', { run_id: N }, ['run_id'], (ctx, a) => waitForRun(Number(a.run_id)));
def('name_thread', 'Give this conversation a short title (two to five words) once its subject is clear.', { title: S }, ['title'], (ctx, a) => {
  const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (title.length < 2) fail('Give a short title.');
  if (ctx.scope !== 'thread') fail('Only the main conversation has a title.');
  const done = db.prepare('UPDATE threads SET title=?, titled=1 WHERE id=? AND titled<2').run(title, ctx.scope_id).changes;
  return done ? { ok: true } : { ok: false, note: 'You named this thread yourself; the agent leaves it alone.' };
});

// ---- gated actions ----
const kinds = Object.keys(ACTIONS);
def('propose_action', `Propose an action for a human to approve. Nothing happens until they press Approve on a card. Kinds: ${kinds.map((k) => `${k} (fields: ${Object.keys(ACTIONS[k].fields).join(', ')})`).join('; ') || 'none'}. Give action_id to change a proposal that has not been approved yet.`,
  { kind: { type: 'string', enum: kinds }, fields: { type: 'object' }, action_id: N }, ['kind', 'fields'], (ctx, a) => {
    if (a.action_id) { gates.revise(Number(a.action_id), a.fields || {}, AGENTS[ctx.agent].label); return { ok: true, action_id: Number(a.action_id), note: 'Changed. It needs a fresh approval.' }; }
    const id = gates.propose(a.kind, a.fields || {}, AGENTS[ctx.agent].label);
    return { ok: true, action_id: id, note: 'Proposed. It waits for approval; show it with show_actions.' };
  });
def('list_actions', 'List actions and where each stands (proposed, approved, running, done, failed, rejected).', { status: S }, [], (ctx, a) =>
  db.prepare(`SELECT id, kind, title, status, run_at, done_at, problem FROM actions ${a.status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 50`).all(...(a.status ? [a.status] : [])));
def('show_actions', 'Put actions in front of the human as a card in the chat. The card shows the live content from the records, so do not repeat it. Set ask_approval to true to put an Approve button on it. That button is the only way an action is approved: you cannot approve one, and must not say it is approved unless list_actions shows it.',
  { action_ids: { type: 'array', items: N }, ask_approval: B }, ['action_ids'], (ctx, a) => {
    const ids = idList(a.action_ids);
    if (!ids.length) fail('Give the action ids (see list_actions).');
    if (ids.some((id) => !gates.get(id))) fail('One of those action ids does not exist.');
    return { shown: ids, note: a.ask_approval ? 'They now see these with an Approve button. Wait for them.' : 'They now see these as a card.' };
  });

// ---- the panel: a view composed by the agent, opened over the right of the page ----
const PANEL_TYPES = ['heading', 'text', 'facts', 'callout', 'links', 'choices', 'actions', 'tabs'];
def('show_panel', 'Open a panel over the right of the page and lay out what was asked for, as blocks. A new call replaces the panel. Blocks:\n'
  + '- {type:"heading", text}  - {type:"text", text} (markdown)  - {type:"facts", items:[{label, value}]}\n'
  + '- {type:"callout", tone:"warn"|"info"|"good", text}  - {type:"links", items:[{label, url}]}\n'
  + '- {type:"actions", action_ids:[...], ask_approval, then}: live action cards; then = text sent to you as the next message once approved\n'
  + '- {type:"choices", items:["Next", ...]}: buttons that send that text to you as the next message\n'
  + '- {type:"tabs", tabs:[{label, blocks:[...]}], open}: tabs (no tabs inside tabs)\n'
  + 'Do not repeat in the chat what a live block already shows.',
  { title: S, subtitle: S, blocks: { type: 'array', items: { type: 'object' } } }, ['title', 'blocks'], (ctx, a) => {
    if (!String(a.title || '').trim()) fail('Give the panel a title.');
    const blocks = Array.isArray(a.blocks) ? a.blocks : [];
    if (!blocks.length || blocks.length > 40) fail('Give 1 to 40 blocks.');
    const check = (b, where, nested) => {
      if (!b || !PANEL_TYPES.includes(b.type)) fail(`${where}: type must be one of ${PANEL_TYPES.join(', ')}.`);
      if (b.type === 'tabs') {
        if (nested) fail(`${where}: no tabs inside tabs.`);
        if (!Array.isArray(b.tabs) || b.tabs.length < 2 || b.tabs.length > 8) fail(`${where}: give 2 to 8 tabs.`);
        b.tabs.forEach((t, j) => { if (!t || !String(t.label || '').trim() || !Array.isArray(t.blocks) || !t.blocks.length) fail(`${where}, tab ${j + 1}: give a label and blocks.`); t.blocks.forEach((tb, k) => check(tb, `${where}, tab ${j + 1}, block ${k + 1}`, true)); });
        return;
      }
      if (['heading', 'text', 'callout'].includes(b.type) && !String(b.text || '').trim()) fail(`${where}: give some text.`);
      if (['facts', 'links', 'choices'].includes(b.type) && !(Array.isArray(b.items) && b.items.length)) fail(`${where}: give items.`);
      if (b.type === 'links' && b.items.some((l) => !/^https?:\/\//.test(String(l && l.url)))) fail(`${where}: every link needs an http(s) url.`);
      if (b.type === 'actions' && (!idList(b.action_ids).length || idList(b.action_ids).some((id) => !gates.get(id)))) fail(`${where}: check the action ids.`);
    };
    blocks.forEach((b, i) => check(b, `Block ${i + 1}`, false));
    return { shown: true, note: 'The panel is open. Reply in a line or two and wait.' };
  });

// ---- your own tools, from agents.config.js ----
for (const [name, t] of Object.entries(cfg.tools || {})) {
  if (T[name]) throw new Error(`agents.config.js: tool "${name}" clashes with a built-in app tool.`);
  def(name, t.description || name, t.input || {}, t.required || [], (ctx, a) => t.handler(ctx, a, { db, log, fail }));
}
for (const a of Object.values(AGENTS)) for (const t of a.appTools) if (!T[t]) throw new Error(`agents.config.js: agent "${a.name}" lists unknown app tool "${t}".`);

const toolsFor = (agent) => AGENTS[agent].appTools.map((n) => T[n]).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
function callTool(ctx, name, args) {
  if (!AGENTS[ctx.agent].appTools.includes(name) || !T[name]) fail(`Tool ${name} is not available to this agent.`);
  return T[name].handler(ctx, args || {});
}
module.exports = { toolsFor, callTool, TOOL_NAMES: () => Object.keys(T), MAIN };
