# Survival Intelligence Layer

Layer deterministico di intelligenza tra l'obiettivo utente e le bounded action:
progressione, sopravvivenza, skill dichiarative e verifica. È ispirato ai concetti
di [Voyager](https://github.com/MineDojo/Voyager) (skill library, curriculum,
self-verification, esperienza riusabile) **senza** adottarne il modello di
code-generation: qui nessun modello genera JavaScript eseguibile per il
comportamento Minecraft.

Documenti collegati: [`BEDROCK.md`](../BEDROCK.md) (porting Bedrock), [`README.md`](../README.md),
[`AGENTS.md`](../AGENTS.md) (note per gli agenti).

---

## Architettura

```text
                       USER GOAL (GOAL / CURRICULUM)
                          |
                          v
                +--------------------+
                | Progression Engine |  knowledge/progression.json
                |  survival/progression.mjs
                +---------+----------+
                          |
                    desired milestone
                          |
                          v
                +--------------------+        +------------------------------+
                |  Hermes Planner    |<------>| Skill Library (gameplay)     |
                |    System Two      |        | skills/gameplay/**/*.json    |
                +---------+----------+        +------------------------------+
                          |
                    planned skill (campo opzionale `skill`)
                          |
                          v
OBSERVATION ---> +--------------------+
 (/observe)      | Survival Governor  |  knowledge/survival-rules.json
                 | survival/governor  |
                 +---------+----------+
                           |
                     safe objective
                           |
                           v
                 +--------------------+
                 |   Skill Resolver   |  survival/resolver.mjs
                 +---------+----------+
                           |
                           v
                    Harness /options      (l'unico proprietario della validità)
                           |
                           v
                         JEV
                     System One
                           |
                       one action
                           |
                           v
                   Bedrock Adapter
                           |
                           v
                      Minecraft
```

Principi invariati:

- **I modelli non controllano la meccanica.** Hermes e Jev non inviano pacchetti,
  non premono tasti, non generano codice eseguito e non bypassano `/options`.
- **Il harness possiede la validità.** Se un'azione non è eseguibile o non è
  utile ora, non viene offerta.
- **Jev resta bounded.** Sceglie esattamente una key tra quelle offerte.
- **Hermes resta milestone-oriented.** Non gira a ogni tick e non memorizza il
  tech tree: la conoscenza deterministica sta nei file di `knowledge/`.
- **Deterministico prima del prompt.** `codice/regole -> stato strutturato
  compatto -> modello`, mai `prompt enorme -> il modello indovina`.

---

## Moduli

| Path | Ruolo |
|---|---|
| `survival/perception.mjs` | Normalizza `/observe` in uno stato di sopravvivenza: vita, fame, fase del giorno, ostili con severità, cibo migliore, letto, arma/piccone, riassunto inventario per tag. |
| `survival/risk.mjs` | Punteggio di rischio 0..100 e livello `none/low/medium/high/critical` con `reasons` espliciti. |
| `survival/needs.mjs` | Bisogni ordinati: `survive, escape, eat, heal, sleep, shelter, obtain_food, obtain_weapon, obtain_armor, replace_tool, continue_progression`. |
| `survival/rules.mjs` | Valutatore esplicito delle regole JSON (vocabolario chiuso e validato al load). |
| `survival/governor.mjs` | Combina perception/risk/needs/regole in `{mode, priority, reasons, needs, overrideObjective, allowedIntents, preferredSkills, risk}`. |
| `survival/intents.mjs` | Vocabolario condiviso degli intenti e mapping key di `/options` → intenti (mai il contrario). |
| `survival/item-tags.mjs` | Tag item (`logs`, `food`, `stone_tools`, ...) usati da verifier e progressione. |
| `survival/skills.mjs` | Loader/validatore delle skill gameplay dichiarative in `skills/gameplay/`. |
| `survival/verify.mjs` | Verifica deterministica: `verifySkill(skill, before, after)` + vocabolario dei criteri. |
| `survival/resolver.mjs` | Skill attiva, filtro di emergenza delle opzioni, intenti preferiti per il ranking. |
| `survival/progression.mjs` | Grafo di progressione, validazione, risoluzione del prossimo prerequisito mancante. |
| `survival/experience.mjs` | Righe JSONL per `runs/<run>/skills.jsonl`. |
| `knowledge/survival-rules.json` | Policy di sopravvivenza deterministica (quando interrompere la progressione). |
| `knowledge/progression.json` | Grafo dei milestone e dipendenze. |
| `skills/gameplay/` | Skill di gioco dichiarative (concetto diverso dalla skill Hermes). |

---

## Contratti HTTP

### `GET /observe`

L'osservazione normalizzata esistente guadagna una sezione compatta:

```json
{
  "health": 4, "food": 3,
  "survival": {
    "mode": "emergency",
    "risk": 100,
    "level": "critical",
    "rule": "low_health_near_hostile",
    "needs": ["survive", "escape", "heal"],
    "reasons": ["critical_health", "food_low", "hostile_critical", "night"],
    "overrideObjective": "Escape immediate danger and recover health before resuming progression."
  }
}
```

Il payload resta piccolo di proposito: è pensato per il planner, non per il debug.

### `GET /options`

Il harness continua a offrire solo azioni valide. In emergenza (`mode:
emergency`) le restringe agli intenti ammessi dal governor (`allowedIntents`).
Il filtro:

- non aggiunge mai key inesistenti;
- non restituisce mai un set vuoto (se non resta nulla di ammesso, torna alle
  opzioni originali e riporta `filterReason: "no_allowed_option"`);
- è l'unico filtro "forte"; il resto è ranking.

La risposta aggiunge metadata (`survival`, `filtered`, `removed`, `filterReason`)
senza rompere il formato `{ options }` usato dal controller.

### `GET /survival` (diagnostica)

Governor completo, skill attiva con provenienza (`plan`, `governor`,
`progression`) e milestone suggerito dal grafo (con `PROGRESSION_GOAL`).

---

## Survival Governor

Output:

```json
{
  "mode": "normal|caution|emergency",
  "priority": 0,
  "reasons": ["food_low"],
  "needs": ["eat", "continue_progression"],
  "overrideObjective": null,
  "allowedIntents": null,
  "preferredSkills": ["eat_available_food"],
  "rule": "low_food",
  "matchedRules": ["low_food", "hungry"],
  "risk": { "level": "low", "score": 18, "threats": [], "reasons": ["food_low"] }
}
```

- `normal`: nessuna regola rilevante, nessuna sovrascrittura.
- `caution` (priorità ≥ 55 o rischio `high`): l'obiettivo mostrato al decision
  model viene sostituito con `overrideObjective`, le opzioni restano tutte.
- `emergency` (priorità ≥ 95 o rischio `critical`): come sopra e in più
  `allowedIntents` restringe `/options`. Morire è un caso speciale: solo `wait`.

**Dove vive la policy deterministica?** In `knowledge/survival-rules.json`, mai
nei prompt. Per aggiungere una policy:

1. scegli le condizioni dal vocabolario (`healthMax`, `foodMax`, `phase`,
   `night`, `bedAvailable`, `hasFood`, `weaponInInventory`, `hostileWithin`,
   `hostileSeverityAtLeast`, `hostileTypeWithin`, `sleeping`, `dead`,
   `lootNearby`, `timeKnown`, `pickaxeInInventory`);
2. assegna `priority` (≥ 95 emergenza, ≥ 55 caution);
3. dichiara `intents` (cosa deve restare possibile), `objective` (frase per il
   decision model) e `preferredSkills` (skill della libreria gameplay, in ordine);
4. aggiungi un test in `tests/survival-governor.test.mjs`. Il loader valida i file
   all'avvio: un refuso in una condizione fallisce subito e con un messaggio chiaro.

---

## Skill gameplay vs skill Hermes Agent

| | Hermes Agent skill | Gameplay skill |
|---|---|---|
| Dove | `skills/minecraft-bounded-agent/SKILL.md` | `skills/gameplay/**/*.json` |
| Cos'è | Istruzioni per una sessione Hermes con tool terminale | Contratto deterministico eseguibile dal controller |
| Chi la usa | Hermes Agent (LLM) | Governor, resolver, verifier, progression engine |
| Contenuto | Markdown discorsivo | JSON validato con criteri e intenti |
| Codice eseguibile | No | No (dichiarativa al 100%) |

### Schema di una gameplay skill

```json
{
  "id": "acquire_wood",
  "description": "Acquire enough logs for early-game crafting.",
  "category": "bootstrap",
  "preconditions": { "inventoryTagGte": { "logs": 0 } },
  "success": { "inventoryTagGte": { "logs": 8 } },
  "failure": null,
  "intents": ["mine", "collect", "travel"],
  "planTargets": { "oak_log": 8 },
  "allowDeath": false
}
```

Intenti ammessi: `escape, fight, eat, heal, sleep, shelter, recover, collect,
travel, mine, craft, smelt, build, wait`.

### Come aggiungere una gameplay skill

1. Crea `skills/gameplay/<categoria>/<id>.json` con `id` e `description`;
2. dichiara `preconditions` e `success` con il vocabolario dei criteri
   (`inventoryGte`, `inventoryTagGte`, `healthAtLeast`, `foodAtLeast`, `phaseIn`,
   `dimension`, `nearbyBlock`, `foodIncreased`, `healthIncreased`,
   `noHostileWithin`, `threatDistanceIncreasedBy`, `nightSurvived`, `allOf`,
   `anyOf`; per i tag vedi `survival/item-tags.mjs`);
3. elenca gli `intents` utili al ranking delle opzioni e, se serve, i
   `planTargets` suggeriti;
4. opzionalmente collega un milestone in `knowledge/progression.json` con
   `"skill": "<id>"`;
5. aggiungi un test in `tests/gameplay-skills.test.mjs`. Il loader valida tutti i
   file all'avvio di harness e controller.

La skill non deve mai dichiarare azioni: quelle restano quelle di `/options`.
`intents` serve solo a ordinare/filtrare ciò che il harness offre già.

---

## Verifica deterministica

`verifySkill(skill, observationBefore, observationAfter)` restituisce:

```json
{ "status": "success", "skill": "acquire_wood", "evidence": { "inventory.logs": 10 }, "reason": null }
```

- `success`: i criteri di `success` sono soddisfatti **dai dati del harness**;
- `failed`: i criteri di `failure` sono soddisfatti oppure il bot è morto
  (`allowDeath` disattiva quest'ultimo controllo);
- `running`: né successo né fallimento.

La verifica non chiede mai a un modello se il task è riuscito. Ogni esito
successo/fallimento finisce in `runs/<run>/skills.jsonl`:

```json
{"t": 1790948940243, "skill": "acquire_wood", "success": true, "status": "success", "actions": 1, "elapsedMs": 20, "failureReason": null, "context": {"milestone": "wood", "evidence": {"inventory.logs": 8}}}
```

Niente embedding o vector database: righe JSON piatte, pronte per una futura
esperienza recuperabile.

---

## Progression Engine

`knowledge/progression.json` rappresenta dipendenze, non una sequenza rigida:

```json
{
  "milestones": {
    "wood": { "requires": [], "skill": "acquire_wood", "satisfiedWhen": { "inventoryTagGte": { "logs": 8 } } },
    "crafting_table": { "requires": ["wood"], "skill": "acquire_crafting_table" },
    "iron_age": { "requires": ["stone_tools"], "skill": "acquire_iron" },
    "enter_nether": { "requires": ["diamonds"], "skill": "enter_nether" }
  },
  "goals": { "first_night": "first_night", "enter_nether": "enter_nether" }
}
```

`resolveMilestone(graph, {goal, observation, completed})` risponde:

- `{status: "met"}` obiettivo già raggiunto;
- `{status: "next", milestone, skill, missing}` primo milestone non soddisfatto
  con tutti i prerequisiti soddisfatti;
- `{status: "error", reason}` goal/grafo non utilizzabile (in quel caso il
  controller torna a Hermes).

Un milestone è soddisfatto se `completed` (verifica reale già avvenuta) lo
contiene oppure se `satisfiedWhen` è valutabile sull'osservazione corrente.

### Come aggiungere un milestone

1. aggiungi il nodo in `knowledge/progression.json` con `requires`, `skill`,
   `description` e, se è verificabile staticamente, `satisfiedWhen`;
2. crea la gameplay skill corrispondente in `skills/gameplay/`;
3. aggiungi l'alias in `goals` se deve essere usabile come obiettivo;
4. aggiungi un test in `tests/progression.test.mjs`.

---

## Curriculum mode (Phase 10)

Con `CURRICULUM=<milestone>` il controller non chiede a Hermes di ricordare il
tech tree:

```text
overall goal (CURRICULUM)
  -> progression engine: next missing prerequisite
  -> gameplay skill
  -> piano deterministico (objective dal catalogo, planTargets dalla skill)
  -> bounded actions + verifica
  -> milestone completato -> prossimo prerequisito
```

Hermes resta il fallback quando il motore non può decidere (`error`) o quando
l'osservazione è ambigua; i replan periodici/anti-loop in modalità curriculum
ricalcolano il milestone senza ripartire da capo.

Esempio di run della milestone `first_night`:

```bash
CURRICULUM=first_night CONTROLLER=jev RUN_ID=first-night MAX_STEPS=120 node controller.mjs
```

Passi loggati in `runs/<run>/controller.jsonl`: `survival` (cambi di
modalità/regola), `plan`, `replan` (`curriculum`), `skill_success`/`skill_failed`,
`options` (con `skill`, `skillSource`, `preferredIntents`), `decision`, `result`,
`goal_met`.

---

## Prima milestone end-to-end

```text
spawn Survival
  -> wood (acquire_wood)
  -> crafting table (acquire_crafting_table)
  -> stone tools (stone_age)
  -> usable food (obtain_food)
  -> first night (first_night)
```

L'architettura è pronta per girare su spawn diversi senza fornire ogni
obiettivo intermedio: il grafo risolve i prerequisiti e il verifier li conferma
dai dati reali. Le capacità Bedrock esistenti e quelle mancanti sono elencate in
[`BEDROCK.md`](../BEDROCK.md); tra i blocker noti: razioni/hunting per il cibo
oltre alle colture, portale del Nether, stabilità NetherNet nelle fasce critiche.

---

## Test

```bash
node --test tests/survival-governor.test.mjs tests/gameplay-skills.test.mjs tests/progression.test.mjs tests/survival-integration.test.mjs
node --test tests/*.test.mjs   # suite completa
```

Coprono, senza server: classificazione ostili, selezione cibo, calcolo rischio,
bisogni, regole, governor, schema/loader skill, resolver/filtro emergenza,
verifica con evidence, dipendenze di progressione, memoria dei milestone e uno
scenario integrato `progressione -> emergenza -> ripresa`.

Lo smoke test del controller in modalità curriculum usa un harness finto e uno
stub del CLI `hermes`: nessuna chiamata a provider esterni, nessun server
Minecraft (vedi cronologia in `runs/smoke-curriculum/`).

## Stato della verifica (02/10/2026)

- **Unit + integrazione offline**: suite completa verde (204 test: 149
  preesistenti + 55 nuovi).
- **Harness**: avvio offline verificato con endpoint irraggiungibile —
  `GET /observe` espone `survival` compatta, `GET /options` aggiunge i metadata
  del filtro e `GET /survival` risponde.
- **Controller in modalità curriculum**: smoke end-to-end con harness finto e
  stub `hermes` — `wood -> crafting table -> cibo -> first_night` con
  interruzione di emergenza (creeper a 4.2 blocchi, vita 4), opzioni filtrate a
  `[flee, eat]`, ripresa dallo stesso milestone, `GOAL MET after 7 actions` e 4
  record in `runs/smoke-curriculum/skills.jsonl`.
- **Verifica live sul BDS**: non eseguita in questa sessione perché il container
  del bot era connesso e attivo (una sessione concorrente con lo stesso account
  l'avrebbe espulsa). Da riprovare in una finestra libera: `GET /observe`
  reale → `survival`, e un giro `CURRICULUM=first_night` sul mondo.
- **Capacità Bedrock mancanti per la milestone completa**: il cibo oltre le
  colture richiede la catena fornace/fusione (esiste ma va collaudata live);
  mancano azioni di shelter avanzate (costruzione di pareti/rifugi) e il
  supporto al portale del Nether; resta l'instabilità NetherNet documentata in
  `BEDROCK.md`.
