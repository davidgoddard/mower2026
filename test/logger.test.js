import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionLogger } from '../dist/index.js';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mower-logger-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('SessionLogger writes JSONL entries with scoped context and transition events', async () => {
  await withTempDir(async (dir) => {
    const fixedNow = new Date(2026, 4, 17, 13, 20, 0, 0);

    const logger = await SessionLogger.create({
      app: 'core-app',
      context: 'bootstrap',
      source: 'MainApp',
      logDir: dir,
      minLevel: 'debug',
      now: () => fixedNow,
    });

    logger.info('app.start', { pid: 1 });
    const drive = logger.child({ context: 'drive', source: 'DriveController' });
    drive.debug('loop.tick', { hz: 30 });
    drive.transition('idle', 'driving', { reason: 'user-request' });
    logger.error('app.error', { code: 'E_MOTOR' });

    await logger.flush();
    await logger.close();

    const content = await readFile(logger.sessionLogPath, 'utf8');
    const lines = content.trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(lines.length, 4);
    assert.equal(lines[0].app, 'core-app');
    assert.equal(lines[0].context, 'bootstrap');
    assert.equal(lines[0].source, 'MainApp');
    assert.equal(lines[1].context, 'drive');
    assert.equal(lines[1].source, 'DriveController');
    assert.equal(lines[2].message, 'state.transition');
    assert.equal(lines[2].data.fromState, 'idle');
    assert.equal(lines[2].data.toState, 'driving');
    assert.equal(lines[3].level, 'error');

    for (const line of lines) {
      assert.equal(typeof line.timestamp, 'string');
      assert.equal(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(line.timestamp), true);
    }
  });
});

test('SessionLogger keeps startup date and most recent prior date only', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session-2026-05-14_09-00-00-000.jsonl'), '{}\n', 'utf8');
    await writeFile(join(dir, 'session-2026-05-15_08-00-00-000.jsonl'), '{}\n', 'utf8');
    await writeFile(join(dir, 'session-2026-05-16_08-00-00-000.jsonl'), '{}\n', 'utf8');

    const logger = await SessionLogger.create({
      app: 'core-app',
      logDir: dir,
      now: () => new Date(2026, 4, 17, 13, 0, 0, 0),
    });

    await logger.close();

    const files = (await readdir(dir)).sort();
    assert.equal(files.includes('session-2026-05-14_09-00-00-000.jsonl'), false);
    assert.equal(files.includes('session-2026-05-15_08-00-00-000.jsonl'), false);
    assert.equal(files.includes('session-2026-05-16_08-00-00-000.jsonl'), true);
    assert.equal(files.some((name) => name === logger.sessionLogPath.split('/').pop()), true);
  });
});

test('SessionLogger respects minLevel filtering', async () => {
  await withTempDir(async (dir) => {
    const logger = await SessionLogger.create({
      app: 'core-app',
      logDir: dir,
      minLevel: 'warn',
      now: () => new Date(2026, 4, 17, 13, 0, 0, 0),
    });

    logger.debug('debug.skip');
    logger.info('info.skip');
    logger.warn('warn.keep');
    logger.error('error.keep');

    await logger.flush();
    await logger.close();

    const content = await readFile(logger.sessionLogPath, 'utf8');
    const messages = content.trim().split('\n').map((line) => JSON.parse(line).message);
    assert.deepEqual(messages, ['warn.keep', 'error.keep']);
  });
});
