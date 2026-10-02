import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { createWorldMemory } from '../world-memory.mjs';

test('the adapter persists container observations into the world memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-mem-'));
  try {
    const memory = createWorldMemory({ dir, logger: { warn () {} } });
    const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
    adapter._setContainerContents(
      { key: '1,2,3', type: 'chest', position: { x: 1, y: 2, z: 3 } },
      { white_wool: 42 },
    );
    // Cache runtime aggiornata...
    assert.equal(adapter.containers.get('1,2,3').contents.white_wool, 42);
    // ...e l'osservazione è finita nel WorldMemory (separata, persisterà).
    const found = memory.containersWithItem('white_wool');
    assert.equal(found.length, 1);
    assert.equal(found[0].contents.white_wool, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an adapter without memory still works (no crash)', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  assert.doesNotThrow(() => adapter._setContainerContents(
    { key: '4,5,6', type: 'barrel', position: { x: 4, y: 5, z: 6 } },
    { coal: 1 },
  ));
  assert.equal(adapter.containers.get('4,5,6').contents.coal, 1);
});
