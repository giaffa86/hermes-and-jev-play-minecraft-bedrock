Analizza il repository `hermes-and-jev-play-minecraft-bedrock` e prepara un file `ROADMAP.md` per il refactoring del percorso di reasoning introdotto dalla parola chiave:

```text
ragiona
```

L'obiettivo è trasformare `ragiona` da semplice bypass del routing legacy basato su regex/regole in un vero layer di planning semantico capace di tradurre una richiesta umana in un **programma di alto livello composto da 1..N capability tipizzate**, validate tramite MCP e poi eseguite deterministicamente da Jev.

Non implementare codice.

Crea esclusivamente:

```text
ROADMAP.md
```

Prima studia il repository reale e basa tutte le decisioni sull'architettura esistente.

---

# 1. Context

Nel sistema attuale esiste o è in corso di implementazione un percorso deterministico che interpreta richieste umane tramite meccanismi come:

```text
regex
keyword matching
hardcoded routing rules
command patterns
```

Flusso concettuale:

```text
Human command
     ↓
legacy deterministic router
(regex / rules)
     ↓
existing action / mission
     ↓
Jev deterministic execution
     ↓
bedrockflayer
```

Parallelamente è in corso l'introduzione della parola chiave:

```text
ragiona
```

che permette di bypassare quel routing semantico legacy e consegnare la richiesta a Hermes/LLM.

Esempio:

```text
ragiona preparati per andare nel Nether
```

`ragiona` NON deve trasformare l'esecuzione in un processo non deterministico.

Deve cambiare solamente il modo in cui viene deciso **cosa fare**.

L'esecuzione fisica deve continuare a passare attraverso Jev e Bedrockflayer.

---

# 2. Core architectural principle

La nuova architettura deve separare chiaramente quattro responsabilità.

```text
Hermes
  = reasoning + planning

MCP
  = capability contracts + schemas + validation + discovery

Jev
  = deterministic missions + bounded execution

bedrockflayer
  = Minecraft Bedrock actuation
```

Formula:

```text
Human language
      ↓
Hermes planner/compiler
      ↓
Capability Plan / IR
      ↓
MCP validation
      ↓
Jev deterministic runtime
      ↓
bounded actions
      ↓
bedrockflayer
```

Principio fondamentale:

```text
MCP tool      = semantic capability
Plan          = ordered program of capability invocations
Jev mission   = deterministic implementation of one capability
Jev action    = bounded atomic operation
bedrockflayer = actuator
```

---

# 3. `ragiona` must behave like a compiler/interpreter

Il modello mentale principale della roadmap deve essere quello di un compilatore.

Una richiesta umana è equivalente a source code:

```text
ragiona preparati per andare nel Nether
```

Hermes deve effettuare:

```text
interpretation
semantic analysis
goal decomposition
planning
capability selection
```

e produrre una rappresentazione intermedia strutturata.

Analogia:

```text
Minecraft architecture       Compiler analogy

Human request                Source code
Hermes reasoning             Parser + semantic analysis
Capability Plan              Intermediate Representation
MCP schema                   Type system / ABI
Capability registry          Symbol table
Mission mapping              Linking
Jev                          Runtime / VM
/options                     Valid instructions
/act                         Instruction execution
bedrockflayer                Hardware
world observation            Runtime state
```

Questa analogia deve essere usata nella roadmap per chiarire i boundary architetturali.

---

# 4. Important: `ragiona` can produce N chained steps

NON progettare `ragiona` come semplice intent classifier:

```text
text
→ one action
```

Deve essere possibile produrre:

```text
text
→ goal
→ 1..N semantic steps
```

Esempio:

```text
ragiona preparati per andare nel Nether
```

può produrre:

```text
1. ensure_item(food, 32)
2. ensure_item(iron_pickaxe, 1)
3. ensure_item(flint_and_steel, 1)
4. ensure_item(obsidian, 10)
5. choose_portal_site()
6. build_nether_portal(...)
7. ignite_portal(...)
```

Oppure, se il goal include anche l'ingresso:

```text
8. enter_dimension(nether)
```

Hermes decide:

```text
WHAT sequence achieves the goal?
```

Jev decide:

```text
HOW is each step executed safely and deterministically?
```

---

# 5. Capability Plan / Intermediate Representation

Valuta esplicitamente l'introduzione di una IR, ad esempio:

```text
CapabilityPlan
```

con struttura concettuale:

```text
Plan
 ├─ goal
 ├─ context
 ├─ steps[]
 └─ metadata
```

Ogni step dovrebbe poter rappresentare almeno:

```text
id
capability
arguments
dependencies
preconditions
postconditions
failure policy
status
result
```

Esempio concettuale:

```json
{
  "goal": "prepare_for_nether",
  "steps": [
    {
      "id": "s1",
      "capability": "acquire_item",
      "args": {
        "item": "food",
        "quantity": 32
      }
    },
    {
      "id": "s2",
      "capability": "acquire_item",
      "args": {
        "item": "flint_and_steel",
        "quantity": 1
      }
    },
    {
      "id": "s3",
      "capability": "acquire_item",
      "args": {
        "item": "obsidian",
        "quantity": 10
      }
    },
    {
      "id": "s4",
      "capability": "build_nether_portal",
      "args": {}
    }
  ]
}
```

Non vincolarti a questo formato se il repository suggerisce un modello migliore.

---

# 6. Start with ordered steps, not a complex workflow engine

Per la prima versione preferire:

```text
Goal
→ ordered Step[]
→ execute one step
→ verify
→ next step
```

Non introdurre prematuramente:

```text
general DAG engine
parallel planner
workflow language
complex graph scheduler
```

Tuttavia il modello dati dovrebbe possibilmente non impedire in futuro:

```text
dependencies
branching
replanning
parallelizable steps
```

---

# 7. Semantic capabilities, not low-level actions

Le capability MCP devono essere high-level.

Esempi:

```text
acquire_item
retrieve_items
deposit_items
craft_item
explore_area
find_resource
fight_entity
tame_entity
farm_crop
trade_with_villager
ride_entity
eat
prepare_for_goal
build_structure
enter_dimension
```

NON esporre normalmente a Hermes primitive come:

```text
walk_forward
turn
look_at
break_block
attack_once
select_slot
press_button
open_inventory
pickup
```

Queste rimangono action Jev interne.

Principio:

```text
Hermes emits domain operations
Jev emits Minecraft operations
```

---

# 8. Semantic contracts

Ogni MCP capability deve funzionare come un contratto semantico.

Ogni capability deve definire almeno:

```text
name
description
intent
input schema
preconditions
postconditions
possible failures
mission mapping
required facts
runtime observations
idempotency semantics
```

Le descrizioni devono aiutare Hermes a distinguere capability vicine.

Esempio:

```text
acquire_item

Use when the desired final state is possession of an item.

May resolve internally to:
- retrieval
- crafting
- mining
- harvesting
- looting
- trading
- another deterministic acquisition strategy

Do not use when the explicit user intent is to move already-owned items into storage.
```

---

# 9. Think in desired world state

Il routing semanticamente corretto non deve basarsi principalmente sulle parole usate.

Deve ragionare sullo stato finale desiderato.

Esempi:

```text
"Mi servono 20 lingotti di ferro"
→ ensure/acquire iron_ingot >= 20

"Prendi il ferro dal baule"
→ retrieve_items

"Metti il ferro nel baule"
→ deposit_items

"Fammi una spada di ferro"
→ craft_item / acquire_item derived

"Preparati per il Nether"
→ composite plan

"Trova del ferro"
→ find_resource / explore

"Portami del ferro"
→ acquire + possibly deliver
```

La roadmap deve definire come disambiguare richieste semanticamente simili.

---

# 10. Ensure-state vs delta-based vs command-like

Per ogni capability deve essere definita la semantica.

Possibili categorie:

```text
ensure-state
delta-based
command-like
```

Esempio:

```text
acquire_item(iron_ingot, 20)
```

potrebbe voler dire:

```text
ensure inventory contains >= 20 iron_ingot
```

e non necessariamente:

```text
collect 20 additional iron_ingot
```

La roadmap deve decidere esplicitamente quale semantica usare.

Preferire dove possibile capability idempotenti e state-oriented.

---

# 11. Dynamic execution and verification

Il piano NON deve essere eseguito alla cieca.

Flusso preferito:

```text
compile high-level plan
      ↓
step 1
      ↓
check precondition
      ↓
execute
      ↓
verify postcondition
      ↓
step 2
      ↓
...
```

Se una postcondition è già soddisfatta:

```text
skip step
```

Esempio:

```text
ensure iron_ingot >= 2
```

Se l'inventario ne contiene già 2:

```text
step satisfied
→ no execution needed
```

---

# 12. Structured replanning

Il sistema deve prevedere failures strutturati.

Esempio:

```text
acquire_item(iron_ingot, 2)
```

può fallire con:

```text
RESOURCE_LOCATION_UNKNOWN
```

Jev non deve improvvisare arbitrariamente.

Deve restituire un risultato strutturato.

Esempio:

```json
{
  "status": "blocked",
  "reason": "RESOURCE_LOCATION_UNKNOWN",
  "recoverable": true
}
```

Hermes può quindi effettuare replanning.

Prima:

```text
1 acquire iron
2 craft sword
```

Dopo failure:

```text
1a find/explore iron
1b acquire iron
2  craft sword
```

Il reasoning può quindi avvenire in due momenti:

```text
initial planning
runtime replanning
```

---

# 13. Replanning must remain bounded

Hermes può modificare il piano restante.

NON può:

```text
take direct control
call /act
call bedrockflayer
invent low-level actions
```

Ogni nuovo step generato deve comunque essere una capability registrata e validata.

Flusso:

```text
structured failure
      ↓
Hermes re-evaluates remaining plan
      ↓
new typed capability steps
      ↓
MCP validation
      ↓
Jev
```

---

# 14. Legacy routing and `ragiona` coexistence

Durante il refactoring devono esistere due percorsi.

## Legacy

```text
human command
      ↓
regex/rules
      ↓
mission
      ↓
Jev
```

## Reasoning

```text
ragiona <request>
      ↓
Hermes
      ↓
Capability Plan
      ↓
MCP
      ↓
mission(s)
      ↓
Jev
```

Entrambi devono convergere il prima possibile.

Target ideale:

```text
legacy router ────────────────┐
                              ↓
                        MissionRequest
                              ↓
                             Jev
                              ↑
ragiona → Hermes → MCP ───────┘
```

La roadmap deve individuare concretamente nel repository quale oggetto/boundary può rappresentare questa convergenza.

---

# 15. `ragiona` is not an execution mode

Non deve esistere:

```text
legacy mode = deterministic
ragiona mode = LLM execution
```

Deve esistere:

```text
legacy mode
  deterministic semantic routing

ragiona mode
  semantic planning through Hermes

both
  deterministic execution through Jev
```

`ragiona` decide diversamente **cosa fare**.

Non cambia **come viene eseguito**.

---

# 16. Inspect current `ragiona` implementation

Prima di progettare MCP individua nel repository:

```text
where `ragiona` is detected
how the prefix is removed
how regex routing is bypassed
what receives the remaining text
how Hermes is invoked
what Hermes currently returns
whether it returns free-form text
whether it names actions
whether it names missions
whether it creates goals
how validation currently works
how execution begins
how errors are propagated
how human preemption works
```

Documenta il flusso reale nel `ROADMAP.md`.

---

# 17. MCP as semantic ABI

MCP deve essere trattato come una sorta di ABI/type system tra planner e runtime.

Hermes deve conoscere solamente capability realmente disponibili.

MCP deve fornire:

```text
tool discovery
schema
parameter validation
semantic descriptions
structured errors
structured results
```

Hermes NON deve mantenere una lista duplicata delle capability dentro un prompt hardcoded.

---

# 18. Capability Registry

Valuta fortemente una source-of-truth unica, ad esempio:

```text
CapabilityRegistry
```

che contenga:

```text
name
description
schema
mission handler
supported domain
required facts
preconditions
postconditions
error types
version
status
```

Il registry dovrebbe idealmente alimentare:

```text
MCP tools
documentation
validation
mission dispatch
testing
capability discovery
```

Evitare duplicazione tra:

```text
Hermes prompt
MCP schemas
Jev registry
docs
tests
```

---

# 19. Compile vs execute

Definisci un boundary chiaro:

```text
compile phase
```

responsabile di:

```text
understand goal
decompose
select capability
resolve known symbolic references
validate types
build plan
```

e:

```text
runtime phase
```

responsabile di:

```text
check world state
check preconditions
choose bounded action
execute
retry if allowed
verify
return result
```

Hermes non deve effettuare runtime mechanics.

Jev non deve effettuare semantic interpretation di linguaggio naturale.

---

# 20. Symbolic references

Il planner può produrre riferimenti simbolici.

Esempio:

```text
container="base_chest"
resource="nearest_known_iron"
location="portal_site"
```

Valuta dove devono essere risolti.

Non costringere Hermes a inventare coordinate.

Preferire:

```text
semantic reference
→ memory resolution
→ runtime verification
```

rispetto a:

```text
LLM guessed x/y/z
```

---

# 21. World memory integration

Integra il planning con la world memory esistente.

Considera esplicitamente provenance come:

```text
observed
told
```

e qualsiasi altra provenance già implementata.

Esempio:

```text
"Il ferro è nel baule della miniera"
```

può diventare knowledge:

```text
source=told
```

Hermes può usarla durante il planning.

Ma Jev deve verificare runtime quando necessario.

Principio:

```text
memory informs planning
runtime observation establishes execution truth
```

---

# 22. Told facts are not absolute truth

Un fatto detto dall'utente può essere:

```text
stale
wrong
changed
incomplete
```

La roadmap deve stabilire:

```text
when a told fact is trusted for planning
when it must be verified
how verification updates memory
how contradictions are recorded
```

---

# 23. Goal stack

Il nuovo planner deve integrarsi col goal stack esistente.

Una richiesta:

```text
ragiona vai a prendere del ferro
```

ricevuta durante un altro goal deve poter diventare:

```text
parent goal
   ↓ suspend
child human_preempt goal
   ↓
CapabilityPlan
   ↓
execute
   ↓
verify
   ↓
resume parent
```

MCP non deve bypassare il goal stack.

---

# 24. Composite goals

Distingui:

```text
primitive domain capability
composite capability
plan
mission
action
```

Esempio:

```text
prepare_for_nether
```

potrebbe essere:

```text
composite capability
```

oppure potrebbe essere direttamente un goal che Hermes compila in:

```text
acquire_item
acquire_item
build_portal
...
```

La roadmap deve valutare quale delle due soluzioni produce meno duplicazione.

Evita di codificare sia in Hermes sia in Jev la stessa decomposizione.

---

# 25. Capability granularity

Studia attentamente il livello corretto.

Troppo basso:

```text
move
look
attack
break
```

Troppo alto:

```text
beat_minecraft
become_ready_for_everything
```

Target:

```text
stable reusable domain operations
```

come:

```text
acquire_item
store_item
craft_item
find_resource
fight_entity
farm_crop
tame_entity
travel_to
build_known_structure
```

---

# 26. Reference Java/Mineflayer projects

Studia come reference architetturale:

```text
gerred/mcpmc
yuniko-software/minecraft-mcp-server
egkristi/minecraft-mcp-server
risnake/minecraft-mcp-server
TBrantl/minecraft-mcp-bot
PrismarineJS/mineflayer ecosystem
```

Non sono target tecnologici.

Sono reference per:

```text
MCP tool design
tool naming
schemas
semantic descriptions
navigation abstractions
inventory abstractions
crafting
combat
farming
world inspection
structured results
error handling
```

Sono Java Edition / Mineflayer.

Questo progetto rimane:

```text
Minecraft Bedrock
Hermes
Jev
bedrockflayer
```

---

# 27. Reference analysis format

Nel `ROADMAP.md`, per ogni progetto reference includi:

```text
Reference
Useful pattern
Why useful
What not to copy
Equivalent in our architecture
```

Esempio:

```text
Reference:
minecraft MCP X

Useful:
typed navigation capability

Do not copy:
LLM directly controls Mineflayer

Equivalent here:
MCP capability
→ Jev mission
→ bounded actions
```

---

# 28. Capability coverage audit

Analizza il repository attuale e costruisci una matrice:

| Human intent | Capability | Existing mission | Actions | Status |
|---|---|---|---|---|
| get item | acquire_item | ? | ? | existing/partial/missing |
| retrieve | retrieve_items | ? | ? | ... |
| deposit | deposit_items | ? | ? | ... |
| craft | craft_item | ? | ? | ... |
| explore | explore_area | ? | ? | ... |
| combat | fight_entity | ? | ? | ... |
| tame | tame_entity | ? | ? | ... |
| farm | farm_crop | ? | ? | ... |
| trade | trade_with_villager | ? | ? | ... |
| ride | ride_entity | ? | ? | ... |
| eat | eat | ? | ? | ... |

Non assumere che esistano.

Marca:

```text
existing
partial
missing
needs refactor
```

---

# 29. Mission compilation

Ogni capability deve compilare verso una missione deterministica.

Esempio:

```text
acquire_item(oak_planks, 20)
```

potrebbe produrre:

```text
check inventory
resolve recipe
resolve missing ingredients
acquire oak_log
craft planks
verify inventory
```

Ma questa procedura deve appartenere a Jev/mission layer, non al reasoning LLM.

---

# 30. Recursive capability planning

Valuta attentamente dove permettere ricorsione.

Esempio:

```text
acquire_item(iron_sword)
```

richiede:

```text
iron_ingot
stick
```

Possibili modelli:

### A

Hermes espande tutto:

```text
acquire iron
acquire stick
craft sword
```

### B

Hermes emette:

```text
acquire_item(iron_sword)
```

e Jev risolve deterministicamente le dipendenze.

### C

Hybrid:

```text
Hermes decomposes semantic goals
Jev resolves deterministic crafting prerequisites
```

La roadmap deve scegliere il boundary più robusto.

Preferire che Hermes non replichi recipe logic o dependency logic che può essere deterministica.

---

# 31. Keep deterministic knowledge deterministic

Regola importante:

Se qualcosa può essere determinato senza reasoning LLM, dovrebbe probabilmente stare sotto Hermes.

Esempi:

```text
crafting recipe
tool requirements
item stack size
known block properties
inventory count
reachable path
combat cooldown
container slots
```

Hermes deve ragionare dove esiste vera ambiguità o composizione strategica.

---

# 32. Plan validation

Prima di eseguire un piano verifica:

```text
all capability names exist
all arguments validate
dependencies reference valid steps
no forbidden low-level capability exists
goal is representable
required capabilities are supported
```

Un piano invalido non deve arrivare a Jev.

---

# 33. Partial plan execution

Definisci cosa succede se:

```text
step 1 success
step 2 success
step 3 fail
```

Il sistema deve mantenere:

```text
completed steps
current step
remaining steps
world changes
facts learned
failure reason
```

Hermes deve poter ripianificare solo il resto.

---

# 34. Plan persistence

Valuta se `CapabilityPlan` deve essere persistito nel run ledger.

Se sì, registra almeno:

```text
planId
goalId
original human request
steps
current step
step status
revisions
results
```

---

# 35. Plan revision

Una modifica causata da replanning dovrebbe produrre:

```text
plan revision 1
plan revision 2
...
```

Non sovrascrivere necessariamente il piano originale.

Questo rende auditabile:

```text
what Hermes planned
what failed
why it replanned
what changed
```

---

# 36. Structured step result

Definisci uno schema uniforme.

Esempio:

```json
{
  "stepId": "s3",
  "capability": "acquire_item",
  "status": "success",
  "effects": {
    "inventoryBefore": 4,
    "inventoryAfter": 20
  },
  "verified": true,
  "factsLearned": []
}
```

Fallimento:

```json
{
  "stepId": "s3",
  "status": "blocked",
  "reason": "RESOURCE_LOCATION_UNKNOWN",
  "recoverable": true
}
```

---

# 37. Error taxonomy

Valuta almeno:

```text
INVALID_ARGUMENT
UNSUPPORTED_CAPABILITY
PRECONDITION_FAILED
TARGET_UNKNOWN
TARGET_UNREACHABLE
RESOURCE_LOCATION_UNKNOWN
MISSING_TOOL
MISSING_PREREQUISITE
INSUFFICIENT_RESOURCES
WORLD_STATE_CHANGED
ACTION_NOT_AVAILABLE
MISSION_ABORTED
VERIFICATION_FAILED
HUMAN_PREEMPT
PLAN_INVALID
PLAN_BLOCKED
```

Riutilizza errori esistenti se presenti.

---

# 38. Failure policy per step

Ogni step può avere policy come:

```text
abort
retry
skip
replan
ask-human
```

Non permettere a Hermes di decidere queste policy in modo completamente arbitrario se possono essere definite semanticamente dalla capability.

---

# 39. Bounded execution

MCP non deve chiamare `/act` direttamente.

Percorso:

```text
Capability Plan
      ↓
step
      ↓
Jev mission
      ↓
available bounded options
      ↓
deterministic action selection
      ↓
/act
```

Se il codice reale differisce, identifica il punto equivalente.

---

# 40. `/options` remains authoritative

Se una missione vuole eseguire un'azione non disponibile:

```text
ACTION_NOT_AVAILABLE
```

Non permettere fallback come:

```text
Hermes invents an alternative raw action
```

L'alternativa deve essere:

```text
mission handles it
or
structured failure
or
replan at capability level
```

---

# 41. Observability

Deve essere possibile ricostruire:

```text
human request
ragiona detection
Hermes plan
selected capabilities
arguments
plan revisions
MCP validation
goal
mission
actions
verification
failure
replanning
final result
```

Non è necessario salvare chain-of-thought.

Salvare solamente decisioni strutturate.

---

# 42. Structured reasoning trace

Persisti dati come:

```text
interpreted_goal
selected_capability
plan_steps
dependencies
reason category
revision cause
structured failure
```

NON:

```text
private chain-of-thought
free-form hidden reasoning
```

---

# 43. MCP transport

Valuta:

```text
stdio
Streamable HTTP
```

in funzione dell'architettura reale.

Se Hermes/Pi è locale e MCP può essere locale:

```text
prefer minimal infrastructure
```

Non aggiungere networking inutile.

---

# 44. First vertical slice

Il primo slice MCP deve partire da `ragiona`.

Preferibilmente:

```text
ragiona procurami N item X
```

Flusso completo:

```text
ragiona detected
→ legacy router bypassed
→ Hermes interprets goal
→ creates one-step CapabilityPlan
→ MCP validates acquire_item
→ mission created
→ Jev bounded execution
→ verify inventory
→ structured result
```

Questo dimostra tutta la pipeline senza introdurre subito multi-step complexity.

---

# 45. Second vertical slice

Poi introdurre un vero piano multi-step.

Esempio:

```text
ragiona costruisci una spada di ferro
```

Possibile plan:

```text
1 ensure iron
2 ensure stick
3 craft sword
```

Oppure una singola capability composta se il boundary deterministico suggerisce quella soluzione.

Il test deve dimostrare concatenazione e verification.

---

# 46. Third vertical slice

Poi testare replanning.

Esempio:

```text
ragiona costruisci una spada di ferro
```

Plan:

```text
1 acquire iron
2 acquire stick
3 craft sword
```

Step 1:

```text
RESOURCE_LOCATION_UNKNOWN
```

Expected:

```text
structured failure
→ Hermes replans
→ add exploration/find-resource step
→ resume plan
```

---

# 47. Golden scenarios

Prevedi:

```text
single-step acquire
multi-step crafting
already satisfied precondition
retrieve from container
deposit to container
unknown container
unknown resource
missing tool
tool craftable
tool not craftable
combat
farming
taming
trading
ride
prepare for Nether
human preemption
resume parent
told fact valid
told fact stale
world state changes
step fails
plan replans
replan impossible
unsupported intent
ambiguous human intent
```

---

# 48. Intent → Plan tests

Esempio:

```text
ragiona mi servono 20 lingotti di ferro
```

Expected:

```text
goal:
inventory iron_ingot >= 20
```

Plan:

```text
acquire_item(...)
```

NON:

```text
break_block
walk
mine_at_coordinates
```

---

# 49. Multi-step compilation test

Input:

```text
ragiona preparati per il Nether
```

Expected:

```text
CapabilityPlan.steps.length > 1
```

Ogni step deve essere:

```text
registered
typed
validated
```

---

# 50. Capability → mission test

Ogni capability deve mappare a una missione reale.

Test:

```text
capability exists
handler exists
schema matches
mission exists
postcondition can be verified
```

---

# 51. Mission → action test

Una missione può eseguire solo azioni consentite dalla pipeline bounded.

---

# 52. Replanning test

Forza:

```text
RESOURCE_LOCATION_UNKNOWN
```

Expected:

```text
plan becomes blocked
structured result returned
Hermes receives only structured state
new plan revision created
remaining steps updated
completed steps preserved
```

---

# 53. Human preemption test

Durante un piano lungo:

```text
parent plan executing
```

arriva:

```text
ragiona torna alla base
```

Expected:

```text
parent suspended
child goal created
child plan executed
child verified
parent resumed
```

---

# 54. Migration phases

Definisci almeno queste fasi.

## Phase A — Stabilize `ragiona`

Completare:

```text
ragiona detection
legacy bypass
Hermes invocation
structured response boundary
```

Se già in corso, considerarla precondition.

---

## Phase B — Capability model

Introdurre:

```text
Capability
CapabilityRegistry
schemas
mission mapping
```

senza ancora multi-step planning complesso.

---

## Phase C — MCP single-step

Implementare:

```text
ragiona
→ one capability
→ MCP
→ Jev
```

---

## Phase D — CapabilityPlan IR

Introdurre:

```text
Plan
Step[]
execution state
verification
```

---

## Phase E — Multi-step execution

Supportare:

```text
1..N sequential steps
```

---

## Phase F — Structured replanning

Supportare:

```text
blocked step
→ structured feedback
→ plan revision
```

---

## Phase G — Composite goals

Supportare goal come:

```text
prepare_for_nether
prepare_for_combat
establish_food_supply
```

senza introdurre procedure LLM low-level.

---

## Phase H — Hardening

Aggiungere:

```text
observability
regression
golden scenarios
failure recovery
memory verification
```

---

# 55. Java/Mineflayer references

Per ogni reference Java/Mineflayer identifica:

```text
useful tool abstractions
useful schemas
bad low-level exposure
possible capability names
result/error patterns
```

Ma non sostituire Jev con Mineflayer.

---

# 56. Critical design questions

Il `ROADMAP.md` deve rispondere esplicitamente:

### Q1

Qual è il punto corretto di convergenza tra:

```text
legacy router
ragiona planner
```

?

### Q2

Qual è la granularità corretta delle capability?

### Q3

Quali dipendenze vanno risolte da Hermes e quali deterministicamente da Jev?

### Q4

Quando usare:

```text
single capability
```

e quando:

```text
multi-step plan
```

?

### Q5

Chi possiede recipe resolution?

### Q6

Chi possiede tool selection?

### Q7

Chi possiede resource-location strategy?

### Q8

Come viene verificato ogni step?

### Q9

Come vengono gestiti stale facts?

### Q10

Come avviene replanning senza dare a Hermes accesso diretto alle primitive?

---

# 57. Core invariant

Mantieni sempre:

```text
Hermes owns:
- interpretation
- semantic reasoning
- high-level decomposition
- capability selection
- plan revision

MCP owns:
- capability contracts
- schemas
- discovery
- validation
- dispatch metadata

Jev owns:
- deterministic mission logic
- preconditions
- recipe/tool/runtime mechanics where deterministic
- bounded action selection
- retries
- verification

bedrockflayer owns:
- protocol interaction
- movement execution
- block interaction
- entity interaction
- inventory interaction
```

Se il repository reale suggerisce boundary migliori, proponili.

---

# 58. Security / architecture invariants

Devono valere sempre:

```text
Hermes never calls bedrockflayer directly
Hermes never calls /act directly
MCP never bypasses Jev
MCP does not become a second executor
Jev remains authoritative for bounded actions
world memory does not replace runtime verification
human preempt always goes through goal stack
unsupported capabilities fail structurally
invalid plans do not execute
```

---

# 59. Non-goals

Esplicitare:

```text
replace Jev
replace bedrockflayer
migrate to Java Edition
adopt Mineflayer
remove legacy regex router immediately
expose low-level actions as MCP tools
let the LLM drive the bot step-by-step
duplicate world memory
duplicate goal stack
create a second execution engine
encode crafting recipes in Hermes prompts
translate every legacy regex 1:1 into MCP
make MCP the runtime
```

---

# 60. ROADMAP.md structure

Il documento deve contenere almeno:

```text
1. Executive summary
2. Current architecture
3. Current `ragiona` flow
4. Problem statement
5. Target architecture
6. Compiler/interpreter model
7. Capability Plan / IR
8. MCP semantic capability model
9. Capability taxonomy
10. Capability Registry
11. Legacy vs reasoning routing
12. Plan compilation
13. Plan execution
14. Step verification
15. Structured replanning
16. World memory integration
17. Goal stack / human preemption
18. Error model
19. Result model
20. Observability
21. Java/Mineflayer reference analysis
22. Capability coverage matrix
23. Testing strategy
24. Golden scenarios
25. Migration plan
26. Milestones
27. Files/modules expected to change
28. Risks
29. Non-goals
30. Definition of Done
```

---

# 61. Milestone format

Per ogni milestone indica:

```text
Goal
Why
Existing code involved
Files expected to change
New files
Data structures
API/schema changes
Tests
Acceptance criteria
Dependencies
Risks
```

---

# 62. Suggested milestones

Adatta i nomi al repository reale.

Indicativamente:

```text
M0 — Architecture and `ragiona` inventory

M1 — Capability abstraction and registry

M2 — MCP capability discovery and validation

M3 — First `ragiona` single-capability vertical slice

M4 — CapabilityPlan IR

M5 — Sequential multi-step execution

M6 — Inventory/resource/crafting capability coverage

M7 — Entity/combat/farming capability coverage

M8 — Structured failures and replanning

M9 — World-memory and told/observed integration

M10 — Human preemption and resume

M11 — Observability and plan revision history

M12 — Golden suite and regression hardening
```

---

# 63. Files expected to change

La roadmap deve individuare file reali.

Non inventare nomi se non esistono.

Per ogni file indica:

```text
current responsibility
required change
why
```

Proponi nuovi moduli solo dove necessario.

---

# 64. Avoid parallel architecture

Prima di introdurre:

```text
new planner
new goal engine
new mission registry
new memory
new executor
```

verifica se nel repository esiste già una struttura equivalente.

Preferire estensione alla duplicazione.

---

# 65. Definition of Done

Il refactoring è concluso quando una richiesta come:

```text
ragiona preparati per andare nel Nether
```

può diventare:

```text
Human language
      ↓
Hermes semantic analysis
      ↓
CapabilityPlan
      ↓
1..N typed MCP capability invocations
      ↓
schema validation
      ↓
Jev deterministic missions
      ↓
bounded /options → /act
      ↓
runtime verification after each step
      ↓
structured replanning if required
      ↓
final verified goal state
```

senza che Hermes:

```text
inventi primitive
inventi coordinate senza evidenza
chiami /act
chiami bedrockflayer
replichi recipe logic
replichi pathfinding
replichi mission logic
mantenga una seconda world memory
```

---

# 66. Ultimate architectural target

Il sistema finale deve permettere questa divisione:

```text
Human:
"ragiona costruisci una base sicura per la notte"

Hermes:
understands the high-level objective
decomposes it into semantic capabilities
builds a typed plan

MCP:
ensures every requested capability really exists
validates arguments
provides stable contracts

Jev:
executes each capability deterministically
checks world state
selects valid bounded actions
verifies results

bedrockflayer:
performs Minecraft interactions
```

La vera intelligenza deve stare nella capacità di:

```text
understand
decompose
plan
observe failures
replan
```

senza sacrificare:

```text
determinism
auditability
bounded execution
runtime verification
```

---

# Final instruction

Non limitarti a progettare un "MCP wrapper".

Progetta il refactoring come introduzione di un vero **semantic planning/compiler layer** sopra Jev.

Il risultato desiderato non è:

```text
LLM chooses an action
```

ma:

```text
LLM compiles human intent
into a typed executable plan
whose instructions are deterministic capabilities
implemented by Jev
```

Studia prima il codice reale, confrontalo con i reference Java/Mineflayer e costruisci una roadmap incrementale, implementabile e verificabile.

Non implementare codice.

Crea esclusivamente:

```text
ROADMAP.md
```