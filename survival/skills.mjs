// Libreria delle skill gameplay: file JSON dichiarativi sotto skills/gameplay/.
//
// Queste skill NON sono le skill di Hermes Agent (skills/minecraft-bounded-agent/
// SKILL.md). Sono contratti deterministici: precondizioni, criteri di successo,
// intenti preferiti. Nessuna contiene codice eseguibile generato da un modello.
//
// Una skill dichiara:
//   id, description          obbligatori
//   category                 bootstrap | survival | progression (informativo)
//   preconditions            criteri valutati sull'osservazione corrente
//   success / failure        criteri per il verifier (survival/verify.mjs)
//   intents                  vocabolario di survival/intents.mjs
//   planTargets              {item: minCount} suggeriti per il plan del harness
//   allowDeath               se true, morire non fallisce la skill (default false)

import { readFileSync, readdirSync } from 'node:fs';
import { INTENTS } from './intents.mjs';
import { validateCriteria } from './verify.mjs';

export function validateSkill (def, where = 'skill') {
  const errors = [];
  if (!def || typeof def !== 'object') return [`${where}: not an object`];
  if (typeof def.id !== 'string' || !def.id) errors.push(`${where}: missing id`);
  if (typeof def.description !== 'string' || !def.description) errors.push(`${where}: missing description`);
  if (def.category != null && typeof def.category !== 'string') errors.push(`${where}: category must be a string`);
  if (def.intents != null) {
    if (!Array.isArray(def.intents)) errors.push(`${where}: intents must be an array`);
    else for (const intent of def.intents) {
      if (!INTENTS.includes(intent)) errors.push(`${where}: unknown intent "${intent}"`);
    }
  }
  if (def.planTargets != null) {
    if (typeof def.planTargets !== 'object' || Array.isArray(def.planTargets)) errors.push(`${where}: planTargets must be an object`);
    else for (const [item, count] of Object.entries(def.planTargets)) {
      if (typeof count !== 'number' || count <= 0) errors.push(`${where}: planTargets.${item} must be a positive number`);
    }
  }
  errors.push(...validateCriteria(def.preconditions, `${where}.preconditions`));
  errors.push(...validateCriteria(def.success, `${where}.success`));
  errors.push(...validateCriteria(def.failure, `${where}.failure`));
  return errors;
}

function collectJsonFiles (dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(entry.name, dir);
    if (entry.isDirectory()) files.push(...collectJsonFiles(new URL(`${entry.name}/`, dir)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files.sort((a, b) => a.href.localeCompare(b.href));
}

// Carica e valida tutte le skill gameplay. Restituisce una Map id -> skill con
// ordine deterministico. Lancia un errore con l'elenco dei problemi trovati.
export function loadGameplaySkills (root = new URL('../skills/gameplay/', import.meta.url)) {
  const skills = new Map();
  const errors = [];
  for (const file of collectJsonFiles(root)) {
    let def;
    try {
      def = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${file.href}: invalid JSON (${error.message})`);
      continue;
    }
    const fileErrors = validateSkill(def, file.href.replace(/^.*\/skills\/gameplay\//, ''));
    errors.push(...fileErrors.map(message => `${file.href}: ${message}`));
    if (fileErrors.length) continue;
    if (skills.has(def.id)) {
      errors.push(`${file.href}: duplicate skill id "${def.id}"`);
      continue;
    }
    skills.set(def.id, def);
  }
  if (errors.length) throw new Error(`invalid gameplay skills:\n${errors.join('\n')}`);
  return skills;
}

export function skillById (skills, id) {
  if (!skills) return null;
  if (skills instanceof Map) return skills.get(id) || null;
  return skills[id] || null;
}
