import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonMemoryRepository, MEMORY_SCHEMA_VERSION } from '../memory-store.mjs';

const withRepo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonmem-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const quiet = { warn () {} };

test('upsert/get/find/remove round-trip', () => withRepo((dir) => {
  const repo = new JsonMemoryRepository({ dir, logger: quiet }).load();
  repo.upsert({ id: 'sheep_farm_1_2_3', kind: 'landmark', type: 'sheep_farm', position: { x: 1, y: 2, z: 3 } });
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 9, y: 9, z: 9 }, contents: { wool: 2 } });
  assert.equal(repo.get('c').contents.wool, 2);
  assert.deepEqual(repo.find({ kind: 'container' }).map(r => r.id), ['c']);
  assert.deepEqual(repo.find({ excludeKind: 'container' }).map(r => r.id), ['sheep_farm_1_2_3']);
  assert.equal(repo.count(), 2);
  assert.equal(repo.remove('c'), true);
  assert.equal(repo.count(), 1);
}));

test('a record without an id is rejected', () => withRepo((dir) => {
  const repo = new JsonMemoryRepository({ dir, logger: quiet }).load();
  assert.throws(() => repo.upsert({ type: 'x' }), /needs an id/);
}));

test('flush persists and reload restores', () => withRepo((dir) => {
  const a = new JsonMemoryRepository({ dir, logger: quiet }).load();
  a.upsert({ id: 'x', kind: 'landmark', type: 'x', position: { x: 0, y: 0, z: 0 } });
  a.flush();
  const b = new JsonMemoryRepository({ dir, logger: quiet }).load();
  assert.equal(b.get('x').type, 'x');
  const payload = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  assert.equal(payload.version, MEMORY_SCHEMA_VERSION);
  assert.ok(Array.isArray(payload.records));
}));

test('a corrupt file is set aside and the repo starts empty', () => withRepo((dir) => {
  writeFileSync(join(dir, 'world.json'), '{ broken json');
  const repo = new JsonMemoryRepository({ dir, logger: quiet }).load();
  assert.equal(repo.count(), 0);
}));

test('markStaleBefore promotes old records by kind / excludeKind', () => withRepo((dir) => {
  const repo = new JsonMemoryRepository({ dir, logger: quiet }).load();
  repo.upsert({ id: 'c', kind: 'container', type: 'chest', position: { x: 0, y: 0, z: 0 }, status: 'known', lastSeenAt: 1 });
  repo.upsert({ id: 'l', kind: 'landmark', type: 'village', position: { x: 5, y: 0, z: 5 }, status: 'known', lastSeenAt: 1 });
  assert.equal(repo.markStaleBefore({ kind: 'container', before: 100 }), 1);
  assert.equal(repo.get('c').status, 'stale');
  assert.equal(repo.get('l').status, 'known');
  assert.equal(repo.markStaleBefore({ excludeKind: 'container', before: 100 }), 1);
  assert.equal(repo.get('l').status, 'stale');
}));
