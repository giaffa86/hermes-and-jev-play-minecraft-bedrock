# Roadmap — Fluidi: nuoto, annegamento, respirazione, lava e cascate

> Fonte grezza (spec). Sintesi in [`wiki/fluids.md`](../wiki/fluids.md).
> Stato: **spec, non implementato** (nessuna riga di codice in produzione).
> Riferimenti al codice: `bedrock-adapter.mjs`, `bedrock-fishing.mjs`,
> `bedrock-survival.mjs`, `survival/*`, `knowledge/*.json`.

## Obiettivo

Rendere il bot capace di operare **dentro e attorno ai fluidi** senza morire:

- nuotare e attraversare fiumi/laghi/oceani;
- non annegare (respirazione, emersione, gestione dell'aria);
- sfruttare le **cascate** per scendere e per salire;
- **evitare la lava** finché non è attrezzato (secchio, resistenza al fuoco, ponti);
- coprire tutte le skill legate ai fluidi: secchi, barche, colonne di bolle,
  pozioni, pesca subacquea, estrazione subacquea.

Principio guida: la lava è un **pericolo assoluto** per default. Acqua,
cascate e colonne di bolle sono **opportunità** di mobilità. Il bot impara
prima a sopravvivere all'acqua e a evitare la lava, poi (stretch) ad
attraversare la lava con l'attrezzatura.

---

## Stato attuale (verificato dal codice, non dal runbook)

Fatti rilevanti letti in `bedrock-adapter.mjs`:

1. **I fluidi sono muri.** `_passable()` ritorna `false` per `water|lava`
   (`// il bot non nuota`). Di conseguenza A* (`_neighbors`) e la fisica locale
   (`_collides`, `_moveVertical`) trattano acqua e lava come solide: il bot
   **non può entrare** in acqua, una `goto_waypoint` verso una sponda opposta
   si blocca o devia.
2. **Niente appoggio sull'acqua.** `_standable()` richiede un blocco solido
   sotto i piedi, quindi la superficie dell'acqua non è un nodo valido.
3. **Scavare rifiuta i fluidi, ma solo la cella bersaglio.** `_digTargets()` e
   `_upTargets()` ritornano `unsafe_block_*` se la cella da scavare è
   `water|lava`; **non** controllano le celle adiacenti né la cella di atterraggio
   (si può ancora aprire un pozzo che sfonda in lava/acqua).
4. **Movimento server-authoritative custom.** `_authTick` → `_sendAuthInput`
   (`player_auth_input`) con `delta` = velocità locale e `input_data` di intento
   (`jumping`, `want_up`, `start_jumping`, `vertical_collision`,
   `horizontal_collision`). La fisica locale deve rispecchiare l'acqua, altrimenti
   `correct_player_move_prediction` teletrasporta/rimbalza il bot.
5. **Nessuna aria/respirazione.** `_applyOwnAttributes` legge solo
   `minecraft:health`, `player.hunger`, `player.level`, `player.experience`.
   `_applyEntityMetadata` mappa i flag (`flags`, bitfield, e `flags_extended`);
   nessun flag di immersione/aria è cablato.
6. **`_refreshNearby` non scansiona acqua/lava**, quindi `/observe.nearby` non
   mostra i fluidi e il controller non li "vede".
7. **`_flee` fugge solo dai mob.** I candidati passano da `_standableNear`, che
   esclude i fluidi: in un campo di lava la fuga non usa l'acqua come riparo.
8. **Morte in lava = loot perso.** `_onOwnHealth` registra `deathSite` per
   `recover_loot`; in lava i drop bruciano e il recupero è impossibile (motivo in
   più per trattare la lava come hazard assoluto).
9. **La pesca conosce già l'acqua.** `bedrock-fishing.mjs` ha `isWaterBlock`,
   `shoreCandidates`, `CAST_RANGE`: geometria di riva riusabile per M1–M3.

---

## Vocabolario proposto (da validare nei loader chiusi)

### Nuove chiavi azione `/options`

| Key | Significato |
|---|---|
| `swim_to` | Nuota verso un bersaglio in/attraverso l'acqua (o `goto_waypoint` fluido-aware). |
| `surface` | Risale verticalmente all'aria/alla sponda più vicina. |
| `dive` | Discesa controllata verso un bersaglio sommerso, con budget d'aria. |
| `descend_waterfall` | Discesa in una colonna d'acqua (cascata). |
| `climb_waterfall` | Risalita di una colonna d'acqua / colonna di bolle. |
| `use_bubble_column` | Soul sand (su) / magma block (giù) — stretch. |
| `avoid_lava` / `move_to_safe` | Fuga generalizzata da un hazard (lava in primis). |
| `craft_bucket`, `craft_boat` | Ricette fluide. |
| `fill_bucket`, `empty_bucket`, `place_water` | Interazioni con secchio. |
| `brew_water_breathing`, `brew_fire_resistance`, `brew_night_vision` | Pozioni (stretch). |
| `drink_potion_<effetto>` / `use_potion` | Consumo effetto (stretch). |
| `mount_boat` + `goto_waypoint` | Navigazione in barca (il prefisso `mount_*` e `_rideToward` esistono). |

### Nuovi intenti (`survival/intents.mjs`)

Aggiungere **`swim`, `surface`, `descend`, `ascend`** (e un `fluid` per i secchi).
Mapping non inventa key: classifica solo quelle offerte.

```
surface            -> ['surface', 'escape']
descend_waterfall  -> ['descend', 'travel']
climb_waterfall    -> ['ascend', 'travel']
dive               -> ['swim', 'descend']
swim_to            -> ['swim', 'travel']
avoid_lava         -> ['escape', 'travel']
fill/empty_bucket  -> ['fluid', ...]
craft_bucket       -> ['craft']
```

### Nuove condizioni governor (`knowledge/survival-rules.json`)

`inWater`, `headInWater`, `airBelow`, `inLava`, `lavaWithin` (numero, blocchi),
`onWaterfall` (bool). Le stesse vanno aggiunte a `CONDITION_KEYS` in
`survival/rules.mjs` con la validazione di tipo, come da convenzione.

### Nuovi tag item (`survival/item-tags.mjs`)

`buckets` (`bucket`, `water_bucket`, `lava_bucket`, `milk_bucket`,
`powder_snow_bucket`, `cod_bucket`, ...), `boats` (tutti i `*_boat`),
`water_breathing` / `fire_resistance` / `potions`.

### Nuovi criteri verifier (`survival/verify.mjs`)

`inWater`, `airAtLeast`, `notInLava`; i tag nuovi riusano `inventoryTagGte`.

---

## Milestone

### M0 — Consapevolezza dei fluidi (nessun movimento nuovo)

**Deliverable**

- Modulo puro **`bedrock-fluids.mjs`**:
  - classificazione blocchi (`water`, `flowing_water`, `still_water`, `lava`,
    `flowing_lava`, `magma`, `soul_sand` sotto acqua);
  - `submersionState(feet, head)` → `{ inWater, headInWater, inLava, feetFluid, headFluid }`;
  - `airTick(air, state)` → budget aria deterministico (default 300 tick = 15 s,
    reset quando la testa è in aria);
  - `waterColumn` / `findWaterfalls` / `findBubbleColumns` (bozze, usate in M3);
  - `isSafeLanding(block, fallBlocks)` → l'acqua annulla il danno da caduta.
- **`/observe.fluids`**: `{ inWater, headInWater, inLava, air, airMax,
  feetFluid, headFluid, waterDistance, lavaDistance, lavaCount,
  waterfall: {top,bottom}|null, bubbleColumn, safeShore }`.
- **`_refreshNearby`** scansiona `water`, `flowing_water`, `lava`,
  `flowing_lava`, `magma` (oggi assenti).
- **Perception** (`survival/perception.mjs`): campi fluidi + rischio dedicato
  (lava contatto = critical, drowning = high in base all'aria).
- **Governor**: regole `lava_contact` (emergency), `drowning` (emergency a
  `airBelow` soglia), `lava_near` (caution). Vocabolario chiuso aggiornato.
- **Pathfinding**: lava vietata ovunque + penalità di prossimità; l'acqua resta
  muro (M1 la rende percorribile).
- **`dig_up`/`dig_down`**: controllo fluidi esteso ad **adiacenza + atterraggio**
  (non aprire un pozzo che sfonda in lava/acqua).
- **`_flee`**: generalizzato a un hazard non-mob (lava) via `avoid_lava`.

**Test**: `tests/bedrock-fluids.test.mjs` (puro), `/observe` shape,
`survival-governor.test.mjs` (nuove regole), `bedrock-dig.test.mjs`
(rifiuto adiacenza).

**Accettazione**: live `/observe.fluids` mostra distanze acqua/lava corrette;
un waypoint viene deviato attorno alla lava; nessuna azione scava nella lava.

---

### M1 — Nuoto: fisica e navigazione

**Deliverable**

- `_passable`: acqua → percorribile (mezzo nuotabile); lava resta muro.
- `_physicsStep`: rilevamento del mezzo a piedi/testa; in acqua:
  - gravità ridotta, **galleggiamento** con `want_up` (jump tenuto), velocità di
    nuoto, drag orizzontale, velocità terminale, **nessun danno da caduta**;
  - `want_down` per la discesa (dive).
- `_sendAuthInput`: flag `input_data` corretti per l'acqua. **Task di scoperta
  protocollo**: catturare il traffico mentre un giocatore reale nuota e
  confermare i nomi esatti (`swimming`/`swim`/`sprinting`/`want_up`/`want_down`)
  e il modello di `delta`; senza questo il server corregge e il bot rimbalza.
  Aggiornare inoltre il flag self `swimming`.
- A*: nodi d'acqua (stesso livello, su se c'è acqua sopra, giù se c'è acqua
  sotto, ingresso/uscita dalla sponda); costo che penalizza la profondità e
  preferisce il guado più corto; `_findGoalNodes` accetta un bersaglio in
  superficie d'acqua.
- `_moveTo`/`goto_waypoint` attraverso l'acqua; recupero da "affondato"
  (surface) e blocco.
- **Budget aria nel loop**: se la testa è sommersa e l'aria scende sotto soglia,
  abort e `surface` (precede ogni altro progresso).
- Azione **`surface`**; **`swim_to`** (o copertura trasparente di
  `goto_waypoint`).

**Test**: `_physicsStep` su mondo finto (puro), generazione vicini A*,
countdown aria, generazione opzioni.

**Accettazione**: live attraversamento di un fiume/lago verso la sponda opposta
senza annegare; `goto_waypoint` sopra l'acqua; `surface` da posizione sommersa.

---

### M2 — Respirazione e immersioni controllate

- Azione **`dive`** verso un bersaglio sommerso, con budget d'aria e `surface`
  come abort automatico.
- `collect_drop` / `mine_*` sott'acqua (argilla, sabbia, ghiaia, corallo) con
  gestione aria.
- Rilevamento **Water Breathing** (effetto via attributi/metadata se esposto,
  altrimenti inventario/held) per estendere l'aria; `drink_potion` stretch.
- Governor: regola `drowning` come emergency con preferenza per `surface`; nuovo
  bisogno `breathe` in `survival/needs.mjs`.
- **Accettazione**: `dive` verso un blocco sommerso e ritorno con aria mai sotto
  soglia; test unitario di prelazione dell'annegamento.

---

### M3 — Cascate: discesa e risalita

- **`findWaterfalls`**: colonna verticale di `flowing_water` con sorgente in cima
  e pozza/terreno in basso (con atterraggio sicuro). **`findBubbleColumns`**:
  `soul_sand` (su) / `magma` (giù) sotto acqua.
- **`descend_waterfall`**: entrare nella colonna, lasciarsi portare giù
  (gravità/galleggiamento), atterrare nella pozza; nessun danno da caduta.
- **`climb_waterfall`**: tenere `want_up`/jump contro la colonna per risalire; se
  bloccata, provare una colonna adiacente; fallback `dig_up`.
- **`use_bubble_column`**: ascensore soul sand in su, magma in giù (danno se non
  si è accovacciati — esporre il flag).
- Pathfinding: edge di discesa cascata (economico, se atterraggio sicuro) e di
  risalita (a costo), edge di colonna di bolle.
- `dig_down` preferisce una cascata vicina quando si scende da un dirupo;
  invariato se non c'è acqua.
- **Accettazione**: live discesa di una cascata naturale senza danno; risalita
  della stessa; ripetibile; `dig_*` invariato senza acqua.

---

### M4 — Lava: evitare (e attraversare più avanti)

- Default: la lava è un ostacolo **assoluto**. A* la vieta e la respinge.
- `avoid_lava` / `move_to_safe` quando `lavaWithin` è basso; se `inLava`,
  puntare alla sponda più vicina (acqua preferita) e `surface`.
- Morte: marcare le morti in lava (drop distrutti, `recover_loot` da saltare).
- **Mai scavare nella lava**: il controllo M0 vale per ogni `mine_*`/`dig_*` e i
  drop che giacciono in lava vengono ignorati.
- **Secchi** (anticipo di M5): `fill_bucket` (acqua) e `empty_bucket` →
  acqua su lava = ossidiana/pietra, spegne il fuoco, crea una discesa sicura o un
  atterraggio morbido (`place_water`).
- **Stretch, gated**: mari di lava del Nether via ponti di blocchi +
  `fire_resistance` + strider; **mai** default. L'acqua non si può piazzare nel
  Nether.
- **Accettazione**: test unitari provano che la lava non entra mai in un percorso
  A*; live fuga dal bordo lava; `place_water` → ossidiana live; gate esplicito
  "evita finché non attrezzato".

---

### M5 — Secchi, barche e pozioni (tutte le skill coi fluidi)

- Craft **`bucket`** (3 lingotti di ferro), **`craft_boat`** (5 assi); tag
  `buckets`, `boats`.
- `fill_bucket` (acqua/lava/latte/pesce/axolotl/powder snow), `empty_bucket`,
  `place_water`, `place_lava`.
- **Barca**: `mount_boat` + `_rideToward` su acqua aperta (estendere il percorso
  `mount_*`/`_rideToward` già esistente a nodi senza appoggio); `dismount` a riva.
- **Brewing**: `brew_water_breathing`, `brew_fire_resistance`,
  `brew_night_vision`; `fill_bottle` a una sorgente. Riusa l'infra stazioni.
- La pesca è già water-based; integrarla con `dive`/barca.
- **Accettazione**: `craft_bucket` → `fill_bucket` → `place_water` live; barca
  attraverso l'acqua live; pozione preparata + effetto confermato (stretch).

---

### M6 — Integrazione Survival Intelligence

- Nuove skill dichiarative `skills/gameplay/fluids/`:
  `cross_water`, `survive_drowning`, `escape_lava`, `descend_waterfall`,
  `climb_waterfall`, `craft_bucket`, `bucket_and_place_water`, `boat_travel`,
  `brew_water_breathing`.
- `knowledge/progression.json`: milestone `bucket` (requires `iron_age`),
  `water_travel` (requires `stone_tools`/`bucket`), `nether_cross_lava`
  (requires `fire_resistance` + `bucket`, gated).
- Governor + perception + intents cablati; criteri verifier nuovi.
- Docs: `BEDROCK.md` action table, `wiki/fluids.md`, righe in
  `wiki/verification.md`, `wiki/open-questions.md`.
- **Accettazione**: suite verde; `CURRICULUM=water_travel` raggiunge il
  milestone; e2e live.

---

## Piano di test

| Livello | Cosa | File |
|---|---|---|
| Unit puro | classificazione fluidi, `submersionState`, aria, cascate, atterraggio | `tests/bedrock-fluids.test.mjs` |
| Unit puro | fisica in acqua (`_physicsStep` su mondo finto) | `tests/bedrock-movement.test.mjs` |
| Unit puro | generazione nodi/vicini A* attorno ai fluidi | `tests/bedrock-movement.test.mjs` |
| Unit puro | regole governor `drowning`/`lava_contact`/`lava_near` | `tests/survival-governor.test.mjs` |
| Unit puro | skill/progressione fluidi | `tests/gameplay-skills.test.mjs`, `tests/progression.test.mjs` |
| Live | `/observe.fluids`, nuoto, `surface`, `dive`, cascata, fuga lava, secchio, barca, pozione | BDS CT 108 |

Vincoli operativi: un solo account bot (fermare il container prima dei test
locali), riavvio BDS a 0 giocatori su `connecterror:9`, `BEDROCK_DEBUG=1` se
serve, non toccare le infrastrutture d'acqua della base.

---

## Rischi e questioni aperte

1. **Modello di movimento in acqua Bedrock ignoto.** Flag `input_data` esatti e
   semantica di `delta`/`move_vector` da confermare con una cattura pacchetti
   (task M0/M1). Una predizione sbagliata = rubber-band e stallo.
2. **Segnale di annegamento.** Confermare se i metadata del self espongono
   `breathing`/aria o se il budget va **simulato** (celle d'acqua + timer).
   Nessuna assunzione senza cattura.
3. **Danno da caduta assente oggi.** Le cascate risolvono la discesa in acqua, ma
   non le cadute sulla terra: introdurre `_fallStartY` + `isSafeLanding` (M0).
4. **Danno/costo in acqua profonda.** Il pathfinding deve preferire guadi bassi e
   stimare l'aria necessaria; niente path attraverso oceani senza budget.
5. **Prestazioni.** La scansione fluidi su oceani grandi va limitata per raggio e
   per budget di subchunk (come già fa `findBlocks`).
6. **Mondo di famiglia.** Non rompere né redirigere pozzi, irrigazioni e cascate
   costruite; non piazzare acqua dentro le costruzioni senza consenso.
7. **Nether.** L'acqua non è piazzabile; la traversata lava richiede
   `fire_resistance` + ponti → tenuta gated.

---

## Non-obiettivi (per ora)

- Simulazione realistica della propagazione/flow dei fluidi.
- Costruzione subacquea oltre a estrazione e raccolta.
- Traversata completa del Nether.
- Elytra/volo.
