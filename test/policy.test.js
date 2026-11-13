// Checks the policy (what each agent may call) in demo mode. Run: node test/policy.test.js
const os = require('os'), fs = require('fs'), path = require('path');
process.env.AGENTIC_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-'));
process.env.AGENTIC_MODE = 'demo';
const { ROOT } = require('../src/mode');
const { decide } = require('../src/policy');

let pass = 0, failed = 0;
const check = (name, agent, tool, input, want, kind = 'chat') => {
  const d = decide({ id: 0, agent, kind, payload: null }, { tool_name: tool, tool_input: input });
  const good = !!d.allow === want;
  good ? pass++ : failed++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + name + (good ? '' : `  (got ${d.allow ? 'allow' : 'deny: ' + d.reason})`));
};
check('loading tool definitions is always allowed', 'writer', 'ToolSearch', {}, true);
check('an agent may use a tool it lists', 'assistant', 'Read', { file_path: 'prompts/assistant.md' }, true);
check('an agent may not use a tool it does not list', 'writer', 'Read', { file_path: 'x' }, false);
check('an agent may not use Bash unless listed', 'assistant', 'Bash', { command: 'ls' }, false);
check('an app tool the agent lists is allowed', 'writer', 'mcp__app__propose_action', {}, true);
check('an app tool the agent does not list is refused', 'writer', 'mcp__app__ask_agent', {}, false);
check('demo mode switches off the tools in demo.blockTools', 'assistant', 'WebSearch', { query: 'x' }, false);
check('demo mode keeps file tools off the real data folder', 'assistant', 'Read', { file_path: 'data/app.db' }, false);
check('... by full path too', 'assistant', 'Grep', { pattern: 'x', path: path.join(ROOT, 'data') }, false);
check('... but the demo data folder is fine', 'assistant', 'Read', { file_path: path.join(ROOT, 'data-demo', 'notes.txt') }, true);
check('a gated tool is refused outside an approved action', 'publisher', 'mcp__notes__publish_note', { channel: '#team', title: 'x', body: 'y' }, false);
check('an unknown agent is refused', 'stranger', 'Read', {}, false);
console.log(`\n${pass} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
