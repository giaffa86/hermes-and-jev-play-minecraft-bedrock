import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BedrockAdapter} from '../bedrock-adapter.mjs';

function adapter() {
  const bot = new BedrockAdapter({logger:{log(){}}});
  bot.client = {entityId:7n, write(){}};
  bot.position = {x:0.5,y:64.62,z:0.5};
  bot._feet = {x:0.5,y:63,z:0.5};
  return bot;
}

test('player byte sleep bit confirms sleep and a later byte confirms waking', () => {
  const bot = adapter();
  bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:26,value:2}]});
  assert.equal(bot.sleeping,true);
  bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:'player_flags',value:0}]});
  assert.equal(bot.sleeping,false);
  bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:26,value:4}]});
  assert.equal(bot.sleeping,false,'the dead bit does not mean asleep');
});

test('player sleep wins over generic resting flags in either packet order', () => {
  for(const reversed of [false,true]) {
    const bot=adapter();
    const metadata=[{key:'flags',value:{resting:false}},{key:'player_flags',value:2}];
    bot._applyEntityMetadata({runtime_entity_id:7n,metadata:reversed ? metadata.reverse():metadata});
    assert.equal(bot.sleeping,true);
    bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:'flags',value:0n}]});
    assert.equal(bot.sleeping,true,'an unrelated generic flag update cannot wake a sleeping player');
    bot._applyEntityMetadata({runtime_entity_id:42n,metadata:[{key:26,value:0}]});
    assert.equal(bot.sleeping,true,'another player cannot wake the bot');
  }
});

test('sleeping retains the server position without local gravity or queued jumping', () => {
  const bot=adapter();
  let physicsSteps=0;
  bot._physicsStep=()=>{physicsSteps++;bot.position.y+=1;};
  bot._freeJump={queued:true,heldTicks:4};
  bot._velocity={x:1,y:1,z:1};
  bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:26,value:2}]});
  const position={...bot.position};
  bot._driveMotion(100n);
  assert.equal(physicsSteps,0);
  assert.deepEqual(bot.position,position);
  assert.deepEqual(bot._velocity,{x:0,y:0,z:0});
  assert.equal(bot._freeJump,null);
  bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:26,value:0}]});
  bot._driveMotion(101n);
  assert.equal(physicsSteps,1,'normal simulation resumes without catching up asleep ticks');
});

test('a server player sleep flag completes bed use without sending stop_sleeping', async () => {
  const bot=adapter();
  bot._recordTime(18000);
  const writes=[];
  bot.client.write=(name,payload)=>writes.push({name,payload});
  bot.world.blockAt=({y})=>y===62 ? {name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'};
  bot._queueAuthInput=async input=>{
    if(input.transaction)bot._applyEntityMetadata({runtime_entity_id:7n,metadata:[{key:26,value:2}]});
  };
  const result=await bot._trySleepInBed({position:{x:0,y:63,z:2}},{confirmMs:30});
  assert.equal(result.ok,true);
  assert.equal(result.slept,'player_sleep_flag');
  assert.equal(bot.sleeping,true);
  assert.deepEqual(writes.filter(x=>x.name==='player_action').map(x=>x.payload.action),['start_sleeping']);
});
