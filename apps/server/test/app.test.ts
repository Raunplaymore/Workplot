import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { healthSchema } from '@studio/contracts';
import { buildApp } from '../src/app.js';

test('health reports the disconnected agent and SQLite survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-test-'));
  const path = join(directory, 'test.sqlite');
  try {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const app = await buildApp(path);
      try {
        const response = await app.inject('/api/health');
        expect(response.statusCode).toBe(200);
        expect(healthSchema.parse(response.json()).agent).toBe('not_connected');
        expect((await app.inject('/api/unknown')).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db
          .prepare('SELECT value FROM app_metadata WHERE key = ?')
          .get('schema_version'),
      ).toEqual({ value: '2' });
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
