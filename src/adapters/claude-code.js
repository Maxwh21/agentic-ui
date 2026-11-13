// The one file that knows how an agent is started. This one runs the Claude Code CLI (`claude -p`) on your own
// Claude login. To use another provider, write a file with the same `start` function and point the runner at it:
// it must call onEvent with Claude Code "stream-json" events (system/init, stream_event, assistant, user tool
// results, result) and onExit when the agent stops. src/uistream.js turns those events into the chat stream.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const beside = path.join(path.dirname(process.execPath), 'claude');
  return fs.existsSync(beside) ? beside : 'claude';
}

// opts: { prompt, system, model, tools, sessionId, hookCommand, mcpServers, cwd, env, onEvent, onExit }
function start(opts) {
  // Every tool call goes through the hook first; the app answers allow or deny (mcp/hook.js).
  const settings = { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: opts.hookCommand }] }] } };
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', opts.model || 'sonnet', '--tools', ['ToolSearch', ...opts.tools].join(','), '--setting-sources', '',
    '--disable-slash-commands', '--system-prompt', opts.system, '--settings', JSON.stringify(settings),
    '--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }),
    '--strict-mcp-config']; // only the servers in agents.config.js: none of your personal connectors leak in
  if (opts.sessionId) args.push('--resume', opts.sessionId);

  const proc = spawn(claudeBin(), args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      opts.onEvent(m);
    }
  });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { err += '\n' + e.message; });
  proc.on('close', (code) => opts.onExit(code, err));
  return { stop: () => proc.kill('SIGTERM') };
}

module.exports = { start };
