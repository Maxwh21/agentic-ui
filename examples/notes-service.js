#!/usr/bin/env node
// The example's outside service: a tiny MCP server with one tool, publish_note.
//   node notes-service.js          "real": appends the note to DATA_DIR/published-notes.jsonl, or POSTs it to
//                                   NOTES_WEBHOOK_URL if set (e.g. a chat webhook)
//   node notes-service.js --mock   demo mode: answers the same way but publishes nothing
// Swap this for any MCP server (a ticket system, email, a CMS) and give it a mock in agents.config.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MOCK = process.argv.includes('--mock');

const TOOLS = {
  publish_note: {
    description: 'Publish a note to a channel.' + (MOCK ? ' (Mock: publishes nothing.)' : ''),
    inputSchema: { type: 'object', properties: { channel: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['channel', 'title', 'body'] },
    async run(a) {
      const id = crypto.randomBytes(6).toString('hex');
      const at = new Date().toISOString();
      if (MOCK) return { status: 'published', id, at, mock: true };
      if (process.env.NOTES_WEBHOOK_URL) {
        const r = await fetch(process.env.NOTES_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*${a.title}* (${a.channel})\n${a.body}` }) });
        if (!r.ok) throw new Error('The webhook answered ' + r.status);
      } else {
        fs.appendFileSync(path.join(process.env.DATA_DIR || '.', 'published-notes.jsonl'), JSON.stringify({ id, at, ...a }) + '\n');
      }
      return { status: 'published', id, at };
    },
  },
};

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
async function handle({ id, method, params }) {
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notes' + (MOCK ? '-mock' : ''), version: '0.1.0' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  if (method === 'tools/call') {
    const t = TOOLS[params.name];
    try {
      if (!t) throw new Error('Unknown tool ' + params.name);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(await t.run(params.arguments || {})) }] } });
    } catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } }); }
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
    try { handle(JSON.parse(line)); } catch { /* not JSON */ }
  }
});
