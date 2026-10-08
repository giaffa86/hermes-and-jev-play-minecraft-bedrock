// R6 — gli scenari golden: l'ordine e il mondo in ingresso, l'esito atteso in
// tabella.
//
// R1–R5 hanno i loro test di modulo (la forma del piano, la porta, la traccia,
// il rifiuto tipizzato, la catena dei milestone). Questo file congela **la
// decisione osservabile**, cioe' quello che un umano vedrebbe dalla chat: un
// ordine scritto, un mondo scriptato, e quello che il controller vero ne fa sul
// filo — la domanda che fa (o che non fa), il goal che nasce (o non nasce), la
// forma del piano che pubblica, il rifiuto che scrive dentro lo step.
//
// Gli scenari *sono* i test: una riga di `SCENARIOS` = un caso. Se una forma di
// piano regredisce, si rompe qui per prima, e il messaggio d'errore porta
// l'esito completo invece di un solo campo.
//
// Perche' sul filo e non in pura: `humanCommandPlan` vive dentro `controller.mjs`
// (non e' importabile), e l'ordine attraversa cose che solo eseguendo il
// controller si vedono insieme — il marcatore «ragiona» (M11) tolto prima del
// planner, il router delle domande (M6), i fatti dettati (M10), la porta R2 e il
// ciclo dei goal. Il finto `hermes` e' un eseguibile vero che risponde al prompt
// del piano con un JSON e a quello della decisione con una chiave presa da una
// coda: ogni passo e' scriptato, niente e' indovinato.
//
// I due casi negativi della roadmap (C17, C18) stanno qui come *assenza* di
// domanda: «ragiona portami del cibo» non deve chiedere quale cibo, e «metti il
// ferro nel baule» con due bauli non deve chiedere quale baule. La meta'
// deterministica di C18 — il baule che contiene gia' l'item vince sul piu' vicino
// — vive dove vive la politica, in `tests/bedrock-storage.test.mjs` («a chest that
// already holds the item beats a nearer empty one») e non viene duplicata qui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPlanTrace } from '../plan-trace.mjs';
import { CRITERIA_KEYS } from '../survival/verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SENDER_AT = { x: 120, y: 64, z: -230 };

// Il piano che il finto planner restituisce quando la riga non ne dichiara uno:
// un ordine senza meta, senza target e senza follow. E' il piano "vuoto" che
// serve ai casi in cui la decisione non e' il contenuto del piano.
const EMPTY_PLAN = { objective: 'ordine di prova', subgoal: null, targets: {}, waypoint: null, follow: null, notes: 'golden' };

// Il goal che il controller semina all'avvio (`seedInitialGoal`) e' un goal
// **autonomo** senza lavoro dichiarato. Nella base dei golden il seme dichiara un
// target che il mondo scriptato non soddisfa mai: il goal resta aperto mentre
// arriva l'ordine, cosi' il caso e' sempre lo stesso (l'ordine sospende un goal
// in corso) e non dipende da chi vince una corsa fra il primo `goalMet` e la
// lettura dell'inbox. Il waypoint e' dove il bot sta gia': non fa camminare
// nessuno. Un `GOAL_CONTRACT` seminato qui chiuderebbe anche il goal nato
// dall'ordine (e' il limite gia' noto dei test R2), quindi non c'e'.
const SEED_PLAN = { objective: 'nessun lavoro in corso', subgoal: null, targets: { dirt: 99 }, waypoint: { x: 0, z: 0 }, follow: null, notes: 'seme' };

// Finto `hermes` CLI. Un ordine umano fa due domande diverse allo stesso
// eseguibile: il prompt del **piano** («Return ONLY a JSON object …») e quello
// della **decisione** («Reply with ONLY the key …»). Il prompt del piano di un
// **ordine** porta la riga `said: "…"` e riceve il piano della riga; il piano del
// goal seminato (che non ha nessun umano da ascoltare) riceve `startPlan`. E' la
// riga `said:` a distinguerli: senza, ogni riga proverebbe lo stesso piano per il
// seme e per l'ordine. Il prompt della decisione riceve la prossima chiave della
// coda (o il ripiego). Ogni invocazione lascia gli argomenti in `calls.log`: e'
// cosi' che si prova, senza indovinare, che cosa il planner ha visto davvero.
function fakePlanner ({ plan = EMPTY_PLAN, startPlan = SEED_PLAN, keys = [], fallbackKey = 'wait' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-golden-'));
  const logPath = join(dir, 'calls.log');
  const queuePath = join(dir, 'keys.txt');
  writeFileSync(queuePath, keys.length ? `${keys.join('\n')}\n` : '');
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(logPath)}
case "$*" in
  *"Reply with ONLY the key"*)
    if [ -s ${JSON.stringify(queuePath)} ]; then
      KEY=$(sed -n 1p ${JSON.stringify(queuePath)})
      sed -i 1d ${JSON.stringify(queuePath)}
    else
      KEY=${fallbackKey}
    fi
    printf '%s\\n' "$KEY"
    ;;
  *"said:"*)
    printf '%s\\n' ${JSON.stringify(JSON.stringify(plan))}
    ;;
  *)
    printf '%s\\n' ${JSON.stringify(JSON.stringify(startPlan))}
    ;;
esac
`);
  chmodSync(bin, 0o755);
  return { dir, logPath, read: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '') };
}

// Il mondo scriptato: l'osservazione, le opzioni offerte e cosa fa ogni chiave.
// Il `/act` di una chiave puo' dichiarare `gain` (cio' che l'azione raccoglie):
// l'inventario osservato cambia di conseguenza, come se il drop fosse stato
// raccolto davvero.
function startGoldenHarness (row) {
  return new Promise(resolve => {
    const world = row.world ?? {};
    const inventory = { dirt: 1, ...(world.inventory ?? {}) };
    const options = world.options ?? [{ key: 'wait', description: 'Wait' }];
    const scripted = world.acts ?? {};
    const containers = world.containers ?? [];
    const places = world.places ?? [];
    const calls = [];
    const plans = [];
    const planActs = [];
    const acts = [];
    const asks = [];
    const chatAt = Date.now();
    let observes = 0;
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      dimension: 'overworld',
      inventory: { ...inventory },
      health: 20, food: 20, dead: false, spawned: true,
      self: { username: 'hermes-bot', name: null },
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [{ kind: 'player', username: 'Ale', name: 'Ale', position: SENDER_AT }],
      humans: [{ username: 'Ale', name: 'Ale', position: SENDER_AT }],
      dropped: [], containers, ores: [], drops: [],
      chat: [{ from: 'Ale', message: row.order, type: 'chat', xuid: '1234567890', at: chatAt }],
    });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); }
        else if (path === '/options') res.end(JSON.stringify({ options }));
        else if (path === '/act') {
          const key = payload.key;
          acts.push(key);
          const answer = scripted[key] ?? { ok: true, ms: 5 };
          if (answer.gain) for (const [item, count] of Object.entries(answer.gain)) inventory[item] = (inventory[item] ?? 0) + count;
          res.end(JSON.stringify(answer));
        } else if (path === '/plan') { plans.push(payload.plan ?? payload); planActs.push(acts.length); res.end(JSON.stringify({ ok: true })); }
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/chat/ask') { asks.push({ ...payload, plansSoFar: plans.length }); res.end(JSON.stringify({ ok: true, pending: [{ ...payload, askedAt: Date.now() }] })); }
        else if (path === '/chat/pending') res.end(JSON.stringify({ pending: [] }));
        else if (req.method === 'GET' && path === '/memory/places') res.end(JSON.stringify({ places, count: places.length }));
        else if (path.startsWith('/memory/')) res.end(JSON.stringify({ ok: true, hits: [], count: 0 }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_golden', type: payload.type, intent: payload.intent } }));
        else if (path.startsWith('/mission')) res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, plans, planActs, acts, asks, get observes () { return observes; } }));
  });
}

// Quanti atti sono stati eseguiti **dopo** la pubblicazione di un piano. Fermare
// la run appena il piano e' pubblicato la uccide prima che il controller lo
// adotti nella traccia R3, e la traccia scrive solo i segmenti chiusi: il
// segmento dell'ordine mancherebbe e l'asserzione accuserebbe il codice sbagliato.
function actsAfterPlan (h, objective) {
  const i = h.plans.findIndex(p => p.objective === objective);
  return i < 0 ? 0 : h.acts.length - (h.planActs?.[i] ?? 0);
}

// Guida il controller vero. `stopWhen` e' la condizione che dice "lo scenario e'
// finito": appena vera il processo riceve SIGTERM, che il controller tratta come
// una fine normale (`run_end` con `interrupted`, la coda salvata) — cosi' ogni
// riga gira per il tempo che le serve e non per un timeout. Il tetto duro resta
// una rete: se `stopWhen` non arriva mai, il test si rompe invece di appendersi.
function runController (env, { stopWhen = null, maxMs = 20000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['controller.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const poll = stopWhen ? setInterval(() => { if (stopWhen()) child.kill('SIGTERM'); }, 40) : null;
    const hard = setTimeout(() => { child.kill('SIGKILL'); }, maxMs);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code, signal) => { clearInterval(poll); clearTimeout(hard); resolve({ code, signal, stdout, stderr }); });
  });
}

// La base dei test sul controller: canale chat aperto per `Ale`, nessun modello
// di chat, porta R2 accesa e **nessun goal iniziale** — il controller parte in
// IDLE, che e' dove arriva l'ordine: cosi' e' l'ordine a diventare il goal, e
// l'esito che si osserva e' il suo. Un `GOAL_CONTRACT` (o un `TARGETS`) seminato
// qui chiuderebbe subito il goal nato dall'ordine e lo scenario non proverebbe
// niente (e' il limite gia' noto dei test R2).
const baseEnv = (runId, port, plannerDir, extra = {}) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${plannerDir}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '100',
  IDLE_TIMEOUT_MS: '3000',
  AUTONOMY: '',
  MAX_STEPS: '3',
  CHAT_LANG: 'it',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_LLM: 'off',
  CHAT_CLARIFY: 'on',
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  ...extra,
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

const says = harness => harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);

async function withRun (fn) {
  const runId = `test-golden-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try { return await fn(runId); } finally { if (!process.env.KEEP_RUNS) rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true }); }
}

// Gli scenari. Ogni riga dichiara il mondo (`world`), eventuali variabili
// d'ambiente proprie (`env`) e l'esito atteso (`expect`):
//
//   asks        le domande registrate nell'inbox, campo per campo (vuoto = nessuna)
//   goal        true/false: nasce un goal umano? (evento `human_order`)
//   orderPlan   true/false: l'ordine produce un piano deciso? (il piano vive
//               nell'evento `human_order`, shaped: e' la decisione, non il
//               piano del goal seminato all'avvio)
//   noQuestion  true = in chat non compare nessun punto interrogativo
//   firstSay    la prima riga in chat (sempre indirizzata al mittente)
//   sayCount    quante righe in chat (solo dove il numero e' la prova)
//   events      eventi che devono esserci / `notEvents` quelli che non devono
//   promptHas   cosa il planner deve aver visto / `promptHasNot` cosa no
//   shape       la forma del piano pubblicato (subgoal, id dello step, targets, verify)
//   refusal     il rifiuto scritto dentro il passo (`steps[i].refused`)
//   actsFirst   le prime chiavi eseguite / `noRepeat` la chiave mai ripetuta
//   killed      true: la run viene uccisa da un SIGTERM e deve comunque aver
//               scritto `run_end` (con `interrupted`) e la traccia R3
const SCENARIOS = [
  {
    id: 'G1',
    name: 'un ordine di movimento senza meta fa una domanda e non crea nessun goal',
    order: '@bot vai',
    expect: {
      asks: [{ field: 'destination', reason: 'no_destination', originalText: 'vai' }],
      goal: false,
      orderPlan: false,
      noPlanAfterAsk: true,
      noQuestion: false,
      firstSay: /^@Ale /,
      sayCount: 1,
      events: ['chat_command', 'chat_clarify'],
      notEvents: ['human_order', 'human_preempt'],
      promptHas: [/said: "vai"/],
      stopWhen: h => h.asks.length >= 1 && h.observes >= h.asks[0].observedAt + 2,
    },
  },
  {
    id: 'G2',
    name: 'una meta che la memoria conosce non fa chiedere niente, e il piano prende la forma R1',
    order: '@bot vai al rifugio',
    world: {
      places: [{ id: 'landmark_rifugio', label: 'rifugio', position: SENDER_AT, dimension: 'overworld', source: 'told' }],
      // La memoria risponde prima del planner: questo piano non viene mai letto
      // dal controller (lo prova `shape.source: 'deterministic'`), serve solo a
      // tenere la riga completa.
      plan: { objective: 'vado a rifugio', subgoal: null, targets: {}, waypoint: null, follow: null, notes: 'golden' },
    },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      firstSay: /^@Ale /,
      shape: { source: 'deterministic', objective: 'vado a rifugio', subgoal: 'vado a rifugio', stepId: 'vado_a_rifugio', targets: {}, verify: [] },
      stopWhen: h => h.plans.some(p => p.objective === 'vado al rifugio'),
    },
  },
  {
    id: 'G3',
    name: 'un posto che la memoria non conosce fa una domanda sul posto, non sulla meta',
    order: '@bot vai al villaggio',
    expect: {
      asks: [{ field: 'place', reason: 'unknown_place', originalText: 'vai al villaggio', question: /villaggio/ }],
      goal: false,
      orderPlan: false,
      noPlanAfterAsk: true,
      noQuestion: false,
      firstSay: /^@Ale /,
      sayCount: 1,
      events: ['chat_clarify'],
      notEvents: ['human_order', 'human_preempt'],
      stopWhen: h => h.asks.length >= 1 && h.observes >= h.asks[0].observedAt + 2,
    },
  },
  {
    id: 'G4',
    name: 'C17 — «ragiona portami del cibo» non chiede quale cibo, e il marcatore non arriva al planner',
    order: '@bot ragiona portami del cibo',
    world: {
      plan: { objective: 'ti porto qualcosa da mangiare', subgoal: null, targets: {}, waypoint: null, follow: null, notes: 'golden' },
    },
    // `CHAT_REASON` e' l'interruttore del marcatore «ragiona» (senza di lui il
    // marcatore arriva intatto al planner); `CHAT_LLM` resta spento, quindi
    // nessun modello viene chiamato: qui si prova solo che la parola viene tolta.
    env: { MAX_STEPS: '1', CHAT_REASON: 'on' },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      promptHas: [/said: "portami del cibo"\./],
      promptHasNot: [/said: "ragiona/],
      shape: { source: 'hermes', objective: 'ti porto qualcosa da mangiare', subgoal: 'ti porto qualcosa da mangiare', stepId: 'ti_porto_qualcosa_da_mangiare', targets: {}, verify: [] },
      stopWhen: h => actsAfterPlan(h, 'ti porto qualcosa da mangiare') >= 1,
    },
  },
  {
    id: 'G5',
    name: 'C18 — «metti il ferro nel baule» con due bauli non chiede quale baule',
    order: '@bot metti il ferro nel baule',
    world: {
      containers: [
        { type: 'chest', position: { x: 2, y: 64, z: 0 }, contents: {} },
        { type: 'chest', position: { x: 40, y: 64, z: 0 }, contents: { iron_ingot: 12 } },
      ],
      plan: { objective: 'metto il ferro nel baule', subgoal: null, targets: {}, waypoint: null, follow: null, notes: 'golden' },
    },
    env: { MAX_STEPS: '1' },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      promptHas: [/said: "metti il ferro nel baule"/],
      shape: { source: 'hermes', objective: 'metto il ferro nel baule', subgoal: 'metto il ferro nel baule', stepId: 'metto_il_ferro_nel_baule', targets: {}, verify: [] },
      stopWhen: h => actsAfterPlan(h, 'metto il ferro nel baule') >= 1,
    },
  },
  {
    id: 'G6',
    name: 'un ordine di stop non diventa un inseguimento, non fa domande e non porta target',
    order: '@bot fermati',
    world: {
      plan: { objective: 'mi fermo', subgoal: null, targets: { dirt: 1 }, waypoint: { x: 1, z: 2 }, follow: 'Ale', notes: 'naive' },
    },
    env: { MAX_STEPS: '1' },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      events: ['human_order'],
      promptHas: [/said: "fermati"/],
      planFields: { follow: null, waypoint: null, targets: {} },
      stopWhen: h => h.calls.filter(c => c.path === '/say').length >= 2,
    },
  },
  {
    id: 'G7',
    name: 'un approccio bloccato esce dalle opzioni e il rifiuto finisce dentro lo step (R4)',
    order: '@bot mina un diamante',
    world: {
      inventory: { diamond_pickaxe: 1 },
      options: [
        { key: 'mine_diamond_ore', description: 'Mine a visible diamond ore' },
        { key: 'mine_deepslate_diamond_ore', description: 'Mine a visible deepslate diamond ore' },
        { key: 'wait', description: 'Wait' },
      ],
      keys: ['mine_diamond_ore', 'mine_deepslate_diamond_ore'],
      acts: {
        mine_diamond_ore: { ok: false, error: 'no reachable diamond_ore found nearby' },
        mine_deepslate_diamond_ore: { ok: true, ms: 5, gain: { diamond: 1 } },
      },
      plan: { objective: 'mining a diamond', subgoal: null, targets: { diamond: 1 }, waypoint: null, follow: null, notes: 'golden' },
    },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      events: ['step_failed', 'step_switch'],
      promptHas: [/said: "mina un diamante"/],
      actsFirst: ['mine_diamond_ore', 'mine_deepslate_diamond_ore'],
      noRepeat: 'mine_diamond_ore',
      refusal: { key: 'mine_diamond_ore', error: 'no reachable diamond_ore found nearby', kind: 'blocked', retryable: false, alternatives: ['mine_deepslate_diamond_ore'] },
      stopWhen: h => h.acts.length >= 2,
      shape: { source: 'hermes', objective: 'mining a diamond', subgoal: 'mining a diamond', stepId: 'mining_a_diamond', targets: { diamond: 1 }, verify: [] },
    },
  },
  {
    id: 'G8',
    name: 'un ordine ambiguo non sospende il goal in corso: chiede e lascia lavorare',
    order: '@bot vai',
    world: {
      // Qui serve un goal gia' aperto: il seme dichiara un target che il mondo
      // non soddisfa e il contratto chiede 4 dirt mentre l'inventario ne ha 1.
      // L'ordine non ha un piano proprio (il planner restituisce il piano vuoto):
      // e' proprio il caso in cui non c'e' niente da indovinare e si chiede.
      inventory: { dirt: 1 },
    },
    env: { GOAL_CONTRACT: JSON.stringify({ goal: 'stock dirt', success: { inventoryGte: { dirt: 4 } } }), MAX_STEPS: '4' },
    expect: {
      asks: [{ field: 'destination', reason: 'no_destination', originalText: 'vai' }],
      goal: false,
      noQuestion: false,
      firstSay: /^@Ale /,
      sayCount: 1,
      events: ['chat_clarify'],
      notEvents: ['human_order', 'human_order_override', 'human_preempt'],
      askBeforeLastAct: true,
      stopWhen: h => h.asks.length >= 1 && h.acts.length >= 1 && h.observes >= h.asks[0].observedAt + 1,
    },
  },
  {
    id: 'G9',
    name: 'una run uccisa da un segnale lascia comunque il suo ledger (run_end e traccia R3)',
    order: '@bot seguimi',
    world: {
      plan: { objective: 'seguo Ale', subgoal: null, targets: {}, waypoint: null, follow: 'Ale', notes: 'golden' },
    },
    env: { MAX_STEPS: '1' },
    expect: {
      asks: [],
      goal: true,
      orderPlan: true,
      noQuestion: true,
      firstSay: /^@Ale /,
      shape: { source: 'hermes', objective: 'seguo Ale', subgoal: 'seguo Ale', stepId: 'seguo_ale', targets: {}, verify: [] },
      killed: true,
      stopWhen: h => actsAfterPlan(h, 'seguo Ale') >= 1,
    },
  },
];

// L'esito in una riga: e' quello che compare nel messaggio quando uno scenario
// si rompe, cosi' non serve rieseguire per capire che cosa e' cambiato.
function render (o) {
  return JSON.stringify({
    asks: o.asks.map(a => `${a.field}/${a.reason}`),
    says: o.says,
    orderPlan: o.orderPlan ? { objective: o.orderPlan.objective, follow: o.orderPlan.follow ?? null, waypoint: o.orderPlan.waypoint ?? null, targets: o.orderPlan.targets ?? null, subgoal: o.orderPlan.subgoal ?? null, steps: (o.orderPlan.steps ?? []).map(s => `${s.id}:${JSON.stringify(s.targets ?? {})}:${JSON.stringify(s.verify ?? [])}`) } : null,
    orderTrace: o.orderTrace ? { reason: o.orderTrace.reason, source: o.orderTrace.source, objective: o.orderTrace.objective, subgoal: o.orderTrace.subgoal, stepCount: o.orderTrace.stepCount, endedBy: o.orderTrace.endedBy, refusals: o.orderTrace.refusals } : null,
    plans: o.plans.map(p => ({ objective: p.objective, follow: p.follow ?? null, waypoint: p.waypoint ?? null, targets: p.targets ?? null, steps: (p.steps ?? []).map(s => s.id) })),
    acts: o.acts,
    events: o.events.map(e => `${e.type}${e.via ? `:${e.via}` : ''}${e.error ? `:${e.error}` : ''}${e.status ? `:${e.status}` : ''}`),
    calls: o.calls.filter(c => c.path !== '/observe').map(c => c.path),
    code: o.code,
    stderr: o.stderr ? o.stderr.slice(-400) : null,
    prompt: o.prompt ? o.prompt.slice(-500) : null,
  });
}

function checkRow (row, o) {
  const why = () => `scenario ${row.id} (${row.name}) — esito: ${render(o)}`;
  const types = o.events.map(e => e.type);
  // Un ordine accettato diventa un goal in due modi, e in entrambi il piano
  // deciso e' nell'evento: `human_order` quando riorienta il goal in corso o
  // nasce in IDLE, `human_preempt` quando sospende il goal in corso e diventa un
  // goal figlio (il caso normale: l'ordine arriva mentre il bot sta lavorando).
  // Il `plan` dell'evento serve solo per i campi neutralizzati da uno stop: e'
  // l'oggetto condiviso del goal e puo' essere stato mutato dopo la decisione.
  const humanOrders = o.events.filter(e => e.type === 'human_order' || e.type === 'human_preempt');
  o.orderPlan = humanOrders.at(-1)?.plan ?? null;
  // La fonte della decisione e' la traccia R3 (`plan-trace.jsonl`), che timbra
  // `source`/`subgoal`/`steps` dove nascono e sopravvive alla fine della run: il
  // segmento dell'ordine e' quello con l'obbiettivo dell'ordine. Il suo `reason`
  // non e' asserito: dipende da dove arrivava l'ordine (`human_order` se ha
  // riorientato il goal in corso o e' nato in IDLE, `start` se e' diventato un
  // goal figlio) e non e' una proprieta' dell'ordine.
  const seedObjective = row.world?.startPlan?.objective ?? SEED_PLAN.objective;
  const orderObjective = row.world?.plan?.objective ?? EMPTY_PLAN.objective;
  o.orderTrace = row.expect.goal === true ? (o.trace.filter(t => t.objective === orderObjective).at(-1) ?? null) : null;

  if (row.expect.asks) {
    assert.equal(o.asks.length, row.expect.asks.length, `domande registrate (attese ${row.expect.asks.length}) — ${why()}`);
    row.expect.asks.forEach((want, i) => {
      const got = o.asks[i];
      assert.equal(got.field, want.field, `campo della domanda ${i} — ${why()}`);
      assert.equal(got.reason, want.reason, `motivo della domanda ${i} — ${why()}`);
      assert.equal(got.originalText, want.originalText, `ordine originale nella domanda ${i} — ${why()}`);
      assert.equal(got.from, 'Ale', `mittente della domanda ${i} — ${why()}`);
      assert.ok(got.orderId, `la domanda ${i} ha un id — ${why()}`);
      if (want.question) assert.match(got.question, want.question, `testo della domanda ${i} — ${why()}`);
    });
  }
  if (row.expect.goal === true) {
    assert.ok(types.includes('human_order') || types.includes('human_preempt'), `il goal umano nasce — ${why()}`);
    assert.ok(o.orderTrace, `e l'ordine lascia un segmento nella traccia R3 — ${why()}`);
  }
  if (row.expect.goal === false) {
    assert.equal(types.some(t => t === 'human_order' || t === 'human_preempt'), false, `nessun goal umano — ${why()}`);
    assert.equal(o.orderTrace, null, `e nessun segmento dell'ordine nella traccia R3 — ${why()}`);
    // La traccia resta quella del goal seminato: l'ordine non ha ne' creato ne'
    // adottato nessun piano.
    assert.equal(o.trace.every(t => t.objective === seedObjective), true, `la traccia resta quella del goal seminato — ${why()}`);
  }
  if (row.expect.orderPlan === true) assert.ok(o.orderPlan, `l'ordine ha un piano deciso (evento human_order) — ${why()}`);
  if (row.expect.orderPlan === false) assert.equal(o.orderPlan, null, `nessun piano per l'ordine — ${why()}`);
  if (row.expect.noPlanAfterAsk) assert.equal(o.plans.length, (o.asks[0]?.plansSoFar ?? 0), `nessun piano pubblicato dopo la domanda — ${why()}`);
  if (row.expect.events) for (const type of row.expect.events) assert.ok(types.includes(type), `evento ${type} — ${why()}`);
  if (row.expect.notEvents) for (const type of row.expect.notEvents) assert.equal(types.includes(type), false, `evento ${type} non deve esserci — ${why()}`);
  if (row.expect.sayCount != null) assert.equal(o.says.length, row.expect.sayCount, `righe in chat — ${why()}`);
  if (row.expect.firstSay) assert.match(o.says[0] ?? '', row.expect.firstSay, `prima riga in chat — ${why()}`);
  if (row.expect.noQuestion) assert.equal(o.says.some(s => String(s).includes('?')), false, `nessun punto interrogativo in chat — ${why()}`);
  if (row.expect.promptHas) for (const re of row.expect.promptHas) assert.match(o.prompt, re, `il planner deve aver visto ${re} — ${why()}`);
  if (row.expect.promptHasNot) for (const re of row.expect.promptHasNot) assert.doesNotMatch(o.prompt, re, `il planner non deve aver visto ${re} — ${why()}`);
  if (row.expect.actsFirst) assert.deepEqual(o.acts.slice(0, row.expect.actsFirst.length), row.expect.actsFirst, `azioni eseguite — ${why()}`);
  if (row.expect.noRepeat) assert.equal(o.acts.filter(k => k === row.expect.noRepeat).length, 1, `la chiave ${row.expect.noRepeat} non si ripete — ${why()}`);
  if (row.expect.planFields) {
    const plan = o.orderPlan;
    assert.ok(plan, `un piano dell'ordine per leggerne i campi — ${why()}`);
    for (const [field, want] of Object.entries(row.expect.planFields)) {
      assert.deepEqual(plan[field] ?? null, want, `piano.${field} — ${why()}`);
    }
  }
  if (row.expect.shape) {
    const want = row.expect.shape;
    const t = o.orderTrace;
    assert.ok(t, `l'ordine lascia un segmento nella traccia R3 — ${why()}`);
    if (want.source != null) assert.equal(t.source, want.source, `traccia.source — ${why()}`);
    if (want.objective != null) assert.equal(t.objective, want.objective, `traccia.objective — ${why()}`);
    assert.equal(t.subgoal, want.subgoal, `traccia.subgoal — ${why()}`);
    assert.equal(t.stepCount, want.stepCount ?? 1, `traccia.stepCount — ${why()}`);
    assert.equal(t.steps.length, 1, `R1 promuove un livello: un solo step — ${why()}`);
    const step = t.steps[0];
    assert.equal(step.id, want.stepId, `id dello step — ${why()}`);
    assert.deepEqual(step.targets ?? {}, want.targets ?? {}, `targets dello step — ${why()}`);
    assert.deepEqual(step.verify ?? [], want.verify ?? [], `verify dello step — ${why()}`);
    // Il vocabolario dei criteri e' chiuso: una forma di piano non puo' introdurre
    // un nome che il verificatore non conosce.
    for (const s of t.steps) for (const name of s.verify ?? []) assert.ok(CRITERIA_KEYS.includes(name), `criterio noto ${name} — ${why()}`);
  }
  if (row.expect.refusal) {
    const want = row.expect.refusal;
    const failed = o.events.find(e => e.type === 'step_failed');
    assert.ok(failed, `un passo rifiutato — ${why()}`);
    assert.equal(failed.error, want.error, `errore del passo — ${why()}`);
    assert.equal(failed.key, want.key, `chiave rifiutata — ${why()}`);
    assert.equal(failed.kind, want.kind, `tipo del rifiuto — ${why()}`);
    assert.equal(failed.retryable, want.retryable, `ritentabile — ${why()}`);
    assert.equal(failed.disposition, 'switch', `disposizione del rifiuto — ${why()}`);
    // Il piano che porta la revisione, non l'ultimo pubblicato: quando il goal
    // figlio si chiude il controller ripubblica il piano del padre, quindi il
    // piano corretto sta in mezzo alla lista.
    const revised = o.plans.find(p => p.steps?.some(s => s.refused)) ?? o.plans.at(-1);
    const refused = revised?.steps?.find(s => s.refused)?.refused;
    assert.ok(refused, `il rifiuto vive dentro lo step (steps[i].refused) — ${why()}`);
    assert.equal(refused.error, want.error, `errore nel rifiuto dello step — ${why()}`);
    assert.equal(refused.kind, want.kind, `kind nel rifiuto dello step — ${why()}`);
    assert.equal(refused.retryable, want.retryable, `retryable nel rifiuto dello step — ${why()}`);
    if (want.alternatives) assert.deepEqual(refused.alternatives ?? [], want.alternatives, `alternative registrate nello step — ${why()}`);
    // Il rifiuto e' anche un fatto della traccia R3, con il tipo e il passo a cui
    // appartiene: e' cosi' che un rifiuto resta leggibile dopo la fine della run.
    const recorded = o.orderTrace?.refusals?.find(r => r.key === want.key);
    assert.ok(recorded, `il rifiuto e' nella traccia R3 — ${why()}`);
    assert.equal(recorded.kind, want.kind, `kind nella traccia — ${why()}`);
    assert.equal(recorded.retryable, want.retryable, `retryable nella traccia — ${why()}`);
    assert.ok(recorded.stepId, `il rifiuto e' attribuito a uno step — ${why()}`);
  }
  if (row.expect.askBeforeLastAct) {
    const askAt = o.calls.findIndex(c => c.path === '/chat/ask');
    const lastAct = o.calls.map(c => c.path).lastIndexOf('/act');
    assert.ok(askAt >= 0 && lastAct > askAt, `il goal continua a lavorare dopo la domanda — ${why()}`);
  }
  if (row.expect.killed) {
    // Una run uccisa deve comunque raccontarsi: il gestore del segnale scrive
    // `run_end` (`interrupted: true`) e chiude la traccia. Prima del 07/10/2026
    // leggeva due variabili locali di `runGoal` e moriva di ReferenceError, e
    // una run uccisa non lasciava ne' costo ne' traccia.
    const end = o.events.filter(e => e.type === 'run_end').at(-1);
    assert.ok(end, `la run uccisa scrive run_end — ${why()}`);
    assert.equal(end.interrupted, true, `run_end interrotto — ${why()}`);
    assert.ok(end.signal, `il segnale e' registrato — ${why()}`);
    assert.ok(o.orderTrace, `e la traccia R3 resta scritta — ${why()}`);
    assert.equal(o.orderTrace.endedBy, `signal:${end.signal}`, `la traccia nomina il segnale — ${why()}`);
  }
}

for (const row of SCENARIOS) {
  test(`golden ${row.id} — ${row.name}`, async () => {
    const harness = await startGoldenHarness(row);
    const planner = fakePlanner({ plan: row.world?.plan ?? EMPTY_PLAN, startPlan: row.world?.startPlan ?? SEED_PLAN, keys: row.world?.keys ?? [], fallbackKey: row.world?.fallbackKey ?? 'wait' });
    try {
      await withRun(async runId => {
        const stop = row.stopWhen ?? row.expect.stopWhen;
        const run = await runController(baseEnv(runId, harness.port, planner.dir, row.env ?? {}), { stopWhen: stop ? () => stop(harness) : null });
        checkRow(row, {
          code: run.code,
          stdout: run.stdout,
          stderr: run.stderr,
          stderr: run.stderr,
          asks: harness.asks,
          says: says(harness),
          plans: harness.plans,
          acts: harness.acts,
          calls: harness.calls,
          events: readEvents(runId),
          trace: readPlanTrace(join(ROOT, 'runs', runId)) ?? [],
          prompt: planner.read(),
        });
      });
    } finally {
      harness.server.close();
      rmSync(planner.dir, { recursive: true, force: true });
    }
  });
}
