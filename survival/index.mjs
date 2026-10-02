// Survival Intelligence Layer: API unica per il resto del progetto.
//
// - perception/risk/needs/governor: valutazione deterministica dello stato;
// - rules: knowledge/survival-rules.json;
// - skills/resolver/verify: libreria gameplay dichiarativa e verifica;
// - progression: knowledge/progression.json;
// - experience: statistiche JSONL per skill.
//
// Vedi docs/SURVIVAL-INTELLIGENCE.md per l'architettura e per come estendere
// regole, skill e milestone.

export { perceive, perceiveThreats, threatSeverity, MAX_HEALTH, MAX_FOOD } from './perception.mjs';
export { assessRisk, riskLevelForScore, RISK_LEVELS } from './risk.mjs';
export { deriveNeeds, NEED_PRIORITY, NEEDS } from './needs.mjs';
export { evaluateSurvival, summarizeSurvival, EMERGENCY_PRIORITY, CAUTION_PRIORITY } from './governor.mjs';
export { loadSurvivalRules, evaluateRules, ruleMatches, evaluateCondition, validateRules, CONDITION_KEYS } from './rules.mjs';
export { optionIntents, keyMatchesIntents, intentMatchesKey, INTENTS } from './intents.mjs';
export { ITEM_TAGS, itemMatchesTag, tagCount, tagItems, isKnownTag } from './item-tags.mjs';
export { evaluateCriteria, verifySkill, validateCriteria, CRITERIA_KEYS } from './verify.mjs';
export { loadGameplaySkills, validateSkill, skillById } from './skills.mjs';
export { filterOptionsForGovernor, resolveActiveSkill, skillApplicable, skillPreferredIntents, findOptionForIntents } from './resolver.mjs';
export { loadProgression, validateProgression, resolveMilestone, progressionSnapshot } from './progression.mjs';
export { buildSkillRecord, appendSkillRecord } from './experience.mjs';
