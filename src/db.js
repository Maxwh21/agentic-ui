// The one database (SQLite). Conversations, runs, the activity log, notebooks and gated actions live here.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ROOT, DEMO } = require('./mode');

// demo mode never opens the real data folder
const DATA = process.env.AGENTIC_DATA || path.join(ROOT, DEMO ? 'data-demo' : 'data');
fs.mkdirSync(path.join(DATA, 'agent-home'), { recursive: true });

const db = new Database(path.join(DATA, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY, title TEXT, titled INTEGER DEFAULT 0, created_at TEXT, closed_at TEXT);
CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, scope TEXT NOT NULL, scope_id INTEGER NOT NULL,
  session_id TEXT, UNIQUE(agent, scope, scope_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id), role TEXT NOT NULL,
  text TEXT, parts TEXT, run_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, chat_id INTEGER, agent TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat',
  scope TEXT, scope_id INTEGER, status TEXT NOT NULL DEFAULT 'queued', prompt TEXT, payload TEXT, token TEXT, output TEXT, error TEXT,
  created_at TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, ts TEXT, kind TEXT, text TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, notebook TEXT NOT NULL, text TEXT NOT NULL, written_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed', proposed_by TEXT, run_at TEXT, approved_at TEXT, done_at TEXT, result TEXT, problem TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS blocklist (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, UNIQUE(kind, value));
`);

const now = () => new Date().toISOString();
const bus = new (require('events').EventEmitter)();
bus.setMaxListeners(100);
function log(kind, text, ref) {
  db.prepare('INSERT INTO activity(ts,kind,text,ref) VALUES(?,?,?,?)').run(now(), kind, String(text).slice(0, 2000), ref == null ? null : String(ref));
  bus.emit('ev', { t: 'data' });
}

module.exports = { db, DATA, ROOT, now, log, bus };
