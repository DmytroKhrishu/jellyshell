// `npm test` pre-step: make sure everything the suite needs is installed, so one command works on a fresh checkout or
// worktree. Installs only what is missing (each app's own lockfile), then the headless Chromium (no-op when present).
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, cwd = root) => {
  console.log(`[test setup] ${cwd === root ? '.' : cwd.slice(root.length + 1)}: ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

for (const [dir, bin] of [['.', 'playwright'], ['web', 'vite'], ['dash/web', 'vite']]) {
  const cwd = resolve(root, dir);
  if (!existsSync(resolve(cwd, 'node_modules/.bin', bin))) run('npm ci --no-audit --no-fund', cwd);
}
run('npx playwright install --only-shell chromium');
