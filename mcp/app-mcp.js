#!/usr/bin/env node
// Bridge between an agent and the app, as an MCP server over stdio. It holds no logic: it asks the app
// which tools this run may use, and passes each call to the app, which checks it (src/tools.js).
const URL_ = process.env.APP_URL, TOKEN = process.env.APP_TOKEN;
async function api(method, path, body) {
  const r = await fetch(URL_ + path, { method, headers: { 'content-type': 'application/json', 'x-run-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'app', version: '0.1.0' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') { const r = await api('GET', '/internal/tools'); return send({ jsonrpc: '2.0', id, result: { tools: r.tools || [] } }); }
  if (method === 'tools/call') {
    const r = await api('POST', '/internal/call', { name: params.name, args: params.arguments || {} });
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.error ? 'ERROR: ' + r.error : JSON.stringify(r.result) }], isError: !!r.error } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message || e) } }); });
  }
});
