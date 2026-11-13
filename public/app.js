// The example host app: plain JavaScript, no build step. Your own pages go here; the agent rail
// (ui/chat.jsx, built into chat.bundle.js) is mounted beside them at the bottom of this file.
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
// Like replaceChildren, but takes nested lists and skips empty slots.
function set(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k))))); }
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-agentic': '1' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000); }
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATE = { proposed: ['Waiting for you', 'amber'], approved: ['Approved', 'blue'], running: ['Running', 'blue'], done: ['Done', 'green'], failed: ['Failed', 'red'], check: ['Check it', 'red'], rejected: ['Rejected', ''] };
const pill = (s) => h('span', { class: 'pill ' + ((STATE[s] || [])[1] || '') }, (STATE[s] || [s])[0]);

// ---------- live events: the page and the rail both listen ----------
const listeners = new Set();
const es = new EventSource('/api/events');
es.onmessage = (m) => { const ev = JSON.parse(m.data); for (const l of listeners) l(ev); };
let timer = null, current = null;
listeners.add(() => { clearTimeout(timer); timer = setTimeout(() => { status(); if (current) current(); }, 350); });

async function status() {
  try {
    const s = await api('GET', '/api/state');
    const st = $('#status'); st.replaceChildren();
    if (s.runs.length) st.append(h('span', { class: 'live' }, h('span', { class: 'spin' }), `${s.runs.length} working`));
    if (s.counts.proposed) st.append(h('span', {}, `${s.counts.proposed} waiting for you`));
  } catch { $('#status').textContent = 'App not responding'; }
}

// ---------- pages ----------
function Home(el) {
  const load = async () => {
    const { actions } = await api('GET', '/api/actions');
    const group = (title, list, empty) => [h('div', { class: 'section' }, h('h2', {}, title)),
      list.length ? h('table', {}, h('tbody', {}, list.map((a) => h('tr', {},
        h('td', {}, h('div', { class: 'item-name' }, a.title), h('div', { class: 'muted small' }, a.fields.filter((f) => f.key !== 'title').map((f) => `${f.label}: ${f.value.slice(0, 120)}`).join(' · '))),
        h('td', {}, pill(a.status), a.problem ? h('div', { class: 'note bad' }, a.problem) : null),
        h('td', { class: 'muted small' }, a.run_at ? 'runs ' + fmt(a.run_at) : fmt(a.done_at || a.created_at)),
        h('td', {}, a.status === 'proposed' ? h('button', { class: 'primary sm', onclick: act(async () => { await api('POST', '/api/actions/approve', { items: [{ id: a.id, version: a.version }] }); toast('Approved.'); }) }, 'Approve') : null,
          a.status === 'approved' ? h('button', { class: 'sm danger', onclick: act(() => api('POST', `/api/actions/${a.id}/takeback`)) }, 'Take back') : null,
          a.status === 'check' ? [h('button', { class: 'sm', onclick: act(() => api('POST', `/api/actions/${a.id}/resolve`, { ok: true })) }, 'It went'), h('button', { class: 'sm danger', onclick: act(() => api('POST', `/api/actions/${a.id}/resolve`, { ok: false })) }, 'It did not')] : null))))) : h('div', { class: 'empty' }, empty)];
    set(el, 
      h('h1', {}, 'Notes desk'),
      h('p', { class: 'muted' }, 'An example workspace. Ask the agent in the rail to draft a note; it appears here for you to approve, and is published only after you do.'),
      group('Waiting for you', actions.filter((a) => a.status === 'proposed'), 'Nothing waiting. Ask the agent to draft a note.'),
      group('Scheduled and running', actions.filter((a) => ['approved', 'running', 'check'].includes(a.status)), 'Nothing scheduled.'),
      group('Done', actions.filter((a) => ['done', 'failed', 'rejected'].includes(a.status)).slice(0, 30), 'Nothing yet.'));
  };
  return load;
}
function Activity(el) {
  return async () => {
    const rows = await api('GET', '/api/activity');
    set(el, h('h1', {}, 'Activity'), h('p', { class: 'muted' }, 'Every proposal, approval, gate decision, blocked tool call, shell command and file change.'),
      rows.length ? h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { class: 'muted small' }, fmt(r.ts)), h('td', {}, h('span', { class: 'pill' + (r.kind === 'blocked' || r.kind === 'run_error' ? ' red' : '') }, r.kind)), h('td', {}, r.text))))) : h('div', { class: 'empty' }, 'Nothing has happened yet.'));
  };
}
function Notebooks(el) {
  return async () => {
    const d = await api('GET', '/api/notes');
    set(el, h('h1', {}, 'Notebooks'), h('p', { class: 'muted' }, 'What the agents remember between conversations. They write here with remember and forget; you can delete anything.'),
      d.notebooks.map((nb) => [h('div', { class: 'section' }, h('h2', {}, nb === 'general' ? 'General' : d.labels[nb])),
        d.notes.filter((n) => n.notebook === nb).map((n) => h('div', { class: 'row' }, h('div', { class: 'grow' }, n.text), h('button', { class: 'sm danger', onclick: act(() => api('DELETE', `/api/notes/${n.id}`)) }, 'Delete')))]));
  };
}
function Rules(el) {
  return async () => {
    const d = await api('GET', '/api/blocklist');
    set(el, h('h1', {}, 'Rules'), h('p', { class: 'muted' }, 'The gate refuses any action whose value is on its blocklist, at proposal, at approval and at the moment it runs. Time windows and rate limits live in agents.config.js.'),
      d.kinds.map((k) => {
        const v = h('input', { placeholder: k.field }), why = h('input', { placeholder: 'reason (optional)' });
        return [h('div', { class: 'section' }, h('h2', {}, `${k.kind}: blocked ${k.field} values`)),
          d.items.filter((i) => i.kind === k.kind).map((i) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, i.value), i.reason ? h('span', { class: 'muted' }, ' · ' + i.reason) : null), h('button', { class: 'sm danger', onclick: act(() => api('DELETE', `/api/blocklist/${i.id}`)) }, 'Remove'))),
          h('div', { class: 'row', style: 'margin-top:10px' }, v, why, h('button', { onclick: act(async () => { await api('POST', '/api/blocklist', { kind: k.kind, value: v.value, reason: why.value }); toast('Blocked.'); }) }, 'Block'))];
      }));
  };
}
function route() {
  const page = (location.hash.split('/')[1] || 'home');
  document.querySelectorAll('#top nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
  const el = $('#page');
  current = ({ activity: Activity, notebooks: Notebooks, rules: Rules }[page] || Home)(el);
  current().catch((e) => toast(e.message));
}
window.addEventListener('hashchange', route);

// ---------- top bar: theme and the real / demo switch ----------
(() => {
  const btn = $('#theme'), root = document.documentElement;
  const light = () => root.dataset.theme === 'light';
  const paint = () => { btn.textContent = light() ? '☾' : '☀'; btn.title = light() ? 'Switch to dark' : 'Switch to light'; };
  btn.addEventListener('click', () => { if (light()) delete root.dataset.theme; else root.dataset.theme = 'light'; try { localStorage.setItem('agentic.look', light() ? 'light' : 'dark'); } catch { /* no storage */ } paint(); });
  paint();
})();
(() => {
  const demo = document.documentElement.dataset.mode === 'demo';
  const btn = $('#mode');
  btn.textContent = demo ? 'Demo ● on' : 'Demo: off';
  $('#demo-banner').hidden = !demo;
  if (demo) document.title = 'DEMO · ' + document.title;
  btn.addEventListener('click', act(async () => {
    const to = demo ? 'real' : 'demo';
    if (!confirm(demo ? 'Switch back to real mode? The app restarts.' : 'Switch to demo mode (separate data, mock services)? The app restarts; your real data is untouched.')) return;
    btn.disabled = true; btn.textContent = 'Restarting…';
    try { await api('POST', '/api/mode', { mode: to }); } catch (e) { btn.disabled = false; btn.textContent = demo ? 'Demo ● on' : 'Demo: off'; throw e; }
    const wait = async () => { try { const j = await (await fetch('/api/mode')).json(); if (j.mode === to) return location.reload(); } catch { /* restarting */ } setTimeout(wait, 700); };
    setTimeout(wait, 900);
  }));
})();

status();
route();
// The agent rail, beside every page.
AgenticUI.mount($('#agent'), { toast, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } });
