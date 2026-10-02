# Milestone — Autonomous Exploration v1

## Obiettivo

Implementare una capacità di **esplorazione autonoma** per il Player Bot.

Il bot deve poter ricevere obiettivi di alto livello come:

```text
Trova un Cherry Grove.
Trova un Pale Garden.
Trova dei funghi marroni.
Trova un villaggio.
Trova una Trial Chamber.
```

Hermes interpreta la richiesta e crea un task di esplorazione.

Il Player Bot esplora autonomamente il mondo, evita di visitare ripetutamente le stesse aree, identifica il target e produce un risultato **riproducibile**.

Il movimento locale e le decisioni immediate rimangono gestiti dall'attuale pipeline agentica / Jev.

---

# M1 — Find Biome MVP

## Goal

Supportare:

```text
explore -> find biome -> report -> wait
```

Esempio:

```text
Rive, trova un Cherry Grove.
```

Risultato atteso:

```text
Cherry Grove trovato.

Posizione: X=4210 Y=118 Z=-2360
Distanza dalla base: 4812 blocchi
Tempo di ricerca: 18m 32s

Rive è rimasto sul posto in attesa di istruzioni.
```

---

## Task 1 — Exploration Mission Model

Creare un modello persistente per una missione di esplorazione.

Campi minimi:

```text
id
type
target
status

origin
startedAt
completedAt

currentPosition
targetPosition

distanceTravelled
chunksVisited

route/checkpoints

result
failureReason
```

Status suggeriti:

```text
PENDING
RUNNING
PAUSED
FOUND
FAILED
CANCELLED
```

---

## Task 2 — Biome Target

Supportare inizialmente:

```text
minecraft:cherry_grove
minecraft:pale_garden
minecraft:badlands
minecraft:mushroom_fields
minecraft:deep_dark
minecraft:meadow
```

Il target deve essere espresso internamente tramite ID Minecraft e non tramite descrizione naturale.

Esempio:

```text
"bioma dei ciliegi"
"foresta di ciliegi"
"cherry biome"
```

devono convergere verso:

```text
minecraft:cherry_grove
```

---

## Task 3 — Exploration Planner

Implementare una strategia di esplorazione deterministica.

Prima versione possibile:

```text
origin
  ↓
expanding square / spiral
  ↓
new unexplored chunks
```

Requisiti:

- evitare aree già visitate;
- preferire chunk nuovi;
- mantenere memoria dell'area esplorata;
- consentire pausa e ripresa;
- evitare loop;
- poter riprendere dopo restart del servizio.

Non serve ottimizzare immediatamente il percorso.

La priorità è avere un comportamento:

```text
deterministico
osservabile
riproducibile
```

---

## Task 4 — Exploration Checkpoints

Durante l'esplorazione salvare checkpoint sparsi.

Esempio:

```json
[
  { "x": 120, "y": 71, "z": -40 },
  { "x": 380, "y": 74, "z": -210 },
  { "x": 810, "y": 92, "z": -430 },
  { "x": 1240, "y": 110, "z": -760 }
]
```

Non è necessario salvare ogni singolo movimento.

Il checkpoint deve essere sufficiente per:

```text
ricostruire il percorso
ritornare al target
guidare successivamente il player
```

---

## Task 5 — Biome Detection

Durante l'esplorazione verificare continuamente il biome corrente.

Quando:

```text
currentBiome == targetBiome
```

la missione diventa:

```text
FOUND
```

Salvare:

```text
coordinate
biome
timestamp
distanza dall'origine
route
```

---

## Task 6 — Exploration Report

Produrre un report strutturato.

Esempio:

```json
{
  "missionId": "exp-123",
  "target": "minecraft:cherry_grove",
  "status": "FOUND",

  "origin": {
    "x": 104,
    "y": 68,
    "z": -91
  },

  "targetPosition": {
    "x": 4210,
    "y": 118,
    "z": -2360
  },

  "distanceFromOrigin": 4812,
  "distanceTravelled": 6231,

  "chunksVisited": 183,

  "durationSeconds": 1112
}
```

Hermes deve poter trasformare il report in una risposta naturale.

Esempio:

```text
Ho trovato un Cherry Grove a circa 4800 blocchi dalla base.
Sono rimasto sul posto.
```

---

## Task 7 — Remain At Target

Dopo il ritrovamento il bot non deve tornare automaticamente.

Default:

```text
FOUND
↓
HOLD_POSITION
```

Deve:

- restare nei pressi del punto trovato;
- evitare pericoli;
- mangiare quando necessario;
- potersi spostare leggermente per sopravvivere;
- mantenere il target come anchor.

Il Survival Governor può temporaneamente prendere priorità.

---

# Acceptance Criteria M1

La milestone è completata quando questo scenario funziona end-to-end:

```text
User:
Rive, trova un Cherry Grove.

Hermes:
crea exploration mission

Rive:
esplora autonomamente

Rive:
rileva minecraft:cherry_grove

System:
salva target + route + report

Hermes:
Cherry Grove trovato a circa 4800 blocchi dalla base.
Rive è sul posto.
```

La missione deve sopravvivere a:

```text
pause
resume
restart
temporary survival interruption
```

---

# M2 — Route Replay

## Goal

Permettere al bot di ritornare automaticamente in un luogo già scoperto.

Comando:

```text
Rive, torna al Cherry Grove che hai trovato.
```

Implementare:

```text
exploration report
        ↓
saved checkpoints
        ↓
route replay
        ↓
target
```

Il replay non deve obbligatoriamente seguire esattamente ogni passo originale.

I checkpoint sono guide.

Il pathfinding locale può trovare un percorso migliore tra due checkpoint.

---

## Acceptance Criteria M2

```text
find biome
↓
return home
↓
go back to discovered biome
```

senza nuova esplorazione completa.

---

# M3 — Escort Player

## Goal

Permettere a Rive di accompagnare il giocatore verso un luogo scoperto.

Flusso:

```text
User:
Vieni a prendermi.

Rive:
raggiunge il player

User:
Portami al Cherry Grove.

Rive:
esegue il percorso salvato
```

Durante l'escort:

- mantenere distanza ragionevole dal player;
- fermarsi se il player resta troppo indietro;
- evitare combattimenti inutili;
- aspettare quando necessario;
- riprendere quando il player ritorna vicino.

Possibile stato:

```text
ESCORTING
WAITING_FOR_PLAYER
```

---

# M4 — Search Blocks / Resources

Estendere `explore/find` a target osservabili.

Esempi:

```text
Trova dei funghi marroni.
Trova delle zucche.
Trova del bambù.
Trova un albero di mangrovia.
```

Missione:

```text
EXPLORE
↓
SCAN
↓
MATCH BLOCK / ENTITY
↓
REPORT
```

Il risultato deve includere:

```text
tipo target
coordinate
quantità osservata
bioma
route
```

---

# M5 — Search Structures

Supportare strutture più complesse.

Priorità suggerita:

```text
Village
Trial Chamber
Pillager Outpost
Woodland Mansion
Ancient City
Desert Pyramid
Jungle Temple
```

Il riconoscimento può inizialmente essere euristico.

Esempio:

```text
Village =
villagers
+ beds
+ village blocks
+ structure pattern
```

Successivamente introdurre detector specifici.

---

# M6 — Ricerca sotterranea (caverne, miniere, deep dark/ancient city, spawner)

## Goal

Supportare target **sotterranei**, che sono la fonte più ricca di risorse e la ragione
principale per cui vale la pena esplorare.

Esempi:

```text
Trova una caverna.
Trova una miniera abbandonata.
Trova una Ancient City / il Deep Dark.
Trova uno spawner.
```

Obiettivo: riusare lo stesso modello di missione (M1) cambiando il `target`:
non "bioma" ma **caverna / struttura sotterranea / blocco / spawner**.

## Target (ID Minecraft)

```text
caverna              -> cave_air (volume) + cave / lush_caves / dripstone_caves (biomi)
miniera abbandonata  -> mineshaft / abandoned_mineshaft (planche, rotaie, ragnatele, spawner)
deep dark / city     -> deep_dark (bioma) + sculk / sculk_shrieker / sculk_catalyst /
                        reinforced_deepslate + ancient_city
spawner              -> mob_spawner / monster_spawner (stato del blocco, tipo di mob)
geode                -> amethyst_geode (bonus)
```

## Rilevamento (euristico prima, detector dopo)

```text
caverna =
cave_air clusters
OPPURE pozzo/varco verticale (superficie -> aria sotto)

mineshaft =
planks + rails + fences + cobwebs + spawner (vicini)

ancient city =
sculk + sculk_shrieker + deepslate + reinforced_deepslate (area estesa)

spawner =
blocco mob_spawner visibile (con il tipo di mob dal metadata/NBT)
```

## Rischio e sicurezza

Il sottosuolo è molto più pericoloso dell'esplorazione superficiale:

- **buio** → mob; portare torce e illuminare mentre si scava/avanza;
- **lava e acqua** → dipendono da `FLUIDS_ROADMAP` (M0/M4): mai scavare nella lava,
  mai aprire un pozzo che sfondi in un lago di lava;
- **Deep Dark** → lo **sculk shrieker** evoca il **Warden**: se si trova una
  Ancient City, avvicinarsi con cautela, non attivare più shrieker, non rubare
  senza via di fuga; il default è **osservare e riferire**, non saccheggiare;
- **spawner** → di default **non rompere** uno spawner di una base senza consenso;
  in esplorazione si annota e si può disattivare con la luce (fiaccole) solo su
  richiesta; una farm di mob/XP è un milestone separato e gated;
- **crolli** (ghiaia/sabbia), **cadute**, **perdersi**: lasciare checkpoint/segnali
  e non consumare tutto il kit;
- **Cave Spider / Mineshaft**: gli spawner di ragni della miniera sono letali in
  spazi stretti.

## Navigazione sotterranea

L'attuale A* è pensato per la superficie (appoggio, gradini ±1, cadute brevi). Il
sottosuolo richiede:

- pathfinding **3D** e gestione dislivelli (dig / place / pillar);
- `dig_down`/`dig_up` come primitive, ma con `DIG_PROTECTED` e il controllo fluidi;
- avanzare verso un bersaglio mantenendo una via di ritorno (checkpoint).

Dipende dal milestone "advanced navigation" di `AI_PLAYER_ROADMAP`
(bridge / pillar / dig tunnel / safe descent).

## Kit per l'escursione sotterranea

Estende il travel survival kit: torce, blocchi (ponte/pillar), spada + armatura, cibo,
secchio (acqua), piccone (+ scudo se disponibile), e **spazio inventario libero**.

## Acceptance Criteria M6

- `Trova una caverna.` → il bot entra in un volume `cave_air`, marca una entrata,
  riferisce coordinate/bioma e resta sul posto (`HOLD_POSITION`).
- `Trova una miniera abbandonata.` → rileva planche+rotaie+spawner e riferisce.
- `Trova il Deep Dark.` → raggiunge il bioma `deep_dark` senza attivare il Warden;
  se lo trova, si ferma a distanza di sicurezza e riferisce.
- `Trova uno spawner.` → rileva il blocco `mob_spawner` (con tipo mob) e **non lo
  rompe** senza consenso.
- Nessuna morte per lava/fuoco/caduta durante il test; route e checkpoint salvati;
  nessun blocco della base rotto.

---

# Exploration Skill API

Obiettivo finale:

```text
explore.findBiome(target)
explore.findBlock(target)
explore.findResource(target)
explore.findStructure(target)
explore.findCave()
explore.findMineshaft()
explore.findSpawner()
explore.findDeepDark()

explore.pause()
explore.resume()
explore.cancel()

explore.returnTo(resultId)
explore.escortTo(resultId)
```

---

# Separazione delle responsabilità

## Hermes

Responsabile di:

```text
intent
target resolution
mission creation
progress/reporting
user interaction
```

## Exploration Planner

Responsabile di:

```text
dove esplorare
quali zone sono già state visitate
checkpoint
mission progress
```

## Jev / Player Agent

Responsabile delle bounded actions:

```text
move
jump
swim
climb
interact
avoid obstacle
```

## Survival Governor

Può interrompere temporaneamente l'esplorazione per:

```text
health
hunger
night
hostile mobs
fall risk
equipment
```

Terminata l'emergenza:

```text
resume exploration mission
```

---

# Principio fondamentale

L'esplorazione non deve essere una lunga action generata dall'LLM.

Deve essere:

```text
LLM
↓
high-level objective

deterministic exploration controller
↓
next exploration objective

Jev
↓
bounded local action
```

In questo modo una ricerca può durare anche molto tempo senza trasformarsi in una singola azione agentica incontrollabile.

---

# Definition of Done

La feature `Autonomous Exploration v1` può considerarsi chiusa quando possiamo dire:

```text
Rive, trova un Cherry Grove.
```

e il sistema è in grado autonomamente di:

```text
1. interpretare il target;
2. creare una missione persistente;
3. esplorare nuovi chunk;
4. sopravvivere durante il viaggio;
5. riconoscere il biome;
6. salvare coordinate e percorso;
7. produrre un report;
8. restare sul posto;
9. tornare successivamente nello stesso luogo;
10. accompagnare il player fino al target.
```
