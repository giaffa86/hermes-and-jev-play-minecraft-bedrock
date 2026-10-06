// Integration tests for the goal stack: a human order that lands while another
// goal is running suspends it instead of reorienting it, and the session loop
// unwinds the stack when the child closes (resuming the parent, or closing it
// when the world already satisfies it). Same mechanics as the emergency preempt
// (`SUSPENDED -> PENDING`), same store, no parallel bookkeeping.
//
// Six cases (roadmap: suspension/resume of goals):
//   1. autonomous A -> human B -> B done -> resume A
//   2. autonomous A -> human B -> B failed -> resume A
//   3. autonomous A -> human B -> emergency -> resume B -> B done -> resume A
//   4. a suspended goal already satisfied when resumed (closed, not re-run)
//   5. two different humans sending consecutive orders (each gets its own outcome)
//   6. controller restart with suspended goals
// plus the boundary of the delegation rule: a second order from the *same*
// requester revises the running goal (one outcome, no child).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI: prints the next scripted line. A line that contains an
// option key is a *decision* (`hermesDecide` matches the key in the output), a
// JSON line is a plan. Every output is appended to a log so a test can count
// the model calls.
function fakeHermesQueue (outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const queuePath = join(dir, 'queue.json');
  const popPath = join(dir, 'pop.mjs');
  writeFileSync(queuePath, JSON.stringify(outputs));
  writeFileSync(popPath, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(queuePath)};
const queue = JSON.parse(readFileSync(path, 'utf8'));
const next = queue.shift() ?? 'wait';
writeFileSync(path, JSON.stringify(queue));
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(next) + '\\n');
process.stdout.write(next);
`);
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(popPath)}\n`);
  chmodSync(bin, 0o755);
  return {
    dir,
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// Pre-seed a goal store as a previous session would have left it. Unlike the
// session smoke test this accepts the whole goal record (type, source,
// parentGoal, plan) so a test can script a real stack.
function seedGoals (runId, goals) {
  const dir = join(ROOT, 'runs', runId, 'goals');
  mkdirSync(dir, { recursive: true });
  const records = goals.map(g => ({
    id: g.id, kind: 'goal', status: g.status,
    goal: {
      id: g.id,
      type: g.type ?? 'chat',
      source: g.source ?? 'chat',
      priority: g.priority ?? (g.source === 'autonomous' ? 20 : 80),
      status: g.status,
      objective: g.objective,
      plan: g.plan ?? null,
      parameters: g.parameters ?? null,
      parentGoal: g.parentGoal ?? null,
      attempts: g.attempts ?? 1,
      createdAt: g.createdAt ?? 1,
      startedAt: g.startedAt ?? 1,
      finishedAt: null,
      reason: g.reason ?? null,
      result: null,
    },
  }));
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ version: 2, savedAt: Date.now(), records }));
  return dir;
}

// Scripted harness for the goal stack. The world evolves with the actions
// (`dig_down` fills the inventory with dirt, `drop_item` empties one piece at a
// time, `collect_drop` moves the named drops into the inventory, `recover_loot`
// clears the death site) and every chat message is injected either always
// (`afterActs: 0`, the default) or from the Nth action on, so a test can script
// an order that lands *while* a goal is running.
function startStackHarness ({ chats = [], inventory = {}, drops = [], onAct = null } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    const state = {
      inventory: { ...inventory },
      ground: drops.map((item, index) => {
        const drop = typeof item === 'string' ? { item } : item;
        return { id: `d${index}`, item: drop.item, count: drop.count ?? 1, position: { x: 2, y: 63, z: 0 } };
      }),
      deathSite: null,
    };
    const injected = chats.map((chat, index) => ({ ...chat, at: Date.now() + index, xuid: `xuid-${index}`, afterActs: chat.afterActs ?? 0 }));
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { ...state.inventory },
      health: 20, food: 20, dead: false, spawned: true,
      self: { username: 'hermes-bot', name: null },
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], humans: [], containers: [],
      drops: state.ground, dropped: state.ground,
      deathSite: state.deathSite,
      plan: null,
      chat: injected
        .filter(chat => acts >= chat.afterActs)
        .map(({ from, message, type = 'chat', xuid, at }) => ({ from, message, type, xuid, at })),
    });
    const options = () => {
      if (state.deathSite) return [{ key: 'recover_loot', description: 'Recover the dropped items at the death site' }];
      const offered = [];
      if (state.ground.length) offered.push({ key: 'collect_drop', description: 'Collect a dropped item from the ground' });
      if (Object.values(state.inventory).some(count => Number(count) > 0)) offered.push({ key: 'drop_item', description: 'Drop an item from the inventory' });
      offered.push({ key: 'dig_down', description: 'Dig down for dirt' });
      offered.push({ key: 'wait', description: 'Wait' });
      return offered;
    };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); return; }
        if (path === '/options') { res.end(JSON.stringify({ options: options() })); return; }
        if (path === '/act') {
          const key = payload.key;
          acts += 1;
          if (key === 'dig_down') state.inventory.dirt = Number(state.inventory.dirt || 0) + 1;
          else if (key === 'drop_item') {
            const name = Object.keys(state.inventory).find(item => Number(state.inventory[item]) > 0);
            if (name) state.inventory[name] = Number(state.inventory[name]) - 1;
          } else if (key === 'collect_drop') {
            // Un drop alla volta, come l'harness vero: un ordine "cattura X"
            // non deve raccogliere anche gli oggetti di un ordine successivo.
            const drop = state.ground.shift();
            if (drop) state.inventory[drop.item] = Number(state.inventory[drop.item] || 0) + Number(drop.count || 1);
          } else if (key === 'recover_loot') state.deathSite = null;
          if (onAct) onAct(key, state, acts);
          res.end(JSON.stringify({ ok: true, ms: 1 }));
          return;
        }
        if (path === '/say') { res.end(JSON.stringify({ ok: true, sent: payload.message })); return; }
        if (path === '/plan') { res.end(JSON.stringify({ ok: true })); return; }
        if (path === '/mission') { res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type } })); return; }
        if (path === '/mission/finish') { res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } })); return; }
        if (path === '/mission/action' || path === '/mission/link') { res.end(JSON.stringify({ ok: true, id: 'x1' })); return; }
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      calls,
      state,
      acts: () => acts,
      observes: () => observes,
    }));
  });
}

function runController (env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['controller.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 25000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  RESUME: 'on',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '600',
  AUTONOMY: 'off',
  VILLAGE_WORK: 'off',
  EMERGENCY: 'off',
  MAX_STEPS: '6',
  TARGETS: '{}',
  WAYPOINT: '',
  REPLAN_EVERY: '20',
  ANTI_LOOP_THRESHOLD: '10',
  CHAT_ALLOWLIST: 'Ale,Bea',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_NARRATE: 'off',
  GOAL_CONTRACT: '',
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

function saysOf (harness) {
  return harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
}

function actsOf (harness) {
  return harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
}

function savedGoals (runId) {
  const file = join(ROOT, 'runs', runId, 'goals', 'world.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(saved.records.map(record => [record.id, record]));
}

// A: an autonomous goal still to be done (3 dirt), so the parent is never
// satisfied by the human order and the resume really re-runs it.
const AUTO_DIRT = {
  id: 'g1', status: 'pending', type: 'autonomous', source: 'autonomous', priority: 20,
  objective: 'dig 3 dirt',
  plan: { objective: 'dig 3 dirt', targets: { dirt: 3 }, waypoint: null },
};

test('case 1: a human order suspends the autonomous goal and the resume re-runs it', async () => {
  const harness = await startStackHarness({
    chats: [{ from: 'Ale', message: '@bot cattura i diamanti' }],
    inventory: { dirt: 0 },
    drops: ['diamond'],
  });
  const fake = fakeHermesQueue(['dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-resume-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [AUTO_DIRT]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /HUMAN ORDER Ale: suspend g1 -> run g2/, stdout);
    assert.match(stdout, /GOAL g2 COMPLETED/, stdout);
    assert.match(stdout, /RESUME g1 \(suspended while g2 ran\)/, stdout);
    assert.match(stdout, /GOAL g1 COMPLETED/, stdout);

    // L'ordine umano ha lavorato per primo, poi il goal sospeso ha ripreso il
    // suo piano dall'inizio (3 scavi), non un'azione a metà.
    assert.deepEqual(actsOf(harness), ['collect_drop', 'dig_down', 'dig_down', 'dig_down']);

    // Un goal autonomo non parla in chat: solo l'ack e l'esito dell'ordine.
    const says = saysOf(harness);
    assert.equal(says.length, 2, `expected ack + outcome, got ${JSON.stringify(says)}`);
    assert.match(says[0], /^@Ale ok: /);
    assert.match(says[1], /^@Ale fatto: /);

    const events = readEvents(runId);
    const preempt = events.find(e => e.type === 'human_preempt');
    assert.equal(preempt?.parentGoalId, 'g1');
    assert.equal(preempt?.goalId, 'g2');
    assert.equal(preempt?.from, 'Ale');
    assert.ok(events.some(e => e.type === 'goal_resumed' && e.goalId === 'g1' && e.after === 'g2'), JSON.stringify(events));

    const goals = savedGoals(runId);
    assert.equal(goals.g1.status, 'completed');
    assert.equal(goals.g2.status, 'completed');
    assert.equal(goals.g2.goal.source, 'chat');
    assert.equal(goals.g2.goal.parentGoal, 'g1');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('case 2: a failed human order still resumes the suspended parent', async () => {
  const harness = await startStackHarness({
    chats: [{ from: 'Ale', message: '@bot cattura i diamanti' }],
    inventory: { dirt: 0 },
    drops: [], // nessun diamante a terra: l'ordine non puo' riuscire
  });
  const fake = fakeHermesQueue(['dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-failed-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [AUTO_DIRT]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /COLLECT ORDER: nessun oggetto a terra/, stdout);
    assert.match(stdout, /HUMAN ORDER Ale: suspend g1 -> run g2/, stdout);
    assert.match(stdout, /RESUME g1 \(suspended while g2 ran\)/, stdout);
    assert.match(stdout, /GOAL g1 COMPLETED/, stdout);
    assert.equal(actsOf(harness).includes('collect_drop'), false, 'nessuna azione su un ordine impossibile');

    const events = readEvents(runId);
    const end = events.find(e => e.type === 'goal_end' && e.status === 'failed');
    assert.equal(end?.reason, 'no_matching_drop', JSON.stringify(events));
    assert.ok(events.some(e => e.type === 'goal_resumed' && e.goalId === 'g1'), JSON.stringify(events));

    const says = saysOf(harness);
    assert.match(says[0], /^@Ale ok: /);
    assert.ok(says.some(m => /non vedo diamanti a terra/.test(m)), `manca il rifiuto: ${JSON.stringify(says)}`);
    // L'esito e' un fallimento, mai un "fatto".
    assert.equal(says.some(m => /^@Ale fatto: /.test(m)), false, JSON.stringify(says));
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('case 3: an emergency during the human order resumes it, then resumes the parent', async () => {
  // Il bot muore mentre esegue l'ordine (il sito di morte nasce sul primo drop).
  const harness = await startStackHarness({
    chats: [{ from: 'Ale', message: '@bot getta 3 diamanti' }],
    inventory: { dirt: 0, diamond: 3 },
    onAct: (key, state) => {
      if (key === 'drop_item' && !state.deathSite && !state.deathHappened) {
        state.deathHappened = true;
        state.deathSite = { position: { x: 0, y: 64, z: 0 }, at: Date.now() };
      }
    },
  });
  const fake = fakeHermesQueue(['recover_loot', 'dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-emergency-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [AUTO_DIRT]);
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), EMERGENCY: 'on' });
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /HUMAN ORDER Ale: suspend g1 -> run g2/, stdout);
    assert.match(stdout, /EMERGENCY PLAYER_DIED: suspend g2 -> run g3/, stdout);
    assert.match(stdout, /RESUME g2 \(suspended while g3 ran\)/, stdout);
    assert.match(stdout, /RESUME g1 \(suspended while g2 ran\)/, stdout);
    assert.equal((stdout.match(/GOAL g\d+ COMPLETED/g) ?? []).length, 3, stdout);

    // drop (l'ordine B) -> recover (emergenza) -> drop x2 (B riprende) -> dig x3 (A riprende)
    assert.deepEqual(actsOf(harness), ['drop_item', 'recover_loot', 'drop_item', 'drop_item', 'dig_down', 'dig_down', 'dig_down']);

    const goals = savedGoals(runId);
    assert.equal(goals.g3.goal.source, 'emergency');
    assert.equal(goals.g3.goal.parentGoal, 'g2');
    assert.equal(goals.g2.goal.parentGoal, 'g1');
    for (const id of ['g1', 'g2', 'g3']) assert.equal(goals[id].status, 'completed', `g${id} not completed`);

    // L'ordine di Ale riprende e chiude: l'esito e' il suo, non quello dell'emergenza.
    const says = saysOf(harness);
    assert.equal(says.filter(m => /^@Ale /.test(m)).length, 2, JSON.stringify(says));
    assert.match(says[1], /^@Ale fatto: /);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('case 4: a suspended goal already satisfied while suspended is closed, not re-run', async () => {
  const harness = await startStackHarness({
    chats: [{ from: 'Ale', message: '@bot cattura i diamanti' }],
    inventory: { dirt: 0 },
    drops: [{ item: 'diamond', count: 2 }],
  });
  const fake = fakeHermesQueue([]);
  const runId = `test-goal-stack-satisfied-${process.pid}-${Date.now()}`;
  try {
    // A vuole 2 diamanti: l'ordine di Ale ne raccoglie 2, quindi mentre A e'
    // sospeso il suo criterio si avvera e la ripresa non deve rieseguirlo.
    seedGoals(runId, [{ ...AUTO_DIRT, objective: 'get 2 diamonds', plan: { objective: 'get 2 diamonds', targets: { diamond: 2 }, waypoint: null } }]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /GOAL g2 COMPLETED/, stdout);
    assert.match(stdout, /GOAL g1 COMPLETED \(already satisfied while suspended\)/, stdout);
    assert.equal(/RESUME g1/.test(stdout), false, "un goal gia' soddisfatto non si riprende");
    assert.deepEqual(actsOf(harness), ['collect_drop'], 'solo la raccolta: nessun passo per A');
    assert.equal(fake.calls().length, 0, 'nessuna chiamata al modello: il resume non riscrive il piano');

    const events = readEvents(runId);
    const satisfied = events.find(e => e.type === 'goal_resume_satisfied');
    assert.equal(satisfied?.goalId, 'g1');
    assert.equal(satisfied?.after, 'g2');
    assert.equal(satisfied?.steps, 0);

    const goals = savedGoals(runId);
    assert.equal(goals.g1.status, 'completed');
    assert.equal(goals.g2.status, 'completed');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('case 5: two different humans get their own outcome, even with nested orders', async () => {
  const harness = await startStackHarness({
    chats: [
      { from: 'Ale', message: '@bot cattura i diamanti' },
      { from: 'Bea', message: '@bot cattura il ferro', afterActs: 2 },
    ],
    inventory: { dirt: 0 },
    drops: ['diamond', 'iron_ingot'],
  });
  const fake = fakeHermesQueue(['dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-two-humans-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [AUTO_DIRT]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /HUMAN ORDER Ale: suspend g1 -> run g2/, stdout);
    assert.match(stdout, /HUMAN ORDER Bea: suspend g1 -> run g3/, stdout);
    assert.match(stdout, /RESUME g1 \(suspended while g2 ran\)/, stdout);
    assert.match(stdout, /GOAL g1 COMPLETED/, stdout);

    const says = saysOf(harness);
    const toAle = says.filter(m => m.startsWith('@Ale'));
    const toBea = says.filter(m => m.startsWith('@Bea'));
    assert.equal(toAle.length, 2, JSON.stringify(says));
    assert.equal(toBea.length, 2, JSON.stringify(says));
    // Il bug del mittente: l'esito del secondo umano non deve finire al primo.
    assert.ok(toAle.every(m => /diamant/.test(m)), `Ale deve ricevere solo il suo ordine: ${JSON.stringify(toAle)}`);
    assert.ok(toBea.every(m => /ferro/.test(m)), `Bea deve ricevere solo il suo ordine: ${JSON.stringify(toBea)}`);
    assert.match(toBea[1], /^@Bea fatto: /);

    const goals = savedGoals(runId);
    assert.equal(goals.g2.goal.parentGoal, 'g1');
    assert.equal(goals.g3.goal.parentGoal, 'g1');
    assert.equal(goals.g2.goal.parameters.from, 'Ale');
    assert.equal(goals.g3.goal.parameters.from, 'Bea');
    for (const id of ['g1', 'g2', 'g3']) assert.equal(goals[id].status, 'completed', `g${id} not completed`);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('case 6: a restart resumes the suspended goals and runs the child before the parent', async () => {
  const harness = await startStackHarness({
    inventory: { dirt: 0 },
    drops: ['diamond'],
  });
  const fake = fakeHermesQueue(['dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-restart-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [
      { id: 'g1', status: 'suspended', type: 'autonomous', source: 'autonomous', objective: 'dig 3 dirt', plan: { objective: 'dig 3 dirt', targets: { dirt: 3 }, waypoint: null }, reason: 'human_order:Ale' },
      {
        id: 'g2', status: 'suspended', type: 'chat', source: 'chat', parentGoal: 'g1', objective: 'take the diamonds',
        plan: { objective: 'take the diamonds', targets: {}, waypoint: null, collect: { token: 'diamond', word: 'diamanti', items: ['diamond'], beforeTotal: 0 } },
        parameters: { from: 'Ale', message: '@bot cattura i diamanti' }, reason: 'session restarted',
      },
    ]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /RESUME 2 goal\(s\) from a previous session/, stdout);
    // Il figlio (priorita' chat) precede il padre: e' lo stesso ordine della pila.
    assert.ok(stdout.indexOf('GOAL g2 COMPLETED') >= 0 && stdout.indexOf('GOAL g2 COMPLETED') < stdout.indexOf('GOAL g1 COMPLETED'), stdout);

    const goals = savedGoals(runId);
    assert.equal(goals.g1.status, 'completed');
    assert.equal(goals.g2.status, 'completed');
    assert.equal(goals.g2.goal.parentGoal, 'g1', 'il legame padre/figlio sopravvive al restart');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a second order from the same requester revises the goal instead of nesting', async () => {
  const harness = await startStackHarness({
    chats: [
      { from: 'Ale', message: '@bot getta 3 diamanti' },
      { from: 'Ale', message: '@bot getta 2 diamanti', afterActs: 1 },
    ],
    inventory: { dirt: 0, diamond: 3 },
  });
  const fake = fakeHermesQueue(['dig_down', 'dig_down', 'dig_down']);
  const runId = `test-goal-stack-revision-${process.pid}-${Date.now()}`;
  try {
    seedGoals(runId, [AUTO_DIRT]);
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);

    assert.match(stdout, /HUMAN ORDER Ale: suspend g1 -> run g2/, stdout);
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'human_preempt' && e.from === 'Ale' && e.parentGoalId === 'g2'), false,
      'un secondo ordine dello stesso umano non annida un goal');
    const orders = events.filter(e => e.type === 'human_order' && e.from === 'Ale');
    // Il primo ordine ha *sospeso* g1 (nessun `human_order`: e' un goal figlio),
    // il secondo ha riorientato g2: una sola revisione, nessun nuovo goal.
    assert.equal(orders.length, 1, JSON.stringify(events));
    assert.equal(events.filter(e => e.type === 'goal_start').length, 3, 'g1, g2 e la ripresa di g1');

    // Un solo esito per Ale (due ack, un esito) e nessun goal figlio.
    const says = saysOf(harness);
    assert.equal(says.filter(m => /^@Ale ok: /.test(m)).length, 2, JSON.stringify(says));
    assert.equal(says.filter(m => /^@Ale fatto: /.test(m)).length, 1, JSON.stringify(says));

    const goals = savedGoals(runId);
    assert.equal(goals.g2.status, 'completed');
    assert.equal(goals.g2.goal.parentGoal, 'g1');
    assert.equal(goals.g1.status, 'completed');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
