// Checks the gate without starting any agent or touching real data. Run: node test/gate.test.js
const os = require('os'), fs = require('fs'), path = require('path');
process.env.AGENTIC_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-'));
process.env.AGENTIC_MODE = 'real';
const { db } = require('../src/db');
const gates = require('../src/gates');

let pass = 0, failed = 0;
const ok = (name, cond) => { cond ? pass++ : failed++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const TOOL = 'mcp__notes__publish_note';
const WED_NOON = new Date('2026-11-11T12:00:00Z'); // a Wednesday, inside the example window (08:00-20:00 London)
const SAT_NOON = new Date('2026-11-14T12:00:00Z');
const plus = (d, min) => new Date(d.getTime() + min * 60000);
const note = { channel: '#team', title: 'Demo on Friday', body: 'Line one.\n\nLine two.' };
const runFor = (actionId) => db.prepare(db.prepare("INSERT INTO runs(agent,kind,status,payload,token) VALUES('publisher','action','running',?,?)").run(JSON.stringify({ action_id: actionId }), 't' + Math.random()).lastInsertRowid && 'SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
let n = 0;
const call = (run, input, at, tool = TOOL) => gates.check(db.prepare('SELECT * FROM runs WHERE id=?').get(run.id), { tool_name: tool, tool_input: input, tool_use_id: 'tu' + (++n) }, at);
const status = (id) => gates.get(id).status;

// proposing
ok('a proposal missing a field is refused', throws(() => gates.propose('publish_note', { channel: '#team', title: 'x' }, 'Test')));
ok('an unknown action kind is refused', throws(() => gates.propose('delete_everything', note, 'Test')));
db.prepare("INSERT INTO blocklist(kind,value,reason) VALUES('publish_note','#announcements','needs a manager')").run();
ok('a proposal to a blocklisted channel is refused', throws(() => gates.propose('publish_note', { ...note, channel: '#Announcements' }, 'Test')));
let id = gates.propose('publish_note', note, 'Test');
ok('a good proposal is saved as proposed', status(id) === 'proposed');

// approving
ok('approving with an old version is refused', throws(() => gates.approve([{ id, version: 'old' }], WED_NOON)));
const version = gates.get(id).updated_at;
gates.revise(id, { body: note.body + ' PS' }, 'Test');
ok('approving after the agent changed it is refused', throws(() => gates.approve([{ id, version }], WED_NOON)));
gates.revise(id, { body: note.body }, 'Test');
const [done] = gates.approve([{ id, version: gates.get(id).updated_at }], WED_NOON);
ok('approving the current version schedules it', status(id) === 'approved' && Date.parse(done.run_at) >= WED_NOON.getTime());
ok('an approved action cannot be approved again', throws(() => gates.approve([{ id, version: gates.get(id).updated_at }], WED_NOON)));
ok('the executor is told the exact arguments', gates.executorPrompt(gates.get(id)).includes(JSON.stringify(note.body)));

// the gate, at the moment the executor calls the service
const at = plus(new Date(done.run_at), 1);
let run = runFor(id);
ok('a call before its time is blocked', !call(run, note, plus(WED_NOON, -60)).allow);
ok('a call at the weekend (outside the window) is blocked', !call(run, note, SAT_NOON).allow);
ok('a changed body is blocked', !call(run, { ...note, body: note.body + ' PS' }, at).allow);
ok('a changed title is blocked', !call(run, { ...note, title: 'Demo on Friday!' }, at).allow);
ok('a different channel is blocked', !call(run, { ...note, channel: '#random' }, at).allow);
ok('an extra argument is blocked', !call(run, { ...note, cc: 'everyone' }, at).allow);
ok('a different tool is blocked', !call(run, note, at, 'mcp__notes__delete_note').allow);
ok('blocked attempts leave it approved', status(id) === 'approved');
ok('whitespace at the ends does not count as a change', call(run, { ...note, body: '\n' + note.body + '  ' }, at).allow);
const allowedCall = 'tu' + n;
ok('it is now running', status(id) === 'running');
ok('a second call from the same run is blocked', !call(run, note, at).allow);
gates.onResult(db.prepare('SELECT * FROM runs WHERE id=?').get(run.id), allowedCall, false, JSON.stringify({ status: 'published', id: 'abc' }));
ok('the service answer marks it done', status(id) === 'done');

// rate limit, blocklist added later, and the executor that never calls
const id2 = gates.propose('publish_note', { ...note, title: 'Second' }, 'Test');
const [d2] = gates.approve([{ id: id2, version: gates.get(id2).updated_at }], at);
ok('the next slot keeps the gap after the last one', Date.parse(d2.run_at) >= Date.parse(gates.get(id).done_at) + 2 * 60000);
const run2 = runFor(id2);
ok('a call too soon after the last one is blocked', !call(run2, { ...note, title: 'Second' }, plus(new Date(gates.get(id).done_at), 1)).allow);
db.prepare("INSERT INTO blocklist(kind,value) VALUES('publish_note','#team')").run();
ok('a channel blocked after approval is blocked at run time', !call(run2, { ...note, title: 'Second' }, plus(new Date(d2.run_at), 1)).allow);
db.prepare("DELETE FROM blocklist WHERE value='#team'").run();
gates.onRunEnd(db.prepare('SELECT * FROM runs WHERE id=?').get(run2.id));
ok('an executor that stopped without calling marks the action failed', status(id2) === 'failed');

// windows, take back, reject
ok('a slot asked for on Saturday moves to Monday morning', new Date(gates.nextSlot('publish_note', SAT_NOON)).getUTCDay() === 1);
const id3 = gates.propose('publish_note', { ...note, title: 'Third' }, 'Test');
gates.approve([{ id: id3, version: gates.get(id3).updated_at }], WED_NOON);
gates.takeBack(id3);
ok('taking back returns it to proposed', status(id3) === 'proposed');
gates.reject(id3, 'not now');
ok('a rejected action cannot be approved', throws(() => gates.approve([{ id: id3, version: gates.get(id3).updated_at }], WED_NOON)));

console.log(`\n${pass} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
