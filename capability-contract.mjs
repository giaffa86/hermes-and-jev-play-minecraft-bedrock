// R7 — il contratto di capacita': la superficie di R0, versionata e verificabile.
//
// R0 (`tools/capability-inventory.mjs`) sa dire cosa il progetto dichiara e se i
// collegamenti fra i file reggono. R7 aggiunge il pezzo che servirebbe a un
// **secondo consumatore**: un contratto versionato, con un digest del contenuto e
// una porta d'ingresso che il consumatore esegue prima di fidarsi
// (`checkCapabilityContract`).
//
// Perche' non MCP e non un registry service (non-goal dichiarati in
// docs/raw/ROADMAP_refactoring_reasoning.md §R7): oggi il consumatore e' uno solo
// (controller + harness, stesso codebase). Il contratto qui e' una **proiezione**
// dei file dichiarativi — derivata, di sola lettura, mai scritta: la fonte di
// verita' resta `knowledge/progression.json`, `skills/gameplay/**` e
// `circuits/*.json` (invariante 6). Il trasporto e' la porta HTTP che il
// controller gia' usa (`GET /capabilities` in `bedrock-harness.mjs`); un servizio
// separato sarebbe una seconda cosa da tenere in vita, non una seconda verita'.
//
// Forma e versione sono congelate: `CAPABILITY_CONTRACT_KEYS` e' l'insieme esatto
// delle chiavi e `CAPABILITY_CONTRACT_VERSION` va alzata quando la forma cambia,
// altrimenti `tests/capability-contract.test.mjs` fallisce. Il digest copre il
// contenuto, non l'istante della lettura (`generatedAt` resta fuori).
//
// Uso (gate offline, senza bot e senza rete):
//   node capability-contract.mjs --summary   # riassunto leggibile
//   node capability-contract.mjs --check     # exit 1 se il contratto non regge

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { buildInventory } from './tools/capability-inventory.mjs';

export const CAPABILITY_CONTRACT_VERSION = 1;

// La forma esatta del contratto. Un campo aggiunto senza alzare la versione e'
// un errore per il consumatore (`unknown_key`), non un'estensione silenziosa.
export const CAPABILITY_CONTRACT_KEYS = [
  'contractVersion',
  'generatedAt',
  'contentHash',
  'valid',
  'problems',
  'counts',
  'intents',
  'optionVocabulary',
  'skills',
  'circuits',
  'milestones',
  'goals',
  'criteria',
];

// JSON canonico (chiavi ordinate): il digest non deve dipendere dall'ordine di
// inserimento, perche' un consumatore lo ricalcola su cio' che ha ricevuto.
function canonical (value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Il digest descrive **cosa** il contratto dichiara: `generatedAt` (quando e'
// stato letto) e `contentHash` (se stesso) restano fuori.
export function contractDigest (payload) {
  const { generatedAt, contentHash, ...rest } = payload ?? {};
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

// Proiezione + verdetto in un oggetto solo: `valid` e `problems` sono il
// risultato dei controlli di R0, `contentHash` e' l'impronta del contenuto.
export function buildCapabilityContract (options = {}) {
  const inventory = buildInventory(options);
  const contract = {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    generatedAt: inventory.generatedAt,
    contentHash: null,
    valid: !inventory.issues.some(issue => issue.level === 'error'),
    problems: inventory.issues,
    counts: {
      intents: inventory.intents.length,
      optionKeys: inventory.optionVocabulary.keys.length,
      optionPatterns: inventory.optionVocabulary.patterns.length,
      skills: inventory.skills.length,
      circuits: inventory.circuits.length,
      milestones: inventory.milestones.length,
      goals: Object.keys(inventory.goals).length,
      criteria: inventory.criteria.length,
    },
    intents: inventory.intents,
    optionVocabulary: inventory.optionVocabulary,
    skills: inventory.skills,
    circuits: inventory.circuits,
    milestones: inventory.milestones,
    goals: inventory.goals,
    criteria: inventory.criteria,
  };
  contract.contentHash = contractDigest(contract);
  return contract;
}

// La porta d'ingresso di un consumatore: non interpreta, **valida**. Non lancia
// mai — un payload incomprensibile e' un problema tipizzato, non un'eccezione.
// `ok` significa «autentico, della versione giusta e dichiarato sano»: un
// contratto che il produttore stesso ha marcato `valid: false` non va usato.
export function checkCapabilityContract (payload, { version = CAPABILITY_CONTRACT_VERSION } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      version: null,
      problems: [{ level: 'error', kind: 'not_an_object', detail: 'the contract must be a JSON object' }],
    };
  }

  const problems = [];
  const missing = CAPABILITY_CONTRACT_KEYS.filter(key => !(key in payload));
  if (missing.length) {
    problems.push({ level: 'error', kind: 'missing_key', detail: `missing key(s): ${missing.join(', ')}` });
  }
  const unknown = Object.keys(payload).filter(key => !CAPABILITY_CONTRACT_KEYS.includes(key));
  if (unknown.length) {
    problems.push({
      level: 'error',
      kind: 'unknown_key',
      detail: `unknown key(s): ${unknown.join(', ')} — bump CAPABILITY_CONTRACT_VERSION instead of extending the shape silently`,
    });
  }
  if (payload.contractVersion !== version) {
    problems.push({
      level: 'error',
      kind: 'version_mismatch',
      detail: `contract is v${payload.contractVersion}, this consumer expects v${version}`,
    });
  }
  if ('contentHash' in payload) {
    const expected = contractDigest(payload);
    if (payload.contentHash !== expected) {
      problems.push({
        level: 'error',
        kind: 'hash_mismatch',
        detail: `contentHash ${String(payload.contentHash).slice(0, 16)}… does not match the payload (${expected.slice(0, 16)}…)`,
      });
    }
  }
  if (payload.valid !== true) {
    const errors = Array.isArray(payload.problems)
      ? payload.problems.filter(problem => problem?.level === 'error').map(problem => problem.kind).join(', ')
      : '';
    problems.push({
      level: 'error',
      kind: 'surface_invalid',
      detail: `the producer reports valid: ${JSON.stringify(payload.valid)}${errors ? ` (${errors})` : ''}`,
    });
  }

  return { ok: problems.length === 0, version: payload.contractVersion ?? null, problems };
}

function main () {
  const args = process.argv.slice(2);
  let contract;
  try {
    contract = buildCapabilityContract();
  } catch (cause) {
    console.error(`capability contract: ${cause.message}`);
    process.exitCode = 1;
    return;
  }
  const check = checkCapabilityContract(contract);

  if (args.includes('--summary')) {
    console.log(`capability contract v${contract.contractVersion} — ${contract.generatedAt}`);
    console.log(`  contentHash     ${contract.contentHash.slice(0, 16)}…`);
    for (const [key, value] of Object.entries(contract.counts)) console.log(`  ${key.padEnd(15)} ${value}`);
    console.log(`  valid           ${contract.valid}`);
    for (const problem of contract.problems) console.log(`    [${problem.level}] ${problem.kind}: ${problem.detail}`);
    if (!check.ok) for (const problem of check.problems) console.log(`    [check] ${problem.kind}: ${problem.detail}`);
  } else {
    process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
  }

  if (args.includes('--check') && !(contract.valid && check.ok)) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || (process.argv[1] && process.argv[1].endsWith('capability-contract.mjs'))) main();
