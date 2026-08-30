#!/usr/bin/env node
/**
 * One-click dev:web restart — stop the old server, rebuild the packages
 * that `pnpm dev:web` itself misses, then relaunch the dev loop.
 *
 * Equivalent manual sequence:
 *   pnpm dev:web:stop
 *   pnpm --filter @zleap/ai build
 *   pnpm dev:web
 *
 * Why only @zleap/ai needs an explicit build: `pnpm dev:web` already rebuilds
 * @zleap/agent, @zleap/host (npm-script part) and @zleap/core, @zleap/store,
 * @zleap-ai/cli, @zleap/tasks, @zleap/gateway (runDevBuild part), and next dev
 * hot-reloads @zleap/web. The runtime dependency that no step rebuilds is
 * @zleap/ai, whose dist next dev keeps loading until it is refreshed.
 *
 * Usage:
 *   pnpm dev:web:restart            # stop → rebuild @zleap/ai → pnpm dev:web
 *   node scripts/dev-web-restart.mjs --dry-run   # print the steps, run nothing
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isDryRun = process.argv.includes('--dry-run');
const quiet = process.argv.includes('--quiet');

/** Spawn a child with inherited stdio; resolve on exit 0, reject otherwise. */
function run(cmd, args, { silent = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!silent) {
      process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
    }
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: silent ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (error) => (allowFail ? resolve(0) : reject(error)));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(code);
        return;
      }
      if (allowFail) {
        if (!silent) {
          process.stdout.write(`  (exit ${code} — continuing)\n`);
        }
        resolve(code ?? 0);
        return;
      }
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

const STEPS = [
  {
    // Best-effort: "not running" (exit 1) is a fine starting state.
    label: 'Stop the current dev:web (next dev) — tolerates "not running"',
    cmd: 'pnpm',
    args: ['dev:web:stop'],
    allowFail: true,
  },
  {
    // The one package `pnpm dev:web` never rebuilds; web's runtime depends on its dist.
    label: 'Rebuild @zleap/ai (the gap dev:web leaves behind)',
    cmd: 'pnpm',
    args: ['--filter', '@zleap/ai', 'build'],
  },
  {
    // Rebuilds agent/host + core/store/cli/tasks/gateway, then postgres, migrate, next dev.
    label: 'Relaunch dev:web (rebuilds the rest, migrates, starts next dev — stays in foreground)',
    cmd: 'pnpm',
    args: ['dev:web'],
  },
];

async function main() {
  const startedAt = Date.now();
  process.stdout.write('=== Zleap dev:web one-click restart ===\n');

  if (isDryRun) {
    process.stdout.write('[dry-run] would run, in order:\n');
    for (const step of STEPS) {
      process.stdout.write(`  $ ${step.cmd} ${step.args.join(' ')}\n`);
    }
    process.stdout.write('[dry-run] nothing executed.\n');
    return;
  }

  for (const step of STEPS) {
    process.stdout.write(`\n─── ${step.label}\n`);
    await run(step.cmd, step.args, { silent: quiet, allowFail: step.allowFail });
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\n=== done in ${seconds}s — dev:web is back up at http://localhost:3000 ===\n`);
  process.stdout.write('Tip: to keep it alive after closing this terminal, launch it detached instead:\n');
  process.stdout.write('  setsid nohup pnpm dev:web > /tmp/zleap-dev-web.log 2>&1 &\n');
}

main().catch((error) => {
  process.stderr.write(
    `\n[dev-web-restart] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
