# Hermes — Roadmap evolutiva verso un vero AI Player

## Obiettivo

Portare Hermes da:

> bot controllabile via chat

a:

> agente autonomo persistente, capace di ricevere ordini, reagire al mondo, interrompere e riprendere attività, prendere iniziative sensate e restare presente nel server anche quando non ha un goal esplicito.

---

# 0. Prima cosa da verificare — Lifecycle del bot

C'è un dubbio importante da chiarire prima di costruire autonomia sopra l'architettura attuale:

> **oggi Hermes resta connesso al server quando termina il goal, oppure il player bot viene disconnesso / il processo entra in uno stato inattivo?**

La specifica precedente del progetto puntava a un client reale che:

- resta connesso;
- mantiene un loop operativo;
- gestisce reconnect automatico;
- torna al decision loop dopo errori o cadute di connessione.

Quindi **goal lifecycle e connection lifecycle dovrebbero essere separati**.

La regola architetturale target deve essere:

```text
SERVER SESSION
    ├── connect
    ├── spawn
    ├── observe
    ├── execute goals
    ├── idle / autonomous behavior
    ├── receive new goals
    └── disconnect solo per:
        - shutdown esplicito
        - errore non recuperabile
        - restart controllato
        - comando amministrativo
```

Non:

```text
connect
↓
execute goal
↓
goal completed
↓
disconnect
```

Prima milestone quindi:

## Lifecycle Audit

Verificare cosa accade realmente oggi quando un goal termina.

### Acceptance criteria

- il bot completa un goal;
- resta connesso al BDS;
- resta spawnato;
- continua a ricevere eventi;
- continua a leggere la chat;
- può ricevere un nuovo goal senza reconnect;
- se non ha goal entra in `IDLE`;
- `IDLE` non equivale a `DISCONNECTED`;
- disconnect e goal completion sono eventi indipendenti.

### Stato target

```text
CONNECTED
  ↓
IDLE
  ↓
GOAL_RUNNING
  ↓
GOAL_COMPLETED
  ↓
IDLE
```

Il ciclo continua indefinitamente.

---

# 1. Goal Manager

## Obiettivo

Tutto ciò che Hermes tenta di fare deve essere rappresentato come un **goal**.

Esempi:

```text
FOLLOW_PLAYER
FIND_IRON
COLLECT_WOOD
RETURN_HOME
DEFEND_SELF
RECOVER_PLAYER_LOOT
EXPLORE_AREA
CRAFT_PICKAXE
HELP_PLAYER
```

Ogni goal dovrebbe avere almeno:

```text
id
type
source
priority
status
parameters
parentGoal
createdAt
```

### Source

```text
CHAT
AUTONOMOUS
WORLD_EVENT
PLAYER_BEHAVIOR
EMERGENCY
```

### Status

```text
PENDING
RUNNING
SUSPENDED
COMPLETED
FAILED
```

### Principio

La chat non deve comandare direttamente primitive.

```text
"Hermes cerca ferro"
```

deve produrre:

```text
Goal:
  type: FIND_IRON
  source: CHAT
  priority: HIGH
```

---

# 2. Goal completion ≠ fine attività

Quando un goal termina:

```text
GOAL_COMPLETED
↓
evaluate pending/suspended goals
↓
resume previous goal
OR
select autonomous goal
OR
enter IDLE
```

Mai:

```text
GOAL_COMPLETED
↓
disconnect
```

---

# 3. Interrupt / Suspend / Resume

## Obiettivo

Hermes deve poter interrompere un goal senza perderlo.

Esempio:

```text
FIND_IRON
↓
Creeper rilevato
↓
suspend FIND_IRON
↓
DEFEND_SELF
↓
resume FIND_IRON
```

Altro esempio:

```text
EXPLORE_CAVE
↓
player: "Hermes vieni"
↓
suspend EXPLORE_CAVE
↓
FOLLOW_PLAYER
↓
player: "vai pure"
↓
resume EXPLORE_CAVE
```

### Priorità indicative

```text
CRITICAL
- survive
- recover player loot
- escape lethal danger

HIGH
- defend player
- urgent direct player command
- retrieve valuable dropped items

MEDIUM
- mining
- gathering
- crafting
- exploration

LOW
- curiosity
- idle activities
```

---

# 4. Emergency Goal System

Gli eventi critici del mondo possono creare automaticamente goal che preemptano quelli correnti.

## PLAYER_DIED

```text
PLAYER_DIED
↓
create RECOVER_PLAYER_LOOT
priority = CRITICAL
```

### Behavior

```text
1. memorizza death location
2. sospendi il goal corrente
3. valuta distanza e pericolo
4. raggiungi il punto della morte
5. raccogli il loot
6. prioritizza gli item importanti
7. porta il loot in sicurezza
8. torna dal player / torna a casa
9. riprendi il goal precedente
```

### Priorità loot

```text
1. Netherite / Diamond gear
2. enchanted tools
3. Elytra
4. rare items
5. valuable resources
6. food / common materials
```

### Risk awareness

```text
death in lava
→ non buttarsi alla cieca

death near Warden
→ approccio prudente

death in Nether
→ verifica route / portal

inventory almost full
→ libera spazio prima del recupero
```

Questo goal deve partire **senza bisogno di un comando chat**.

---

# 5. Autonomous Idle Behavior

## Obiettivo

Hermes non deve restare passivo quando non riceve ordini.

```text
no active goal
↓
evaluate state
↓
evaluate needs
↓
select autonomous goal
```

Prime regole:

```text
food low
→ find food

tool missing
→ craft tool

tool damaged
→ repair / replace

inventory full
→ store items

night + unsafe
→ seek shelter

valuable resource nearby
→ collect it

no useful activity
→ explore
```

### Principio

Le decisioni semplici non devono richiedere un LLM.

Usare:

```text
state
+
rules
+
utility score
```

---

# 6. Attention System

## Obiettivo

Permettere al giocatore di attirare l'attenzione di Hermes senza chat.

Eventi possibili:

```text
player nearby + repeated crouch
player nearby + repeated jump
player staring at Hermes
player hits Hermes lightly
player approaches quickly
```

Producono:

```text
PLAYER_REQUESTS_ATTENTION
```

Hermes può:

```text
look at player
pause low-priority activity
move closer
wait briefly
```

---

# 7. Contextual Assistance

## Obiettivo

Hermes deve capire cosa sta facendo il giocatore e poterlo aiutare.

Esempi:

```text
player starts mining
→ mining support

player attacks hostile mob
→ combat support

player chops trees
→ gather nearby wood

player starts building
→ bring/place basic materials

player enters cave
→ follow / support
```

Eventi iniziali:

```text
PLAYER_MINING
PLAYER_FIGHTING
PLAYER_BUILDING
PLAYER_FLEEING
PLAYER_EXPLORING
```

Hermes decide:

```text
assist
observe
ignore
```

in base a:

```text
current goal
distance
danger
priority
context
```

---

# 8. Home System

## Obiettivo

Dare a Hermes una base persistente.

```text
HOME
├── bed
├── chest
├── furnace
├── crafting table
├── food storage
├── tool storage
└── safe area
```

Comportamenti:

```text
inventory full
→ RETURN_HOME

valuable loot
→ STORE_ITEMS

night
→ RETURN_HOME / SHELTER

need better tool
→ USE_HOME_CRAFTING

low food
→ SEARCH_HOME_STORAGE
```

---

# 9. Minecraft-Aware Navigation

## Obiettivo

Il pathfinding non deve limitarsi a trovare percorsi già esistenti.

Hermes deve poter modificare il mondo.

Skill:

```text
walk
jump
swim
dig
place block
bridge
pillar
descend safely
break obstacle
```

Esempi:

```text
ravine blocks path
↓
bridge
↓
continue
```

```text
target above
↓
pillar up
```

```text
ore behind wall
↓
mine tunnel
```

---

# 10. Curiosity System

## Obiettivo

Hermes nota eventi e luoghi interessanti.

Interest events:

```text
diamond ore
village
ruined portal
new biome
large cave
rare mob
structure
explosion
player combat
unusual block
```

Generano:

```text
INVESTIGATE_POINT_OF_INTEREST
```

Solo se:

```text
current goal priority allows interruption
danger acceptable
distance reasonable
```

Esempio:

```text
COLLECT_WOOD
↓
village discovered
↓
suspend briefly
↓
inspect village
↓
store location
↓
resume COLLECT_WOOD
```

---

# 11. World Memory

## Obiettivo

Hermes deve ricordare il mondo.

Memoria minima:

```text
home
known caves
resource locations
villages
dangerous zones
useful chests
portals
structures
recent player locations
death locations
```

Esempio:

```text
Iron ore discovered:
x=124
y=-23
z=381
```

Poi:

```text
ResourceSpot:
type = IRON
confidence = HIGH
lastSeen = ...
depleted = false
```

---

# 12. Player Model

## Obiettivo

Hermes deve iniziare a capire le abitudini del giocatore.

Memoria possibile:

```text
preferred base
frequent mining area
common travel direction
favorite resources
combat behavior
usual play style
```

Esempio:

```text
player frequently mines underground
→ Hermes keeps torches / food available
```

---

# 13. Personality Layer

Da introdurre solo dopo aver stabilizzato i sistemi precedenti.

Parametri:

```text
curiosity
riskTolerance
sociability
independence
greed
caution
helpfulness
```

La personalità modifica i pesi del Goal Manager.

Non sostituisce il Goal Manager.

---

# 14. Planner gerarchico

## Obiettivo

Separare:

```text
goal
plan
skill
```

Esempio:

```text
GOAL
FIND_DIAMONDS
```

diventa:

```text
need iron pickaxe
↓
find iron
↓
smelt iron
↓
craft pickaxe
↓
find deep cave
↓
mine diamonds
```

Le skill primitive restano deterministiche.

---

# Architettura target

```text
                 ┌──────────────┐
                 │     Chat     │
                 └──────┬───────┘
                        │
              ┌─────────▼─────────┐
              │ Intent Interpreter │
              └─────────┬─────────┘
                        │
                        ▼
┌──────────────┐   ┌───────────────┐
│ World Events │──▶│  Goal Manager  │
└──────────────┘   └───────┬───────┘
                            │
┌──────────────┐            │
│ Player Events│────────────┤
└──────────────┘            │
                            ▼
                    ┌───────────────┐
                    │    Planner    │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Skill Library │
                    └───────┬───────┘
                            │
                            ▼
                     Minecraft BDS
```

A lato:

```text
Session Manager
World Memory
Player Model
Needs
Personality
Emergency Events
```

Il `Session Manager` deve vivere indipendentemente dai goal.

---

# State machine minima

```text
DISCONNECTED
    ↓
CONNECTING
    ↓
CONNECTED
    ↓
IDLE
    ↓
GOAL_RUNNING
    ↓
GOAL_COMPLETED
    ↓
IDLE
```

Interruzioni:

```text
GOAL_RUNNING
    ↓
GOAL_SUSPENDED
    ↓
EMERGENCY_GOAL
    ↓
GOAL_COMPLETED
    ↓
RESUME_PREVIOUS_GOAL
```

Caduta connessione:

```text
ANY_CONNECTED_STATE
    ↓
CONNECTION_LOST
    ↓
RECONNECTING
    ↓
RESTORE_STATE
    ↓
RESUME
```

---

# Ordine di implementazione consigliato

## Milestone 0 — Lifecycle persistence

```text
verify current post-goal behavior
separate goal lifecycle from connection lifecycle
stay connected after goal completion
idle state
new goal without reconnect
reconnect without losing agent state
```

## Milestone 1 — Agent Core

```text
Goal Manager
Priority
Suspend
Resume
Goal sources
Goal completion handling
```

## Milestone 2 — Emergency System

```text
PLAYER_DIED
RECOVER_PLAYER_LOOT
danger override
self-preservation
critical goal preemption
```

## Milestone 3 — Autonomy

```text
Needs
Idle behavior
Autonomous goals
Basic utility scoring
```

## Milestone 4 — Social behavior

```text
Attention system
Follow
Player activity detection
Contextual assistance
```

## Milestone 5 — World awareness

```text
Home
World memory
Points of interest
Curiosity
```

## Milestone 6 — Advanced navigation

```text
Digging path
Bridge
Pillar
Obstacle modification
Safe descent
```

## Milestone 7 — Planning

```text
Hierarchical goals
Prerequisites
Subgoals
Failure recovery
```

## Milestone 8 — Character

```text
Personality
Player model
Long-term behavior
Emergent routines
```

---

# Feature da evitare per ora

Non investire subito su:

```text
LLM per ogni decisione
dialoghi complessi
emozioni simulate
memory vector DB enorme
multi-agent coordination
learning automatico
```

Prima Hermes deve diventare affidabile in:

```text
stay connected
goal
interrupt
resume
survive
recover loot
navigate
help
remember
idle intelligently
```

---

# North Star

Hermes deve superare questi test:

### Test 1 — Persistenza

> Completa un goal e resta nel server.

### Test 2 — Nuovo goal

> Completa un goal, resta idle e accetta un nuovo comando senza reconnect.

### Test 3 — Autonomia

> Se non riceve comandi per 20 minuti, continua a comportarsi come un compagno credibile.

### Test 4 — Emergenza

> Se il player muore, sospende il task corrente e tenta di recuperare il loot.

### Test 5 — Resume

> Finita l'emergenza, riprende il goal precedente.

### Test 6 — Reconnect

> Se la connessione cade, rientra nel server e ripristina il contesto operativo.

---

# Principio architetturale finale

```text
Hermes non deve vivere "finché c'è un goal".

Hermes deve vivere "finché la sessione dell'agente è attiva".

I goal sono attività temporanee dentro una sessione persistente.
```

