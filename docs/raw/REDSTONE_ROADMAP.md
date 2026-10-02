# Roadmap — Redstone e automazioni primitive

> Fonte grezza (spec). Sintesi in [`wiki/redstone.md`](../wiki/redstone.md).
> Stato: **spec, non implementato** (nessun supporto redstone in produzione).
> Riferimenti al codice: `bedrock-adapter.mjs`, `bedrock-world.mjs`,
> `bedrock-survival.mjs`, `survival/*`, `knowledge/*.json`.

## Obiettivo

Rendere il bot capace di **usare la redstone e costruire automazioni primitive**
con circuiti redstone, partendo dalle primitive già verificate (piazzamento,
interazione `click_block`, contenitori, crafting, scavo) e senza mai rompere i
circuiti o le costruzioni della base.

Esempi di obiettivo finale:

- `lever → redstone_lamp / piston / dispenser` (accensione a distanza);
- linea di ritardo a **repeater**; clock a repeater loop;
- `daylight_detector` → lampada automatica (luce di notte);
- `observer + piston` → raccolta automatica (canna da zucchero, bamboo, kelp);
- `hopper → chest` (trasporto item) e `crafter` (autocrafting, stretch);
- porta automatica con pressure plate / tripwire.

Principio: la redstone **non è magia da prompt**. È un insieme di blocchi con
**stato deterministico**, quindi: leggere lo stato → pianificare il circuito →
piazzare/interagire → **verificare lo stato** dal mondo. Nessun modello decide la
meccanica.

---

## Stato attuale (verificato dal codice e dal registry)

1. **Zero supporto redstone.** Non esiste alcun blocco, azione o regola redstone
   in `bedrock-adapter.mjs`, `knowledge/*.json`, `skills/gameplay/`.
2. **La base ha item redstone** (dust, sculk, ecc.) finiti a terra dopo un
   incidente (`INCIDENTS.md`): materiale disponibile, ma non censito.
3. **`DIG_PROTECTED` NON copre la redstone.** `dig_up`/`dig_down` possono
   distruggere `piston`, `redstone_wire`, `repeater`, `observer`, ecc. Lo stesso
   bug che ruppe un baule si applica ai circuiti.
4. **Il modello del mondo espone già lo stato.** `bedrock-world.mjs` decodifica i
   runtime id delle sezioni e `blockAt()` restituisce un blocco Prismarine con
   `getProperties()`. Verificato nel registry `bedrock_1.26.51`:

   | Blocco | Proprietà di stato |
   |---|---|
   | `redstone_wire` | `redstone_signal` 0..15 |
   | `lever` | `lever_direction`, `open_bit` |
   | `stone_button` / `<legno>_button` | `facing_direction`, `button_pressed_bit` |
   | `repeater`/`unpowered_repeater`/`powered_repeater` | `minecraft:cardinal_direction`, `repeater_delay` 0..3 |
   | `comparator`/`powered_comparator` | `minecraft:cardinal_direction`, `output_lit_bit`, `output_subtract_bit` |
   | `observer` | `minecraft:facing_direction`, `powered_bit` |
   | `dispenser` / `dropper` | `facing_direction`, `triggered_bit` |
   | `hopper` | `facing_direction`, `toggle_bit` |
   | `piston` / `sticky_piston` | `facing_direction` |
   | `daylight_detector` | `redstone_signal` 0..15 (`_inverted` per la notte) |
   | `sculk_sensor` | `sculk_sensor_phase` |
   | `tripwire_hook` | `attached_bit`, `direction`, `powered_bit` |
   | `crafter` | `crafting`, `orientation`, `triggered_bit` |
   | `redstone_lamp` / `lit_redstone_lamp` | due **blocchi distinti** (lit = cambio nome) |
   | `redstone_ore` / `lit_redstone_ore` (+ deepslate) | due blocchi distinti |
   | `tnt` | `explode_bit` (**pericolo**) |
   | `stone_pressure_plate`, `heavy_weighted_pressure_plate`, ... | `redstone_signal` |

   Quindi la **sensing** è già possibile a livello dati; manca solo esporla.
5. **Il piazzamento non controlla l'orientamento.** `_placeAtCell` clicca sempre
   la faccia superiore (`face: 1`, `clickPos {0.5,1,0.5}`), usa lo yaw verso il
   centro della cella e conferma solo `placed.name === blockName`. Per pistoni,
   observer, repeater, comparator, leve e torce **serve lo stato giusto**
   (`facing_direction`/`cardinal_direction`), e per i componenti a parete serve
   una faccia laterale.
6. **L'interazione `click_block` esiste ed è riusabile.** `_blockUseTransaction`
   è già usata per porte, letti, tavoli: può azionare **leve, pulsanti, pressione,
   fence gate, trapdoor** e ciclare **delay/mode** di repeater e comparator.
7. **Le opzioni di scavo sono guidate da `_refreshNearby`.** Offre `mine_<blocco>`
   solo per i blocchi nella sua lista fissa: **redstone ore e componenti non sono
   nella lista**, quindi il bot non li vede né li mina/sposta.
8. **`findBlocks` cerca solo per nome, non per stato**: non sa trovare "un
   repeater alimentato" o "una leva aperta".
9. **Crafting generico già pronto**: `craft_<item>` usa le ricette di
   `crafting_data`; repeater/comparator/piston/dispenser/dropper/observer/
   lampada/torcia redstone/hopper si craftano se i materiali e la ricetta sono
   presenti (da verificare quali arrivano nel BDS 1.26).

---

## Vocabolario proposto (loader chiusi, come da convenzione)

### Nuove chiavi azione `/options`

| Key | Significato |
|---|---|
| `build_circuit_<id>` | Costruisce un circuito primitivo dal blueprint (id: `lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`, `auto_harvest`, `auto_dispense`, `hopper_chain`, `crafter_pulse`). Una sola azione bounded, come `dig_down`. |
| `use_redstone` | Aziona la leva/pulsante più vicino (o un bersaglio dal plan) e verifica il cambio di stato. |
| `set_repeater_delay` | Cicla il delay di un repeater fino al valore richiesto. |
| `sense_redstone` | Diagnostica: legge componenti vicini + livelli di potenza. |
| `teardown_circuit` | Rimuove un circuito **costruito dal bot** (mai quelli della base). |
| `place_<componente>` | Piazzamento mirato con orientamento (estensione, non nuova tassonomia). |
| `mine_redstone_ore` | Aggiunto a `_refreshNearby` (serve il pickaxe di ferro). |
| `craft_<componente>` | Già generico. |

### Nuovi intenti (`survival/intents.mjs`)

`redstone` (costruire/piazzare circuiti), `toggle` (azionare), `sense`
(diagnostica). Mapping: `build_circuit_*`/`place_<componente>` → `redstone`+`build`;
`use_redstone`/`set_repeater_delay` → `toggle`; `sense_redstone` → `sense`.

### Nuovi tag item (`survival/item-tags.mjs`)

`redstone_dust` (`redstone`), `redstone_components` (repeater, comparator, piston,
sticky_piston, observer, dispenser, dropper, hopper, lever, button, pressure
plate, torch, lamp, daylight_detector, tripwire_hook, target, crafter),
`pistons`, `hoppers`.

### Nuove condizioni governor / criteri verifier

- Condizione: `redstoneNearby` (bool), `tntNearby` (bool, pericolo).
- Criteri: `blockStateAt` / `blockPoweredAt` (es. `{ position, property, value }`),
  `circuitActive` (definito dal blueprint), `inventoryTagGte` con i tag nuovi.

---

## Milestone

### R0 — Consapevolezza redstone e protezione (nessun circuito)

**Deliverable**

- **Proteggere la redstone in `DIG_PROTECTED`**: pistoni, sticky, observer,
  repeater, comparator, redstone_wire, torch, lever, bottoni, pressure plate,
  daylight detector, tripwire hook, dispenser, dropper, lampada, crafter,
  redstone_block, target. `dig_up`/`dig_down` e le azioni di scavo non devono
  toccarli.
- **`_refreshNearby` esteso**: `redstone_ore`, `deepslate_redstone_ore`,
  `lit_redstone_ore`, `lit_deepslate_redstone_ore` (minabili) e i componenti
  vicini (lista componenti).
- **`/observe.redstone`**: `{ components: [{name, position, distance,
  properties}], power: {position: signal}, ore: [...], tntNearby }`.
- **Ricerca per stato**: `findBlocksByState(names, predicate, point, radius)` in
  `bedrock-world.mjs` (o overload di `findBlocks`) per trovare "repeater
  alimentato", "leva aperta", "torcia accesa".
- **`observe().standingOn` già c'è**: aggiungere un helper `_blockProps(pos)`.
- **`tnt` = pericolo**: mai piazzare/azionare TNT; `tntNearby` in osservazione.
- Modulo puro **`bedrock-redstone.mjs`**: `isRedstoneComponent`, `powerOf(block)`
  (legge `redstone_signal`/`powered_bit`/`open_bit`/nome `lit_*`),
  `isSource`, `isOutput`, `circuitDanger`.

**Test**: `tests/bedrock-redstone.test.mjs` (puro: powerOf/facing),
`tests/bedrock-dig.test.mjs` (rifiuto redstone), `/observe` shape.

**Accettazione**: live `/observe.redstone` elenca i componenti vicini con le
proprietà corrette; `dig_down`/`dig_up` non rompono un circuito; redstone ore
compare tra le opzioni di scavo se il pickaxe è giusto.

---

### R1 — Piazzamento con orientamento (la parte critica)

**Deliverable**

- **`_placeAtCell` esteso** con un parametro `state`/`props`:
  - calcolo di yaw/pitch/faccia di click dalla direzione desiderata
    (`facing_direction`, `cardinal_direction`, `lever_direction`);
  - supporto a facce **laterali/inferiori** per componenti a parete (torce,
    leve, bottoni, tripwire hook);
  - conferma di piazzamento **nome + proprietà** (non solo nome);
  - retry correttivo: piazza → leggi `update_block` → se lo stato non è quello
    atteso, rompi il blocco appena messo e ripiazza con yaw/faccia corretti.
- **Task di scoperta protocollo (bloccante)**: confermare dal vivo come il BDS
  deriva lo stato di un blocco dal contesto di piazzamento (yaw/pitch del
  giocatore, faccia cliccata, `click_pos`, e se il `block_runtime_id` previsto
  deve combaciare). Pistone e repeater sono i due casi di prova.
- **`repeater_delay` e `output_subtract_bit`**: impostati con
  `click_block` (right-click) dopo il piazzamento, non al piazzamento →
  `set_repeater_delay` / `toggle_comparator_mode` con verifica di stato.

**Test**: unit sul calcolo yaw/faccia dalle proprietà attese (puro), world test
sul matching nome+props, live su repeater/pistone.

**Accettazione**: live piazzamento di un repeater con `cardinal_direction` e
`repeater_delay` attesi e di un pistone con `facing_direction` atteso, confermati
da `/observe.redstone`; un repeater porta il delay a 3 via interazione.

---

### R2 — Interazione e sensing

**Deliverable**

- **`use_redstone`**: trova la leva/pulsante più vicino (o dal plan), invia
  `click_block`, verifica `open_bit`/`button_pressed_bit` e l'effetto a valle
  (lampada accesa, pistone esteso, `triggered_bit`, `redstone_signal`).
- **Sensing continuo**: dopo ogni `update_block`, aggiornare una cache
  `redstoneState` e riesporla in `/observe` (già il `setBlock` aggiorna il
  mondo; serve solo leggerlo).
- **Diagnostica**: `sense_redstone` e una sezione `/survival` con
  `{ power, activeOutputs }` per il controller.
- **Sicurezza**: dopo ogni test, riportare gli input `off` (leva chiusa) e non
  lasciare clock attivi.
- **Verifier**: criteri `blockPoweredAt` / `circuitActive`.

**Test**: `survival/verify` con criteri nuovi; unit sul toggle; live su
`lever → lamp`.

**Accettazione**: live `lever → redstone_lamp`: `use_redstone` accende/spegne la
lampada e `/observe.redstone` mostra il cambio di nome `redstone_lamp ↔
lit_redstone_lamp`.

---

### R3 — Circuiti primitivi (blueprint dichiarativi)

**Deliverable**

- **`circuits/*.json`** (o `skills/redstone/`): blueprint dichiarativi, come le
  gameplay skill. Ogni circuito dichiara:
  - `id`, `description`, `requires` (materiali/tag), `anchor` (rispetto al bot),
  - `steps: [{ item, offset, facing, supportOffset, face, delay }]`,
  - `trigger` (leva/pulsante/pressure plate),
  - `success: [{ offset, property, expected }]` per la verifica deterministica,
  - `danger` (mai se coinvolge TNT/trappole).
- **Catalogo iniziale**:
  1. `lamp_switch` — leva → lampada (il più semplice).
  2. `delay_line` — leva → N repeater (delay crescente) → lampada; misura il
     ritardo reale tra trigger e uscita.
  3. `auto_lamp` — `daylight_detector_inverted` → lampada (luce automatica di
     notte).
  4. `auto_door` — bottoni/pressure plate → sticky piston (o fence gate);
     richiede consenso se è una porta della base.
  5. `auto_harvest` — `observer` su canna/bamboo → `piston` → `hopper`/acqua →
     `chest`. Dipende da M1 fluidi per il flusso d'acqua.
  6. `auto_dispense` — leva + clock a repeater → `dispenser`.
  7. `hopper_chain` — `hopper` → `chest` (trasporto item, collega lo storage).
  8. `crafter_pulse` — pulsazione → `crafter` (stretch, 1.21+).
- **`build_circuit_<id>`**: azione bounded che sposta il bot all'anchor, piazza
  in ordine, verifica ogni step, aziona il trigger, verifica `success` e
  registra l'esito in `runs/<run>/circuits.jsonl` (come `skills.jsonl`).

**Test**: validazione dei blueprint al load (come le gameplay skill), planner
puro che ordina e verifica gli step, world test su un mondo sintetico.

**Accettazione**: live `build_circuit_lamp_switch` e `build_circuit_delay_line`
costruiscono e verificano; il delay misurato corrisponde a quello impostato.

---

### R4 — Verifica, teardown e protezione della base

**Deliverable**

- **Verifier deterministico per circuiti**: dal solo stato del mondo, non
  dall'opinione del modello.
- **`teardown_circuit`**: rimuove **solo** i blocchi registrati come costruiti dal
  bot per quel circuito (lista `builtByBot`), con `DIG_PROTECTED` che impedisce
  di toccare tutto il resto.
- **Guardrail**: nessuna azione redstone su un circuito non costruito dal bot;
  nessun `mine_*` su componenti redstone salvo teardown esplicito.
- **Rollback**: se un circuito fallisce a metà, ripristinare l'anchor (rimuovere
  i blocchi piazzati) e riportare un errore, senza lasciare il mondo sporco.

**Accettazione**: un teardown live riporta i materiali nel delta inventario e
lascia il mondo come prima; un fallimento a metà non lascia blocchi orfani.

---

### R5 — Automazioni e integrazione

**Deliverable**

- **Skill dichiarative** `skills/gameplay/redstone/`: `redstone_basics`
  (minare redstone ore, craftare repeater/pistone), `build_lamp_switch`,
  `build_auto_lamp`, `build_auto_harvest`, `build_hopper_chain`.
- **Progressione** `knowledge/progression.json`: milestone `redstone_ore`
  (requires `stone_tools`, satisfiedWhen `inventoryTagGte: {redstone_dust: 1}`),
  `redstone_basics` (requires `redstone_ore`, skill `redstone_basics`),
  `redstone_automation` (requires `redstone_basics` + `hopper`/`bucket`),
  goal alias `redstone`.
- **Integrazioni**:
  - farming → `auto_harvest` (collega `FARMING-TASK` e le skill di raccolta);
  - storage → `hopper_chain` (collega `STORAGE-TASK`, trasporto item);
  - difesa/luci → `auto_lamp` e `place_torch` (collega `DEFENSE-TASK`);
  - fluidi → `auto_harvest` con flusso d'acqua (dipende da M1).
- **`CURRICULUM=redstone_automation`** end-to-end.

**Accettazione**: suite verde; `CURRICULUM=redstone_automation` costruisce almeno
un circuito verificato; nessun circuito della base rotto.

---

### R6 — Limiti, sicurezza e documentazione

- **No command block**: `allow-cheats=false`, e comunque fuori scope.
- **No TNT/trappole** senza consenso esplicito; mai costruire trappole che
  colpiscono giocatori/villager.
- **Lag**: limite alla dimensione dei circuiti e divieto di clock troppo veloci
  (un clock a repeater a 1 tick satura il BDS); il bot spegne i clock dopo il test.
- **Sicurezza del bot**: non sostare nel percorso di un pistone; non azionare
  circuiti che possano danneggiarlo.
- **Documentazione**: `BEDROCK.md` action table, `wiki/redstone.md`,
  `wiki/verification.md`, `wiki/open-questions.md`, `wiki/roadmap.md`.

---

## Piano di test

| Livello | Cosa | File |
|---|---|---|
| Unit puro | `powerOf`, `facingFromDirection`, `isSource/isOutput`, planner blueprint | `tests/bedrock-redstone.test.mjs` |
| Unit puro | ricerca per stato (`findBlocksByState`) | `tests/bedrock-world.test.mjs` |
| Unit puro | rifiuto scavo redstone (`DIG_PROTECTED`) | `tests/bedrock-dig.test.mjs` |
| Unit puro | validazione blueprint + verifier `blockPoweredAt` | `tests/gameplay-skills.test.mjs`, `tests/survival-*` |
| Live | `/observe.redstone`, piazzamento orientato, `use_redstone`, `build_circuit_*`, teardown | BDS CT 108 |

Vincoli operativi: un solo account bot (fermare il container), BDS a 0
giocatori su `connecterror:9`, `BEDROCK_DEBUG=1`/`BEDROCK_PACKET_LOG=1` per la
cattura di piazzamento, non toccare i circuiti esistenti della base.

---

## Rischi e questioni aperte

1. **Orientamento di piazzamento (bloccante, R1).** Il BDS deriva lo stato dal
   contesto; il client deve fornire yaw/faccia/click_pos corretti. Fallback: ciclo
   "piazza → leggi → correggi". Da confermare con cattura pacchetti.
2. **Stati che cambiano runtime id.** `redstone_wire` ha 16 stati, repeater 16,
   comparator 16, observer 12, ecc. Il `setBlock` li gestisce via palette, ma la
   conferma di stato va testata sul campo (specialmente con `unknown`).
3. **Blocchi mancanti nel registry 1.26.** `note_block`, `tripwire` e
   `pressure_plate` generico risultano assenti nel registry `bedrock_1.26.51`:
   verificare i nomi corretti (es. `noteblock`?) o escluderli dal catalogo.
4. **Ritardi/tick.** Il delay dei repeater è in tick; la misura live del tempo
   serve a tarare la verifica. Clock troppo veloci saturano il server.
5. **Verifica di potenza indiretta.** `redstone_wire.redstone_signal` dà il
   livello solo sulla cella letta; il "circuito funziona" va verificato
   sull'**output** (lampada/pistone/dispenser), non solo sul filo.
6. **Lag e TPS.** Grandi circuiti o clock continui abbassano il TPS del BDS
   condiviso: limiti di dimensione e spegnimento obbligatorio.
7. **Materiali limitati.** La redstone è un bene raro; censire l'inventario e non
   sprecarla in test, riportando i materiali col teardown.
8. **Mondo di famiglia.** Non modificare i circuiti esistenti; costruire in aree
   concordate e usare ancora/waypoint della base.

---

## Non-obiettivi (per ora)

- Computer redstone / logica complessa multi-bit.
- Glitch e 0-tick / 1-tick instabili tra versioni.
- Fabbriche su larga scala e mob farm (performance + sicurezza).
- Command block, `fill`/`setblock` (cheat disattivati).
- Trappole per giocatori/villager.
