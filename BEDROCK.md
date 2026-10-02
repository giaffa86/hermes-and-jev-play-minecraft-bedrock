# Hermes + Jev → Minecraft Bedrock Edition

Questo documento descrive il porting del progetto originale da Minecraft Java Edition a Minecraft Bedrock Edition.

L'architettura è la stessa: **Hermes** pianifica, **Jev** sceglie un'azione tra quelle valide, e un **harness Bedrock** esegue l'azione nel mondo reale tramite un bot Bedrock autenticato.

---

## Componenti Bedrock

| Path | Ruolo |
|---|---|
| `bedrock-harness.mjs` | Entry point del container: connette il bot Bedrock al BDS e espone l'HTTP API (`/observe`, `/options`, `/act`, `/plan`, `/survival`). Applica anche il filtro di emergenza del Survival Governor alle opzioni. |
| `bedrock-adapter.mjs` | Adattatore che traduce lo stato Bedrock nel formato atteso da `controller.mjs`. |
| `controller-decisions.mjs` | Funzioni pure del controller (nessun I/O): ranking/tetto delle opzioni (inclusi gli intenti della skill attiva), anti-loop, fingerprint di progresso, diagnostica e istruzioni di decisione. Unit test in `tests/controller-decisions.test.mjs`. |
| `survival/` | Survival Intelligence Layer deterministico: perception, risk/needs, governor, regole, intenti, tag item, skill dichiarative, resolver, verifier, progressione, esperienza. Unit test dedicati. |
| `knowledge/` | `survival-rules.json` (quando interrompere la progressione) e `progression.json` (grafo dei milestone con dipendenze). |
| `skills/gameplay/` | Skill di gioco dichiarative (JSON): precondizioni, criteri di successo, intenti. Concetto diverso dalla skill Hermes `SKILL.md`; nessun codice eseguibile. |
| `bedrock-world.mjs` | Registry Bedrock 1.26 e decoder Prismarine v9; richieste `subchunk_request`, gestione di hash sconosciuti e sezioni non ricevute. |
| `bedrock-lifecycle.mjs` | Disconnessione del gioco prima del teardown SCTP/DTLS e attesa della pulizia asincrona, riutilizzabile dai test. |
| `Dockerfile` | Immagine Node.js 24 con il progetto e le dipendenze. |
| `docker-compose.yml` | Avvia il container su host Docker con le reti corrette e la persistenza della cache Xbox. |
| `test-ping.mjs` | Ping NetherNet al server Bedrock. |
| `test-connect.mjs` | Connessione + spawn di test. |

---

## Requisiti

- Server Minecraft Bedrock Dedicated Server `1.26.50+` con `transport=nethernet`.
- Account Microsoft/Xbox del bot aggiunto all'allowlist del server.
- VM/LXC Linux con Docker (testato su host Docker, `<ip-host>`).
- Cache token Xbox Live in `~/.minecraft/nmp-cache` (popolata al primo login).

---

## Variabili d'ambiente

Copiare `.env.example` in `.env` e valorizzare:

```bash
# Connessione Bedrock
BEDROCK_HOST=<ip-server-bedrock>
BEDROCK_PORT=19132
BEDROCK_USERNAME=<gamertag_o_email>
BEDROCK_AUTH_TITLE=MinecraftNintendoSwitch

# Harness
API_PORT=3077
RUN_ID=demo

# Jev (TypeSafe)
TYPESAFE_API_KEY=ts-...
CONTROLLER=jev
JEV_MODEL=jev-latest

# Obiettivo
GOAL="Hold at least 4 dirt in inventory and stand within 2 blocks of the waypoint."
WAYPOINT='{"x":380,"z":16}'
TARGETS='{"dirt":4}'
MAX_STEPS=20
REPLAN_EVERY=8

# Qualità delle decisioni (opzionali)
MAX_OPTIONS=12          # tetto di opzioni passate a Jev (0 = nessun tetto)
ANTI_LOOP_THRESHOLD=3   # azioni consecutive senza progresso prima di replan/esclusione
ANTI_LOOP_COOLDOWN=3    # passi in cui la key bloccata resta esclusa
```

> Non committare `.env` o la cache `nmp-cache`.

---

## Deploy su host Docker

### 1. Copia del progetto

Dall'host Proxmox:

```bash
rsync -avz --exclude=node_modules --exclude=runs --exclude=.git \
  <percorso-progetto>/ \
  -e 'ssh -i <chiave-ssh>' \
  <utente-ssh>@<ip-host>:~/hermes-jev-bedrock/
```

### 2. Cache Xbox Live

Popolare `./nmp-cache` con i token precedentemente autenticati:

```bash
rsync -avz -e 'ssh -i <chiave-ssh>' \
  ~/.minecraft/nmp-cache/ \
  <utente-ssh>@<ip-host>:~/hermes-jev-bedrock/nmp-cache/
```

> Se la cache non esiste, al primo avvio il container stamperà un URL `microsoft.com/link` e un codice da inserire dopo aver fatto login con l'account del bot.

### 3. Avvio

```bash
ssh -i <chiave-ssh> <utente-ssh>@<ip-host>
cd ~/hermes-jev-bedrock
# Usare --build dopo aver modificato sorgenti/Dockerfile
sudo docker compose up -d --build
sudo docker logs -f hermes-jev-bedrock
```

### 4. Verifica rete

Dal container:

```bash
# Ping Bedrock server
sudo docker exec hermes-jev-bedrock node test-ping.mjs

# Ping container Hermes
sudo docker exec hermes-jev-bedrock ping -c 3 <ip-container-hermes>
```

### 5. Avvio controller

`controller.mjs` richiede il CLI `hermes` per la pianificazione. Il container agente non include Hermes CLI, quindi il controller va eseguito **dentro il container Hermes esistente** tramite `docker exec` (nessuna modifica all'immagine). Da questo aggiornamento il controller importa `controller-decisions.mjs`, `survival/`, `knowledge/` e `skills/gameplay/`: copia l'intero progetto (o monta la directory read-only) invece dei due soli file.

Copia il progetto nel container Hermes:

```bash
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/controller.mjs hermes:/tmp/controller.mjs
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/controller-decisions.mjs hermes:/tmp/controller-decisions.mjs
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/survival hermes:/tmp/survival
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/knowledge hermes:/tmp/knowledge
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/skills hermes:/tmp/skills
```

Esegui il loop (usa `-w /opt/data` per persistere le run sul volume Hermes):

```bash
sudo docker exec \
  -w /opt/data \
  -e RUN_ID=demo \
  -e HARNESS=http://hermes-jev-bedrock:3077 \
  -e WAYPOINT='{"x":380,"z":16}' \
  -e TARGETS='{"dirt":4}' \
  -e MAX_STEPS=14 \
  -e CONTROLLER=jev \
  -e TYPESAFE_API_KEY="$TYPESAFE_API_KEY" \
  -e JEV_MODEL=jev-latest \
  hermes node /tmp/controller.mjs
```

Per la milestone automatica (curriculum deterministico) aggiungi `-e CURRICULUM=first_night` e ometti `WAYPOINT`/`TARGETS`.

Le run verranno scritte in `/opt/data/runs` (volume `hermes-data`). Per copiarle nel progetto:

```bash
sudo docker cp hermes:/opt/data/runs /home/<utente-ssh>/hermes-jev-bedrock/runs-from-hermes
```

---

## Architettura di rete su host Docker

```text
+----------------+       hermes-internal       +------------------+
|    hermes      | <--------------------------> | hermes-jev-bedrock|
|  (container)   |                              |   (container)     |
+----------------+                              +------------------+
                                                       |
                                                       | bridge
                                                       v
                                               <ip-server-bedrock>:19132
                                               (server Bedrock BDS)
```

- `hermes-internal`: rete Docker di Hermes, usata per la comunicazione tra i container.
- `hermes-jev-bedrock`: rete bridge locale del container agente, usata per raggiungere il BDS e le API remote.
- Il container agente ha quindi due interfacce: una verso Hermes e una verso l'esterno.

---

## Stato delle azioni Bedrock

| Azione | Stato | Note |
|---|---|---|
| `wait` | ✅ Funzionante | |
| `goto_waypoint` | ✅ Funzionante | Movimento server-authoritative via `player_auth_input` (fisica locale: gravità, collisioni, gradini, salti) + pathfinding A* sul mondo caricato; apre le porte sul percorso. |
| `collect_drop` | ✅ Funzionante | Traccia gli item entity (`move_entity`/`move_entity_delta`), cammina fino al drop e verifica il pickup (`take_item_entity`). La ricerca del nodo usa la quota del drop, altrimenti un drop sotto il bot non viene mai raggiunto. |
| `mine_*` | ✅ Funzionante | Rottura reale con `player_auth_input` + `block_action`, conferma dal server e evento di distruzione. Prima di rompere, l'adapter seleziona l'utensile giusto (piccone/ascia/pala/ zappa, miglior tier) e i tempi di rottura seguono la formula vanilla (pietra col piccone di legno ≈ 1,3 s). Senza piccone le opzioni `mine_stone`/`mine_cobblestone` non vengono offerte (nessun drop). Per i minerali serve anche il rango giusto: `_blockHarvestable` confronta il rango del piccone (legno/oro = 1, pietra/rame = 2, ferro = 3, diamante = 4, netherite = 5) con l'insieme `harvestTools` del blocco; `mine_iron_ore` non è offerto col piccone di legno. |
| `dig_down` | ✅ Funzionante | Scava un gradino (testa, fronte e cella sotto il fronte), poi avanza e scende; i gradini restano percorribili anche in salita. Rifiuta blocchi protetti (tavoli, contenitori, stazioni, e materiali da costruzione: assi, lastre, scale, lana, vetro, mattoni). Se il gradino è già aperto scende soltanto. Le celle con hash non risolto (`unknown`) vengono scavate con una rottura grezza. |
| `dig_up` | ✅ Funzionante | Specchio di `dig_down`: apre anche la volta sopra la testa (serve spazio per il salto), il gradino davanti e le due celle sopra di esso, poi sale. Gli `unknown` sono bersagli raw. Verificato live il 02/10: uscita dalla buca dello scavo (da y=67 a y=73, 5 gradini) e protezione dei blocchi sensibili (tavoli, bauli, stazioni). Se lo scalino è già aperto sale e basta. |
| `attack_<mob>` | ✅ Base | Insegue e colpisce il mob ostile più vicino del tipo richiesto (fino a 25 s per azione) con transazione `item_use_on_entity` (`action_type: attack`) + `animate swing_arm`; equipaggia la spada migliore in hotbar; si ferma quando il mob sparisce o la sua vita arriva a 0. Verificato live il 02/10: 19-20 colpi a segno in 25 s a 1,6 blocchi (senza spada in inventario il danno è basso; `combat_timeout` riporta `hits` e il mob resta danneggiato). |
| `flee` | ✅ Funzionante | Si allontana dal mob ostile più vicino provando più direzioni e distanze (9-16 blocchi) con pathfinding. Verificato live il 02/10: distacco reale di ~7 blocchi; se un tentativo va in timeout ma il distacco cresce l'azione riporta `ok` con `partial: true`. |
| `eat` | ✅ Base | Equipaggia il cibo preferito disponibile (lista sicura: cotti prima, poi pane/patate/carote/frutta; esclusi quelli con effetti negativi) e invia `item_use` `click_air`; conferma quando la fame sale o l'item cala. Forma pacchetto verificata; il collaudo live richiede cibo in inventario e fame < 20 (finora il bot era pieno o senza cibo). |
| `sleep` | ✅ Funzionante | Di notte cerca il letto più vicino (blocco `bed` nel mondo caricato), ci cammina accanto e lo clicca (`click_block`). Conferma dal flag `resting` nei metadata oppure, con un solo giocatore, dal salto d'orario dell'alba (`slept: 'night_skipped'`). Verificato live il 02/10 (due notti saltate). `player_bed_position` non è usato come stato (è il letto di respawn); con mostri vicini il server rifiuta e l'azione riporta `sleep_rejected`. |
| `craft_*` | ✅ Funzionante | Ricette da `crafting_data` (network id), griglia 2×2 nell'inventario e 3×3 al tavolo da lavoro; item_stack_request `craft_recipe` con consumi e output. I tag `stone_tool_materials`/`stone_crafting_materials` sono mappati (cobblestone/cobbled_deepslate/blackstone) e `minecraft:coals` (carbone + carbonella) per le torce; `craft_furnace` usa 8 cobblestone al tavolo. |
| `smelt_*` | ✅ Funzionante | Fusione con mappa statica input→output (il protocollo 1.26 non manda le `furnace_recipes` nel `crafting_data`; se presenti, hanno priorità) e **stazione adatta**: altoforno (`blast_furnace`) per i minerali, affumicatore (`smoker`) per il cibo, fornace base per tutto il resto, con fallback alla fornace se la stazione preferita non c'è. Apre la stazione (`click_block`), mette 1 materiale nel container ingrediente giusto (`furnace_ingredient`/`blast_furnace_ingredient`/`smoker_ingredient`) e 1 combustibile in `furnace_fuel` (carbone/carbonella, poi assi/tronchi), aspetta l'output dagli aggiornamenti slot del server (con riapertura della stazione come ripiego) e lo ritira in inventario. **Verificato live il 02/10**: `craft_furnace` → `place_furnace` → `smelt_raw_iron` → `iron_ingot` (15,8 s, 1 carbone consumato). |
| `recover_loot` | ✅ Base | Recupero post-morte: il sito di morte è registrato su `deathSite` (posizione dei piedi); dopo il respawn l'azione ci torna con il pathfinding, raccoglie i drop nel raggio di 12 blocchi e resta un momento sul posto per gli orb EXP. `/observe` espone `deathSite` ed `experience`; il risultato riporta `recovered`, `leftNearby`, `expGained`. Coperto da unit test. |
| `place_*` | ✅ Base | Piazzamento con transazione `click_block`; usato per tavoli da lavoro e fornaci. Lo swap in hotbar rilegge l'inventario dal server (riconnessione) se lo stack id è stantio. |

### Sopravvivenza (aggiornamento 02/10/2026)

- **Entità**: `add_entity`/`add_player`/`move_entity`/`set_entity_data`/`entity_event` alimentano una mappa di mob e giocatori con posizione, distanza e vita (metadata `health`); una lista di tipi classifica gli ostili (zombie, skeleton, creeper, enderman, ...).
- **Ora del giorno**: BDS 1.26 non invia `set_time`; l'ora arriva da `sync_world_clocks` (clock `minecraft:overworld`, `% 24000`) con fallback `set_time`.
- **Attributi del giocatore**: `update_attributes` usa il campo `current` (non `value`) per vita, fame e livello/esperienza (`minecraft:player.level`, `minecraft:player.experience`).
- **Morte e respawn**: vita <= 0 → stato `dead`; il client invia `player_action` respawn e completa il flusso rispondendo ai pacchetti `Respawn` del server con `state = 2` (client_ready). La posizione finale si applica allo `state 1`; fallback a 4 s. Verificato live il 02/10 (il bot è morto in combattimento e si è risvegliato al letto).
- **Recupero post-morte**: alla morte il sito viene registrato (`deathSite`); dopo il respawn `/options` offre `recover_loot`, che torna sul posto, raccoglie i drop nel raggio di 12 blocchi e resta un momento per gli orb EXP. Il sito resta finché non c'è più loot vicino (o finché il percorso fallisce: si ritenta dopo). Coperto da unit test; collaudo live in corso.
- **Limbo post-respawn**: se il fallback chiude il respawn ma la vita resta a 0 (server non pronto, input ignorati), il tick di sopravvivenza riapre il flusso di respawn dopo 5 s (`respawn_limbo_recover`). Recupero osservato live il 02/10 con un riavvio del container (poi automatizzato).
- **Hash non risolti**: i blocchi `unknown` sono conservativi nella pianificazione (niente percorsi attraverso muri invisibili) e scavabili con rottura grezza (`_mineRawCell`).
- `/observe` espone `time`, `sleeping`, `dead`, `deaths`, `deathSite`, `experience`, `entities` (con distanza, tipo e vita).
- `/options` offre `attack_<tipo>`, `flee`, `eat`, `sleep`, `dig_up` e `recover_loot` quando validi; le opzioni `attack_` sono deduplicate per tipo.
- Verificato live (02/10): tracking entità (cat, maiali, creeper/zombie/skeleton con vita), orologio/notte, fame, letti della base, attacco (colpi a segno), fuga, sonno (due notti saltate), morte+respawn, mining/rottura (anche di celle `unknown`), dig_up dalla buca, recupero post-morte (loot + EXP), carbone e ferro minati e raccolti, fusione `raw_iron → iron_ingot`. `eat` resta coperto da unit test e serializzazione: per il collaudo live servono fame < 20 e cibo in inventario.
- Diagnostica: rotte `GET /debug/geom` e `POST /debug/mine` (solo con `BEDROCK_DEBUG=1`); log opzionali `BEDROCK_PACKET_LOG=1` e `BEDROCK_META_LOG=1`.

### Fase pietra della milestone (aggiornamento 01/10/2026)

Catena `legno → piccone di legno → scavo → pietra → piccone di pietra` completata dal loop Hermes → Jev → Bedrock:

1. `dig_down` scava la scalinata nel terreno (dirt/grass) e scende di un blocco per azione; quando il gradino è `stone` viene usato il piccone di legno e la discesa raccoglie automaticamente il cobblestone.
2. `mine_stone`/`mine_cobblestone` con `wooden_pickaxe` in mano: conferma server + evento di distruzione con tempo vanilla (≈ 1,3 s con piccone di legno); i drop vengono raccolti con `collect_drop`.
3. `craft_stone_pickaxe` (3 cobblestone + 2 bastoni) alla griglia 3×3 di un tavolo da lavoro.

Run di riferimento: `runs/e2e-stone6/controller.jsonl` — `GOAL MET after 33 actions`, inventario con `stone_pickaxe: 1` (avvio da inventario senza utensili: legno, craft del piccone di legno, scavo e piccone di pietra). Evidenze dello scavo con discesa: `runs/e2e-stone1/controller.jsonl`.

### Fase minerali e durabilità (aggiornamento 01/10/2026)

Dopo la pietra il passo successivo sono i minerali: carbone (qualsiasi piccone) e ferro/rame (piccone di pietra o superiore). La validità resta nell'harness:

1. **Rango di raccolta**: gli insiemi `harvestTools` del registry 1.26, confrontati con le versioni precedenti (in 1.21.42 non esistono strumenti di rame), danno il rango per materiale: legno/oro = 1, pietra/rame = 2, ferro = 3, diamante = 4, netherite = 5. `_blockHarvestable` rifiuta il blocco se nessun utensile in inventario copre il rango; le opzioni `mine_*` non vengono offerte per il tier sbagliato.
2. **Scelta dell'utensile**: `_selectToolFor` preferisce il piccone più veloce *tra quelli che lasciano il drop* e usa il più veloce in assoluto solo come ripiego. Sul carbone vince il piccone d'oro (veloce), sul ferro scatta quello di pietra.
3. **Durabilità**: BDS tiene il consumo nell'NBT `Damage` (il metadata resta 0); `/observe` espone `heldDurability: {damage, max}` per l'oggetto in mano e le richieste di rottura inviano `predicted_durability` coerente.
4. **Craft propedeutici**: mappato il tag `minecraft:coals` (carbone + carbonella) per `craft_torch`; `craft_furnace` compare con 8 cobblestone e un tavolo vicino.
5. **Rilevamento minerali**: `/observe.nearby` include carbone, ferro e rame (anche varianti deepslate).

Evidenza live (host Docker, container `hermes-jev-bedrock`):

- `runs/e2e-minerals1/controller.jsonl` — `GOAL MET after 2 actions`, `mine_copper_ore` con `stone_pickaxe`, `collect_drop` → `raw_copper: 1`.
- `runs/e2e-minerals5/controller.jsonl` — carbone minato più volte e raccolto (`coal: 6`); morte in combattimento con **recupero del loot e +1 EXP** (`recover_loot` → `recovered: [stone_pickaxe, oak_log, coal, oak_planks, wooden_pickaxe ×2]`).
- `runs/e2e-iron3/controller.jsonl` — `GOAL MET after 25 actions`: ricraft del piccone di pietra, `mine_iron_ore` confermata e `raw_iron: 1`.
- `runs/e2e-smelt1/controller.jsonl` — `GOAL MET after 3 actions`: `craft_furnace` → `place_furnace` → `smelt_raw_iron` → **`iron_ingot: 1`** (stazione `furnace`, 1 carbone).

204 test unitari verdi (inclusi `survival/` e `controller-decisions.mjs`). Durante questi collaudi sono stati corretti: steering di `dig_down` verso il waypoint, eviction della hotbar piena (`hotbar_evict`), mappatura container per take/place (`hotbar`/`hotbar_and_inventory`, finestra aperta obbligatoria) e recupero del cursore sporco dopo un place fallito.

### Controller robusto (aggiornamento 01/10/2026)

`controller.mjs` non si blocca più se il planner Hermes è indisponibile o lento:

1. la CLI viene lanciata con `spawn` detached e, a `HERMES_TIMEOUT_MS` (default 180000), l'intero process group viene terminato (`SIGKILL`) — lo shim `hermes` fork-a un processo che altrimenti tiene aperto lo stdout e fa attendere `spawnSync`/`execFileSync` per sempre;
2. se la CLI non risponde, il controller degrada a un piano statico costruito da `GOAL`/`TARGETS`/`WAYPOINT` (`plan_fallback` nei log) e prosegue con Jev;
3. l'azione appena fallita viene esclusa dalla scelta successiva, così un `goto_waypoint` senza percorso non consuma tutto il budget.

### Qualità delle decisioni di Jev (aggiornamento 02/10/2026)

La logica pura è in `controller-decisions.mjs` (18 unit test in `tests/controller-decisions.test.mjs`); il harness resta l'unico proprietario della validità e il controller può solo riordinare, limitare o nascondere temporaneamente le key offerte.

1. **Istruzioni di decisione** (`buildDecisionInstructions`): priorità esplicite — sopravvivenza (fuga se vita bassa o lotta persa, sonno se notte e letto raggiungibile, cibo se fame bassa, attacco solo con vita sufficiente), recupero (drop e sito di morte), obiettivo — più la regola "non ripetere un'azione che non ha prodotto progresso".
2. **Anti-loop**: dopo ogni azione il controller confronta il fingerprint dell'osservazione (posizione arrotondata, inventario, obiettivo del piano) con quello del momento della scelta. `ANTI_LOOP_THRESHOLD` (default 3) azioni consecutive della stessa key senza progresso forzano un replan e mettono la key in cooldown per `ANTI_LOOP_COOLDOWN` passi (default 3). Log: `no_progress`, `anti_loop`, `replan`. Il controller non svuota mai l'insieme: se tutto è escluso, ripristina le opzioni del harness.
3. **Tetto opzioni**: con più di `MAX_OPTIONS` (default 12; 0 disabilita) opzioni, le più rilevanti sopravvivono (sopravvivenza → recupero loot → drop → azioni che colpiscono i target → craft/piazzamento/fusione → viaggio/scavo → mining generico → `wait`, con distanza come spareggio). `wait` viene nascosto quando esiste un'alternativa; le escluse finiscono nei log (`options.excluded`, `options.droppedByCap`).
4. **Diagnostica**: ogni decisione logga le key candidate con la probabilità per key (non solo l'indice scelto), `selectedProbability`, `confidence`, `cost`, `ms` e l'obiettivo; `wait_only` registra il motivo (riconnessione, morte, sonno, nessuna opzione utile) quando il harness offre solo `wait`; `result` registra l'esito di ogni azione; `goal_met`/`budget_exhausted` includono il costo totale.
5. **Smoke test**: con un harness finto in `/tmp` un loop di 3 `goto_waypoint` stagnanti ha prodotto `anti_loop` → replan → esclusione → scelta di `mine_dirt` (log `runs/smoke-decisions/controller.jsonl`).

### Survival Intelligence Layer (aggiornamento 02/10/2026)

Layer deterministico tra l'obiettivo utente e le bounded action, ispirato ai concetti di Voyager (skill library, curriculum, self-verification) **senza** code-generation: nessun modello genera JavaScript per il comportamento Minecraft. Architettura completa e guide di estensione in [`docs/SURVIVAL-INTELLIGENCE.md`](docs/SURVIVAL-INTELLIGENCE.md).

1. **Survival Governor** (`survival/governor.mjs` + `knowledge/survival-rules.json`): valutazione di vita/fame/ostili/notte con regole esplicite e priorità. Output `{mode: normal|caution|emergency, needs, overrideObjective, allowedIntents, preferredSkills, risk}`; con priorità ≥ 95 o rischio `critical` scatta l'emergenza, l'obiettivo mostrato al decision model viene sovrascritto e `/options` viene ristretto agli intenti ammessi (il filtro può solo togliere key già offerte, mai aggiungerne, e non svuota mai il set).
2. **Stato compatto in `/observe`**: `survival: {mode, risk, level, rule, needs, reasons, overrideObjective}`. `GET /survival` espone governor completo, skill attiva e milestone suggerito.
3. **Skill gameplay dichiarative** (`skills/gameplay/**`): JSON con precondizioni, criteri di successo/fallimento e intenti; concetto diverso dalla skill Hermes `skills/minecraft-bounded-agent/SKILL.md`. Il loader valida i file all'avvio di harness e controller.
4. **Skill Resolver** (`survival/resolver.mjs`): la skill attiva è quella preferita dal governor in emergenza, poi il campo opzionale `skill` del piano, poi il milestone della progressione; gli intenti della skill attiva danno un boost di rilevanza nel ranking delle opzioni del controller.
5. **Verifica deterministica** (`survival/verify.mjs`): `verifySkill(skill, before, after)` controlla lo stato reale (inventario per tag, variazioni fame/vita, distacco dagli ostili, notte sopravvissuta). Ogni esito finisce in `runs/<run>/skills.jsonl` (skill, esito, azioni, durata, motivazione).
6. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`): grafo con dipendenze; `resolveMilestone` restituisce il primo prerequisito mancante. Con `CURRICULUM=<milestone>` (es. `first_night`, `enter_nether`) il controller costruisce da solo i piani deterministici e usa Hermes solo come fallback.
7. **Smoke test offline**: harness finto + stub del CLI `hermes` ha eseguito `wood → crafting table → cibo → first_night` con un'interruzione di emergenza (creeper a 4.2 blocchi, vita 4) che ha filtrato le opzioni a `[flee, eat]` e poi è ripresa dallo stesso milestone; `GOAL MET after 7 actions`, 4 record in `runs/smoke-curriculum/skills.jsonl`.

### Inventario e stack id (aggiornamento 01/10/2026)

BDS 1.26 non invia aggiornamenti slot al pickup (`take_item_entity` aggiorna solo i conteggi aggregati). Se un pickup si fonde con uno stack esistente, il server assegna un nuovo `stack_id` che il client non conosce: `take`/`place`/`swap` falliscono con status 49/50 (`FailedToValidateSrc/DstSlot`).

L'adapter gestisce il caso in modo auto-riparante:

1. i pickup sono accumulati in `pickups` e mostrati nell'aggregato (`/observe`) finché non vengono riconciliati;
2. se un craft fallisce con `missing_ingredients` (aggregato > slot) o `take_failed_49/50`/`place_failed_49/50`, l'adapter si riconnette una volta (`inventory_resync` nei log): al login BDS invia sempre `inventory_content` completo con gli stack id aggiornati;
3. poi ritenta il craft con gli id freschi.

Lo stesso resync viene usato quando uno swap in hotbar o un piazzamento trova uno stack id stantio.

**Mappatura container per take/place (scoperta live il 02/10/2026)**: le richieste `item_stack_request` valgono solo con una **finestra aperta** (senza container BDS risponde 49/50). Fuori dal crafting valgono queste regole:

1. **sorgenti**: hotbar con `hotbar`/0..8, main inventory con `hotbar_and_inventory`/**indice assoluto** (0..35); `inventory` come sorgente dà status 49;
2. **destinazioni**: sempre `hotbar_and_inventory`/indice assoluto (0..35); `inventory` in destinazione dà status 50;
3. gli **swap diretti cross-container** non sono accettati: per spostare un item si usa take→cursore e place→destinazione;
4. un **place fallito lascia l'item sul cursore lato server**: i take successivi verso il cursore falliscono con 50 finché non lo si rimette in uno slot (l'adapter riprova a rimetterlo nella sorgente).

Questo ha risolto il blocco "hotbar piena": il bot sposta il ciarpame in un buco dell'inventario (eviction) e porta l'utensile in hotbar, tutto via cursore.

### Crafting e piazzamento (aggiornamento 01/10/2026)

BDS usa `item_stack_request` con **stack id** degli slot e una sessione container aperta:

1. `interact open_inventory` apre l'inventario (griglia 2×2 ai blocchi 30/31/28/29); un `click_block` sul tavolo apre la finestra `workbench` (griglia 3×3 ai blocchi 32..40).
2. Per ogni ingrediente: `take` dall'inventario al cursore, `place` dal cursore alla griglia (con lo stack id corrente dello slot di destinazione).
3. La richiesta di craft contiene `craft_recipe`, `results_deprecated`, un `consume` per ogni slot della griglia e un `place` dall'output creato (`creative_output`, slot 50, stack id = id della richiesta) verso l'inventario.
4. Le risposte `item_stack_response` vengono applicate alla copia locale dell'inventario; la griglia e il cursore sono tracciati e ripuliti in caso di errore.

Attenzione: `slot_type.dynamic_container_id` va **omesso** (con il campo presente BDS tratta il container come dinamico e rifiuta le richieste). Gli stack id delle pile esistenti sono obbligatori per fondere l'output; gli attrezzi (stack 1) non si fondono.

Verificato sul server reale: `oak_log → oak_planks → stick → crafting_table → place → wooden_pickaxe` e loop Hermes → Jev → Bedrock con `GOAL MET` (4 `wooden_pickaxe` in inventario).

### Movimento (aggiornamento 01/10/2026)

BDS 1.26 usa il movimento **server-authoritative**: il client invia ogni tick un
`player_auth_input` con posizione simulata, `move_vector` e flag di intento; il tick
deve restare nella finestra di rewind (`rewind_history_size`, 40 tick) e viene
riallineato da `correct_player_move_prediction`. Il vecchio `move_player` con
posizioni arbitrarie viene scartato o riportato indietro dal server: da qui i
`movement timeout` sui tragitti con ostacoli o dislivelli.

L'adapter ora:

1. simula localmente camminata (0,2158 b/tick), gravità, collisioni, gradini e salti;
2. invia la posizione simulata e l'intento (`up`, `jumping`, `start_jumping`, flag di collisione) nello stesso `player_auth_input`;
3. pianifica con A* sul mondo caricato (supporto, gradini ±1, cadute fino a 4 blocchi) verso il nodo camminabile più vicino al bersaglio;
4. apre le porte chiuse con una transazione `click_block` (`item_interact`) quando le incontra;
5. accetta le correzioni del server oltre 0,75 blocchi e riallinea l'ancora dei tick.

Verificato sul server reale: uscita dalla stanza di spawn attraverso la porta, tragitti
di 13-21 blocchi con posizione client e server coincidenti, raccolta dei drop con
conteggio inventario aggiornato (`take_item_entity`), e loop
Hermes → Jev → Bedrock con `GOAL MET` (`oak_log` 9 → 10).

---

## Problemi noti

- **Risalita da buche/pozzi**: risolta con `dig_up` (apre volta e gradino e sale); verificata live il 02/10 uscendo dalla buca dello scavo (da y=67 a y=73 in 5 passi). Prima della protezione, un `dig_up` ha scavato un baule della base: ora rispetta `DIG_PROTECTED` come `dig_down`.
- **`connecterror:9`**: il teardown corretto ha superato cicli consecutivi, ma il passaggio tra client diversi ha riprodotto il blocco il 01/10. Il solo tempo morto non è una soluzione dimostrata (errore persistente per circa 9 ore). Un riavvio BDS a zero giocatori ripristina il servizio. Il nuovo harness ha un solo worker di connessione; `connect()` condivide il tentativo tra chiamanti concorrenti e ripulisce anche gli errori prima dello spawn. Non considerare questi test una garanzia per client esterni che non attendono il teardown.
- **Drop durante il mining (risolto 02/10)**: la sessione NetherNet cadeva dopo 1-2 blocchi scavati (`client_close: disconnected`, anche dal container). Causa: `item_stack_request` di `mine_block` con id `-1, -2, ...`; il client vanilla usa negativi dispari. Corretto usando la stessa sequenza del crafting; dopo il fix il mining regge (verificato live). Resta nota l'instabilità NetherNet generale (vedi sotto).
- **Attacco e danno**: i colpi vengono inviati e atterrano (verificato live), ma su mob con armatura il danno per colpo è basso e `_combat` può scadere prima di uccidere (`combat_timeout` con `hits` valorizzato). Miglioria possibile: preferire un'arma (spada/ascia) e/o allungare il tempo per azione. `weapon: null` indica che non c'era una spada in inventario durante il test.
- **Registry**: `start_game.block_properties` non è la palette completa dei runtime ID. Non assegnare agli elementi l'indice dell'array, né forzare `diggable` o `hardness`. `bedrock-world.mjs` usa `prismarine-registry` con `block_network_ids_are_hashes` e la tabella vanilla della versione configurata.
- **Chunk parser**: il loader generale di `prismarine-chunk` non seleziona 1.26; il decoder Bedrock v9 esistente è riutilizzato esplicitamente con il registry 1.26. In questo BDS `level_chunk` contiene biomi e `highest_subchunk_count`: servono richieste `subchunk_request` e risposte `subchunk`, non l'evento `sub_chunk`.
- **Dati non disponibili**: sezioni non ricevute restituiscono `null`; hash non presenti nel registry restituiscono `unknown`, non aria o cemento. Al collaudo 01/10 ci sono 39-41 hash sconosciuti. Dal 02/10 `unknown` è conservativo anche per il pathfinding (prima contava come attraversabile e il bot si bloccava contro muri invisibili); `dig_up`/`dig_down` possono scavare le celle `unknown` con una rottura grezza. Terra, pietra e tronchi sono riconosciuti con durezza corretta.
- **Blocchi parziali**: l'adapter non conosce l'altezza esatta di letti, lastre e gradini; la fisica locale li approssima come cubi pieni e il server riporta la quota corretta con `correct_player_move_prediction`. Il movimento resta fluido, ma la quota può oscillare di ~0,5 blocchi su questi blocchi.
- **Inventario server-authoritative**: BDS non invia aggiornamenti di inventario al pickup; l'adapter aggiorna il conteggio dal pacchetto `take_item_entity` (conferma di raccolta) e riconcilia con `inventory_content` alla connessione successiva.
- **Inventario persistente**: l'account del bot è lo stesso usato dal giocatore umano; l'inventario sopravvive tra le sessioni. I target del controller vanno scelti sopra il conteggio corrente.
- **Crafting**: supportate le ricette shaped/shapeless con ingredienti per nome o tag (`planks`, `logs`, `stone_tool_materials`); ricette senza output noto (multi) e ricette speciali (fucina, incudine, telai) non sono implementate. Il craft usa sempre un oggetto per volta (niente `times_crafted > 1`).
- **Piazzamento**: piazzamento solo su una faccia superiore adiacente al bot; nessuna scalatura o orientamento dei blocchi.
- **Item nel mondo**: un craft fallito può lasciare item davanti al tavolo (chiusura del container con griglia piena). L'adapter ripulisce la griglia prima di chiudere quando può tracciarla.
- **Stack id dopo un pickup**: vedi "Inventario e stack id". Se l'aggregato ha più materiali degli slot, un craft tenta una riconnessione automatica (`inventory_resync`) prima di arrendersi.
- **NetherNet instabile**: in alcune fasce orarie la sessione cade ogni pochi secondi (log BDS: `Player disconnected` dopo 3-20 s, nessun errore lato server). L'harness riconnette da solo; durante la riconnessione `/options` offre solo `wait`. Un caso specifico e risolto era il mining (`item_stack_request` con id non valido, vedi sopra). Il rimedio documentato per il blocco persistente è un riavvio BDS a zero giocatori; nei run lunghi conviene alzare `MAX_STEPS` perché i flap consumano passi.
- **`dig_down` e blocchi costruiti**: il passo viene rifiutato (`protected_*`) se testa/fronte/gradino contengono tavoli, contenitori, stazioni o materiali da costruzione (assi, lastre, scale, lana, vetro, mattoni, cemento). Idem per `dig_up`. Evita di distruggere la base; usare `mine_*` per blocchi naturali.
- **Planner Hermes**: il provider primario può esaurire la quota e il fallback può non rispondere; il controller ora degrada al piano statico (vedi "Controller robusto") e logga `plan_fallback`.

### Collaudi e passaggio tra client

`npm run test-world` controlla blocchi di una cattura reale BDS 1.26.52, palette singleton con hash e coordinate negative. `npm run test-reconnect` verifica tre ingressi, chiamanti concorrenti e blocchi naturali ricevuti dal server; richiede `.env` e cache Xbox valida. `node --env-file=.env test-movement.mjs [x z]` verifica un tragitto con pathfinding verso un waypoint lontano (default `76 148`). Sui test locali con lo stesso account fermare prima il container.

Fermare il container prima di avviare un test sul nodo con lo stesso account. Attendere `await closeBedrockClient(client)` (o `await adapter.disconnect()`), poi riavviare il container. Per integrare altre azioni riutilizzare il client dell'adapter e `world.blockAt()`/`world.findBlocks()`: il porting resta basato sulle librerie Prismarine. Non cambiare mondo per aggirare una lettura errata.

---

## Collegamenti

- Repo originale Java: `teknium1/hermes-and-jev-play-minecraft`
- Fork locale: `giaffa86/hermes-and-jev-play-minecraft-bedrock`
- Fork bedrockflayer NetherNet: `giaffa86/mineflayer-for-bedrock-nethernet`
- Wiki server: `<percorso-wiki>/wiki/minecraft-bedrock.md`
- Wiki Hermes: `<percorso-wiki>/wiki/hermes-agent.md`
