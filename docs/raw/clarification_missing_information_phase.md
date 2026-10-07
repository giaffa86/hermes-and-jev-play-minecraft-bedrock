# Clarification / Missing Information Phase

Prima di emettere un `CapabilityPlan`, Hermes deve determinare se il goal espresso dall'utente è sufficientemente specificato per essere pianificato senza introdurre assunzioni arbitrarie.

Il reasoning non deve essere costretto a produrre immediatamente un piano.

Il risultato della fase di semantic analysis deve poter essere almeno uno dei seguenti:

```text
READY
NEEDS_INPUT
UNSUPPORTED
```

## READY

Usare quando il goal è sufficientemente definito oppure quando le informazioni mancanti possono essere risolte deterministicamente tramite:

```text
explicit user request
current observation
world memory
known facts
deterministic policies/defaults
runtime resolution delegated to Jev
```

Solo in questo stato il sistema deve procedere alla compilazione del `CapabilityPlan`.

```text
REQUEST
   ↓
semantic analysis
   ↓
READY
   ↓
compile CapabilityPlan
   ↓
MCP validation
   ↓
Jev execution
```

---

## NEEDS_INPUT

Usare quando esiste un'ambiguità materiale che non può essere risolta in modo affidabile dal sistema e che cambierebbe significativamente:

```text
goal semantics
target
destination
quantity
constraints
irreversible choices
high-level execution strategy
```

In questo caso Hermes NON deve:

```text
guess
invent coordinates
select an arbitrary target
invent missing constraints
compile a speculative plan
start execution
```

Deve invece produrre una richiesta di chiarimento strutturata.

Esempio:

```json
{
  "status": "needs_input",
  "missing": [
    {
      "field": "destination",
      "reason": "multiple_matching_containers"
    }
  ],
  "question": "In quale baule vuoi mettere il ferro?",
  "options": [
    "base_chest",
    "mine_chest",
    "smelter_chest"
  ]
}
```

La domanda human-facing deve essere breve e chiedere esclusivamente le informazioni realmente necessarie.

---

# Resolve Before Asking

Prima di chiedere ulteriori informazioni all'utente, Hermes deve tentare di risolvere l'ambiguità attraverso le fonti già disponibili.

Ordine concettuale:

```text
1. explicit request
2. current conversational context
3. world memory
4. current observation
5. deterministic policies/defaults
6. runtime-resolvable parameters
7. ask human
```

Non chiedere all'utente informazioni che Jev può determinare deterministicamente durante l'esecuzione.

Esempio:

```text
ragiona portami del cibo
```

non richiede necessariamente:

```text
"Quale cibo?"
```

se esiste una policy deterministica come:

```text
select best suitable known available food
```

Al contrario:

```text
ragiona metti il ferro nel baule
```

con più bauli semanticamente equivalenti e nessun riferimento che permetta di identificarne uno deve produrre `NEEDS_INPUT`.

---

# Clarification Must Preserve the Pending Goal

Una richiesta di chiarimento NON deve creare un nuovo goal indipendente.

Il sistema deve mantenere uno stato di planning pendente.

Esempio:

```text
Human:
ragiona metti il ferro nel baule

Hermes:
NEEDS_INPUT
destination unresolved

Human:
quello della base
```

Il secondo messaggio deve essere interpretato come continuazione del goal pendente:

```text
pending goal
   ↓
merge clarification
   ↓
resume semantic analysis
   ↓
READY
   ↓
compile CapabilityPlan
```

Non deve essere interpretato come una nuova richiesta autonoma.

---

# Suggested Planning State Machine

Valuta l'introduzione esplicita di una state machine equivalente a:

```text
REQUEST_RECEIVED
      ↓
ANALYZING
      ↓
 ┌────┴───────────────┐
 │                    │
READY            NEEDS_INPUT
 │                    │
COMPILE          WAITING_INPUT
 │                    │
 │              INPUT_RECEIVED
 │                    │
 │              RESUME_ANALYSIS
 │                    │
 └──────────────←─────┘
      ↓
VALIDATE
      ↓
EXECUTE
      ↓
VERIFY
```

Prevedere anche:

```text
UNSUPPORTED
```

quando il goal non può essere rappresentato attraverso capability disponibili.

---

# Clarification vs Replanning

La roadmap deve distinguere chiaramente:

```text
clarification
```

da:

```text
replanning
```

## Clarification

Avviene prima dell'esecuzione quando manca informazione semantica necessaria per capire correttamente cosa vuole l'utente.

```text
request
→ ambiguity detected
→ ask human
→ complete intent
→ compile plan
```

## Replanning

Avviene dopo che un piano valido è già stato compilato e l'esecuzione incontra una situazione runtime che richiede una nuova strategia.

```text
valid plan
→ execute
→ structured runtime failure
→ Hermes revises remaining plan
```

Esempio clarification:

```text
"Metti il ferro nel baule"
→ quale baule?
```

Esempio replanning:

```text
acquire_item(iron_ingot, 20)
→ RESOURCE_LOCATION_UNKNOWN
→ add find_resource/explore step
```

Non confondere i due meccanismi.

---

# Clarification Contract

Valuta uno schema strutturato equivalente a:

```text
ClarificationRequest
```

con almeno:

```text
pendingGoalId
status
missingFields
reason
question
knownOptions
context
```

Esempio concettuale:

```json
{
  "pendingGoalId": "goal-123",
  "status": "needs_input",
  "missingFields": ["destination"],
  "reason": "AMBIGUOUS_TARGET",
  "question": "Quale baule vuoi usare?",
  "knownOptions": [
    {
      "id": "base_chest",
      "label": "Baule della base"
    },
    {
      "id": "mine_chest",
      "label": "Baule della miniera"
    }
  ]
}
```

Non vincolarti a questo schema se il repository possiede già un modello adatto.

---

# Do Not Over-Ask

Hermes non deve chiedere conferme inutili.

Una clarification deve essere emessa solo quando l'informazione mancante cambia materialmente il piano.

Non chiedere dettagli relativi a decisioni che appartengono al runtime deterministico.

Esempi di domande normalmente NON necessarie:

```text
quale percorso vuoi seguire?
da quale lato vuoi avvicinarti?
quale slot della hotbar vuoi usare?
con quale orientamento preciso devo guardare il blocco?
```

Queste decisioni appartengono a Jev.

Il principio deve essere:

```text
Human resolves semantic ambiguity.
Jev resolves mechanical ambiguity.
```

---

# Ambiguity Policy

Definisci nella roadmap una policy esplicita per distinguere:

```text
safe deterministic default
```

da:

```text
material semantic ambiguity
```

Il sistema può usare automaticamente un default quando:

```text
the choice is reversible
the outcome remains equivalent to the requested goal
the policy is deterministic
the policy is documented
the choice does not materially surprise the user
```

Deve invece chiedere quando:

```text
multiple materially different targets exist
the requested object cannot be uniquely identified
quantity materially affects execution and cannot be inferred
the operation is irreversible or expensive
different interpretations correspond to different goals
```

---

# Ambiguous Plan Example

Input:

```text
ragiona costruisci una casa
```

Hermes deve valutare quali informazioni sono realmente indispensabili.

Non assumere automaticamente che debba chiedere:

```text
material
exact width
exact height
roof shape
number of windows
door type
orientation
```

La roadmap deve definire se esistono deterministic defaults per alcuni di questi parametri.

Potrebbe ad esempio essere sufficiente chiedere solo:

```text
"Dove vuoi costruirla?"
```

se dimensioni e materiali possono essere scelti tramite una policy conosciuta.

Oppure nessuna domanda, se esiste una capability semanticamente definita:

```text
build_basic_shelter()
```

con contratto deterministico.

---

# Clarification and Symbolic References

Favorire riferimenti semantici invece di coordinate richieste all'utente.

Esempio:

```text
Human:
"nel baule della base"
```

deve poter risolvere:

```text
destination = base_chest
```

attraverso world memory.

Non chiedere:

```text
"Dammi x, y, z"
```

se il sistema può risolvere il riferimento simbolico.

Pattern:

```text
human semantic reference
      ↓
memory/entity resolution
      ↓
symbolic target
      ↓
runtime verification
```

---

# Clarification and `told` Facts

Le risposte dell'utente durante una clarification possono produrre nuovi fatti `told`.

Esempio:

```text
Hermes:
"Dove si trova il baule?"

Human:
"È quello accanto alla fornace della base."
```

Questa informazione può essere registrata come knowledge con provenance appropriata.

Tuttavia:

```text
clarification answer
≠ guaranteed runtime truth
```

Jev deve continuare a verificare ciò che è verificabile durante l'esecuzione.

---

# Clarification and Human Preemption

Se `ragiona` viene invocato mentre esiste un goal attivo e il nuovo goal richiede clarification:

```text
parent goal
   ↓
human_preempt child
   ↓
ANALYZING
   ↓
NEEDS_INPUT
```

la roadmap deve stabilire cosa succede al parent mentre il sistema aspetta risposta.

Preferire una semantica esplicita e testabile.

Possibili strategie da valutare:

```text
parent remains suspended until clarification completes
```

oppure, se compatibile con il goal stack:

```text
pending clarification stored
parent resumes
child restarts when human answers
```

Non assumere una soluzione senza analizzare il comportamento attuale del goal stack.

---

# Clarification Timeout / Abandonment

Valuta cosa succede se una clarification rimane senza risposta.

Il sistema dovrebbe poter rappresentare uno stato come:

```text
WAITING_INPUT
CANCELLED
ABANDONED
```

senza trasformare automaticamente l'ambiguità in una scelta arbitraria.

Non introdurre necessariamente timeout temporali se non necessari all'architettura attuale, ma definire il lifecycle del pending goal.

---

# Tests for Clarification

Aggiungi test almeno per:

```text
clear request → READY without asking

ambiguous destination → NEEDS_INPUT

ambiguous target with known candidates → question includes candidates

missing value resolvable from world memory → no question

missing value resolvable deterministically by Jev → no question

clarification response resumes same pending goal

clarification response updates unresolved field

clarification answer may create told fact

invalid clarification answer keeps goal in NEEDS_INPUT

unsupported request → UNSUPPORTED, not NEEDS_INPUT

no CapabilityPlan executes while required semantic fields are unresolved

no arbitrary target is selected when ambiguity is material

human_preempt + NEEDS_INPUT preserves correct goal-stack semantics
```

---

# Golden Clarification Scenarios

Include at least:

```text
"porta il ferro nel baule" with one known chest
→ READY

"porta il ferro nel baule" with multiple equivalent known chests
→ NEEDS_INPUT

"vai alla base"
with exactly one known base
→ READY

"vai alla base"
with multiple locations identified as bases
→ NEEDS_INPUT

"procurami del cibo"
with deterministic food-selection policy
→ READY

"costruisci qui un rifugio"
with deterministic shelter template
→ READY

"costruisci la casa vicino a quella struttura"
with multiple candidate structures
→ NEEDS_INPUT
```

---

# Updated Compiler Model

Estendi l'analogia del compilatore includendo la risoluzione interattiva dell'ambiguità:

```text
Human request
      ↓
parse
      ↓
semantic analysis
      ↓
resolve symbols / context
      ↓
enough information?
   ┌───────┴────────┐
   │                │
  yes               no
   │                │
   │         clarification request
   │                ↓
   │          human response
   │                ↓
   └──────── resume analysis
      ↓
CapabilityPlan / IR
      ↓
MCP type/schema validation
      ↓
Jev runtime
```

Il planner deve quindi poter sospendere la compilazione prima della generazione della IR finale.

---

# Updated High-Level Agent Loop

Il comportamento complessivo target diventa:

```text
understand
   ↓
resolve known context
   ↓
clarify if necessary
   ↓
plan
   ↓
validate
   ↓
execute step
   ↓
verify
   ↓
success?
 ┌─┴───────────────┐
 │                 │
yes               blocked
 │                 │
next/final     structured failure
                   ↓
                replan
                   ↓
                 resume
```

Questa distinzione è fondamentale:

```text
before plan:
clarify semantic uncertainty

during execution:
handle runtime uncertainty through verification and replanning
```

---

# Additional Definition of Done

Considera completato il clarification layer quando una richiesta ambigua può attraversare:

```text
ragiona <ambiguous request>
      ↓
semantic analysis
      ↓
NEEDS_INPUT
      ↓
human clarification
      ↓
resume same pending goal
      ↓
READY
      ↓
compile typed CapabilityPlan
      ↓
MCP validation
      ↓
deterministic Jev execution
```

senza che il sistema:

```text
inventi informazioni mancanti
scelga arbitrariamente tra target semanticamente diversi
avvii execution prima di avere un goal sufficientemente definito
perda il contesto tra domanda e risposta
tratti la risposta di clarification come un goal indipendente
chieda informazioni che Jev può risolvere deterministicamente
```

Il principio finale deve essere:

```text
Hermes asks when semantic intent is incomplete.
Hermes plans when semantic intent is complete.
Jev decides deterministic mechanics.
```
