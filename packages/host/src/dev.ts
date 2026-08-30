import { join } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { loadServeEnvFiles } from './dotenv.js';
import { buildServeEnv } from './env.js';
import { runDevBuild, runDevBuildGateway, runMigrate } from './migrate.js';
import { ensurePostgres } from './postgres.js';
import { zleapHome } from './layout.js';
import { resolveRepoRoot } from './paths.js';
import { resolvePnpm } from './pnpm.js';
import { runForeground, spawnDetached } from './process.js';

/** State file recording the `next dev` PID so `dev:web:stop` can kill it. */
export function devWebPidPath(): string {
  return join(zleapHome(), 'dev-web.pid');
}

export type DevOptions = {
  repoRoot?: string;
  skipPostgres?: boolean;
  skipBuild?: boolean;
};

/** Web-only dev loop: Postgres → build → migrate → `next dev`. */
export async function runDevWeb(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipPostgres) {
    await ensurePostgres(env);
  }
  if (!options.skipBuild) {
    await runDevBuild(repoRoot, env);
  }
  await runMigrate(repoRoot, env);

  const pnpm = await resolvePnpm();
  const child = spawnDetached(pnpm.command, [...pnpm.argsPrefix, '--filter', '@zleap/web', 'dev:next'], {
    cwd: repoRoot,
    env,
  });
  const pid = child.pid;
  if (pid) {
    await writeFile(devWebPidPath(), String(pid), 'utf8').catch(() => {});
  }
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  try {
    await new Promise<number>((resolve, reject) => {
      child.once('exit', (code, signal) => {
        process.removeListener('SIGINT', forward);
        process.removeListener('SIGTERM', forward);
        if (code === 0 || signal) {
          resolve(0);
          return;
        }
        reject(new Error(`next dev exited with code ${code}`));
      });
      child.once('error', reject);
    });
  } finally {
    if (pid) {
      await unlink(devWebPidPath()).catch(() => {});
    }
  }
  return 0;
}

/**
 * Stop a `dev:web`-started next dev server. Kills the recorded process (and its
 * detached group) via `~/.zleap/dev-web.pid`, then removes the state file.
 */
export async function stopDevWeb(): Promise<{ stopped: boolean; missing: boolean }> {
  const path = devWebPidPath();
  let pid: number;
  try {
    pid = Number((await readFile(path, 'utf8')).trim());
  } catch {
    return { stopped: false, missing: true };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stopped: false, missing: true };
  }
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
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
    if (!alive()) break;
  }
  await unlink(path).catch(() => {});
  return { stopped: true, missing: false };
}

/** Standalone task worker for `pnpm dev:tasks`. */
export async function runDevWorker(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipBuild) {
    await runDevBuild(repoRoot, env);
  }

  const workerScript = join(repoRoot, 'packages', 'tasks', 'dist', 'worker.js');
  await runForeground(process.execPath, [workerScript], { cwd: repoRoot, env });
  return 0;
}

/** Standalone IM gateway worker for `pnpm dev:gateway`. */
export async function runDevGateway(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipBuild) {
    await runDevBuildGateway(repoRoot, env);
  }

  const gatewayScript = join(repoRoot, 'packages', 'gateway', 'dist', 'worker.js');
  await runForeground(process.execPath, [gatewayScript], { cwd: repoRoot, env });
  return 0;
}
