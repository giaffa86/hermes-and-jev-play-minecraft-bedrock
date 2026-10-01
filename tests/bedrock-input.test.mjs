import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');
const parser = createDeserializer('1.26.51');

function adapterWithDecodedPackets () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { x: 78.5, y: 73.62, z: 159.5 };
  const packets = [];
  adapter.client = {
    write (name, params) {
      const buffer = serializer.createPacketBuffer({ name, params });
      packets.push(parser.parsePacketBuffer(buffer).data.params);
    },
  };
  return { adapter, packets };
}

test('protocol 2193 mining retains the block action input flag on the wire', () => {
  const { adapter, packets } = adapterWithDecodedPackets();
  const position = { x: 78, y: 71, z: 160 };
  for (const action of ['start_break', 0]) {
    adapter._sendBlockAction(action, position, 1, { yaw: 0, pitch: 0 });
    const packet = packets.at(-1);
    assert.deepEqual(packet.input_data, ['block_breaking_delay_enabled', 'block_action']);
    assert.deepEqual(packet.block_action, [{ action: 'start_break', position, face: 1 }]);
  }
});

test('idle auth input omits the optional block action payload', () => {
  const { adapter, packets } = adapterWithDecodedPackets();
  adapter._sendAuthInput();
  assert.deepEqual(packets[0].input_data, ['block_breaking_delay_enabled']);
  assert.equal(packets[0].block_action, undefined);
});

test('auth input preserves eye position and emits degree-based camera direction', () => {
  const { adapter, packets } = adapterWithDecodedPackets();
  const look = adapter._lookAt({ x: adapter.position.x + 1, y: adapter.position.y, z: adapter.position.z });
  assert.equal(look.yaw, -90);
  adapter._sendAuthInput(look);
  assert.ok(Math.abs(packets[0].position.y - adapter.position.y) < 0.0001);
  assert.ok(Math.abs(packets[0].camera_orientation.x - 1) < 0.0001);
  assert.deepEqual(packets[0].interact_rotation, { x: look.pitch, z: -90 });
  for (const field of ['position', 'move_vector', 'interact_rotation', 'delta', 'camera_orientation', 'raw_move_vector']) {
    assert.ok(Object.values(packets[0][field]).every(Number.isFinite), `${field} must contain no NaN`);
  }
  assert.equal(adapter._faceForBlock({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 3, z: 0.5 }), 1);
  assert.equal(adapter._faceForBlock({ x: 0, y: 0, z: 0 }, { x: 3, y: 0.5, z: 0.5 }), 5);
});
