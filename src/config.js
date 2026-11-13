// Loads agents.config.js and checks it, so a typo fails at start-up rather than in the middle of a run.
const path = require('path');
const { ROOT, DEMO } = require('./mode');

const cfg = require(process.env.AGENTIC_CONFIG ? path.resolve(process.env.AGENTIC_CONFIG) : path.join(ROOT, 'agents.config.js'));
const AGENTS = cfg.agents || {};
const ACTIONS = cfg.actions || {};
const fail = (m) => { throw new Error('agents.config.js: ' + m); };

if (!AGENTS[cfg.main]) fail(`main agent "${cfg.main}" is not in agents.`);
for (const [name, a] of Object.entries(AGENTS)) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`agent name "${name}" must be lower case letters, digits and _.`);
  if (!a.prompt) fail(`agent "${name}" needs a prompt file.`);
  a.name = name; a.label = a.label || name; a.tools = a.tools || []; a.appTools = a.appTools || [];
}
for (const [kind, x] of Object.entries(ACTIONS)) {
  if (!AGENTS[x.executor] || !AGENTS[x.executor].executor) fail(`action "${kind}" needs an executor agent marked executor: true.`);
  if (!x.tool || !AGENTS[x.executor].tools.includes(x.tool)) fail(`action "${kind}": its executor must list the tool ${x.tool}.`);
  if (!x.match || !Object.keys(x.match).length) fail(`action "${kind}" needs a match map.`);
  x.kind = kind; x.fields = x.fields || {}; x.required = x.required || Object.keys(x.fields);
}
// The gate rules in force: demo mode loosens the timing so things happen on camera.
function rules(kind) {
  const x = ACTIONS[kind];
  const d = cfg.demo || {};
  if (!DEMO) return { window: x.window || null, perDay: (x.rate || {}).perDay || Infinity, gapMinutes: (x.rate || {}).gapMinutes || 0 };
  return { window: 'window' in d ? d.window : x.window || null, perDay: Infinity, gapMinutes: 'gapMinutes' in d ? d.gapMinutes : (x.rate || {}).gapMinutes || 0 };
}
const actionForTool = (tool) => Object.values(ACTIONS).find((x) => x.tool === tool) || null;
const page = (hash) => (typeof cfg.page === 'function' ? cfg.page(hash) : null) || { label: 'Home', line: '', starters: [] };

module.exports = { cfg, AGENTS, ACTIONS, MAIN: cfg.main, rules, actionForTool, page };
