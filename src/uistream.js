// Turns what a Claude Code agent says into the AI SDK "UI message stream", so the chat panel
// (useChat from @ai-sdk/react) can show text, thinking and tool calls as they happen.
// One stream per chat run. Chunks are kept while the run lives, so a browser that joins late
// (page reload, a turn the app started itself) gets the whole reply replayed from the start.
const HEADERS = {
  'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1', 'x-accel-buffering': 'no',
};
const streams = new Map(); // run id -> { chunks, subs: Set<res>, done }
const sse = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters not shown)` : s);

function open(runId) {
  streams.set(runId, { chunks: [{ type: 'start', messageId: 'run-' + runId, messageMetadata: { runId, queued: true } }], subs: new Set(), done: false });
}
const has = (runId) => streams.has(runId);
function push(runId, chunk) {
  const s = streams.get(runId);
  if (!s || s.done) return;
  s.chunks.push(chunk);
  const line = sse(chunk);
  for (const res of s.subs) res.write(line);
}
function end(runId) {
  const s = streams.get(runId);
  if (!s || s.done) return;
  push(runId, { type: 'finish' });
  s.done = true;
  streams.delete(runId);
  for (const res of s.subs) { res.write('data: [DONE]\n\n'); res.end(); }
}
// Send a run's stream to one browser: everything so far, then live. False if the run has no stream.
function attach(runId, res) {
  const s = streams.get(runId);
  if (!s) return false;
  res.writeHead(200, HEADERS);
  for (const c of s.chunks) res.write(sse(c));
  s.subs.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => { clearInterval(ping); s.subs.delete(res); }); // res, not req: a POST request "closes" as soon as its body is read
  return true;
}

// A tool result as plain text, whatever shape Claude Code hands it over in.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => (x && x.type === 'text' ? x.text : JSON.stringify(x))).join('\n');
  return JSON.stringify(content);
}

// Reads one run's Claude Code events (stream-json with partial messages) and pushes UI chunks.
// It also keeps the finished message parts, which are saved so the chat reads the same after a reload.
function translator(runId) {
  const blocks = new Map(); // content block index -> what is streaming there
  const tools = new Map(); // tool call id -> saved part
  const parts = [];
  let n = 0;
  const emit = (c) => push(runId, c);
  const closeBlock = (b) => {
    if (b.kind === 'text') emit({ type: 'text-end', id: b.id });
    else if (b.kind === 'reasoning') emit({ type: 'reasoning-end', id: b.id });
    else if (b.kind === 'tool') {
      let input = {};
      try { input = b.json.trim() ? JSON.parse(b.json) : {}; } catch { input = { raw: b.json }; }
      b.part.input = input;
      emit({ type: 'tool-input-available', toolCallId: b.id, toolName: b.name, input, dynamic: true });
    }
  };
  function onEvent(m) {
    if (m.parent_tool_use_id) return; // a helper agent's inner chatter is not part of this reply
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'message_start') emit({ type: 'start-step' });
      else if (e.type === 'message_stop') emit({ type: 'finish-step' });
      else if (e.type === 'content_block_start') {
        const b = e.content_block;
        if (b.type === 'text') {
          const part = { type: 'text', text: '' }; parts.push(part);
          const blk = { kind: 'text', id: `t${runId}-${++n}`, part }; blocks.set(e.index, blk);
          emit({ type: 'text-start', id: blk.id });
        } else if (b.type === 'thinking') {
          const part = { type: 'reasoning', text: '' }; parts.push(part);
          const blk = { kind: 'reasoning', id: `r${runId}-${++n}`, part }; blocks.set(e.index, blk);
          emit({ type: 'reasoning-start', id: blk.id });
        } else if (b.type === 'tool_use') {
          const part = { type: 'dynamic-tool', toolCallId: b.id, toolName: b.name, state: 'input-available', input: {} }; parts.push(part);
          tools.set(b.id, part);
          blocks.set(e.index, { kind: 'tool', id: b.id, name: b.name, json: '', part });
          emit({ type: 'tool-input-start', toolCallId: b.id, toolName: b.name, dynamic: true });
        }
      } else if (e.type === 'content_block_delta') {
        const blk = blocks.get(e.index);
        if (!blk) return;
        const d = e.delta;
        if (d.type === 'text_delta' && blk.kind === 'text') { blk.part.text += d.text; emit({ type: 'text-delta', id: blk.id, delta: d.text }); }
        else if (d.type === 'thinking_delta' && blk.kind === 'reasoning') { blk.part.text += d.thinking; emit({ type: 'reasoning-delta', id: blk.id, delta: d.thinking }); }
        else if (d.type === 'input_json_delta' && blk.kind === 'tool') { blk.json += d.partial_json; emit({ type: 'tool-input-delta', toolCallId: blk.id, inputTextDelta: d.partial_json }); }
      } else if (e.type === 'content_block_stop') {
        const blk = blocks.get(e.index);
        if (blk) { blocks.delete(e.index); closeBlock(blk); }
      }
    } else if (m.type === 'user') {
      for (const c of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) {
        if (c.type !== 'tool_result') continue;
        const part = tools.get(c.tool_use_id);
        if (!part || part.state !== 'input-available') continue;
        const text = resultText(c.content);
        if (c.is_error) { part.state = 'output-error'; part.errorText = clip(text, 2000); emit({ type: 'tool-output-error', toolCallId: c.tool_use_id, errorText: clip(text, 6000), dynamic: true }); }
        else { part.state = 'output-available'; part.output = clip(text, 2000); emit({ type: 'tool-output-available', toolCallId: c.tool_use_id, output: clip(text, 6000), dynamic: true }); }
      }
    }
  }
  // The agent has stopped. Close whatever was still open and return the parts to save.
  function finish() {
    for (const blk of blocks.values()) closeBlock(blk);
    blocks.clear();
    for (const part of tools.values()) {
      if (part.state !== 'input-available') continue;
      part.state = 'output-error'; part.errorText = 'Stopped before it finished.';
      emit({ type: 'tool-output-error', toolCallId: part.toolCallId, errorText: part.errorText, dynamic: true });
    }
    const saved = [];
    for (const p of parts) {
      if (p.type === 'text') { if (p.text.trim()) saved.push({ type: 'text', text: p.text }); }
      else if (p.type === 'reasoning') { if (p.text.trim()) saved.push({ type: 'reasoning', text: clip(p.text, 6000) }); }
      else {
        const json = JSON.stringify(p.input);
        saved.push(json.length > 4000 ? { ...p, input: { shortened: clip(json, 4000) } } : p);
      }
    }
    return saved;
  }
  return { onEvent, finish };
}

// Saved chat rows -> the message shape useChat works with. Rows saved before this existed have no parts.
function toUIMessages(rows) {
  return rows.map((r) => {
    let parts = null;
    if (r.parts) { try { parts = JSON.parse(r.parts); } catch { parts = null; } }
    if (!parts || !parts.length) parts = [{ type: 'text', text: r.text || '' }];
    const metadata = { at: r.created_at };
    if (r.role === 'auto' || r.role === 'error') metadata.kind = r.role;
    return { id: 'm' + r.id, role: r.role === 'user' || r.role === 'auto' ? 'user' : 'assistant', parts, metadata };
  });
}

module.exports = { open, has, push, end, attach, translator, toUIMessages, resultText };
