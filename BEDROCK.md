# Hermes + Jev → Minecraft Bedrock Edition

Questo documento descrive il porting del progetto originale da Minecraft Java Edition a Minecraft Bedrock Edition.

L'architettura è la stessa: **Hermes** pianifica, **Jev** sceglie un'azione tra quelle valide, e un **harness Bedrock** esegue l'azione nel mondo reale tramite un bot Bedrock autenticato.

---

## Componenti Bedrock

| Path | Ruolo |
|---|---|
| `bedrock-harness.mjs` | Entry point del container: connette il bot Bedrock al BDS e espone l'HTTP API (`/observe`, `/options`, `/act`, `/plan`). |
| `bedrock-adapter.mjs` | Adattatore che traduce lo stato Bedrock nel formato atteso da `controller.mjs`. |
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

`controller.mjs` richiede il CLI `hermes` per la pianificazione. Il container agente non include Hermes CLI, quindi il controller va eseguito **dentro il container Hermes esistente** tramite `docker exec` (nessuna modifica all'immagine).

Copia il controller nel container Hermes:

```bash
sudo docker cp /home/<utente-ssh>/hermes-jev-bedrock/controller.mjs hermes:/tmp/controller.mjs
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
| `collect_drop` | ✅ Funzionante | Traccia gli item entity (`move_entity`/`move_entity_delta`), cammina fino al drop e verifica il pickup (`take_item_entity`). |
| `mine_*` | ✅ Funzionante | Rottura reale con `player_auth_input` + `block_action`, conferma dal server e evento di distruzione (patate, pietra, terra, `oak_log`). |
| `craft_*` | ✅ Funzionante | Ricette da `crafting_data` (network id), griglia 2×2 nell'inventario e 3×3 al tavolo da lavoro; item_stack_request `craft_recipe` con consumi e output. |
| `place_*` | ✅ Base | Piazzamento con transazione `click_block`; usato per il tavolo da lavoro. |

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

- **`connecterror:9`**: il teardown corretto ha superato cicli consecutivi, ma il passaggio tra client diversi ha riprodotto il blocco il 01/10. Il solo tempo morto non è una soluzione dimostrata (errore persistente per circa 9 ore). Un riavvio BDS a zero giocatori ripristina il servizio. Il nuovo harness ha un solo worker di connessione; `connect()` condivide il tentativo tra chiamanti concorrenti e ripulisce anche gli errori prima dello spawn. Non considerare questi test una garanzia per client esterni che non attendono il teardown.
- **Registry**: `start_game.block_properties` non è la palette completa dei runtime ID. Non assegnare agli elementi l'indice dell'array, né forzare `diggable` o `hardness`. `bedrock-world.mjs` usa `prismarine-registry` con `block_network_ids_are_hashes` e la tabella vanilla della versione configurata.
- **Chunk parser**: il loader generale di `prismarine-chunk` non seleziona 1.26; il decoder Bedrock v9 esistente è riutilizzato esplicitamente con il registry 1.26. In questo BDS `level_chunk` contiene biomi e `highest_subchunk_count`: servono richieste `subchunk_request` e risposte `subchunk`, non l'evento `sub_chunk`.
- **Dati non disponibili**: sezioni non ricevute restituiscono `null`; hash non presenti nel registry restituiscono `unknown`, non aria o cemento. Al collaudo 01/10 ci sono 39-41 hash sconosciuti. Per movimento e pathfinding `unknown` conta come attraversabile e come piano d'appoggio (il server corregge eventuali divergenze), mentre la fisica locale lo tratta come solido. Terra, pietra e tronchi sono riconosciuti con durezza corretta.
- **Blocchi parziali**: l'adapter non conosce l'altezza esatta di letti, lastre e gradini; la fisica locale li approssima come cubi pieni e il server riporta la quota corretta con `correct_player_move_prediction`. Il movimento resta fluido, ma la quota può oscillare di ~0,5 blocchi su questi blocchi.
- **Inventario server-authoritative**: BDS non invia aggiornamenti di inventario al pickup; l'adapter aggiorna il conteggio dal pacchetto `take_item_entity` (conferma di raccolta) e riconcilia con `inventory_content` alla connessione successiva.
- **Inventario persistente**: l'account del bot è lo stesso usato dal giocatore umano; l'inventario sopravvive tra le sessioni. I target del controller vanno scelti sopra il conteggio corrente.
- **Crafting**: supportate le ricette shaped/shapeless con ingredienti per nome o tag (`planks`, `logs`); ricette senza output noto (multi) e ricette speciali (fucina, incudine, telai) non sono implementate. Il craft usa sempre un oggetto per volta (niente `times_crafted > 1`).
- **Piazzamento**: piazzamento solo su una faccia superiore adiacente al bot; nessuna scalatura o orientamento dei blocchi.
- **Item nel mondo**: un craft fallito può lasciare item davanti al tavolo (chiusura del container con griglia piena). L'adapter ripulisce la griglia prima di chiudere quando può tracciarla.

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
