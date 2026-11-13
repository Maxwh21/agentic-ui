// The policy: the hook (mcp/hook.js) asks this about every tool call every agent makes, before it runs.
// An agent can only use what its entry in agents.config.js lists; gated tools also pass the gate.
const path = require('path');
const { log } = require('./db');
const { cfg, AGENTS, actionForTool } = require('./config');
const { DEMO, ROOT } = require('./mode');
const { toolsFor } = require('./tools');
const gates = require('./gates');

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'];
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Demo mode: file and shell tools may not reach the real data folder (data/), only data-demo/.
function touchesRealData(input) {
  let s = JSON.stringify(input || {}).replace(/[\w./~-]*data-demo[\w./-]*/g, 'DEMO');
  s = s.replace(new RegExp(reEsc(ROOT) + '/', 'g'), '');
  return /(^|[^\w.-])data([/"\\\s]|$)/.test(s) || /\bapp\.db\b/.test(s);
}

function decide(run, ev) {
  const a = AGENTS[run.agent];
  const name = ev.tool_name || '';
  const input = ev.tool_input || {};
  if (!a) return { allow: false, reason: 'Unknown agent.' };
  if (name === 'ToolSearch') return { allow: true }; // loading tool definitions is always fine
  if (name.startsWith('mcp__app__')) {
    const ok = toolsFor(run.agent).some((t) => 'mcp__app__' + t.name === name);
    return ok ? { allow: true } : { allow: false, reason: `Blocked: the ${a.label} agent may not use ${name}.` };
  }
  if (!a.tools.includes(name)) return { allow: false, reason: `Blocked: the ${a.label} agent may not use ${name}.` };
  if (DEMO) {
    if (((cfg.demo || {}).blockTools || []).includes(name)) return { allow: false, reason: `Demo mode: ${name} is switched off, so nothing real comes in. Use the demo records.` };
    if (FILE_TOOLS.includes(name) && touchesRealData(input)) return { allow: false, reason: 'Demo mode: the real data folder is off limits. The demo data is in data-demo/.' };
  }
  const gated = actionForTool(name);
  if (gated) {
    if (run.kind !== 'action') return { allow: false, reason: `Blocked: ${name} only runs for an approved action.` };
    return gates.check(run, { ...ev, tool_input: input });
  }
  if (name === 'Bash') log('shell', `${a.label} ran: ${String(input.command || '').slice(0, 600)}`, run.id);
  if (name === 'Edit' || name === 'Write') log('file', `${a.label} changed ${input.file_path ? path.relative(ROOT, input.file_path) || input.file_path : 'a file'}`, run.id);
  return { allow: true };
}

module.exports = { decide, touchesRealData };
