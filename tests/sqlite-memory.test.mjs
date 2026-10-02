import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryRepository, SQLITE_SCHEMA_VERSION } from '../sqlite-memory.mjs';

const withRepo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlmem-'));
  try { return fn(join(dir, 'world.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const quiet = { warn () {} };

test('upsert/get/find/remove round-trip', () => withRepo((file) => {
  const repo = new SqliteMemoryRepository({ file, logger: quiet });
  repo.upsert({ id: 'sheep_farm_1_2_3', kind: 'landmark', type: 'sheep_farm', label: 'sheep pen', position: { x: 1, y: 2, z: 3 }, tags: ['farm'] });
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 9, y: 9, z: 9 }, contents: { white_wool: 2 } });
  assert.equal(repo.get('c').contents.white_wool, 2);
  assert.equal(repo.get('sheep_farm_1_2_3').label, 'sheep pen');
  assert.deepEqual(repo.find({ kind: 'container' }).map(r => r.id), ['c']);
  assert.deepEqual(repo.find({ excludeKind: 'container' }).map(r => r.id), ['sheep_farm_1_2_3']);
  assert.deepEqual(repo.find({ tag: 'farm' }).map(r => r.id), ['sheep_farm_1_2_3']);
  assert.equal(repo.count(), 2);
  assert.equal(repo.remove('c'), true);
  assert.equal(repo.count(), 1);
  repo.close();
}));

test('records persist across a close/reopen (source of truth on disk)', () => withRepo((file) => {
  const a = new SqliteMemoryRepository({ file, logger: quiet });
  a.upsert({ id: 'x', kind: 'landmark', type: 'village', position: { x: 100, y: 70, z: -200 } });
  a.close();
  const b = new SqliteMemoryRepository({ file, logger: quiet });
  assert.equal(b.get('x').type, 'village');
  assert.equal(b.count(), 1);
  assert.equal(b.db.prepare('SELECT value FROM world_memory_meta WHERE key = ?').get('schema_version').value, String(SQLITE_SCHEMA_VERSION));
  b.close();
}));

test('upsert preserves discoveredAt and updates the rest', () => withRepo((file) => {
  const repo = new SqliteMemoryRepository({ file, logger: quiet });
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 5, y: 6, z: 7 }, contents: { coal: 1 }, discoveredAt: 11, lastSeenAt: 11, status: 'known' });
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 5, y: 6, z: 7 }, contents: { coal: 9 }, discoveredAt: 99, lastSeenAt: 22, status: 'known' });
  const r = repo.get('c');
  assert.equal(r.discoveredAt, 11, 'discoveredAt preservato');
  assert.equal(r.lastSeenAt, 22);
  assert.equal(r.contents.coal, 9);
  assert.equal(repo.count(), 1);
  repo.close();
}));

test('chunk index restricts a spatial query to nearby chunks', () => withRepo((file) => {
  const repo = new SqliteMemoryRepository({ file, logger: quiet });
  repo.upsert({ id: 'near', kind: 'landmark', type: 'village', position: { x: 10, y: 64, z: 10 } });
  repo.upsert({ id: 'far', kind: 'landmark', type: 'village', position: { x: 5000, y: 64, z: 5000 } });
  const ids = repo.find({ kind: 'landmark', near: { x: 10, z: 10 }, radius: 32 }).map(r => r.id);
  assert.deepEqual(ids, ['near']);
  repo.close();
}));

test('markStaleBefore promotes old records by kind / excludeKind', () => withRepo((file) => {
  const repo = new SqliteMemoryRepository({ file, logger: quiet });
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 0, y: 0, z: 0 }, status: 'known', lastSeenAt: 1 });
  repo.upsert({ id: 'l', kind: 'landmark', type: 'village', position: { x: 5, y: 0, z: 5 }, status: 'known', lastSeenAt: 1 });
  assert.equal(repo.markStaleBefore({ kind: 'container', before: 100 }), 1);
  assert.equal(repo.get('c').status, 'stale');
  assert.equal(repo.get('l').status, 'known');
  assert.equal(repo.markStaleBefore({ excludeKind: 'container', before: 100 }), 1);
  assert.equal(repo.get('l').status, 'stale');
  repo.close();
}));
