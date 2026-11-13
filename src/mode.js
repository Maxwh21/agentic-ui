// Real or demo. Read once at start-up; switching writes .mode and restarts the app (start.sh starts it again).
// Demo mode uses its own data folder (data-demo/) and the mock version of every external service,
// so the app can be shown or filmed without real data and without anything leaving the machine.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODE_FILE = path.join(ROOT, '.mode');
const RESTART_CODE = 75; // start.sh starts the app again when it exits with this code

function readMode() {
  if (process.env.AGENTIC_MODE) return process.env.AGENTIC_MODE === 'demo' ? 'demo' : 'real'; // pinned (tests, a fixed demo)
  try { return fs.readFileSync(MODE_FILE, 'utf8').trim() === 'demo' ? 'demo' : 'real'; } catch { return 'real'; }
}
const MODE = readMode();
const DEMO = MODE === 'demo';
const PINNED = !!process.env.AGENTIC_MODE;
function writeMode(mode) { fs.writeFileSync(MODE_FILE, mode === 'demo' ? 'demo\n' : 'real\n'); }

module.exports = { ROOT, MODE, DEMO, PINNED, RESTART_CODE, writeMode };
