#!/usr/bin/env node
// Runs before every tool call an agent makes and asks the app "is this allowed?" (src/policy.js answers).
// If the app cannot be reached, the answer is no.
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', async () => {
  let ev = {};
  try { ev = JSON.parse(s); } catch { /* empty input: deny below */ }
  const out = (decision, why) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: why } }));
  try {
    const r = await fetch(process.env.APP_URL + '/internal/hook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-run-token': process.env.APP_TOKEN },
      body: JSON.stringify({ event: ev.hook_event_name, tool_name: ev.tool_name, tool_input: ev.tool_input, tool_use_id: ev.tool_use_id }),
    });
    const j = await r.json();
    if (ev.hook_event_name !== 'PreToolUse') return;
    if (j.allow) out('allow', 'app policy');
    else out('deny', j.reason || 'Blocked by the app policy.');
  } catch {
    if (ev.hook_event_name === 'PreToolUse') out('deny', 'The app is unreachable, so nothing is allowed.');
  }
});
