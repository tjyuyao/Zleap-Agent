#!/usr/bin/env node
/**
 * `pnpm dev:web:stop` — kill the Next.js dev server started by `pnpm dev:web`.
 *
 * Prefers the recorded PID from ~/.zleap/dev-web.pid, killing its detached
 * process group (next dev + next-server). Falls back to scanning /proc for a
 * next-server whose cwd is this repo's packages/web, which catches orphaned
 * processes whose parent shell is long gone.
 */
import { readFile, readdir, readlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = join(REPO_ROOT, 'packages', 'web');
const PID_PATH = join(homedir(), '.zleap', 'dev-web.pid');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPid(pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* no such process group */
    }
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!alive(pid)) return;
  }
}

async function readRecordedPid() {
  try {
    const pid = Number((await readFile(PID_PATH, 'utf8')).trim());
    return alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Find an orphaned next-server of this repo by matching its cwd under /proc. */
async function findByCwd() {
  try {
    const entries = await readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        if (cwd === WEB_DIR && comm.startsWith('next-server')) return pid;
      } catch {
        /* permission / vanished */
      }
    }
  } catch {
    /* /proc unavailable */
  }
  return undefined;
}

const pid = (await readRecordedPid()) ?? (await findByCwd());
if (!pid) {
  console.error('dev:web not running (no recorded PID and no next-server in packages/web).');
  process.exit(1);
}
await killPid(pid);
await unlink(PID_PATH).catch(() => {});
if (alive(pid)) {
  console.error(`dev:web process ${pid} still alive after SIGKILL; kill it manually.`);
  process.exit(1);
}
console.log(`dev:web stopped (pid ${pid}).`);
