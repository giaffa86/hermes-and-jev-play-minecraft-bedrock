// R7: il contratto di capacita' deve (a) firmare la superficie reale,
// (b) cambiare firma quando la superficie cambia, mai quando cambia l'ora, e
// (c) far **rifiutare** a un consumatore un payload manomesso o di un'altra
// versione invece di fargli credere di aver capito.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CAPABILITY_CONTRACT_KEYS,
  CAPABILITY_CONTRACT_VERSION,
  buildCapabilityContract,
  checkCapabilityContract,
  contractDigest,
} from '../capability-contract.mjs';

function fixture ({ skills = {}, progression = { goals: {}, milestones: {} } }) {
  const root = mkdtempSync(join(tmpdir(), 'capcon-'));
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const [name, def] of Object.entries(skills)) writeFileSync(join(skillsDir, name), JSON.stringify(def));
  const circuitsDir = join(root, 'circuits');
  mkdirSync(circuitsDir, { recursive: true });
  const progressionPath = join(root, 'progression.json');
  writeFileSync(progressionPath, JSON.stringify(progression));
  return { skillsRoot: pathToFileURL(`${skillsDir}/`), circuitsRoot: circuitsDir, progressionPath };
}

const skill = (id, extra = {}) => ({ id, description: `${id} fixture`, intents: [], ...extra });

function kinds (problems) {
  return problems.filter(problem => problem.level === 'error').map(problem => problem.kind).sort();
}

test('the real repository signs a valid contract and the shape is frozen', () => {
  const contract = buildCapabilityContract();

  assert.equal(contract.contractVersion, CAPABILITY_CONTRACT_VERSION);
  assert.equal(contract.valid, true, JSON.stringify(contract.problems, null, 2));
  assert.deepEqual(kinds(contract.problems), []);
  // Forma congelata: una chiave in piu' e' una decisione da prendere (alzare la
  // versione), non un dettaglio da lasciar passare.
  assert.deepEqual(Object.keys(contract).sort(), [...CAPABILITY_CONTRACT_KEYS].sort());
  assert.match(contract.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(contract.counts, {
    intents: contract.intents.length,
    optionKeys: contract.optionVocabulary.keys.length,
    optionPatterns: contract.optionVocabulary.patterns.length,
    skills: contract.skills.length,
    circuits: contract.circuits.length,
    milestones: contract.milestones.length,
    goals: Object.keys(contract.goals).length,
    criteria: contract.criteria.length,
  });
  for (const field of ['intents', 'skills', 'circuits', 'milestones', 'criteria']) {
    assert.ok(contract[field].length > 0, `expected a non-empty ${field}`);
  }
  assert.equal(checkCapabilityContract(contract).ok, true);
});

test('the digest covers the content, not the moment it was read', () => {
  const first = buildCapabilityContract();
  const second = buildCapabilityContract();

  assert.equal(first.contentHash, second.contentHash, 'due letture della stessa superficie firmano uguale');
  assert.notEqual(contractDigest({ ...first, generatedAt: '2026-01-01T00:00:00.000Z' }), null);
  assert.equal(
    contractDigest({ ...first, generatedAt: '2026-01-01T00:00:00.000Z' }),
    first.contentHash,
    'generatedAt resta fuori dal digest',
  );
});

test('a changed surface changes the digest', () => {
  const one = buildCapabilityContract(fixture({ skills: { 'a.json': skill('a') } }));
  const two = buildCapabilityContract(fixture({ skills: { 'a.json': skill('a'), 'b.json': skill('b') } }));

  assert.equal(one.valid, true);
  assert.equal(two.valid, true);
  assert.equal(one.counts.skills, 1);
  assert.equal(two.counts.skills, 2);
  assert.notEqual(one.contentHash, two.contentHash, 'una skill in piu\' cambia la firma');
});

test('a broken link is a typed problem, and the contract says it is not valid', () => {
  const contract = buildCapabilityContract(fixture({
    skills: { 'a.json': skill('a') },
    progression: { goals: { first: 'ghost' }, milestones: { a: { skill: 'missing_skill' } } },
  }));

  assert.equal(contract.valid, false);
  assert.deepEqual(kinds(contract.problems), ['goal_target_missing', 'milestone_skill_missing']);
  const check = checkCapabilityContract(contract);
  assert.equal(check.ok, false, 'un contratto che il produttore stesso dichiara rotto non va usato');
  assert.deepEqual(check.problems.map(problem => problem.kind), ['surface_invalid']);
});

test('a consumer refuses a payload it cannot trust, and never throws', () => {
  const contract = buildCapabilityContract();

  const tampered = structuredClone(contract);
  tampered.skills[0].id = 'not_a_skill';
  const tamperedCheck = checkCapabilityContract(tampered);
  assert.equal(tamperedCheck.ok, false);
  assert.deepEqual(tamperedCheck.problems.map(problem => problem.kind), ['hash_mismatch']);

  const missing = structuredClone(contract);
  delete missing.criteria;
  assert.deepEqual(checkCapabilityContract(missing).problems.map(problem => problem.kind), ['missing_key', 'hash_mismatch']);
  // (il digest usato per il confronto include la chiave tolta: manca anche la firma)

  const extended = structuredClone(contract);
  extended.extraField = 1;
  const extendedCheck = checkCapabilityContract(extended);
  assert.ok(extendedCheck.problems.some(problem => problem.kind === 'unknown_key'));

  const future = structuredClone(contract);
  future.contractVersion = CAPABILITY_CONTRACT_VERSION + 1;
  future.contentHash = contractDigest(future);
  const futureCheck = checkCapabilityContract(future);
  assert.equal(futureCheck.ok, false);
  assert.deepEqual(futureCheck.problems.map(problem => problem.kind), ['version_mismatch']);
  assert.equal(futureCheck.version, CAPABILITY_CONTRACT_VERSION + 1);

  for (const junk of [null, undefined, 'capabilities', 42, {}, []]) {
    const check = checkCapabilityContract(junk);
    assert.equal(check.ok, false, `expected ${JSON.stringify(junk)} to be refused`);
  }
});

test('a consumer that speaks an older version accepts it on purpose', () => {
  const older = buildCapabilityContract();
  older.contractVersion = CAPABILITY_CONTRACT_VERSION - 1;
  older.contentHash = contractDigest(older);

  assert.deepEqual(checkCapabilityContract(older).problems.map(problem => problem.kind), ['version_mismatch']);
  assert.equal(checkCapabilityContract(older, { version: CAPABILITY_CONTRACT_VERSION - 1 }).ok, true,
    'la versione fa parte del digest: chi la dichiara la verifica');
});
