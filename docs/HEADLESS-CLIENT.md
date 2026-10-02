# Client headless: come il bot agisce nel server senza grafica

> Domanda ricorrente: il bot lavora in modalità "headless" o grafica? Come fa un
> processo senza finestra di gioco a compiere i task dentro il server?

Risposta breve: **tutto è headless**. Non c'è nessuna finestra Minecraft, nessun
rendering, nessuno screenshot, nessuna pressione di tasti simulata. Il "client"
non è un client grafico: è un programma Node.js che parla direttamente il
**protocollo di rete** del server. Il modello (Hermes/Jev) non vede mai pixel e
non emette mai input grezzi: sceglie solo **un'azione da un menu** e un harness la
esegue nel mondo reale.

Questo documento spiega come è fatto il client attuale e con quali meccanismi
compie i task. È il complemento "come funziona davvero sotto il cofano" di
[`BEDROCK.md`](../BEDROCK.md) e di [`SURVIVAL-INTELLIGENCE.md`](SURVIVAL-INTELLIGENCE.md).

---

## 1. Headless vs grafica

| Aspetto | Client grafico (vanilla) | Questo progetto |
|---|---|---|
| Rendering del mondo | Sì (GPU, chunk disegnati) | No |
| Input | Tastiera + mouse | Nessuno; pacchetti di protocollo |
| Percezione | Occhi sullo schermo | Stato ricostruito dai pacchetti del server |
| Screenshot come canale | Sì | **Mai**: "no screenshots, no keypresses, no generated code" |
| Esecuzione | Un giocatore umano | `bedrock-adapter.mjs` (Node.js) |

Il bot esiste sul server esattamente come un giocatore reale: ha un account
Xbox/Microsoft autenticato, entra nell'allowlist del BDS, e il server gli assegna
posizione, inventario, vita e fame come a chiunque altro. La differenza è solo che
dalla parte client non c'è un essere umano davanti a uno schermo, ma un processo
che legge e scrive pacchetti.

---

## 2. Architettura a tre strati

```
controller.mjs                      pianificazione / decisione
  │  (Hermes pianifica, Jev sceglie un'azione)
  │  HTTP: GET /observe, GET /options, POST /act, POST /plan, GET /survival
  ▼
bedrock-harness.mjs                 proprietario della VALIDITÀ (API :3077)
  │  offre solo le azioni eseguibili in questo momento
  ▼
bedrock-adapter.mjs                 client di protocollo Bedrock (~174 KB)
  │  pacchetti di rete su NetherNet
  ▼
BDS 1.26.x                          il vero server Minecraft Bedrock (BDS)
```

Il contratto è rigoroso: **la validità appartiene all'harness**. Il controller
sceglie solo una chiave tra quelle restituite da `GET /options`; non può inventare
azioni, coordinate o sequenze. Se il modello "sbaglia", si corregge ciò che viene
offerto in `/options`, non il prompt.

---

## 3. Come "vede" il mondo (percezione senza schermo)

Il mondo non viene disegnato: viene **ricostruito** da ciò che il server invia.

| Informazione | Pacchetti/path | Dove finisce |
|---|---|---|
| Blocchi e chunk | `level_chunk` + `subchunk_request`/`subchunk` (decoder Prismarine v9, registry 1.26) | `adapter.world` → `blockAt()` |
| Posizione del bot | input simulato + `correct_player_move_prediction` | `_feet`, `position` |
| Entità (mob/giocatori) | `add_entity`, `add_player`, `move_entity`, `move_entity_delta`, `set_entity_data` | `adapter.entities` (tipo, posizione, distanza, vita) |
| Vita / fame / esperienza | `update_attributes` (campo `current`) | `health`, `food`, `experience` |
| Ora del giorno | `sync_world_clocks` (`% 24000`), fallback `set_time` | `time` (notte/giorno) |
| Inventario | `inventory_content` + `item_stack_response` | `inventory`, `inventorySlots` |
| Morte / respawn | vita ≤ 0 + flusso `Respawn` (`state = 2`) | `dead`, `deaths`, `deathSite` |

Tutto questo viene normalizzato in uno stato compatto ed esposto da `GET /observe`
(a cui si aggiunge il verdetto compatto del Survival Governor). È l'unica "vista"
che il modello ha del mondo: numeri strutturati, mai immagini.

---

## 4. Come agisce (azione senza tastiera)

Ogni azione è una sequenza di **pacchetti di protocollo**, non di input fisici.

### 4.1 Movimento — `player_auth_input` (server-authoritative)

BDS 1.26 usa il movimento **server-authoritative**: il client non può teletrasportarsi
inviando coordinate arbitrarie (`move_player` viene scartato/riportato indietro).

L'adapter invece:

1. **simula la fisica localmente** — camminata a `0.2158` blocchi/tick (≈ 4,317 m/s),
   gravità `0.08` blocchi/tick², salto `0.42`, collisioni, gradini, cadute;
2. invia ogni tick un `player_auth_input` con posizione simulata, `move_vector` e
   flag di intento, restando dentro la finestra di rewind del server (40 tick);
3. **pianifica con A\*** sul mondo caricato (supporto, gradini ±1, cadute fino a
   4 blocchi) verso il nodo camminabile più vicino al bersaglio;
4. apre le porte chiuse incontrate sul percorso (`click_block` / `item_interact`);
5. accetta le correzioni del server oltre `0.75` blocchi (`MAX_CORRECTION_DRIFT`) e
   riallinea l'ancora dei tick.

### 4.2 Mining — `block_action` con fisica vanilla

Rottura reale di un blocco tramite `player_auth_input` + `block_action`, con conferma
dal server ed evento di distruzione. Prima di rompere, l'adapter seleziona l'utensile
giusto (piccone/ascia/pala/zappa, miglior tier) e i tempi di rottura seguono la
formula vanilla. Il rango di raccolta è confrontato con l'insieme `harvestTools` del
blocco: senza il piccone del tier giusto, l'opzione `mine_*` non viene nemmeno offerta.

### 4.3 Inventario e crafting — `item_stack_request`

Lo spostamento di item, il crafting e la fusione sono transazioni `item_stack_request`
(take/place/swap con **stack id**), valide solo con una finestra aperta:

- `interact open_inventory` apre la griglia 2×2; `click_block` sul tavolo apre la
  finestra `workbench` (3×3);
- ogni ingrediente passa per il cursore (take → place), poi una richiesta
  `craft_recipe` con consumi e output;
- la fusione usa la stazione adatta (fornace/altoforno/affumicatore) e gli slot
  `furnace_ingredient`/`furnace_fuel`/`furnace_output`.

### 4.4 Interazioni — `click_block`, `item_use`, `item_use_on_entity`

- Porte, letti, fornaci, bauli, tavoli da lavoro → `click_block` / `item_interact`;
- mangiare → `item_use` (`click_air`);
- attaccare un mob → `item_use_on_entity` (`action_type: attack`) + `animate swing_arm`.

---

## 5. Il loop "bounded action"

Il ciclo non è "modello che gioca", è un loop a passi discreti e verificabili:

1. `GET /observe` → stato normalizzato del bot (+ Survival Governor);
2. `GET /options` → menu di azioni valide in questo momento (es. `mine_stone`,
   `goto_waypoint`, `sleep`, `craft_furnace`, `attack_zombie`, ...);
3. il controller sceglie **una sola chiave** e chiama `POST /act {key}`;
4. l'harness esegue l'azione nel mondo reale e restituisce l'esito;
5. si ripete finché il goal è raggiunto o il budget (`MAX_STEPS`) è esaurito.

Tutta la traccia finisce in `runs/<run>/controller.jsonl` (piani e decisioni) e
`runs/<run>/events.jsonl` (azioni ed esiti lato harness).

---

## 6. Le due varianti di client

| File | Cos'è | Uso |
|---|---|---|
| `harness.mjs` | Riproduzione "giocattolo" Java Edition: server Minecraft 1.16.5 in puro Node (`flying-squid`) + bot `mineflayer`. Anche questo è headless. | Demo locale, nessun server esterno richiesto |
| `bedrock-harness.mjs` + `bedrock-adapter.mjs` | Il **target reale**: bot Bedrock autenticato che entra in un vero BDS 1.26.x e agisce nel mondo reale. | Deploy su host Docker, server BDS |

L'interfaccia semantica è identica (`observe()`, `options()`, `executeAction()`,
`connect()`, `disconnect()`): il controller Hermes/Jev non sa — e non deve sapere —
su quale edizione sta girando.

---

## 7. Perché headless è importante

- **Nessun canale visivo**: il modello non impara da screenshot, quindi non ci sono
  problemi di OCR, risoluzione o rendering; lo stato è già simbolico e preciso.
- **Determinismo**: la validità delle azioni è calcolata dal codice (harness), non
  giudicata dal modello. Il Survival Governor e la verifica delle skill controllano
  lo stato reale, mai l'opinione del modello.
- **Riproducibilità**: ogni decisione e ogni azione sono loggate in JSONL; i report
  (es. `REPRODUCTION-REPORT.md`) derivano dai log, non dalla memoria.
- **Costo**: il controller Jev risponde a una domanda "choice" in ~0,2 s; nessun
  costo di rendering o di visione.
