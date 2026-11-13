// The agent rail: the agent you talk to, docked beside every page, or full screen.
// Built on useChat from the Vercel AI SDK (@ai-sdk/react). Tool calls the agent makes can draw live cards
// (actions to approve, a panel of blocks) whose buttons call the app directly, so only your click acts.
// Build with `npm run build`; the result is public/chat.bundle.js, which app.js mounts through window.AgenticUI.
import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { domToCanvas } from 'modern-screenshot';
import './chat.css';

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-agentic': '1' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* no storage */ } },
};
const App = createContext(null); // { subscribe, toast, openLog, agents }
const PanelCtx = createContext({ openId: null, open: () => {}, close: () => {} }); // the agent's panel, per thread

// ---------- icons (24px grid, drawn with strokes) ----------
const PATHS = {
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3.5 6.5l8.5 6.5 8.5-6.5',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.2a4 4 0 0 1 0 7.6M22 21v-1a6 6 0 0 0-4-5.6',
  building: 'M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 9h3a1 1 0 0 1 1 1v11M3 21h18M9 7h2M9 11h2M9 15h2',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11',
  pen: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1zM14 7l3 3',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3l8.5-8.5zM14.5 6.5L17 4a4.5 4.5 0 0 0-5.5 5.5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  stop: 'M7 7h10v10H7z',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z',
  alert: 'M12 4l9 16H3L12 4zM12 10v4M12 17v.5',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  side: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14',
  expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  shrink: 'M20 4l-6 6M14 5v5h5M4 20l6-6M10 19v-5H5',
  pin: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 12 3a7 7 0 0 1 7 6.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3.5 16l5-5 4 4 3-3 5 5M15.5 9.5a1 1 0 1 0 0-.01',
  snip: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 15l1-3 5-5a1.4 1.4 0 0 1 2 2l-5 5-3 1z',
};
const Icon = ({ name, size = 16, fill }) => (
  <svg className="fc-icon" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);
const Orb = ({ busy, size = 34 }) => <span className={'ag-orb' + (busy ? ' busy' : '')} style={{ width: size, height: size }} aria-hidden="true"><i /></span>;

// ---------- plain words for tools ----------
// [tool name pattern, icon, while running, once done]. Tools not listed get a label made from their name.
const TOOLS = [
  [/WebSearch/, 'search', 'Searching the web', 'Searched the web'],
  [/WebFetch/, 'globe', 'Reading a web page', 'Read a web page'],
  [/ToolSearch/, 'wrench', 'Getting tools ready', 'Got tools ready'],
  [/^Bash$/, 'wrench', 'Running a command', 'Ran a command'],
  [/^Read$/, 'book', 'Reading a file', 'Read a file'],
  [/^(Edit|Write)$/, 'pen', 'Changing a file', 'Changed a file'],
  [/^(Grep|Glob)$/, 'search', 'Searching the files', 'Searched the files'],
  [/app__agent_result/, 'clock', 'Waiting for the worker', 'Heard back from the worker'],
  [/app__name_thread/, 'pen', 'Naming this thread', 'Named this thread'],
  [/app__show_panel/, 'side', 'Opening a panel', 'Opened a panel'],
  [/app__show_/, 'layers', 'Drawing a card', 'Drew a card'],
  [/app__(remember|forget)/, 'book', 'Updating its notebook', 'Updated its notebook'],
  [/app__propose_action/, 'pen', 'Proposing an action', 'Proposed an action'],
  [/app__list_actions/, 'db', 'Checking the actions', 'Checked the actions'],
];
const humanise = (name) => String(name).replace(/^mcp__[^_]+(_[^_]+)*?__/, '').replace(/_/g, ' ');
function toolInfo(name, input, agents) {
  const w = /app__ask_agent$/.test(name) && input && agents && agents[input.agent];
  if (w) return [null, w.icon, `Waiting on the ${w.label.toLowerCase()}`, `Heard back from the ${w.label.toLowerCase()}`];
  const hit = TOOLS.find(([re]) => re.test(name));
  if (hit) return hit;
  const h = humanise(name);
  return [null, 'wrench', 'Using ' + h, 'Used ' + h];
}
// The one thing worth showing beside the label: the search words, the site, the name.
function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.file_path === 'string') return input.file_path.split('/').slice(-2).join('/');
  if (typeof input.description === 'string' && input.command) return input.description;
  if (typeof input.url === 'string') { try { return new URL(input.url).hostname.replace(/^www\./, ''); } catch { return input.url; } }
  for (const k of ['command', 'pattern', 'query', 'title', 'name', 'label', 'subject', 'reason', 'text', 'message']) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim();
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim() && v.length < 120) return v.trim();
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(', ');
  }
  return '';
}
const isTool = (p) => p.type === 'dynamic-tool' || p.type.startsWith('tool-');
const toolName = (p) => (p.type === 'dynamic-tool' ? p.toolName : p.type.slice(5));
const toolRunning = (p) => p.state === 'input-streaming' || p.state === 'input-available';
const pretty = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return JSON.stringify(v, null, 2);
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtTime(iso);
};
const go = (hash) => { window.location.hash = hash; };

// ---------- message pieces ----------
const Markdown = memo(function Markdown({ text }) {
  const html = useMemo(() => window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { breaks: true })), [text]);
  const onClick = (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  };
  return <div className="md fc-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

function Step({ part }) {
  const [open, setOpen] = useState(false);
  if (part.type === 'reasoning') {
    const live = part.state === 'streaming';
    return (
      <div className="fc-step">
        <button type="button" className="fc-step-row" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="fc-step-icon"><Icon name="sparkle" size={14} /></span>
          <span className={'fc-step-label' + (live ? ' fc-shimmer' : '')}>{live ? 'Thinking' : 'Thought it through'}</span>
          <span className="fc-step-detail" />
          <span className={'fc-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
        </button>
        {open ? <div className="fc-step-body"><div className="fc-thought">{part.text}</div></div> : null}
      </div>
    );
  }
  const { agents } = useContext(App);
  const name = toolName(part);
  const [, icon, doing, done] = toolInfo(name, part.input, agents);
  const running = toolRunning(part);
  const failed = part.state === 'output-error' || part.state === 'output-denied';
  const detail = toolDetail(name, part.input);
  return (
    <div className={'fc-step' + (failed ? ' failed' : '') + (running ? ' running' : '')}>
      <button type="button" className="fc-step-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="fc-step-icon"><Icon name={icon} size={14} /></span>
        <span className={'fc-step-label' + (running ? ' fc-shimmer' : '')}>{running ? doing : failed ? doing + ': did not go through' : done}</span>
        <span className="fc-step-detail" title={detail}>{detail}</span>
        <span className="fc-step-state">
          {running ? <span className="fc-spin" /> : failed ? <Icon name="x" size={13} /> : <Icon name="check" size={13} />}
        </span>
        <span className={'fc-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
      </button>
      {failed && !open && part.errorText ? <div className="fc-step-why">{String(part.errorText).split('\n')[0].slice(0, 220)}</div> : null}
      {open ? (
        <div className="fc-step-body">
          <div className="fc-kv-title">Tool</div><pre>{name}</pre>
          <div className="fc-kv-title">What it was given</div><pre>{pretty(part.input) || '(nothing)'}</pre>
          {part.state === 'output-available' ? <><div className="fc-kv-title">What came back</div><pre>{pretty(part.output) || '(nothing)'}</pre></> : null}
          {failed ? <><div className="fc-kv-title">Why it did not go through</div><pre>{part.errorText || 'Not allowed.'}</pre></> : null}
        </div>
      ) : null}
    </div>
  );
}

// A run of tool calls and thinking between two pieces of text. Long runs fold away once the reply is finished.
function Steps({ items, live }) {
  const [chosen, setChosen] = useState(null);
  const foldable = items.length > 2;
  const open = !foldable || (chosen == null ? live : chosen);
  const failed = items.filter((p) => p.state === 'output-error' || p.state === 'output-denied').length;
  return (
    <div className="fc-steps">
      {foldable ? (
        <button type="button" className="fc-steps-head" onClick={() => setChosen(!open)} aria-expanded={open}>
          <span className={'fc-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
          <span>{live ? 'Working' : 'Worked'} through {items.length} steps</span>
          {failed ? <span className="fc-steps-bad">{failed} did not go through</span> : null}
        </button>
      ) : null}
      {open ? <div className="fc-steps-list">{items.map((p, i) => <Step key={p.toolCallId || i} part={p} />)}</div> : null}
    </div>
  );
}

// ---------- cards: drawn from the live records; the buttons call the app, not the agent ----------
function useLive(load, deps) {
  const { subscribe } = useContext(App);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => load().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), deps);
  useEffect(() => {
    reload();
    let timer = null;
    const off = subscribe((ev) => { if (ev.t === 'data' || ev.t === 'run') { clearTimeout(timer); timer = setTimeout(reload, 400); } });
    return () => { clearTimeout(timer); off(); };
  }, [reload]);
  return [data, error, reload];
}
const ACTION_STATE = { proposed: ['Waiting for you', 'amber'], approved: ['Approved', 'blue'], running: ['Running', 'blue'], done: ['Done', 'green'], failed: ['Failed', 'red'], check: ['Check it', 'red'], rejected: ['Rejected', ''] };
const Card = ({ icon, label, count, children, foot }) => (
  <section className="ag-card">
    <header className="ag-card-head"><Icon name={icon} size={13} /><span>{label}</span>{count != null ? <b>{count}</b> : null}<i className="ag-live" title="Live from the records" />LIVE</header>
    <div className="ag-card-body">{children}</div>
    {foot ? <footer className="ag-card-foot">{foot}</footer> : null}
  </section>
);

// Actions an agent proposed, live from the records. Approve sends the version you are looking at; if the text
// changed since the card was drawn, the app refuses and the card reloads.
function ActionsCard({ ids, ask, oneClick, onApproved }) {
  const { toast } = useContext(App);
  const key = ids.join(',');
  const [data, error, reload] = useLive(() => api('GET', '/api/actions?ids=' + key), [key]);
  const [skipped, setSkipped] = useState(() => new Set());
  const [armed, setArmed] = useState(false);
  const [working, setWorking] = useState(false);
  if (error) return <Card icon="bolt" label="Actions"><div className="ag-card-note">{error}</div></Card>;
  if (!data) return <Card icon="bolt" label="Actions"><div className="fc-loading"><span /><span /><span /></div></Card>;
  const rows = data.actions;
  const open = rows.filter((x) => x.status === 'proposed');
  const picked = open.filter((x) => !skipped.has(x.id));
  const toggle = (id) => { const n = new Set(skipped); if (n.has(id)) n.delete(id); else n.add(id); setSkipped(n); };
  const run = (fn) => async () => { try { await fn(); } catch (e) { toast(e.message); } reload(); };
  const approve = async () => {
    if (!armed && !oneClick) { setArmed(true); setTimeout(() => setArmed(false), 5000); return; }
    setWorking(true);
    let ok = false;
    try { await api('POST', '/api/actions/approve', { items: picked.map((x) => ({ id: x.id, version: x.version })) }); toast(`${picked.length} approved.`); ok = true; }
    catch (e) { toast(e.message); }
    if (ok && onApproved) onApproved();
    setArmed(false); setWorking(false); reload();
  };
  return (
    <Card icon="bolt" label={ask ? 'For your approval' : 'Actions'} count={rows.length}
      foot={ask && open.length ? (
        <>
          <span className="ag-card-note">Runs at the time shown. Nothing happens without this click.</span>
          <button type="button" className={'ag-btn primary' + (armed ? ' armed' : '')} disabled={!picked.length || working} onClick={approve}>
            <Icon name="check" size={14} />{armed ? `Click again to confirm ${picked.length}` : `Approve ${picked.length}`}
          </button>
        </>
      ) : null}>
      {rows.map((x) => {
        const [text, colour] = ACTION_STATE[x.status] || [x.status, ''];
        const isOpen = x.status === 'proposed';
        return (
          <article key={x.id} className={'ag-item' + (ask && isOpen && skipped.has(x.id) ? ' off' : '')}>
            <div className="ag-item-top">
              {ask && isOpen ? <input type="checkbox" checked={!skipped.has(x.id)} onChange={() => toggle(x.id)} title="Include in this approval" /> : null}
              <div className="ag-item-who"><b>{x.title}</b><span>{x.label} · #{x.id}{x.proposed_by ? ' · from ' + x.proposed_by : ''}</span></div>
              <span className={'pill ' + colour}>{text}</span>
            </div>
            {x.fields.map((f) => (f.key === 'title' ? null : f.value.length > 80 || f.value.includes('\n')
              ? <div key={f.key} className="ag-item-body">{f.value}</div>
              : <div key={f.key} className="ag-item-meta"><span>{f.label}: {f.value}</span></div>))}
            {x.problem ? <div className="ag-item-problem">{x.problem}</div> : null}
            <div className="ag-item-meta">
              {isOpen && x.would_run_at ? <span><Icon name="clock" size={11} />would run {fmtTime(x.would_run_at)}</span> : null}
              {x.status === 'approved' ? <span className="good"><Icon name="check" size={11} />runs {fmtTime(x.run_at)}</span> : null}
              {x.done_at ? <span>{fmtTime(x.done_at)}</span> : null}
              {x.status === 'approved' ? <button type="button" className="ag-btn sm danger" onClick={run(() => api('POST', `/api/actions/${x.id}/takeback`))}>Take back</button> : null}
              {isOpen && ask ? <button type="button" className="ag-btn sm danger" onClick={run(async () => { const why = window.prompt('Reject this? Optional reason (the agent sees it):', ''); if (why === null) return; await api('POST', `/api/actions/${x.id}/reject`, { reason: why }); })}>Reject</button> : null}
            </div>
          </article>
        );
      })}
    </Card>
  );
}

// A job handed to a worker: who, what was asked, and what came back.
function WorkerCard({ part }) {
  const { openLog, agents } = useContext(App);
  const [wide, setWide] = useState(false);
  const input = part.input || {};
  const w = (agents && agents[input.agent]) || { label: 'Worker', icon: 'layers' };
  const running = toolRunning(part);
  let out = null;
  if (part.state === 'output-available') { try { out = typeof part.output === 'string' ? JSON.parse(part.output) : part.output; } catch { out = { status: 'done', reply: String(part.output) }; } }
  const failed = part.state === 'output-error' || (out && out.status === 'failed');
  const state = running ? 'Working' : failed ? 'Did not finish' : out && out.status === 'working' ? 'Still working' : 'Done';
  return (
    <section className={'ag-worker' + (running ? ' running' : '') + (failed ? ' failed' : '')}>
      <header>
        <span className="ag-worker-icon"><Icon name={w.icon} size={15} /></span>
        <div className="ag-worker-who"><b>{w.label}</b><span>{state}</span></div>
        {running ? <span className="fc-spin" /> : null}
        {input.agent ? <button type="button" className="ag-link" onClick={() => openLog(`${input.agent}-worker-1`)}>Log<Icon name="arrow" size={11} /></button> : null}
      </header>
      {input.message ? <div className="ag-worker-ask">{input.message}</div> : null}
      {out && out.reply ? <div className={'ag-worker-reply' + (wide || out.reply.length < 360 ? '' : ' clamp')}><Markdown text={out.reply} /></div> : null}
      {out && out.reply && out.reply.length >= 360 && !wide ? <button type="button" className="ag-link" onClick={() => setWide(true)}>Read all of it</button> : null}
      {failed ? <div className="ag-item-problem">{part.errorText || (out && out.error) || 'The worker stopped.'}</div> : null}
    </section>
  );
}

function blockKind(p) {
  if (!isTool(p)) return null;
  const n = toolName(p);
  if (/app__ask_agent$/.test(n) && p.input && p.input.agent) return 'worker';
  if (p.state !== 'output-available' || !p.input) return null;
  if (/app__show_actions$/.test(n) && Array.isArray(p.input.action_ids)) return 'actions';
  if (/app__show_panel$/.test(n)) return 'panel';
  return null;
}
function groupParts(parts) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') { if (p.text && p.text.trim()) out.push({ kind: 'text', part: p }); continue; }
    const block = blockKind(p);
    if (block) { out.push({ kind: block, part: p }); continue; }
    if (isTool(p) || (p.type === 'reasoning' && ((p.text && p.text.trim()) || p.state === 'streaming'))) {
      const last = out[out.length - 1];
      if (last && last.kind === 'steps') last.items.push(p); else out.push({ kind: 'steps', items: [p] });
    }
  }
  return out;
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="fc-ghost" title="Copy this reply" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard not available */ }
    }}>
      <Icon name={done ? 'check' : 'copy'} size={13} />{done ? 'Copied' : 'Copy'}
    </button>
  );
}

const Message = memo(function Message({ message, live }) {
  const kind = message.metadata && message.metadata.kind;
  const text = message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
  const at = fmtTime(message.metadata && message.metadata.at) || undefined;
  if (kind === 'auto') {
    return (
      <div className="fc-auto" title={at}>
        <div className="fc-auto-rule"><span><Icon name="bolt" size={11} />Job given</span></div>
        <div className="fc-auto-text">{text}</div>
      </div>
    );
  }
  if (kind === 'error') {
    if (/Stopped by you\.\s*$/.test(text)) return <div className="fc-auto" title={at}><div className="fc-auto-rule"><span><Icon name="stop" size={10} fill />You stopped it</span></div></div>;
    const [head, ...rest] = text.split('\n\n');
    return (
      <div className="fc-error" title={at}>
        <Icon name="alert" size={16} />
        <div><b>{head}</b>{rest.length ? <div className="fc-error-more">{rest.join('\n\n')}</div> : null}</div>
      </div>
    );
  }
  if (message.role === 'user') {
    const images = message.parts.filter((p) => p.type === 'file' && String(p.mediaType || '').startsWith('image/'));
    return (
      <div className="fc-user" title={at}>
        {images.length ? <div className="ag-shots">{images.map((p, i) => <a key={i} href={p.url} target="_blank" rel="noopener"><img src={p.url} alt={p.filename || 'Attached image'} /></a>)}</div> : null}
        {text}
      </div>
    );
  }
  const groups = groupParts(message.parts);
  if (!groups.length) return null;
  return (
    <div className="fc-assistant">
      {groups.map((g, i) => {
        if (g.kind === 'text') return <Markdown key={i} text={g.part.text} />;
        if (g.kind === 'steps') return <Steps key={i} items={g.items} live={live} />;
        if (g.kind === 'worker') return <WorkerCard key={i} part={g.part} />;
        if (g.kind === 'actions') return <ActionsCard key={i} ids={g.part.input.action_ids} ask={!!g.part.input.ask_approval} />;
        return <PanelChip key={i} part={g.part} />;
      })}
      {!live && text ? <div className="fc-actions"><CopyButton text={text} /></div> : null}
    </div>
  );
});


// ---------- the panel: a view the agent lays out for you, over the right of the page, with the rest faded ----------
const nums = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const isPanel = (p) => isTool(p) && /app__show_panel$/.test(toolName(p)) && p.state === 'output-available' && p.input && Array.isArray(p.input.blocks);

function PanelChip({ part }) {
  const { openId, open, close } = useContext(PanelCtx);
  const on = openId === part.toolCallId;
  return (
    <button type="button" className={'ag-panelchip' + (on ? ' on' : '')} onClick={() => (on ? close() : open(part.toolCallId))} title={on ? 'Close the panel' : 'Show this panel again'}>
      <Icon name="side" size={14} /><span>{part.input.title}</span><em>{on ? 'Open' : 'Show'}</em>
    </button>
  );
}

function Clamp({ text, lines = 6 }) {
  const [wide, setWide] = useState(false);
  const long = String(text || '').length > lines * 90;
  return (
    <>
      <div className={'ag-p-clamp' + (long && !wide ? ' on' : '')} style={{ '--lines': lines }}><Markdown text={text} /></div>
      {long ? <button type="button" className="ag-link" onClick={() => setWide(!wide)}>{wide ? 'Show less' : 'Read all of it'}</button> : null}
    </>
  );
}

function TabsBlock({ b, onChoose, busy }) {
  const tabs = (b.tabs || []).filter((t) => t && Array.isArray(t.blocks));
  const first = Math.max(0, tabs.findIndex((t) => t.label === b.open));
  const [on, setOn] = useState(first);
  const tab = tabs[on] || tabs[0];
  if (!tab) return null;
  return (
    <div className="ag-p-tabs">
      <div className="ag-p-tabbar" role="tablist">
        {tabs.map((t, i) => <button type="button" role="tab" aria-selected={i === on} key={i} className={'ag-p-tab' + (i === on ? ' on' : '')} onClick={() => setOn(i)}>{t.label}</button>)}
      </div>
      <div className="ag-p-tabbody" role="tabpanel">
        {tab.blocks.map((x, i) => <div className="ag-p-block" key={on + '-' + i}><PanelBlock b={x || {}} onChoose={onChoose} busy={busy} /></div>)}
      </div>
    </div>
  );
}

function PanelBlock({ b, onChoose, busy }) {
  switch (b.type) {
    case 'tabs': return <TabsBlock b={b} onChoose={onChoose} busy={busy} />;
    case 'heading': return <h3 className="ag-p-h">{b.text}</h3>;
    case 'text': return <Markdown text={b.text} />;
    case 'callout': return <div className={'ag-p-callout ' + (b.tone || 'info')}><Icon name={b.tone === 'warn' ? 'alert' : b.tone === 'good' ? 'check' : 'info'} size={15} /><Markdown text={b.text} /></div>;
    case 'facts': return <dl className="kv ag-p-kv">{(b.items || []).map((f, i) => <React.Fragment key={i}><dt>{f.label}</dt><dd><Markdown text={String(f.value ?? '')} /></dd></React.Fragment>)}</dl>;
    case 'links': return <div className="ag-p-links">{(b.items || []).map((l, i) => <a key={i} href={l.url} target="_blank" rel="noopener"><Icon name="link" size={12} />{l.label || l.url}</a>)}</div>;
    case 'actions': return <ActionsCard ids={nums(b.action_ids)} ask={!!b.ask_approval} oneClick={!!b.ask_approval} onApproved={b.then ? () => onChoose(String(b.then)) : null} />;
    case 'choices': return <div className="ag-p-choices">{(b.items || []).map((t, i) => <button type="button" key={i} className={'ag-btn' + (i === 0 ? ' primary' : '')} disabled={busy} onClick={() => onChoose(String(t))}>{String(t)}</button>)}</div>;
    default: return null;
  }
}

function Panel({ part, onClose, onChoose, busy }) {
  const input = part.input;
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const body = useRef(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [part.toolCallId]);
  return createPortal(
    <div className="fc ag-panel-wrap">
      <div className="ag-veil" onClick={onClose} />
      <aside className="ag-panel" role="dialog" aria-label={input.title} key={part.toolCallId}>
        <header className="ag-panel-head">
          <Orb busy={busy} size={26} />
          <div className="ag-panel-title"><h2>{input.title}</h2>{input.subtitle ? <p>{input.subtitle}</p> : null}</div>
          <button type="button" className="ag-tool" onClick={onClose} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </header>
        <div className="ag-panel-body" ref={body}>
          {input.blocks.map((b, i) => <div className="ag-p-block" key={i}><PanelBlock b={b || {}} onChoose={onChoose} busy={busy} /></div>)}
        </div>
        <footer className="ag-panel-foot"><Icon name="pin" size={12} />Talk to the agent on the left to change anything here.{busy ? <span className="fc-shimmer"> Working…</span> : null}</footer>
      </aside>
    </div>,
    document.body,
  );
}

// ---------- snip: freeze the page, draw round something, keep that bit as an image ----------
// Only the style properties that change how the page looks are copied, which makes the capture several times faster.
const SIDES = ['top', 'right', 'bottom', 'left'];
const SNIP_STYLES = [
  'display', 'position', ...SIDES, 'z-index', 'box-sizing', 'float', 'clear',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  ...SIDES.map((x) => 'margin-' + x), ...SIDES.map((x) => 'padding-' + x),
  ...SIDES.flatMap((x) => ['border-' + x + '-width', 'border-' + x + '-style', 'border-' + x + '-color']),
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  'background-color', 'background-image', 'background-size', 'background-position-x', 'background-position-y', 'background-repeat', 'background-clip', 'background-origin', 'background-attachment', '-webkit-background-clip',
  'color', '-webkit-text-fill-color', 'opacity', 'visibility', 'overflow-x', 'overflow-y', 'text-overflow', 'white-space', 'white-space-collapse', 'text-wrap-mode', 'word-break', 'overflow-wrap', 'hyphens', 'tab-size',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-feature-settings', 'font-kerning',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent', 'vertical-align', 'direction', 'writing-mode',
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset', 'text-shadow',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self', 'place-items', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows', 'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'transform', 'transform-origin', 'translate', 'rotate', 'scale', 'box-shadow', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'mix-blend-mode', 'isolation', 'clip-path', 'mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size',
  'object-fit', 'object-position', 'list-style-type', 'list-style-position', 'border-collapse', 'border-spacing', 'table-layout', 'caption-side',
  '-webkit-line-clamp', '-webkit-box-orient', 'display', 'contain', 'content-visibility',
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'scrollbar-width', 'scrollbar-color', 'resize', 'accent-color', 'caret-color', 'appearance',
];

// Renders the page as it looks now (scroll positions included) into a canvas the size of the window.
async function grabPage() {
  const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;
  const bg = getComputedStyle(document.body).backgroundColor;
  try {
    // Render the whole document at window size, so fixed panels that reach the bottom are not cut off.
    const full = await domToCanvas(document.documentElement, {
      scale: dpr, width: Math.max(w, document.documentElement.scrollWidth), height: Math.max(h, document.documentElement.scrollHeight), backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : getComputedStyle(document.documentElement).backgroundColor || '#000',
      features: { restoreScrollPosition: true }, font: false, drawImageInterval: 0, timeout: 8000, includeStyleProperties: SNIP_STYLES,
      filter: (n) => !(n instanceof Element && (n.id === 'toast' || n.classList.contains('ag-snip'))),
    });
    const out = document.createElement('canvas');
    out.width = Math.round(w * dpr); out.height = Math.round(h * dpr);
    out.getContext('2d').drawImage(full, -window.scrollX * dpr, -window.scrollY * dpr);
    return out;
  } catch (e) {
    // Fall back to the browser's own tab capture (it asks for permission once per snip).
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw e;
    // the tab capture photographs the screen as it is, so hide the drawing overlay first
    const over = [...document.querySelectorAll('.ag-snip')];
    over.forEach((n) => { n.style.visibility = 'hidden'; });
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' }); }
    catch (err) { over.forEach((n) => { n.style.visibility = ''; }); throw err; }
    try {
      const v = document.createElement('video');
      v.srcObject = stream; v.muted = true; await v.play();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = document.createElement('canvas');
      out.width = v.videoWidth; out.height = v.videoHeight;
      out.getContext('2d').drawImage(v, 0, 0);
      return out;
    } finally { stream.getTracks().forEach((t) => t.stop()); over.forEach((n) => { n.style.visibility = ''; }); }
  }
}

// The overlay goes up the instant the button is pressed. It is see-through and takes the clicks, so the page is
// frozen for input while you draw on the live page. Nothing heavy runs while drawing: the snapshot is taken only
// once the shape is closed (the overlay is left out of it). The rubber-band line follows the mouse by moving the
// SVG directly, once per frame, without a React render. Click to place points; close the shape by clicking the
// first point, double-clicking or pressing Enter. Backspace undoes a point, Esc cancels.
function SnipOverlay({ onDone, onCancel }) {
  const [pts, setPts] = useState([]);
  const [closing, setClosing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const ptsRef = useRef(pts); ptsRef.current = pts;
  const waitRef = useRef(false);
  const lastDown = useRef(null);
  const liveRef = useRef(null); // the dashed rubber-band line
  const cur = useRef(null); // where the mouse is
  const frame = useRef(0);
  const NEAR = 11;
  const nearFirst = (p, list = ptsRef.current) => !!p && list.length >= 3 && Math.hypot(p[0] - list[0][0], p[1] - list[0][1]) <= NEAR;
  // Move the rubber band to the mouse (or snap it to the first point when the shape is about to close).
  const paint = () => {
    frame.current = 0;
    const el = liveRef.current, list = ptsRef.current, c = cur.current;
    if (!el) return;
    if (!list.length || !c || waitRef.current) { el.style.display = 'none'; return; }
    const snap = nearFirst(c, list);
    const [x2, y2] = snap ? list[0] : c, last = list[list.length - 1];
    el.setAttribute('x1', last[0]); el.setAttribute('y1', last[1]); el.setAttribute('x2', x2); el.setAttribute('y2', y2);
    el.style.display = '';
    setClosing((o) => (o === snap ? o : snap)); // renders only when it changes
  };
  const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(paint); };
  useLayoutEffect(paint, [pts, waiting]); // keep the band attached to the newest point
  const finish = (list) => {
    if (waitRef.current) return;
    if (list.length && list.length < 3) return; // a shape needs three points; none at all means the whole window
    waitRef.current = true; setWaiting(true);
    onDone(list);
  };
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!waitRef.current) onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(ptsRef.current); }
      else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); if (!waitRef.current) setPts((o) => o.slice(0, -1)); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (frame.current) cancelAnimationFrame(frame.current); };
  }, []);
  const at = (e) => [e.clientX, e.clientY];
  const onDown = (e) => {
    if (waitRef.current || e.button !== 0) return;
    e.preventDefault();
    const list = ptsRef.current, p = at(e);
    cur.current = p;
    if (nearFirst(p, list)) { finish(list); return; }
    // The second click of a double-click (quick, same spot) ends the shape.
    const prev = lastDown.current; lastDown.current = { t: e.timeStamp, p };
    if (prev && e.timeStamp - prev.t < 400 && Math.hypot(p[0] - prev.p[0], p[1] - prev.p[1]) < 8 && list.length >= 3) { finish(list); return; }
    const last = list[list.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 3) return;
    const next = [...list, p];
    ptsRef.current = next; // a fast next click sees this point even before React renders
    setPts(next);
  };
  const onMove = (e) => {
    // use the newest of the coalesced positions, so a slow frame never leaves the band behind the mouse
    const ev = e.nativeEvent && e.nativeEvent.getCoalescedEvents ? e.nativeEvent.getCoalescedEvents().slice(-1)[0] || e : e;
    cur.current = [ev.clientX, ev.clientY];
    schedule();
  };
  const line = pts.map((p) => p.join(',')).join(' ');
  const hint = waiting ? 'Snipping…' : pts.length === 0 ? 'Click to place points round what you mean. Enter snips the whole window. Esc to cancel.'
    : pts.length < 3 ? 'Keep clicking to add points. Backspace undoes one.'
      : 'Click the first point, double-click or press Enter to close the shape.';
  return createPortal(
    <div className={'ag-snip' + (waiting ? ' waiting' : '')} style={{ cursor: waiting ? 'progress' : closing ? 'pointer' : 'crosshair' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerLeave={() => { cur.current = null; schedule(); }}
      onContextMenu={(e) => { e.preventDefault(); if (waitRef.current) return; if (ptsRef.current.length) setPts(ptsRef.current.slice(0, -1)); else onCancel(); }}>
      <svg className="ag-snip-ink" width="100%" height="100%">
        {pts.length >= 3 ? <polygon points={line} className="fill" /> : null}
        {pts.length >= 2 ? <polyline points={line} className="edge under" /> : null}
        {pts.length >= 2 ? <polyline points={line} className="edge" /> : null}
        <line ref={liveRef} className="edge live" style={{ display: 'none' }} />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 && closing ? 7 : 4} className={i === 0 ? 'first' : ''} />)}
      </svg>
      <div className="ag-snip-hint"><Icon name="snip" size={13} />{hint}</div>
    </div>,
    document.body,
  );
}

// Crop the snapshot round the shape (with some margin) and draw the shape on it. No shape keeps the whole window.
function cropSnip(shot, pts) {
  const s = shot.width / window.innerWidth;
  const P = pts.map(([x, y]) => [x * s, y * s]);
  let x0 = 0, y0 = 0, x1 = shot.width, y1 = shot.height;
  if (P.length >= 3) {
    const pad = 40 * s, xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    x0 = Math.max(0, Math.min(...xs) - pad); y0 = Math.max(0, Math.min(...ys) - pad);
    x1 = Math.min(shot.width, Math.max(...xs) + pad); y1 = Math.min(shot.height, Math.max(...ys) + pad);
  }
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(x1 - x0)); out.height = Math.max(1, Math.round(y1 - y0));
  const g = out.getContext('2d');
  g.drawImage(shot, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  if (P.length >= 3) {
    g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(x - x0, y - y0) : g.moveTo(x - x0, y - y0))); g.closePath();
    g.strokeStyle = '#ef4444'; g.lineWidth = 3 * s; g.lineJoin = 'round';
    g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 2 * s; g.stroke();
  }
  return out;
}

// ---------- one conversation (a thread with the agent, or a worker's log to read) ----------
function Thread({ id, initial, readOnly, where, onDoing }) {
  const { subscribe, toast, agents } = useContext(App);
  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/ui/chat', headers: { 'x-agentic': '1' },
    // The app keeps the conversation itself, so only the new message travels, with the page you are on.
    prepareSendMessagesRequest: ({ id: chatId, messages, trigger }) => ({ body: { id: chatId, trigger, messages: messages.slice(-1), page: window.location.hash } }),
  }), []);
  const { messages, sendMessage, status, error, setMessages, resumeStream, clearError } = useChat({
    id, messages: initial.messages, transport, resume: true, experimental_throttle: 40,
  });
  const [run, setRun] = useState(initial.run);
  const [draft, setDraft] = useState(() => (readOnly ? '' : store.get('agentic.draft.' + id) || ''));
  const [away, setAway] = useState(false);
  const [shots, setShots] = useState([]); // images waiting to go with the next message
  const [dropping, setDropping] = useState(false);
  const [snip, setSnip] = useState(null); // set while you draw a snip
  const picker = useRef(null);
  const scroller = useRef(null), input = useRef(null), stick = useRef(true);
  const statusRef = useRef(status), sending = useRef(false), syncing = useRef(false), again = useRef(false);
  statusRef.current = status;
  const busy = status === 'submitted' || status === 'streaming';

  // The panel: the newest one opens by itself; once you close it, it stays closed until the agent draws another.
  const panels = useMemo(() => (readOnly ? [] : messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter(isPanel) : []))), [messages, readOnly]);
  const latestPanel = panels.length ? panels[panels.length - 1].toolCallId : null;
  const [openPanel, setOpenPanel] = useState(() => (latestPanel && store.get('agentic.panel.shut.' + id) !== latestPanel ? latestPanel : null));
  const seenPanel = useRef(latestPanel);
  useEffect(() => { if (latestPanel && latestPanel !== seenPanel.current) { seenPanel.current = latestPanel; setOpenPanel(latestPanel); } }, [latestPanel]);
  const closePanel = useCallback(() => { setOpenPanel((cur) => { if (cur) store.set('agentic.panel.shut.' + id, cur); return null; }); }, [id]);
  const panelCtx = useMemo(() => ({ openId: openPanel, open: setOpenPanel, close: closePanel }), [openPanel, closePanel]);
  const shownPanel = openPanel ? panels.find((p) => p.toolCallId === openPanel) : null;

  // Fetch the saved conversation and adopt it when nothing is streaming. If a turn has started that this
  // page did not start (a worker's job, or one queued behind the last), join its stream.
  const sync = useCallback(async () => {
    if (syncing.current) { again.current = true; return; }
    syncing.current = true;
    try {
      const d = await api('GET', `/api/ui/chat/${id}/messages`);
      setRun(d.run);
      const idle = statusRef.current === 'ready' || statusRef.current === 'error';
      if (idle && !sending.current) {
        setMessages(d.messages);
        if (d.run) resumeStream().catch(() => {});
      }
    } catch { /* the app is not answering; the next event tries again */ } finally {
      syncing.current = false;
      if (again.current) { again.current = false; sync(); }
    }
  }, [id]);

  const prev = useRef(status);
  useEffect(() => {
    if (prev.current !== status && status === 'ready') { sending.current = false; sync(); }
    prev.current = status;
  }, [status]);
  useEffect(() => {
    let timer = null;
    const off = subscribe((ev) => {
      if (ev.t === 'run' || (ev.t === 'msg' && ev.chat === initial.chat)) { clearTimeout(timer); timer = setTimeout(sync, 250); }
    });
    return () => { clearTimeout(timer); off(); };
  }, [sync]);

  const last = messages[messages.length - 1];
  const lastPart = last && last.role === 'assistant' && last.parts.length ? last.parts[last.parts.length - 1] : null;
  const runId = (busy && last && last.role === 'assistant' && last.metadata && last.metadata.runId) || (run && run.id) || null;
  const queued = busy && ((last && last.role === 'assistant' && last.metadata && last.metadata.queued) || (!lastPart && run && run.status === 'queued'));
  let doing = null;
  if (busy) {
    if (queued) doing = 'Waiting for a free slot';
    else if (lastPart && isTool(lastPart) && toolRunning(lastPart)) doing = toolInfo(toolName(lastPart), lastPart.input, agents)[2];
    else if (lastPart && lastPart.type === 'text' && lastPart.state === 'streaming') doing = 'Writing';
    else doing = 'Thinking';
  }
  useEffect(() => { if (onDoing) onDoing(doing); return () => { if (onDoing) onDoing(null); }; }, [doing]);
  useEffect(() => { if (!readOnly) store.set('agentic.draft.' + id, draft); }, [draft]);

  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });
  const onScroll = () => {
    const el = scroller.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
    stick.current = near;
    setAway(!near);
  };
  const toBottom = () => { stick.current = true; setAway(false); const el = scroller.current; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const grow = () => { const t = input.current; if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; };
  useLayoutEffect(grow, [draft]);

  // Read picked, pasted or dropped images into the tray above the text box.
  const addShots = (list) => {
    const files = [...(list || [])].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (!files.length) return false;
    for (const f of files) {
      if (f.size > 8 * 1024 * 1024) { toast(`${f.name || 'That image'} is over 8 MB.`); continue; }
      const r = new FileReader();
      r.onload = () => setShots((old) => (old.length >= 6 ? (toast('At most 6 images per message.'), old) : [...old, { type: 'file', mediaType: f.type, filename: f.name || 'pasted image', url: r.result }]));
      r.readAsDataURL(f);
    }
    return true;
  };
  // Snip: freeze the page for input, let you draw round something on it, then take the snapshot and keep the crop
  // in the tray and on the clipboard. The snapshot is taken after the shape is closed, so drawing never waits on it.
  const startSnip = () => {
    if (snip) return;
    if (shots.length >= 6) { toast('At most 6 images per message.'); return; }
    setSnip({ at: Date.now() });
  };
  const endSnip = async (pts) => {
    // let the "Snipping…" hint paint before the capture holds the page
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    let shot;
    try { shot = await grabPage(); } catch (e) { setSnip(null); toast('Could not take a snapshot of the page' + (e && e.message ? ': ' + e.message : '.')); return; }
    finishSnip(cropSnip(shot, pts));
  };
  const finishSnip = (canvas) => {
    setSnip(null);
    const url = canvas.toDataURL('image/png');
    setShots((old) => (old.length >= 6 ? old : [...old, { type: 'file', mediaType: 'image/png', filename: 'snip.png', url }]));
    canvas.toBlob(async (blob) => {
      let copied = false;
      try { if (blob && navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } } catch { /* clipboard refused */ }
      toast(copied ? 'Snip added to your message (and copied).' : 'Snip added to your message.');
    }, 'image/png');
    if (input.current) input.current.focus();
  };
  const send = (given) => {
    const text = (typeof given === 'string' ? given : draft).trim();
    if ((!text && !shots.length) || busy) return;
    sending.current = true; stick.current = true;
    if (error) clearError();
    setDraft('');
    if (shots.length) { sendMessage(text ? { text, files: shots } : { files: shots }); setShots([]); }
    else sendMessage({ text });
  };
  const stop = async () => {
    try { if (runId) await api('POST', `/api/runs/${runId}/cancel`); } catch (e) { toast(e.message); }
  };
  let problem = null;
  if (error) { try { problem = JSON.parse(error.message).error; } catch { problem = null; } problem = problem || 'Lost the connection to the app. The agent may still be working.'; }
  const showDots = busy && !(lastPart && ((lastPart.type === 'text' && lastPart.state === 'streaming') || (isTool(lastPart) && toolRunning(lastPart)) || (lastPart.type === 'reasoning' && lastPart.state === 'streaming')));
  const starters = where.starters || [];

  return (
    <PanelCtx.Provider value={panelCtx}>
      {snip ? <SnipOverlay onDone={endSnip} onCancel={() => setSnip(null)} /> : null}
      {shownPanel ? <Panel part={shownPanel} onClose={closePanel} onChoose={(t) => send(t)} busy={busy} /> : null}
      <div className="fc-scroll" ref={scroller} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="fc-empty">
            {readOnly ? <p>Nothing here yet.</p> : (
              <>
                <Orb size={64} />
                <h3>What are we doing?</h3>
                <p>Ask for anything, from any page. I do it, or hand the job to a worker and bring back the result. Decisions come to you as cards with buttons.</p>
                <div className="fc-chips">
                  {starters.map((s) => <button type="button" key={s} className="fc-chip" onClick={() => { if (/:\s$/.test(s)) { setDraft(s); if (input.current) input.current.focus(); } else send(s); }}>{s.replace(/:\s*$/, '…')}</button>)}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="fc-thread">
            {messages.map((m, i) => <Message key={i} message={m} live={busy && i === messages.length - 1} />)}
            {showDots ? <div className="fc-dots" aria-label={doing || 'Working'}><span /><span /><span />{queued ? <em>Waiting for a free slot…</em> : null}</div> : null}
          </div>
        )}
      </div>
      {away ? <button type="button" className="fc-jump" onClick={toBottom} title="Jump to the latest"><Icon name="down" size={15} /></button> : null}
      {problem ? (
        <div className="fc-problem"><Icon name="alert" size={15} /><span>{problem}</span>
          <button type="button" className="fc-ghost" onClick={() => { clearError(); sync(); }}>Reconnect</button></div>
      ) : null}
      {readOnly ? (
        <div className="ag-readonly">
          <span>{busy ? (doing || 'Working') + '…' : 'A worker’s log. To change what it does, ask the agent.'}</span>
          {busy ? <button type="button" className="ag-btn sm" onClick={stop} disabled={!runId}><Icon name="stop" size={11} fill />Stop</button> : null}
        </div>
      ) : (
        <form className={'fc-composer' + (dropping ? ' dropping' : '')} onSubmit={(e) => { e.preventDefault(); send(); }}
          onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)}
          onDrop={(e) => { setDropping(false); if (addShots(e.dataTransfer.files)) e.preventDefault(); }}>
          {shots.length ? (
            <div className="ag-tray">
              {shots.map((f, i) => (
                <span key={i} className="ag-tray-item"><img src={f.url} alt={f.filename} />
                  <button type="button" onClick={() => setShots(shots.filter((_, j) => j !== i))} title="Remove this image"><Icon name="x" size={10} /></button></span>
              ))}
            </div>
          ) : null}
          <div className="ag-context" title="The agent is told which page you are on with every message"><Icon name="pin" size={12} /><span>{where.label}</span></div>
          <textarea ref={input} className="fc-input" rows={1} value={draft} placeholder="Ask for anything…"
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { if (addShots(e.clipboardData && e.clipboardData.files)) e.preventDefault(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <div className="fc-composer-row">
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { addShots(e.target.files); e.target.value = ''; }} />
            <button type="button" className="ag-attach" onClick={() => picker.current && picker.current.click()} title="Attach an image (or paste or drop one here)"><Icon name="image" size={16} /></button>
            <button type="button" className="ag-attach" onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); startSnip(); } }} onClick={(e) => { if (e.detail === 0) startSnip(); }} disabled={!!snip} title="Snip: freeze the page and click round something to attach it"><Icon name="snip" size={16} /></button>
            <span className="fc-hint">{busy ? 'Working. Open another thread to do something else meanwhile.' : 'Enter to send · paste, drop or snip an image'}</span>
            {busy
              ? <button type="button" className="fc-send stop" onClick={stop} disabled={!runId} title="Stop the agent"><Icon name="stop" size={15} fill /></button>
              : <button type="submit" className="fc-send" disabled={!draft.trim() && !shots.length} title="Send"><Icon name="up" size={17} /></button>}
          </div>
        </form>
      )}
    </PanelCtx.Provider>
  );
}

// Loads a conversation's saved messages, then hands over to Thread.
function Conversation({ id, readOnly, where, onDoing }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let on = true;
    setState(null);
    api('GET', `/api/ui/chat/${id}/messages`).then((d) => { if (on) setState({ id, data: d }); }).catch((e) => { if (on) setState({ id, failed: e.message }); });
    return () => { on = false; };
  }, [id]);
  if (!state || state.id !== id) return <div className="fc-loading"><span /><span /><span /></div>;
  if (state.failed) return <div className="fc-empty"><p>{state.failed}</p></div>;
  return <Thread key={id} id={id} initial={state.data} readOnly={readOnly} where={where} onDoing={onDoing} />;
}

// The workers' logs: read what each was asked and what it did.
function Workers({ log, setLog }) {
  const { subscribe, agents } = useContext(App);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const load = () => api('GET', '/api/workers').then(setRows).catch(() => {});
    load();
    let timer = null;
    const off = subscribe((ev) => { if (ev.t === 'run' || ev.t === 'msg') { clearTimeout(timer); timer = setTimeout(load, 400); } });
    return () => { clearTimeout(timer); off(); };
  }, []);
  if (log) {
    const w = (agents && agents[log.split('-')[0]]) || { label: 'Worker', icon: 'layers' };
    return (
      <>
        <div className="ag-logbar">
          <button type="button" className="fc-ghost" onClick={() => setLog(null)}><Icon name="back" size={13} />Workers</button>
          <span className="ag-logbar-title"><Icon name={w.icon} size={13} />{w.label}</span>
        </div>
        <Conversation id={log} readOnly where={{ label: '' }} />
      </>
    );
  }
  return (
    <div className="fc-scroll">
      <div className="ag-section">Workers</div>
      <p className="ag-lede">Workers take jobs from the agent and from the app. Open one to read what it was asked and what it did.</p>
      {!rows ? <div className="fc-loading"><span /><span /><span /></div> : !rows.length ? <p className="ag-lede">No worker has run yet.</p> : (
        <div className="ag-workers">
          {rows.map((r) => {
            const w = (agents && agents[r.agent]) || { label: r.label, icon: 'layers' };
            return (
              <button type="button" key={r.id} className={'ag-workrow' + (r.busy ? ' busy' : '')} onClick={() => setLog(r.id)}>
                <span className="ag-worker-icon"><Icon name={w.icon} size={15} /></span>
                <span className="ag-worker-who"><b>{w.label}</b><span>{r.count} messages</span></span>
                <span className="ag-workrow-when">{r.busy ? <><span className="fc-spin" />working</> : ago(r.last_at)}</span>
                <Icon name="chevron" size={13} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The bar at the top of a thread: its name, which you can type over, and a button to close it.
function ThreadBar({ thread, onRename, onClose }) {
  const [title, setTitle] = useState(thread.title || '');
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setTitle(thread.title || ''); }, [thread.id, thread.title, editing]);
  const save = () => { setEditing(false); const t = title.replace(/\s+/g, ' ').trim(); if (t && t !== (thread.title || '')) onRename(t); else setTitle(thread.title || ''); };
  return (
    <div className="ag-threadbar">
      <Icon name="pen" size={13} />
      <input className="ag-threadname" value={title} placeholder="Name this thread" maxLength={48} title="Type to rename this thread"
        onFocus={() => setEditing(true)} onChange={(e) => setTitle(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setTitle(thread.title || ''); setEditing(false); e.target.blur(); } }} />
      <button type="button" className="fc-ghost" onClick={onClose} title="Close this thread. The agents' notebooks keep what they learned."><Icon name="x" size={12} />Close thread</button>
    </div>
  );
}

// ---------- the rail ----------
function Rail({ subscribe, toast }) {
  const [data, setData] = useState({ threads: [], workers: [] });
  const [current, setCurrent] = useState(() => Number(store.get('agentic.thread')) || null);
  const [view, setView] = useState('chat');
  const [log, setLog] = useState(null);
  const [open, setOpen] = useState(() => store.get('agentic.rail') !== 'closed' && window.innerWidth >= 1100);
  const [full, setFull] = useState(() => store.get('agentic.rail.full') === '1');
  const [width, setWidth] = useState(() => Math.min(760, Math.max(380, Number(store.get('agentic.rail.w')) || 500)));
  const [where, setWhere] = useState({ label: 'Home', starters: [] });
  const [doing, setDoing] = useState(null);
  const [agents, setAgents] = useState(null);
  useEffect(() => { api('GET', '/api/agents').then(setAgents).catch(() => {}); }, []);

  const load = useCallback(() => api('GET', '/api/threads').then((d) => {
    setData(d);
    setCurrent((c) => (d.threads.some((t) => t.id === c) ? c : d.threads[d.threads.length - 1].id));
  }).catch(() => {}), []);
  useEffect(() => {
    load();
    let timer = null;
    const off = subscribe((ev) => { if (ev.t === 'run' || ev.t === 'msg') { clearTimeout(timer); timer = setTimeout(load, 300); } });
    return () => { clearTimeout(timer); off(); };
  }, [load]);
  useEffect(() => { if (current) store.set('agentic.thread', String(current)); }, [current]);

  // which page you are on, for the context chip and the starter prompts
  useEffect(() => {
    const read = () => api('GET', `/api/where?page=${encodeURIComponent(window.location.hash)}`).then(setWhere).catch(() => {});
    read();
    window.addEventListener('hashchange', read); window.addEventListener('agentic:where', read);
    return () => { window.removeEventListener('hashchange', read); window.removeEventListener('agentic:where', read); };
  }, []);

  // the page makes room for the rail
  useLayoutEffect(() => {
    const top = document.getElementById('top');
    const root = document.documentElement;
    root.style.setProperty('--top-h', (top ? top.offsetHeight : 54) + 'px');
    root.style.setProperty('--rail-w', width + 'px');
    document.body.classList.toggle('rail-open', open);
    document.body.classList.toggle('rail-full', open && full);
    store.set('agentic.rail', open ? 'open' : 'closed');
    store.set('agentic.rail.full', full ? '1' : '0');
  }, [open, width, full]);
  // Escape leaves full screen
  useEffect(() => {
    if (!full) return undefined;
    const key = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) setFull(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [full]);
  const drag = (e) => {
    e.preventDefault();
    const move = (ev) => setWidth(Math.min(760, Math.max(380, ev.clientX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('rail-drag'); };
    document.body.classList.add('rail-drag');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  useEffect(() => { store.set('agentic.rail.w', String(width)); }, [width]);

  const ctx = useMemo(() => ({ subscribe, toast, agents: agents && agents.agents, openLog: (id) => { setLog(id); setView('workers'); } }), [agents]);
  const add = async () => { try { const r = await api('POST', '/api/threads'); await load(); setCurrent(r.id); setView('chat'); } catch (e) { toast(e.message); } };
  const close = async (t) => {
    try { await api('DELETE', `/api/threads/${t.id}`); await load(); } catch (e) { toast(e.message); }
  };
  const rename = async (t, title) => {
    try { await api('PUT', `/api/threads/${t.id}`, { title }); await load(); } catch (e) { toast(e.message); }
  };
  const thread = data.threads.find((t) => t.id === current);
  const anyBusy = data.threads.some((t) => t.busy) || data.workers.length > 0;
  const status = doing ? doing + '…' : data.workers.length ? `${data.workers.length} worker${data.workers.length > 1 ? 's' : ''} running` : 'Ready';

  if (!open) {
    return (
      <App.Provider value={ctx}>
        <button type="button" className={'ag-launch' + (anyBusy ? ' busy' : '')} onClick={() => setOpen(true)} title="Open the agent"><Orb busy={anyBusy} size={40} /></button>
      </App.Provider>
    );
  }
  return (
    <App.Provider value={ctx}>
      <aside className={'ag-rail fc' + (anyBusy ? ' busy' : '') + (full ? ' full' : '')}>
        <div className="ag-seam" onPointerDown={drag} title="Drag to resize" />
        <div className="ag-glow" />
        <header className="ag-head">
          <Orb busy={!!doing} />
          <div className="ag-head-text">
            <div className="ag-name">{(agents && agents.agents[agents.main] && agents.agents[agents.main].label) || 'Agent'}</div>
            <div className={'ag-status' + (doing || data.workers.length ? ' busy' : '')}><i />{status}</div>
          </div>
          <button type="button" className={'ag-tool' + (view === 'workers' ? ' on' : '')} onClick={() => { setView(view === 'workers' ? 'chat' : 'workers'); setLog(null); }} title="Workers: what the batch jobs did">
            <Icon name="layers" size={16} />{data.workers.length ? <b>{data.workers.length}</b> : null}
          </button>
          <button type="button" className="ag-tool" onClick={() => setFull(!full)} title={full ? 'Back to the side (Esc)' : 'Full screen'}><Icon name={full ? 'shrink' : 'expand'} size={16} /></button>
          <button type="button" className="ag-tool" onClick={() => { setFull(false); setOpen(false); }} title="Tuck the agent away"><Icon name="side" size={16} /></button>
        </header>
        <nav className="ag-threads">
          {data.threads.map((t) => (
            <span key={t.id} className={'ag-thread' + (t.id === current && view === 'chat' ? ' on' : '') + (t.busy ? ' busy' : '')}>
              <button type="button" className="ag-thread-main" onClick={() => { setCurrent(t.id); setView('chat'); }} title={t.title || 'New thread'}>
                <i />{t.title || 'New thread'}
              </button>
              <button type="button" className="ag-thread-x" onClick={() => close(t)} title="Close this thread"><Icon name="x" size={11} /></button>
            </span>
          ))}
          <button type="button" className="ag-thread-add" onClick={add} title="Start another thread"><Icon name="plus" size={14} /></button>
        </nav>
        {view === 'chat' && thread ? <ThreadBar thread={thread} onRename={(title) => rename(thread, title)} onClose={() => close(thread)} /> : null}
        {view === 'workers' ? <Workers log={log} setLog={setLog} />
          : current && agents ? <Conversation id={`${agents.main}-thread-${current}`} where={where} onDoing={setDoing} /> : <div className="fc-loading"><span /><span /><span /></div>}
      </aside>
    </App.Provider>
  );
}

window.AgenticUI = {
  mount(el, opts) {
    const root = createRoot(el);
    root.render(<Rail {...opts} />);
    return { destroy: () => root.unmount() };
  },
};
