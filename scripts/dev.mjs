// One command for local development: API (:4000) and web (:3000). Works in bash and PowerShell.
import { spawn } from 'node:child_process';
const win = process.platform === 'win32';
const children = [];
let closing = false;

// `npm run` starts grandchildren (tsx, next), so stop the whole tree, not just the npm wrapper.
function stop(c) {
  if (win) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } }
}
function shutdown(code) { if (closing) return; closing = true; children.forEach(stop); setTimeout(() => process.exit(code), 1000); }
for (const [name, script] of [['api', 'dev:api'], ['web', 'dev:web']]) {
  const c = spawn('npm', ['run', script], { stdio: 'inherit', shell: true, detached: !win });
  c.on('exit', (code) => { if (!closing) console.log(`[${name}] exited (${code})`); shutdown(code ?? 1); });
  children.push(c);
}
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));
