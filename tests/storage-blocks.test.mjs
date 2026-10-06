// Storage-container names: the matcher, not a fragile whitelist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStorageBlock, storageBlockNames, storageFamilyOf,
  addStorageBlockName, addStorageBlockFamily, resetStorageExtensions, STORAGE_BLOCK_NAMES,
} from '../storage-blocks.mjs';

test('the names that used to be the whole whitelist still match', () => {
  for (const name of ['chest', 'trapped_chest', 'barrel', 'shulker_box']) assert.equal(isStorageBlock(name), true, name);
});

test('dyed shulker boxes are storage even though they are not in a list', () => {
  for (const color of ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']) {
    assert.equal(isStorageBlock(`${color}_shulker_box`), true, color);
  }
  assert.equal(STORAGE_BLOCK_NAMES.filter((n) => n.endsWith('_shulker_box')).length, 16);
});

test('namespaces and near-misses do not fool the matcher', () => {
  assert.equal(isStorageBlock('minecraft:red_shulker_box'), true);
  assert.equal(isStorageBlock('shulker_box_side'), false);
  assert.equal(isStorageBlock('chest_boat'), false);
  assert.equal(isStorageBlock('trapped_chest_minecart'), false);
  assert.equal(isStorageBlock('ender_chest'), false, 'non è un baule che si può inventariare');
  assert.equal(isStorageBlock(''), false);
  assert.equal(isStorageBlock(null), false);
  assert.equal(isStorageBlock(42), false);
});

test('the scan list contains every concrete name and no duplicates', () => {
  const names = storageBlockNames();
  assert.equal(new Set(names).size, names.length);
  for (const name of ['chest', 'barrel', 'black_shulker_box', 'cyan_shulker_box']) assert.ok(names.includes(name), name);
});

test('the extension points are additive and reportable', () => {
  try {
    assert.equal(isStorageBlock('copper_chest'), false);
    assert.equal(addStorageBlockName('copper_chest'), true);
    assert.equal(isStorageBlock('copper_chest'), true);
    assert.ok(storageBlockNames().includes('copper_chest'));
    assert.equal(addStorageBlockName('copper_chest'), false, 'idempotente');

    assert.equal(addStorageBlockFamily({ id: 'barrel_variant', suffix: '_barrel' }), true);
    assert.equal(isStorageBlock('oak_barrel'), true);
    assert.equal(storageFamilyOf('oak_barrel'), 'barrel_variant');
    assert.equal(storageFamilyOf('red_shulker_box'), 'shulker_box');
    assert.equal(storageFamilyOf('chest'), null);
    assert.equal(addStorageBlockFamily({ id: 'barrel_variant', suffix: '_barrel' }), false);
    assert.equal(addStorageBlockFamily({ suffix: '_x' }), false);
  } finally { resetStorageExtensions(); }
  assert.equal(isStorageBlock('copper_chest'), false, 'il reset riporta il matcher al suo stato');
});
