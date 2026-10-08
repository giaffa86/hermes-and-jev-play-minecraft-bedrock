# Log

## [2026-10-07] feat | R6 implementata: i golden scenarios congelano l'esito di un ordine (e trovano un bug vero)

- `tests/golden-scenarios.test.mjs`: nove righe (ordine + mondo in, forma del piano / domanda / rifiuto / ledger out) contro il **controller vero** su un harness scriptato; le asserzioni leggono la traccia R3, non l'evento. G1 domanda senza meta, G2 meta nota alla memoria, G3 posto ignoto, G4 (C17) il marcatore «ragiona» tolto prima del planner, G5 (C18) deposito a due bauli, G6 stop, G7 rifiuto tipizzato dentro lo step, G8 ordine ambiguo che non sospende il goal, G9 run uccisa da un segnale che lascia comunque il ledger. Suite 1940 → 1949.
- **Bug vero trovato dal golden test**: il gestore SIGTERM di `controller.mjs` leggeva `stepsUsed`/`totalCost`, locali di `runGoal` → `ReferenceError: stepsUsed is not defined` a ogni segnale (uscita 1, nessun `run_end`, nessuna traccia, nessun costo): la promessa di `docs/wiki/observability.md` non era mai stata vera. I contatori sono ora specchiati in `runProgress` a livello di modulo; G9 la fissa.
- **Secondo difetto, minore**: l'uscita deterministica `told_goto` di `maybeHumanCommand` era l'unico piano che non passava da `shapedPlan`, quindi un posto noto alla memoria produceva un segmento di traccia con `steps: []` (e R4 non poteva attribuirgli un rifiuto). Ora prende la forma R1 come tutti gli altri.
- Fixture: il piano del goal seminato e il piano dell'ordine sono due rami distinti del finto planner; il seme dichiara `targets: {dirt: 99}` (insoddisfacibile) così l'ordine arriva sempre a goal in corso; `stopWhen` attende un atto **dopo** la pubblicazione del piano (`actsAfterPlan`), perché un SIGTERM al momento della pubblicazione uccide il controller prima che adotti il piano nella traccia.

## [2026-10-07] lint | R6: i golden scenarios, e i documenti allineati

- Wiki-lint `--strict` sul repository: nessun errore dopo l'aggiunta di R6 (roadmap grezza, `wiki/reasoning-roadmap.md` con la sezione `### Golden scenarios (R6)`, riga 47.69 di `wiki/verification.md`, `wiki/observability.md` con la nota sul SIGTERM, regola in `AGENTS.md`).
- Conteggio finale: 54 file, 818 link relativi, 32 pagine wiki, 15 fonti grezze, 1 nota informativa su `log.md`; `Last lint: 2026-10-07`.

## [2026-10-07] feat | R5 implementata: un goal può chiamare più milestone, e il piano ne dichiara la catena mancante

Un goal del curriculum non è più un solo milestone: `prepare_for_nether` nomina una
**lista** (`enter_nether`, `nether_survival`) e il motore ne espande la chiusura in
ordine di dipendenza. Suite a 1940/1940.

- **Il goal composito è dato, non un motore nuovo**: `goals` in
  `knowledge/progression.json` accetta un id o una lista; `goalTargets(graph, goal)`
  normalizza le due forme e `validateProgression` controlla ogni elemento
  (`goal "x": unknown milestone "y"`) e rifiuta la lista vuota, così un refuso
  fallisce al caricamento e non a run time. Nessun milestone nuovo.
- **`milestoneChain(graph, {goal, observation, completed})`** (`survival/progression.mjs`)
  ritorna `{status, targets, chain, steps, next, missing}`: `chain` è la chiusura
  mancante in ordine topologico **stabile** (prima i prerequisiti, nell'ordine di
  `requires`; un milestone soddisfatto — e tutto il suo sottoalbero — è saltato) e
  ogni `steps[]` è `{id, milestone, skill, description, requires, missing, verify}`,
  con `verify` = `criteriaNames(satisfiedWhen)` filtrato su `CRITERIA_KEYS` (il
  vocabolario chiuso di R1). `missing` è ciò che manca **adesso** al passo: la
  catena non simula il mondo.
- **`resolveMilestone` è ora un wrapper**: un goal semplice risponde esattamente
  come prima (il triplo `next`/`milestone`/`skill` che la sua suite fissa, intatto)
  e in più porta `targets`/`chain`/`steps`. La testa della catena è
  `steps.find(s => s.missing.length === 0) ?? steps[0]`: il contratto single-`next`
  non si rompe, si estende.
- **`met` significa *tutti* i target**: un target soddisfatto dal mondo (es.
  `enter_nether` quando la dimensione diventa `nether`) **non** chiude un goal
  composito. In `controller.mjs` il test di chiusura `finished.milestone ===
  CURRICULUM` è diventato `nextMilestone(obs).status === 'met'` (per un goal
  semplice è la stessa cosa) e `goal_met` porta anche `targets`.
- **Il piano dichiara la catena**: `planFromMilestone` mappa `result.steps` con
  `milestoneStep(entry)` (la forma di `planStep` di R1 + l'id del milestone + i
  criteri del milestone) su `plan.steps`; `withPlanShape` è additiva, quindi il
  produttore vince. La catena si **ricalcola** a ogni replan e si accorcia da sola.
- **Test**: `tests/progression.test.mjs` (+5: espansione e campi dello step,
  prerequisito soddisfatto che accorcia la catena, `met` solo con tutti i target,
  i rami d'errore di `milestoneChain`, la validazione composita) e
  `tests/controller-curriculum.test.mjs` (+1 sul filo, col controller **vero**:
  `CURRICULUM=prepare_for_nether` cammina quattro azioni, i piani portano
  `steps.length` = 4/3/2/1, e `enter_nether` soddisfatto al terzo passo **non**
  chiude il goal — `GOAL MET after 3 actions` non compare mai).
  `tools/capability-inventory.mjs` ha imparato la forma ad array.
- **Limite onesto**: il goal composito sceglie i **target**, non una procedura.
  Una capacità che non è un milestone nel grafo non si può ancora comporre.
- **Residuo**: nessun run vivo con `CURRICULUM=prepare_for_nether` (serve il
  riavvio del container, lo stesso che aspettano R2–R4 e l'ore alert M11).

## [2026-10-07] lint | R5: i goal compositi, e i documenti allineati

Lint pulito dopo R5 (`npm run wiki:lint:strict`). Allineati: la sezione R5 della
roadmap grezza (heading `(IMPLEMENTED)` + blocco degli interventi),
`docs/wiki/reasoning-roadmap.md` (riga R5 → implementata, sezione «Composite goals
(R5)» con il diagramma, il conteggio dei goal a 9 e la domanda aperta sul
multi-ramo), `docs/wiki/survival-intelligence.md` (il punto 5 del layer),
`docs/wiki/verification.md` (riga **47.68**), `AGENTS.md` (la voce `CURRICULUM`
con il goal composito).

## [2026-10-07] feat | R4 implementata: un rifiuto è un fatto tipizzato sul passo, non una stringa nel log

Il rifiuto di un'azione non è più un motivo per ripianificare tutto: è un fatto
**tipizzato sul passo che l'ha subito**, che decide se ritentare, cambiare
approccio o far fallire il passo. Suite a 1934/1934.

- **Il modulo puro** `step-failure.mjs` (nessun import): vocabolario chiuso e
  ordinato `busy|timeout|transient|moved|blocked|refused|prerequisite|unknown`,
  costruito dalle stringhe **reali** di `bedrock-adapter.mjs` (13 famiglie
  `<x>_timeout`, `<x>_refused`, `<bersaglio>_gone`, `no reachable <ore> found
  nearby`, `no_safe_cell`, `not_diggable_*`, `missing_<item>`, …). L'ordine conta:
  `timeout` prima di `refused`, `moved` prima di `blocked`, `blocked` prima di
  `prerequisite`. Fuori vocabolario = `unknown`, terminale: mai indovinato
  ritentabile.
- **La disposizione** `failureDisposition(record, {attempts, maxAttempts: 2})` →
  `retry | switch | replan` con un motivo autoesplicativo (`<kind>_retry`,
  `<kind>_exhausted`, `blocked_alternative`, `<kind>_terminal`). L'unità è il
  **passo** (`activeStepId`), non l'azione: i tentativi si contano per passo e
  `reviseSteps()` restituisce un piano **nuovo** con `steps[i].refused =
  {step, error, kind, retryable, at, alternatives}`, `refusalCount` e le ultime 4
  revisioni.
- **L'alternativa è derivata, non indovinata**: `siblingKeys` + `optionIntents`
  (`survival/intents.mjs`) danno le chiavi offerte che condividono un intento con
  quella rifiutata (`mine_iron_ore` → `mine_deepslate_iron_ore`, `mine_diamond_ore`),
  mai la chiave stessa e mai `unknown`. Restano una **registrazione**: la scelta è
  ancora di Jev sulla lista ridotta.
- **Il cablaggio** vive dove il verdetto esiste (subito dopo `log('result', …)`),
  con la guardia su `busy` (il lock non è un verdetto: si aspetta e si logga
  `harness_busy`): `retry` non tocca niente (nessuna esclusione, altrimenti il
  ritentativo non esiste, e nessuna revisione); `switch` esclude **soltanto** la
  chiave rifiutata, logga `step_switch` con le alternative e ripubblica il piano con
  la revisione dentro lo step; `replan` fa fallire il passo con
  `step_failed:<errore>`. L'evidenza è limitata per costruzione (`refusalEvidence`
  tiene posizione, dimensione, target, `ms` e i campi piccoli: un campo il cui JSON
  supera 200 caratteri viene scartato).
- **Tre difetti reali trovati e corretti**: `replanReason` è dichiarato **dentro**
  il corpo del loop (`controller.mjs:2009`), quindi un motivo prodotto a fine
  iterazione andava perso — ora viaggia in `pendingStepReplan`, dichiarato fuori dal
  loop e consumato all'inizio dell'iterazione successiva **prima** dell'anti-loop;
  la prima versione escludeva anche le chiavi sorelle (rendendo impossibile lo
  switch); la prima versione revisionava il piano anche su `retry` (una revisione
  per un passo che non aveva ancora deciso niente).
- **La regressione che ha plasmato il vocabolario**: `player_not_found` cadeva in
  `unknown`, quindi in un replan mentre un ordine di follow era aperto — in un
  percorso volutamente deterministico. Un umano che si allontana è un **bersaglio
  spostato**: `moved` copre ora `*_not_found`, e un rifiuto ritentabile non
  pubblica alcun piano (`tests/controller-follow-lost.test.mjs` asserisce
  entrambe le cose).
- **Il tipo arriva nei file**: i rifiuti di `plan-trace.jsonl` portano
  `kind`/`retryable`/`stepId`, `summarizePlanTrace` conta `refusalsByKind`,
  `run-facts` stampa `tipi: blocked=1, prerequisite=1`, e `buildSkillRecord()`
  registra il `failure` che ha fatto fallire la skill.
- **I test**: `tests/step-failure.test.mjs` (11, tabella dei casi reali + chiusura
  del vocabolario + evidenza limitata + disposizioni + `reviseSteps`),
  `tests/controller-step-failure.test.mjs` (**nuovo**, 2: il controller vero sul
  filo, due chiavi sorelle, `/act` che rifiuta), `tests/plan-trace.test.mjs` (+2) e
  l'asserzione nuova in `tests/controller-follow-lost.test.mjs`. Suite 1919 →
  **1934**.
- **Residuo**: nessun run vivo ha ancora esercitato un rifiuto (serve il riavvio
  del container che aspettano anche R2/R3); una famiglia di rifiuti aggiunta al
  `bedrock-adapter.mjs` dopo questa data cade in `unknown` — terminale e visibile in
  `refusalsByKind`, non ritentabile finché non entra nella tabella.

## [2026-10-07] lint | R4: il rifiuto tipizzato, e i documenti allineati

Lint della wiki dopo R4: righe nuove in `docs/wiki/reasoning-roadmap.md` (riga R4 →
**implemented** + sezione «Structured failure (R4)»), `docs/wiki/verification.md`
(riga **47.67**), `docs/raw/ROADMAP_refactoring_reasoning.md` (R4 → IMPLEMENTED +
blocco «Implemented (07/10/2026)») e una regola nuova in `AGENTS.md`. Nessuna
contraddizione trovata tra le fonti; `docs/wiki/questioni-aperte.md` resta datata
2026-10-07.

## [2026-10-07] feat | R3 implementata: la traccia del piano dice perché il piano è cambiato

Un run adesso si spiega dai suoi file anche nel *perché*: una riga per segmento di
piano in `runs/<run>/plan-trace.jsonl`, scritta dal controller, con la suite a
1919/1919.

- **Il file** `runs/<run>/plan-trace.jsonl` (uno per run, accanto a `controller.jsonl`):
  una riga JSON per **segmento di piano** — aperto da `adopt()` quando il controller
  adotta un piano, chiuso quando quel piano viene sostituito o il run finisce — con
  `{v, planId, reason, source, objective, subgoal, steps[], stepCount, startedAt,
  endedAt, ms, endedBy, untilStep, actions, ok, failed, decisions[], refusals[],
  omitted}`. I dati per decisione stanno **dentro** la riga (`decisions[]` dalla
  scala di decisione, `refusals[]` con l'errore tipizzato), così il file resta
  proporzionale al numero di piani e non a quello delle azioni: azioni e durate
  restano in `actions.jsonl`. Il goal della roadmap diceva «una riga per decisione»;
  la deviazione è deliberata e documentata.
- **`plan-trace.mjs`** (puro + writer): `PLAN_TRACE_VERSION`, `PLAN_SOURCES`,
  `planTraceSource`, `planTraceSteps`, `planTraceShape`,
  `createPlanTrace({dir, now, write})` con `adopt`/`decided`/`refused`/`record`/`flush`,
  `summarizePlanTrace(rows, {top})` e `readPlanTrace(dir)`.
- **`plan.source` è timbrato dove il piano nasce**, mai dedotto: `planForStep`
  timbra `curriculum`/`construction`, `hermesPlan` timbra `hermes` (anche nel
  fallback statico), i rami deterministici di `humanCommandPlan` e il movimento
  dettato (`told_goto`) timbrano `deterministic`. Il vocabolario è chiuso
  (`PLAN_SOURCES`) e un valore forestiero come il `'governor:normal'` della copia
  del governor rilegge come `hermes`; `setPlan()` dell'adapter memorizza il piano
  com'è, quindi il campo è inerte a runtime e visibile in `observe().plan`.
- **`endedBy` nomina la chiusura**: `replaced`, `human_order`, `human_order_override`
  (il caso `max_goal_depth`, che butta via il piano in corso invece di delegarlo a
  un goal figlio — prima quel ramo scriveva il generico `human_order`),
  `replan:<skill_failed|anti_loop:<key>:<n>|skill_complete|periodic|curriculum>`,
  `goal_met`, `goal_met:<reason>`, `run_end`, `goal_end`, `signal:<SIG>`.
- **Due proprietà di sicurezza, asserite e non sperate**: `adopt()` chiude da sé un
  segmento rimasto aperto e `flush()` è idempotente, quindi una `flush` mancata
  costa una segmentazione più grossolana e mai una riga persa; e un errore di
  scrittura viene inghiottito (`console.error('[plan-trace] write failed:', …)`)
  perché l'osservabilità non deve poter uccidere il bot — non c'è nessun flag per
  spegnerla. Tetti: `steps` compattato a 12 voci (col `stepCount` vero), `decisions`
  e `refusals` a 64 ciascuno con l'eccedenza contata in `omitted`.
- **Lettura**: `readRunFacts` espone `planTrace: {count, summary}` e
  `node tools/run-facts.mjs <run>` stampa `plan-trace: N piani (source=…), N passi,
  N decisioni, N rifiuti, N replan`, i rifiuti per errore, i motivi di chiusura e la
  forma dell'ultimo piano; il riassunto non esiste se il file non c'è (nessuna riga
  inventata).
- **Test**: `tests/plan-trace.test.mjs` (9 — vocabolario di `source`, una riga per
  segmento, flush idempotente, `flush` mancata, i tre motivi di replan, i tetti, il
  blocco CLI) e un 6° test in `tests/controller-clarify.test.mjs` che guida il
  **controller vero** per tre passi e rilegge il file (provenienza, l'`endedBy:
  'human_order'` del preempt, le chiavi scelte, `actions === decisions.length`,
  `failed === 0`). Il test sul filo ha anche fissato il limite onesto: un goal che
  il contratto chiude **prima** di pubblicare un piano non lascia traccia — non
  c'era un piano da tracciare — e l'assert è `null`, non una riga inventata.
- Documentazione: roadmap R3 → IMPLEMENTED (con la deviazione «segmento, non
  decisione»); `docs/wiki/reasoning-roadmap.md` (riga + sezione «The plan trace
  (R3)» con il diagramma); `docs/wiki/observability.md` (la riga del file e perché
  serve); `docs/wiki/verification.md` riga **47.66**; una regola in `AGENTS.md`.
- **Residuo**: nessun run vivo è stato ancora letto — la prima lettura di
  `run-facts` su un run con `CURRICULUM` (che richiede il riavvio del container)
  è quella che mostrerà un `source: curriculum` in produzione.

## [2026-10-07] lint | R3: la traccia del piano, e i documenti allineati

`npm run wiki:lint:strict` (lo stesso script del hook `pre-commit`; `pre-push`
rilancia con `--strict`) è pulito dopo R3: 54 file, 810 link relativi, 32 pagine
wiki, 15 fonti grezze, più una nota informativa sull'ordine cronologico di
`log.md`. Nessuna pagina orfana, nessun link rotto, nessuna fonte grezza non
citata.

- La nuova riga **47.66** di `docs/wiki/verification.md` è l'evidenza di R3; la
  pagina `docs/wiki/observability.md` ha guadagnato il file `plan-trace.jsonl` nella
  tabella degli artefatti e il perché serve; `docs/wiki/reasoning-roadmap.md` ha la
  sezione «The plan trace (R3)» e `docs/raw/ROADMAP_refactoring_reasoning.md`
  l'etichetta IMPLEMENTED con il blocco «as built» (compresa la deviazione
  «segmento, non decisione»).
- `Last lint:` in `docs/wiki/open-questions.md` resta `2026-10-07`, che è la data
  massima dei lint nel log: nessun aggiornamento necessario.

## [2026-10-07] feat | R2 implementata: un ordine ambiguo fa una domanda, non un goal

Il cancello di chiarificazione è in codice, acceso di default (`CHAT_CLARIFY=on`,
kill-switch `off`), con 24 test nuovi e la suite a 1909/1909.

- **La porta pura** `human-clarify.mjs`: `orderGaps(text, plan, obs, {memory, lang,
  names})` → `{status, missing, question, options}` con due soli buchi — movimento
  senza meta (`destination`/`no_destination`) e luogo che la memoria non conosce
  (`place`/`unknown_place`). La scala è "risolvi prima di chiedere": meta nel
  piano, verbo di follow / «qui» / coordinate esplicite, un'attività («vai a
  dormire»), un luogo noto, un oggetto introdotto da un partitivo («portami **del**
  cibo»). Se la memoria è giù la porta resta aperta (fail-open). Più
  `mergeClarifyAnswer`, `restatesOrder`, `renderClarifyRefusal`,
  `planHasDestination`, `planIsOtherOrder`.
- **La domanda vive nell'inbox dell'harness**, non nel controller: `askChat`
  (unico scrittore) registra l'ordine originale e la domanda *prima* che venga
  detta, il messaggio successivo dello stesso mittente (per gamertag o xuid) porta
  un timbro `clarifies` una volta sola e la consuma, `CHAT_ASK_TTL_MS` (300000) la
  fa scadere (`chat_ask_stale`); `observe().chatPending` e `GET /chat/pending` la
  espongono. Il controller la interroga via `POST /chat/ask` e la testuale resta la
  sua.
- **Il cablaggio nel controller**: la porta gira sul piano deciso da
  `humanCommandPlan`, crea **nessun goal**, e la risposta è un messaggio
  **indirizzato** come tutti gli altri — il timbro dà il contesto, non apre un
  canale senza prefisso (regola che tiene separabili più bot sullo stesso server).
  Se la risposta è a sua volta un ordine sostituisce quello trattenuto
  (`replyIsOwnOrder`: `restatesOrder`, stop, drop, collect, equip, farm), altrimenti
  viene unita all'ordine originale e la porta rigira; un secondo buco produce un
  rifiuto tipizzato, mai una seconda domanda.
- **Trovati due difetti reali**, entrambi dal test sul filo: l'import mancante di
  `restatesOrder` (`ReferenceError` a `controller.mjs:1174`, crash alla prima
  risposta decorata) e l'assunto che la risposta non avesse bisogno del prefisso
  (senza `@bot` il messaggio non entra nel loop).
- **Test**: `tests/human-clarify.test.mjs` (13), `tests/bedrock-chat-ask.test.mjs`
  (6), `tests/controller-clarify.test.mjs` (5, controller vero contro harness
  scriptato). Le tre chiavi `clarify_*` sono in tutte e cinque le lingue.
- **Documentato**: `docs/raw/ROADMAP_refactoring_reasoning.md` (R2 → IMPLEMENTED con
  il blocco "as built"), `docs/wiki/reasoning-roadmap.md`,
  `docs/wiki/control-flow.md` (box nel diagramma + nuovo stadio 3),
  `docs/wiki/human-command.md` (§R2 con la tabella degli esempi),
  `docs/wiki/verification.md` (riga 47.65), `AGENTS.md` (due variabili d'ambiente e
  una gotcha).
- **Residuo**: nessun giro in chat su un BDS vivo — serve il riavvio del container
  (controller, adapter e harness sono cambiati). Limite noto e documentato: una meta
  che contiene una parola di oggetto e non è in memoria («vai al campo di patate»)
  viene letta come ordine su un oggetto e non fa domande.

## [2026-10-07] design | R2: la domanda pendente sta nell'inbox, e un ordine ambiguo non sospende il goal

Tre decisioni prese prima di scrivere `human-clarify.mjs`, e una verifica che le
rende praticabili.

- **La clarification pendente vive nell'inbox, non nel controller** (scelta
dell'utente, per separazione delle responsabilità: chat lifecycle → inbox,
planning → controller, world state → memory/observe, esecuzione → harness +
`/options`). Verificato che è il posto naturale: l'inbox esiste già lì
(`bedrock-adapter.mjs:588` `this.chatInbox = []`, voce `{from, message, type,
xuid, at}`, coda di 32, `observe()` ne espone `chatInbox.slice(-10)` a `:4466`,
push a `:12042`). Il modello: il controller chiama `POST /chat/ask` (è lui che ha
già applicato il gate del canale: allowlist, prefisso, età, dedup — il gate vive
nel controller, `bedrock-harness.mjs:159`), l'inbox conserva
`pending[from] = {orderId, originalText, question, askedAt}` e **decora** il
messaggio successivo di quel mittente con `clarifies: {...}`, una volta sola; il
controller riceve `{message, clarifies}` e rivaluta l'ordine **originale** con la
risposta invece di trattare il testo come un ordine nuovo.
- **Un ordine ambiguo non sospende il goal corrente**: non diventa un goal, quindi
non c'è niente da sospendere; il goal in corso resta intatto e l'ordine trattenuto
vive solo nell'inbox. (Era la domanda aperta n. 3 della roadmap.)
- Regole che ne derivano: il pendente scade su `CHAT_MAX_AGE_MS` (la stessa
finestra che rende `chat_stale` un ordine vecchio); un ordine di stop/cancellazione
vince sempre e non viene consumato come risposta; **una sola domanda per ordine**
(dopo la risposta `human-clarify` rigira sull'ordine unito e, se non basta
ancora, il bot **rifiuta** con un messaggio tipizzato invece di chiedere di
nuovo); la voce porta `originalText` perché `observe()` espone solo gli ultimi 10
messaggi. Vantaggio della scelta: la domanda pendente **sopravvive a un riavvio
del controller** (sta nell'adapter), quindi la risposta del giocatore non si perde.
- **Resta aperto**: se `CHAT_CLARIFY` debba essere default-on alla prima release o
restare opt-in dopo un giro live.

Correzione: nel diagramma di `docs/wiki/control-flow.md` (commit `9efcd6c`) avevo
scritto `chat-inbox.mjs`, un file che **non esiste**; il box di input ora dice
`inbox: chatInbox, in the adapter` e la tappa 1 cita `bedrock-adapter.mjs:588`.

## [2026-10-07] docs | I diagrammi dell'architettura nella wiki, allineati a R0/R1

Il diagramma di flusso esisteva già in `docs/wiki/control-flow.md`, ma si fermava
all'ingresso di System Two: non c'erano il canale di chat, il livello di
scomposizione di R1 né lo stack dei goal. L'ho **esteso** invece di aggiungere un
secondo diagramma accanto (la pagina resta l'unica fonte del flusso): nuovo box di
input (l'inbox dell'adapter, `chatInbox`, con «ragiona»/M12 marcato come marcatore di risposta
tolto prima del router), box dei corti circuiti deterministici (M6 domanda, M10
fatti dettati, ordini diretti), box **R1 — plan shape** (`subgoal` + `steps[]`,
`verify ⊆ CRITERIA_KEYS`, nessuna key di `/options`), box del **goal manager**
(`parentGoal`, sospendi/riprendi, `MAX_GOAL_DEPTH`) e la freccia di ritorno del
ciclo (`re-observe → verifySkill → governor`). Aggiornata anche la sezione «Stage
by stage» (10 tappe) e «What System Two does *not* do», che ora spiega perché R1
non sposta il confine: la scomposizione resta scritta nei dati.

`docs/wiki/reasoning-roadmap.md` ha il diagramma della forma del piano (input
piatto → sorgenti dichiarative → `plan.subgoal`/`plan.steps[]`) e la domanda
aperta su `subgoal` è chiusa. `docs/wiki/architecture-evolution.md` segna
Evolution A come **implementata come R1** (con la differenza: `subgoal` è
derivato, non scritto da Hermes) e chiude due domande di design (schema del piano,
stabilità dell'`objective`). `docs/wiki/open-questions.md`: chiusa la domanda su
`subgoal`, resta aperta quella sul grafo multi-ramo.

## [2026-10-07] docs | R1 implementata: il piano ha una forma (`subgoal` + `steps[]`)

Secondo passo della roadmap corretta (`docs/raw/ROADMAP_refactoring_reasoning.md`). Il
piano non è più solo un JSON piatto: `plan-shape.mjs` (puro) deriva `plan.subgoal`
(il pezzo corrente dell'objective, "Evolution A": un solo livello sopra le azioni) e
`plan.steps[{id, skill, circuit, targets, verify}]` dagli artefatti dichiarativi — la
skill decide i `targets`, il circuito (`success.circuitBuilt.id`) e i criteri di
verifica, filtrati a `CRITERIA_KEYS`. Nessuno step nomina una key di `/options`: le
azioni restano una scelta del controller a runtime. `controller.mjs` applica la forma
con un solo `shapedPlan()` nei tre punti dove un piano diventa un goal (ordine umano,
piano iniziale, replan); è **additiva** — un produttore che ha già messo
`subgoal`/`steps` vince, e un sentinella senza `objective` (`{met:true}`) resta com'è.
Le due prompt di planning accettano un `"subgoal"` opzionale che è solo un suggerimento:
con una skill nel piano il `subgoal` *è* la `description` della skill. `criteriaNames` e
`circuitRef` sono condivisi con l'inventario R0 (`tools/capability-inventory.mjs`), che
non li duplica più. `tests/plan-shape.test.mjs` (9 casi): derivazione, `verify` ⊆
`CRITERIA_KEYS`, nessun campo-azione, objective stabile nel replan, il produttore che
vince, il sentinella. Resta aperto il giro live `CURRICULUM` (serve il container).

## [2026-10-07] docs | La roadmap del layer di ragionamento, corretta contro il codice (R0 implementata)

Richiesta dell'utente: *"scrivi roadmap correggendo le inesattezze su questa attività"*,
poi *"continua e poi passa all'implementazione"*. Due bozze italiane mai lette contro il
codice (`docs/raw/roadmap_reasoning_avanzato.md`, 2295 righe, e
`docs/raw/clarification_missing_information_phase.md`, 736 righe) descrivevano un
**compilatore semantico**: richiesta umana → LLM → `CapabilityPlan` → validazione **MCP** →
capability tipizzate su Jev. Verificato in repo: **MCP non esiste** (nessuna dipendenza,
nessun server, nessun identificatore fuori dalle due bozze: `grep -rl MCP` colpisce solo
loro e un `package-lock.json` transitivo) e **`CapabilityPlan`/`CapabilityRegistry` non
esistono**. Altre correzioni registrate: Hermes è uno *strategic replanner* (un piano JSON
piatto, non un planner gerarchico); Jev sceglie **una** key da `/options` e non esegue
missioni; l'attuatore è `bedrock-adapter.mjs` (client bedrock-protocol), non
`bedrockflayer`; **`ragiona` (M12) è implementato e deployato ma è un marker di risposta,
non un planner** (viene tolto prima della dedup key e del router, non instrada nulla, non
tocca il piano: `controller.mjs:1148-1176`, `chat-llm.mjs:88`); i due esempi di chiarimento
della bozza B sono **sbagliati per questo repo** («portami del cibo» e il baule multiplo
sono già risolti in modo deterministico — `_depositTargetFor` punteggia un contenitore che
già tiene l'oggetto `+100000`, poi la distanza).

Prodotto: [ROADMAP_refactoring_reasoning.md](raw/ROADMAP_refactoring_reasoning.md)
(inglese, sostituisce le due bozze) con un **registro di correzioni** (20 voci, ognuna con
l'evidenza di codice) e milestone **R0–R7** in un namespace separato (M0–M12 collide con le
milestone chat già in uso). Pagine wiki: nuova
[reasoning-roadmap.md](wiki/reasoning-roadmap.md), [sources.md](sources.md) (le tre fonti),
[index.md](index.md), [open-questions.md](wiki/open-questions.md) (le voci obsolete su
deploy, M7 e «ragiona» corrette con il report del 07/10) e [human-command.md](wiki/human-command.md)
(M12, ora esercitato dal provider reale: 868 ms normale, 886 ms ragionata, thinking
`disabled` perché con il thinking attivo la riga tornava vuota, `finish_reason:'length'`).

**R0 implementata**: `tools/capability-inventory.mjs` legge come un'unica cosa la
superficie reale — 22 intenti (`survival/intents.mjs`), la mappa key→intento
(`KEY_INTENTS` + `PREFIX_INTENTS`), 42 skill in 6 domini (`loadGameplaySkills`), 8 blueprint
di circuiti (`loadCircuits`), 20 milestone e 8 goal (`knowledge/progression.json`), 27
criteri (`CRITERIA_KEYS`) — e la **controlla**: un intento di skill fuori vocabolario, una
milestone senza skill, un `requires`/goal che non risolve, un `circuitBuilt.id` senza
blueprint sono errori; un blueprint `buildable` che nessuna skill costruisce è un warning.
Questo è il "registry" delle bozze senza la finzione MCP. `npm run inventory`, test in
`tests/capability-inventory.test.mjs`. Prossime: R1 piano tipizzato (`subgoal`+`steps`),
R2 gate di chiarimento dietro `CHAT_CLARIFY` (le bozze hanno ragione solo su questo),
R3 traccia strutturata, R4 fallimenti tipizzati, R5 goal compositi, R6 scenari golden, R7
condizionale.

## [2026-10-07] lint | Roadmap corretta contro il codice, R0, e voci obsolete allineate

Lint dopo l'ingest della roadmap corretta (R0 implementata). Nessun errore: le tre fonti
grezze sono in `docs/sources.md`, `wiki/reasoning-roadmap.md` e in `docs/index.md`, nessuna
pagina orfana, link relativi validi, formato del log rispettato, `Last lint` allineato.
Aggiornate le voci obsolete di `docs/wiki/open-questions.md` (deploy dei fix chat e di M7,
«ragiona» contro il provider reale, alias `DEEPSEEK_API_KEY` vs `CHAT_LLM_API_KEY`) e la
chiusura di M12 in `docs/wiki/human-command.md`. Resta aperto e non verificato da questa
sessione: l'ore alert (M11) è copiato in `hermes-jev-bedrock:/app` ma il processo in
esecuzione lo precede, quindi serve il riavvio del container del bot — decisione
**dell'utente**, non presa qui.

## [2026-10-07] deploy | Il bridge Docker faceva cadere la sessione Bedrock: host networking

Il wedge di trasporto della spedizione `diamond-20261007-1` aveva una causa fuori dal
codice: il container del harness era sulla rete bridge Docker. Misurato: un container
temporaneo dalla stessa immagine, cambiando solo la rete in `--network host`, ha tenuto
**una sessione 6 min 47 s senza un solo `client_close`** (console BDS `Player Spawned
14:46:50` → `Player disconnected 14:53:34`), mentre `hermes-internal` perdeva la sessione
ogni 1-2 minuti e spesso non si riconnetteva.

- `docker-compose.yml` lancia `hermes-jev-bedrock` con `network_mode: host`,
  `API_HOST=172.29.0.1` e `HARNESS=http://172.29.0.1:3077`; l'API resta raggiungibile
  solo da `hermes-internal` grazie a una regola host mirata
  (`ufw allow from 172.29.0.0/24 to 172.29.0.1 port 3077 proto tcp`).
- `mission.sh` usa `HARNESS=http://172.29.0.1:3077` e la nuova release
  `release-live-920018ef` (prima `release-live-d78a190`).
- **Correttezza del deploy**: il container in esecuzione **non aveva `memory-chat.mjs`**
  e usava `world-memory.mjs`/`memory-store.mjs`/`sqlite-memory.mjs`/`chat-lang/`
  vecchi — il merge `dbcc005` (told facts) era pushato ma deployato solo a metà. La
  nuova release si costruisce da `git archive HEAD` sopra la release precedente (così
  `.env` sopravvive) e `/app` viene sincronizzato da lì; sha verificati.
- **Residuo**: a bot inattivo la sessione è stabile, ma durante un run restano 13 drop
  ogni 30 minuti, correlati alle azioni; `connecterror:9` è `InactivityTimeout` di
  nethernet. Dettagli in [open-questions](wiki/open-questions.md) § NetherNet instability.

## [2026-10-07] fix | A blind harness is a broken run, not a quiet one (and a 4 HP bot does not attack)

The `diamond-20261007-1` expedition died eleven times in a day. The forensic reading
of `runs/diamond-20261007-1/actions.jsonl` and of the controller ledger says the
environmental half (the NetherNet transport dropping the session ~2 minutes after
login, five BDS restarts) is not the whole story: **75 decisions picked `wait` with a
single option** and the last 9 death rows have `wait(ok)` as their last action, 12-164 s
before dying, always standing on the same block. Two implementation defects made that
lethal rather than merely unproductive:

1. `bedrock-adapter.mjs` `options()` answered `[{key: 'wait', description: 'Wait for
the Bedrock connection to be re-established'}]` while the session was down — a fake
valid action, indistinguishable from a real choice, when the controller had already
noted the reason (`wait_only {reason: 'not_connected'}`). Now `get sessionLive ()`
(=`spawned === true && status === 'spawned'`) gates the list: no session, **no
options**, and `optionsBlindReason = 'not_connected'`. The dead/sleeping branches still
answer `wait` (a dead or sleeping bot *is* connected).
2. `survival/resolver.mjs` `chooseNeedAction` picked `SURVIVAL FIGHT attack_skeleton`
for a 4 HP bot with an **empty inventory**, because `fight` is the fallback of the
`escape` intent (`NEED_INTENTS.escape = ['escape', 'fight']`) and no `flee` was
offered. The ladder now accepts `policy: { policy.fightAllowed }`, filters every
`attack_*` out when the caller says the bot cannot win (and returns `null` if nothing
else is left, handing the decision back to the model), and `controller.mjs` passes
`fightAllowed: mayFight(obs)` (health ≥ `FIGHT_MIN_HEALTH` = 10 **and** a sword/axe
in the inventory).

The rest of the chain now tells the truth instead of imitating a working run:
`/observe` carries `connected`, `/options` carries `connected` + `blind`, and the
controller treats `connected: false` or an empty list as blindness —
`HARNESS_BLIND_MAX_STEPS` (6) steps of patience at `HARNESS_BLIND_WAIT_MS` (5 s)
without spending budget (`harness_blind`), then exit code 2 with
`harness_blind_stop`. The reconnect backoff was tightened from 60 s to 3/6/12/15 s,
because every second a blind bot stands still is a second a mob can use.

Evidence: `tests/bedrock-options-blind.test.mjs` (new), the reworked case in
`tests/bedrock-dig.test.mjs`, three new cases in `tests/survival-ladder.test.mjs`,
full suite **1805/1805** (was 1804/1 failing — the same old expectation),
`npm run wiki:lint` clean. Docs: [control-flow](wiki/control-flow.md) item 4,
[survival-intelligence](wiki/survival-intelligence.md) (`chooseNeedAction`),
[open-questions](wiki/open-questions.md) (the wedge, still open on the transport
side), `BEDROCK.md` (the `wait_only` note, now death/sleep only). **Live half still
open**: a run that stops with `harness_blind_stop` instead of dying needs a session
lasting more than two minutes.

## [2026-10-07] fix | The walker says `stuck` instead of spending the budget

Run `demo-r3` (07/10) holds three walks that failed with the destination in
sight: rows 6879 and 6918 of `runs/demo-r3/events.jsonl` end `movement timeout`
after the full `STORAGE_TAKE_WALK_MS = 75000`, having covered **1,5 blocks** and
stopped 6,8 blocks short of the chest; `GET /debug/path` returned a complete
12-14 node route the whole time. The per-waypoint verdict in `_updateMotionState`
could not see it: a new minimum of a few centimetres toward the *next node*
resets `lastProgressAt`, so `stuck` never fired. A reconstruction with the same
deployed build and a chest 3,9 blocks away succeeded twice — 7,3 s and 6,2 s — so
the geometry is not the cause.

The motion now also watches the **distance to the goal node**: no new minimum of
25 cm for `MOVE_STALL_MS = 8000` finishes the motion as `no_progress`, and
`_moveTo` closes the walk as `stuck` after three of them (~25 s) instead of
burning the budget, carrying `details` (`from`, `position`, `pathNodes`,
`reachedWaypoints`, `outcome`, `stalled: true`). `storage_open_failure` and the
`/act` result now carry `_moveTo`'s `error.details`, which both used to drop: the
next live failure names where the bot stopped instead of only how the error is
called. Six offline cases in `tests/bedrock-storage-walk.test.mjs`, suite
1799/1799.

**Deployed 07/10, 08:12:37Z**: `hermes-jev-bedrock` restarted with the adapter of
this commit (`sha256 3ecc04c6…`, restarts 0, no controller running at the stop).
The regression check is live: `take_iron_ingot` from the chest at (91,73,160) →
`{"ok":true,"count":64,"ms":6380}`. The stall verdict itself is **not yet
exercised live**: the bot sits at the village and `go_home` now answers
`arrived` immediately because `home` is the spawn of the current adapter
session (91.5,74.62,163.5), so the sealed-pocket target is gone. The next long
walk that stalls is the live proof, and it will name its own position.

## [2026-10-07] fix | The loot comes back with the gear: recover_loot re-arms

Run 2 (`demo-r2`) died ten times and its ledger holds **zero** `equip_*`
attempts: `_recoverLoot` collected the drops and never put the armor back on,
and the only live `equip_armor` (run 1, 06/10) was refused by the server. A death
is exactly the moment the gear matters.

`_recoverLoot` now ends with `_rearmGear()` — `_equipArmor()` then
`_equipShield()` — with `rearm: { ok, armor, shield, failures }` in the payload
and a `recover_loot_rearm` log line when something went on. The re-arm is **best
effort**, because the loot is already recovered when it runs: a refused place
keeps `ok: true` and reports itself in `rearm.failures`
(`armor_place_failed_<status>` + `carried`), and only "something wearable,
nothing worn" is `ok: false` / `rearm_failed`.

`rearm_gear` offers the same pass standalone — offered when `_needsRearm()`
sees a slot carrying an armor piece the armor slots do not wear, or the shield
in the pack — and `survival/intents.mjs` declares it `heal` + `shelter` from the
start, so the emergency filter that once dropped the shield cannot drop it. The
shield goes into the `offhand` container (slot 1, fallback 0), never into the
pack. `tests/bedrock-recover-rearm.test.mjs` (5 tests) covers the pass, the
destination, the partial failure, the empty case and the option gating; the
action catalogue in `BEDROCK.md` gains its row, and [respawn](wiki/respawn.md)
and [emergency](wiki/emergency.md) explain the rule. **No live proof yet**: the
round that proves it is a death with loot to recover, and the armor fix
`4ec6820` is still undeployed (live image `225440a`) — see
[open-questions](wiki/open-questions.md).

## [2026-10-06] fix | One death is one episode, and a runtime id does not outlive its session

The driver dumped the ten `death` events of run 2 (`demo-r2`) from the container
ledger with two minutes of context each. Three of them are mining decisions made
with low health and one is a `flee` that failed; two are harness defects, and
both are now fixed.

**The respawn limbo wrote a death per cycle.** `_onOwnHealth` opened the death on
`health <= 0 && !dead`, but the client-side respawn closes `dead` on its own —
`_finishRespawn`, reached by the 4 s fallback when the server never sends
`state 1` — while the BDS has not restored the health yet. The next health
attribute, still 0, therefore re-entered the death branch: `deaths++`, another
`death` event, `deathSite` rewritten and `_deadSince` reset, so the reconnect
timer (and the `deadMs` it reports) restarted at every cycle. Live: four extra
`death` events at 22:24:00, 22:24:24, 22:24:48 and 22:25:16, all at the same
coordinate with no action in between, plus `respawn_limbo_recover { health: 0,
deaths: 5 }` and a `respawn_reconnect { deadMs: 25023 }` whose 25 s measured the
last cycle, not the death. A death is now an **episode** (`_deathEpisode`, from
health 0 to health > 0): neither `_finishRespawn` nor the limbo re-arm opens a
new one, and `alive_again` also fires when `dead` had already been closed by the
fallback — before, that path left the limbo silent. `tests/bedrock-death-episode.test.mjs`
(3 tests) pins the single event across the whole dance. The internal `deaths`
counter lives only in the constructor (`bedrock-adapter.mjs:631`) and is
never reset in code: it is per process, so a harness restart restarts it — the
ledger stays the only continuous record (10 events there, 7 in the counter).

**A skeleton was attacked on a runtime id from the previous session.** Runtime
ids are per session, but two paths kept stale ones in the census: `_onStartGame`
cleared the inventory mirror and the pickups and **not** `this.entities`, and an
`add_entity` carrying an `unique_id` already known under another runtime id added
a second entry, leaving the old one with its type, position and health until
`_pruneEntities` dropped it after 60 s without packets. The rejoin after the
respawn reconnect rebuilt the list with the skeleton as `508`; `_combat`, which
locks its target by runtime id on purpose (03/10: re-resolving the nearest mob
every swing spread the hits and killed nobody), kept swinging at `50` — 25
`attack` with `targetHealth: 12`, `attack_skeleton` returning `{ ok: false,
error: 'died_in_combat', hits: 25 }`, and an iron sword did no damage at all.
Fixed in three places: `_trackEntity` deletes the previous runtime id when the
same `unique_id` reappears with a new one (`entity_readded`); `_onStartGame`
clears the census, the unique-id index and the name index; and `_combat` treats a
hit that does not move the target's health as no hit — after `ATTACK_SILENT_HITS`
(default 3) it logs `attack_no_damage` (`runtimeId`, `reappeared`, `health`) and
re-locks the nearest entity of that type. A refused `player_action respawn` inside
`_survivalTick` is unchanged: the `RESPAWN_RECONNECT_MS` watchdog remains the
recovery. `tests/bedrock-entity-ghost.test.mjs` (3 tests) pins the tombstone, the
login reset and the re-lock.

Left open, and it is policy rather than harness: nothing yet makes the bot leave
a mob's reach right after a respawn, so a skeleton camping the spawn point is
still a death loop (see open-questions), and the dark base that let it spawn
indoors is only half fixed by the torch crafting of `5fa6f04`.

## [2026-10-06] fix | Equipping armor is typed, retried and survives a stale mirror

Run 1 of the diamond mission spent `equip_armor` once on a carried
`golden_leggings` and got `{"ok": false, "error": "armor_equip_failed"}` with
`observe().armor` empty. The counter dump the harness wrote afterwards keeps
`armor_place_failed=1` and **no** `armor_take_failed`/`cursor_take_failed`: the
take had worked and the **place** into the `armor` container had been refused —
and the status was thrown away, `armor_equip_failed` being the only error the
action could return. The payload lived in the container's `events.jsonl`, so the
refusal itself is not recoverable from this host.

`_equipArmor` now mirrors `_equipShield` (the fixes of 03/10, when the shield
take turned out to need an open player window):

1. it closes a container an action has open before touching the armor;
2. it keeps one retry of the `place` with the cursor still loaded — a refused
   place changes nothing server-side, so the same `item_stack_id` is still valid
   — and reports `armor_place_failed_<status>` with `failures[].attempts`, each
   one carrying its status and the cursor stack id, instead of collapsing into
   `armor_equip_failed`;
3. a piece the aggregate shows but no slot does is a stale mirror, not "no
   armor": one `_resyncByReconnect` (`armor_resync`) then a re-read, and if the
   slot still does not appear the error is `no_armor_in_inventory` with the
   `carried` piece named.

A refused take is still reported per piece (`armor_take_failed` in `failures`)
without skipping the next one. `_equipPumpkin` keeps its own take without the
window guard: same latent class, not changed here.

`tests/bedrock-armor-equip.test.mjs` (7 tests) drives a fake BDS that refuses the
place with a status, flakes once, hands the slot only after a resync or never;
full suite 1780/1780. The cause of the refused place towards `armor` is still
unexplained — the next live attempt is what will print its status.

## [2026-10-06] fix | The inventory resync asks the window before it drops the session

Run 2 of the diamond mission refreshed the inventory mirror the only way the
adapter had — `_resyncByReconnect`: `disconnect` then `connect` — and the BDS
answered `connecterror:9`, retrying `[connect] attempt 5/6/8` until the bot
container was restarted. That code is nethernet's `ErrorCode.InactivityTimeout`
(`node_modules/nethernet/src/signalling.js:18`, armed in `src/client.js:210`):
the negotiation never completes because the server still holds the previous
session, and every retry adds another half-open one. The reconnect existed for a
single purpose — a fresh `inventory_content` with fresh stack ids — and the
server sends exactly that when the player window is opened (`interact
open_inventory`), without touching the session.

`_resyncByReconnect` now:

1. tries `_refreshInventoryFromServer(...)` first: close a **clean** player
   window if one is open, `_ensureInventoryOpen()`, wait for an accepted 36-slot
   snapshot (`_playerSnapshotCount`/`_waitForPlayerSnapshot`), close again;
   logged `inventory_refresh` and `inventory_resync_done {via:'refresh'}`. It
   refuses to touch a window an action is using — any other container (a chest),
   a non-empty crafting grid or a stack on the cursor — and sends those paths to
   the reconnect (`_canRefreshInventoryInPlace`);
2. only then reconnects, after `INVENTORY_RESYNC_SETTLE_MS` (1500 ms) so the
   server can release the old session, at most once every
   `INVENTORY_RESYNC_COOLDOWN_MS` (30 s) — a second attempt inside the cooldown
   throws `inventory_resync_throttled` instead of hammering a BDS that is
   already refusing — and reports a reconnect that failed or never spawned as
   `inventory_resync_wedged` (`connectError` included) rather than pretending the
   slots are fresh.

`tests/bedrock-resync.test.mjs` pins the eight behaviours (refresh without a
reconnect, the fallback, the cooldown, a wedge on a failed connect, a wedge on a
connect without spawn, an open chest left alone, `not_connected` up front, and a
cursor item never dropped); the suite is 1773/1773.

The other four items of that run's report are already fixed and documented:
`recover_loot` duplicating the mirror and the short snapshot that wiped it
(`7291278`, `f74e11d`), the torch craft that did not know what it had placed in
its own grid (`5fa6f04`), the deposit verified on a prediction instead of on the
chest (`f74e11d`), and `anvil_input`, which turned out not to be the wipe. Run 2
itself ended with six ore blocks destroyed according to the run report and no
deposit: the ledger with the coordinates lives in the harness container
(`runs/demo-r2`), so this entry does not quote them.

## [2026-10-06] fix | The exploration drivers never imported the run resolver

The `RUNS_DIR` plumbing replaced the hardcoded `runs/<id>` in every entry point
with `runDir(RUN)`, but the three exploration drivers (`explore.mjs`,
`explore-find.mjs`, `explore-replay.mjs`) never got the import: they would have
died with `ReferenceError: runDir is not defined` at the first line after the
constants. Nothing caught it because the suite loads neither of them — a static
check in `tests/run-paths.test.mjs` now reads all six entry points and asserts
that every `runDir`/`runsRoot` call site imports it from `run-paths.mjs`.

## [2026-10-06] fix | The crafting grid learns what it placed, and a rejected variant no longer stops the search

Run 2 of the diamond mission failed on `craft_torch` twice with a bare
`craft_failed` (status 35), the two `place` requests into the grid having just
been answered `{"statuses":["ok"]}` and `craft_spruce_planks`/`craft_stick`
having succeeded 40 ms earlier through the very same slots 30/28. The failure
detail named the real problem: `"grid":[{"slot":30,"name":0,"count":1},
{"slot":28,"name":0,"count":1}]` — the adapter did not know which item it had
put in its own grid.

`_placeFromCursor` called `_applyStackResponse(response)` **without** a
`networkId`, and it runs immediately after `_clearCraftingGrid`, so a cell could
only ever record `network_id: 0` (`name: 0` in the log). It now takes the source
slot's `network_id` — read *before* the take, because a one-item pile disappears
from the slot and takes its id with it — passes it to `_applyStackResponse`,
records the cell even when the server does not echo `crafting_input`, and logs
`craft_grid_place` with `{gridSlot, item, count, stackId, echoed, containers}`
(`echoed: false` is the proof that the grid is not coming back).

Two more defects came out of the same failure. `_craftAttempt` **returned** on the
first `craft_failed`, so with two torch recipes declared by the server
(`name:charcoal` 1897 and `tag:coals` 1896) a refusal of the chosen variant meant
the other was never tried, even with coal in the pack; it now remembers the first
failure longer and continues through the candidates, reporting
`craft_failed_detail` with the grid's `stack_id`s and the `consumeStackIds`
actually sent. And `craft_failed` joined the `syncable` set of `_craftItem`
(`missing_ingredients|craft_failed|take_failed_49/50|place_failed_49/50`), so a 35
gets **one** `_resyncByReconnect` and one more attempt — safe because the
`finally` of `_craftAttempt` already returns the grid to the pack, so the retry
re-reads the world instead of replaying a stale model.

`tests/bedrock-crafting.test.mjs` (23 pass) now declares both torch recipes in
`craftAdapter()` and pins: the 1×2 torch layout (30/28), `_ingredientMatches` on
the `coals` tag (coal and charcoal, not stick), a placement named from the source
slot when the response does not echo the grid, the status-35 detail with
`consumeStackIds`, the variant fallthrough, and the one-shot resync retry. The
case that asserted *"craft failures unrelated to sync are returned as-is"* now
uses `place_failed_55`, since 35 is syncable by design.

The root cause of the 35 is **not** proven: `runs/demo-r2/events.jsonl` has no
packet log in that window (`BEDROCK_PACKET_LOG=1` gives `packet`/`rx_hex`; run 1
had `packet=179151`) and the torch was never sampled in `recipe_sample`. The
cheap decisive live test is a `craft_torch` with only coal, then only charcoal.

## [2026-10-06] fix | The deposit is a postcondition: read the chest back, not the response

Run 2 of the diamond mission failed on the cheapest step it had (`deposit_diamond`,
five `take_failed_49`) after doing the hard part, and run 1's success had been
declared by `_depositStackInto` on the `ok` of two stack requests plus the
adapter's own register, then checked by hand afterwards (two `read_container`
calls showing `diamond: 21`). While making the check automatic the measurement
itself broke: `dump_inventory` answered `deposit_unverified` with
`before {held:64, stored:4}` → `after {held:0, stored:4}`, because a `place` of 64
onto a pile of 4 fills a **second** slot and the packet does not name the item —
the response cannot be the proof of anything.

`deposit_<item>` is now a postconditioned operation. `_heldCount` counts the item
in the player **slots** (never `this.inventory`, which still sums the estimated
pickups — live: aggregate 5 diamonds against 2 in the slots), `_storageItemCountAfter`
closes and reopens the container and counts the item in the fresh mirror
(`container_reread`, `container_reread_failed`, `null` when unverifiable), and
`_depositStackInto` returns `before/after {held, stored}`, `verified: true`,
`heldDelta` and `storedDelta` only when the chest really grew by the deposited
count. Otherwise: `deposit_unverified`, logged as `container_deposit_unverified`
with `takeStatus`, `placeStatus`, `playerReported`, `expected` and the slot counts
from the `place` response. A stale-mirror failure (`missing_item`,
`take_failed_49/50`, `place_failed_49/50`) gets **one** retry after
`_resyncByReconnect` (`retriedAfterResync`; a resync that fails is logged
`inventory_resync_failed` and the original error is returned), and the cached
container contents are written from the read-back, never from the prediction.

`tests/bedrock-storage.test.mjs` (53 pass) now models the chest as **two
registers** — the server's, which `place` mutates with 64-stack overflow, and the
client mirror, which is rebuilt only when the window opens — and pins the new
behaviours: the successful deposit carries `before {held:4, stored:0}` /
`after {held:0, stored:4}`, a deposition the chest does not show is refused, and a
stale mirror is resynced before `missing_item` is declared.
`node --test tests/*.test.mjs` → 1759 pass in 184 s. Live residual: the read-back
costs one close/open per deposited stack, and the postcondition has not yet run
against the BDS.

## [2026-10-06] fix | A short player snapshot no longer wipes the inventory mirror

Reported from the run 2 session as "login `inventory_content` with
`container_id: anvil_input` empties the mirror" (the empty mirror is what made
`take_failed_49` survive every retry). Reading the code, the anvil packet is a
witness, not the cause: the guard was `isPlayerContainer(containerId) ||
isFullPlayerInventory(list) || (clearWhenEmpty && …)`, and `isPlayerContainer` is
true for `null`, `hotbar`, `inventory` and `hotbar_and_inventory` — in that branch
`this.inventorySlots = slotList` replaced the mirror with whatever arrived,
including an empty or single-slot list, which is exactly the shape of the
`inventory_content` a reconnecting client gets. With `container_id: 'anvil_input'`
both other flags are false, so that packet on its own could not have done it.

`_applyPlayerInventorySnapshot` (`bedrock-adapter.mjs:1704`) now accepts only a
**36-slot** list as a snapshot; anything else logs `inventory_snapshot_ignored`
with `{container, slots, mirror}` and is ignored. It is safe because single-slot
changes arrive through `inventory_slot` (`bedrock-adapter.mjs:1021`,
`_playerSlotIndex`, index bound to 0-35), so a wholesale replace can only be a
full player inventory. Two new cases in `tests/bedrock-inventory-mirror.test.mjs`
(9/9): a short list with `containerId 'inventory'` and an `anvil_input` packet
neither wipe the mirror nor count as inventory.

## [2026-10-06] fix | The run ledger can live on the host (`RUNS_DIR`)

The diamond mission's ledger was written inside the harness container
(`/app/runs/demo`), so the evidence of the run existed only where the run had
happened: `runs/demo` on the host holds test fixtures, and the numbers could be
checked only by reading a copy of the container's files. `runs/<RUN_ID>` was
hardcoded in every entry point (`bedrock-harness.mjs`, `controller.mjs`,
`harness.mjs`, the three `explore-*.mjs` drivers).

`run-paths.mjs` now resolves it: `RUNS_DIR` (default `runs`) plus `RUN_ID`, with
`runsRoot()` feeding `MEMORY_DIR`'s default (`<root>/memory`). Mount a host
directory on `RUNS_DIR` and a run's `actions.jsonl`/`summary.json` are readable
from the host as they are written; the controller reads the same variable, so the
harness ledger and `controller.jsonl` land in one directory even though the
harness runs in a container. Defaults are unchanged when `RUNS_DIR` is unset.

`node --test tests/*.test.mjs` → 1755 pass; `tests/run-paths.test.mjs` has two
cases (the root and the run directory follow `RUNS_DIR`; a ledger written through
it reads back with `readRunFacts` → `verifiable: true`, `busy` counted as a
refusal) and the existing ledger tests are untouched. Documented in
[observability](wiki/observability.md).

## [2026-10-06] fix | `go_home` returns in hops when no direct path exists

The second of the eight gaps the diamond mission exposed: from the mine bottom
`go_home` answered `go_home_failed: path_failed` eight times in a row (once
`movement timeout`), and the "1200 cells spanning the surface" the census
reported were exactly the BFS limit (`reachableCells({ limit: 1200 })`) — a
truncated set, not a route to the surface. Live, the human driving the bot
returned it by walking waypoint hops by hand.

`_goHome` now gives the direct `_moveTo` 60% of its budget and, when that does not
arrive, hands the rest to `_homeHops`: a greedy walk over the *reachable* cells,
where each hop is at most 24 blocks away and at least one block closer (3D) to
home, and each hop is bounded to 12 s, so the 5000-node A* budget
(`PATH_MAX_NODES`, `bedrock-adapter.mjs:78`) is never asked for a 50-block climb
in one go. A hop that fails (`hop_failed`), a reachable set with nothing closer
(`no_progress`) and a hop budget run out (`hop_budget_exhausted`) all come back
with the trail of cells walked, and the success path says which mechanism
returned the bot (`via: 'direct'` / `via: 'hops'`, with `partial` when it stopped
short). The hop loop reads `_startNode()` and `reachableCells()` to choose, never
moves the bot to measure, and a failure inside it is caught and folded into the
`go_home_failed` error instead of escaping the action.

`node --test tests/*.test.mjs` → 1753 pass; `tests/bedrock-go-home.test.mjs`
covers the six cases (the direct path still wins, the hop chain out of a deep
shaft, `no_progress`, the 24-block hop bound, a reachability failure reported
instead of thrown, `maxHops`) and the four `go_home` tests in
`tests/bedrock-survival.test.mjs` still pass unchanged.

## [2026-10-06] fix | `dig_up` stops depending on where the bot happens to look

The first of the eight gaps the diamond mission exposed is the one that stranded
the bot twice in the tunnel it had just dug (at ~y 29.6 and ~y 48.6):
`_upTargets()` computed the stair only in `_digDirection()` (the yaw, or the
planner waypoint), so a bot facing an open side got `no_step_ahead` while the wall
behind it was solid, and `dig_up` disappeared from `/options`.
`pillar_up` was out too (`no_headroom`, it needs 2) and `barricade` failed 24 times
in a row (`barricade_incomplete`); live, the only thing that worked was turning the
bot with a 3-block `goto_waypoint` hop — which only the human driving it knew.

`_upTargets()` now tries the facing direction first and then the other three
cardinals, with the unchanged body in `_upTargetsFor(d)`. The first climbable
direction wins, so a bot that can climb forward still climbs straight (no
zig-zag), and when none of the four works the error is the facing one with `tried`
listing all four attempts. `dig_down` was left as it was: no `_digTargets` refusal
was recorded, only the stranding, and `dig_up` returning is what unblocks it.

`node --test tests/*.test.mjs` → 1747 pass; the three new cases in
`tests/bedrock-dig-up.test.mjs` cover the tunnel (open side, solid wall behind),
the straight-stair preference and the all-four-fail error, and the three tests
that pinned the old behaviour (open step, water step, protected chest, sensor
radius) still pass unchanged.

## [2026-10-06] fix | Three defects from the diamond mission: the inventory mirror, the mining reach, the emergency fight

The audit of the diamond goal returned `verdict: disapproved`, and the two hours
that followed it (not recorded in the goal ledger) had exposed three defects
nobody had written down. All three are fixed with a regression test;
`node --test tests/*.test.mjs` → 1744 pass.

- **The inventory mirror duplicated loot after a death.** `take_item_entity`
  confirms a pickup the BDS never echoes back in `inventory_content`, so the
  adapter mirrors it in `this.pickups`; nothing cleared the mirror on death, so
  the same items were counted twice (`iron_ingot` 64 → 128, `diamond` 3 → 5) and
  the following deposit could not exist (`take_failed_49`). The death branch of
  `_onOwnHealth` now calls `_forgetDroppedInventory('death')`
  (`inventory_mirror_reset`), a full 36-slot snapshot absorbs the pickups
  (`_absorbPickups`) and an empty one never does.
  `tests/bedrock-inventory-mirror.test.mjs` (7 tests).
- **The mining reach is one number shared by the offer and the executor.**
  `/options` advertised a `diamond_ore` 11.7 blocks away, the executor walked,
  failed silently and sent the break anyway, so ten consecutive calls returned
  `block_still_present` (353 failed actions out of 678 in the run).
  `mineTargetReachable()` (`MINE_REACH` 5.1, `MINE_APPROACH_RANGE` 2.5) is used by
  both `_pickMineTarget` and `_mineBlock`, and the executor answers
  `mine_target_unreachable` with the distance.
  `tests/bedrock-mining-reach.test.mjs` (8 tests).
- **An armed bot could neither fight nor raise its shield in an emergency.** The
  emergency filter admits only the intents of rules with `priority >= 95`, and the
  only rule naming `fight` was `hostile_close` (80): `attack_<mob>` was removed in
  *every* emergency, including the skeleton loop that killed the bot five times at
  its spawn point. `equip_shield`/`raise_shield`/`lower_shield` had no intent at
  all (`unknown`, so always filtered). New rule `hostile_melee_armed` (95,
  `hostileWithin: 5` + `weaponInInventory`, `escape` still first) and the three
  shield keys now mean `shelter` ([emergency](wiki/emergency.md)). The death loop
  itself stays open: nothing yet moves the bot out of a camper's reach on respawn.
- `goal_*.jsonl` (pi session logs, personal data) is gitignored, and the
  post-audit defects are written down in [open-questions](wiki/open-questions.md):
  the goal ledger stopped at 18:02 while the checkpoint kept updating to 20:12.

## [2026-10-06] run | Diamond mission end to end: village recon, the village mine channel, two diamonds, the deposit

The first full hand-driven mission against the live Bedrock world (CT 108),
driven only through `POST /plan` + `POST /act` on the harness API, no controller and no
model in the loop. Goal: village recon first, descend through a **pre-existing** village
mine passage (never drill at random), mine at least two diamonds, deposit them in a chest
by the closed pig pen, and never lose loot on death.

- **Recon** — `survey_village` ran its whole 120 s budget (`{"ok":true,"ms":120188}`, the
  only line in `runs/demo/actions.jsonl` for it): 9 houses, 4 plots, 16 storage blocks, 54
  beds, 24 animals, 131 crops, `missing: ['bell (0/1)']`, `CONFIRMED` at confidence 0.6
  (score 6 / minScore 5, evidence beds 54, workstations 159, villagers 10).
- **The existing channel** — the descent used the walkable diagonal staircase at **z = 195**
  (x 114 → 91, y 62 → 39, one block per level) opening into a chamber at y 33–38
  (x 72–96, z 187–207). It was walked down with short waypoint hops (~5 blocks each); a
  single deep waypoint fails (`movement timeout` / `target_not_found`).
- **The diamonds** — from the chamber a staircase of `dig_down` steps reached y 15, where
  four `mine_diamond_ore` calls succeeded against the server world
  (`confirmedBy: server_world`, `destroyedEvent: true`, `tool: iron_pickaxe`):
  **(90,11,191)**, **(90,10,190)**, **(91,10,190)**, **(90,10,191)** — i.e. the vein sits at
  **y 10–11, x 90–91, z 190–191**, above the stone/deepslate boundary (deepslate ores start
  at y ≤ 7 here; a second, unneeded `deepslate_diamond_ore` was seen at (78,2,181)).
- **Kit** — the chest bank at (90–95, 72–73, 160–165) supplied iron ingots, coal, torches,
  shield and golden leggings; **the 19 diamonds and the `diamond_pickaxe` already in those
  chests were deliberately left alone** so the two mined diamonds are the run's own product.
  `craft_iron_pickaxe` worked without placing a table (a reachable `crafting_table` within
  32 blocks); `equip_armor` failed once with `armor_equip_failed` and was never retried.
- **No deaths.** One night caught the bot on the surface (`phase night`, a phantom at 6.1
  blocks, hp 15.8): the governor went to `caution` with `night_with_bed`, `eat` raised food
  to 20 and `sleep` in the bed at (91,73,162) skipped the night (`{"ok":true,"slept":
  "player_sleep_flag"}`); while asleep every `/act` correctly answers `sleeping`.
- **The deposit** — `deposit_diamond` moved the 2 diamonds into the storage bank chest
  **(91,73,160)**: `{"ok":true,"item":"diamond","count":2,"into":"chest",
  "inventoryDelta":-2,"ms":21792}`. Run ledger (`GET /stats`, run `demo`): 682 attempts,
  678 executed, 325 ok, 353 failed, 4 refused (2 `sleeping`, 2 `not_connected`),
  `actionMs` 2815507 (~2816 s of action time).
- **Eight harness gaps this round exposed** (all recorded in
  [open-questions.md](wiki/open-questions.md)): no "dig straight up" action (`dig_up` needs
  a solid step *in the facing direction*, so the bot twice stranded itself in its own
  tunnel and only a facing-turn walk freed it); `go_home` fails from a deep shaft even when
  the reachable set is surface-connected; `pillar_up` cannot start at `headroom: 1`;
  `mine_<ore>` needs a *reachable* drop cell; fences decode as `unknown-` so every pen is
  reported `fenced: false`; the `deposit_<item>` description names a different container
  than the execution targets (and prints the type as a runtime id); `/debug/reach` caps
  `cells` at 200 sorted by y; and `iron_age` is satisfied by any iron tool while the mine
  options need an iron *pickaxe*.
- **Which chest, and the deposit verified** — a fresh `observe().village.pens` (bot at the
  workshop) returns exactly one pig pen, **anchor (83,72,152) with 16 adults**, plus the
  chicken pen (93,74,183); the enclosure near the workshop at (105–113,140–145) is *not* a
  pen any more (no animal in it, `entities` shows villagers, cats and a donkey). The closed
  pig pen is therefore the fenced herd pen, and the nearest chest bank to it is the base
  storehouse **(90–95, 72–73, 160–165)** — (90,72,160) 7.8 and (91,73,160) 8.6 blocks from
  the pen centre, ≈6 from its fence, against ~7+ for the farm-shed bank (73,71,153). The
  double chest at **(91,73,160)** was read back after the deposit: **`diamond` 21** (the 19
  pre-existing + the 2 mined), `iron_ingot` 795 and `gold_ingot` 144 unchanged, and the bot's
  own `diamond` count back to 0.
- **The bot lost the server mid-verification** — `Server closed connection:
  connecterror:9` on every retry (10 s → 60 s backoff) while `test-ping.mjs` still answered
  `PING OK` (`playerCount: 0`, `acceptsOnlineAuth: true`, `acceptsSelfSignedAuth: false`) and
  the Microsoft caches were being refreshed normally (`*_bed-cache.json` rewritten during the
  retries): the documented fault class (NetherNet wedged, see the wiki page for CT 108, the
  `-32 (Kelp)` / `-13` row) and not an auth problem. Fixed the documented way: the bot
  container is stopped, the Bedrock service is restarted at zero players
  (`proxmoxctl exec 108 --command "systemctl restart minecraft-bedrock"`, journal `Stopping…
  17:50:47` / `Started 17:51:35`), then the container starts again and the mirror reconnects.

## [2026-10-06] feat | Deep Dark W2: a route that stays outside every sensor sphere

The Deep Dark roadmap (`docs/raw/DEEP_DARK_ROADMAP.md`) got its third milestone.
**W2** adds the pure planner to `bedrock-vibration.mjs` — `SENSOR_CELL_COST = 50`,
`stealthCellCost({cell, sensors, shriekers, radius})` (a cell with a shrieker under
it is forbidden, every other cell costs more the more sensors hear it),
`astarStealth({start, goal, neighbors, cellCost, maxNodes})` and
`planStealthRoute({start, goal, exit, neighbors, cellCost, maxNodes, maxRisk})`,
which refuses the whole plan as `no_stealth_route` (reason `risk`) instead of
walking through a hearing, and asks for a return route **before** the bot moves:
the exit leg is re-planned towards the exit rather than being the inbound path
reversed (a fall works one way only), and its absence is its own refusal,
`no_exit_route`. The adapter feeds the planner the census (`_stealthPlanner`,
`sculk_unknown` when the world was never scanned) and its walking-only neighbour
generator, so a route can only contain steps — no digging and no placing can
appear in one by construction. `sneak_to` gains the alias `walk_stealthy`; the
accepted plan travels back in the result as `{cells, maxRisk, sneak: true, exit}`
and stays in `_stealthRoute` as mission memory for W3's `escape_deep_dark`. Two
more refusals close the vibration leaks around the walk: `_placeAtCell` refuses a
target inside a sphere (`vibration_risk_place`, with an explicit
`allowVibrationRisk` escape) and the `mine_<block>` branch refuses a noisy target
(`vibration_risk_mine: <block> at x,y,z (N sculk sensor(s) in range)`) after
`_pickMineTarget` preferred a silent one. Tests: 11 pure cases in
`tests/bedrock-stealth-route.test.mjs` and 5 adapter cases in
`tests/bedrock-vibration-adapter.test.mjs`; merged suite **1585/1585**. Still
never live: the W2 acceptance is a two-sensor corridor whose plan must come back
with `maxRisk: 0` and no sensor phase activation, and the world holds no loaded
Deep Dark.

## [2026-10-06] feat | Deep Dark W0/W1: a vibration model and a sneak that is verified

The Deep Dark roadmap (`docs/raw/DEEP_DARK_ROADMAP.md`) got its first two
milestones. **W0** adds the pure module `bedrock-vibration.mjs` (the 8-block
sphere of `VIBRATION_RADIUS`, `vibrationProfile` per action,
`sensorPhase`/`shriekerState`, `vibrationRisk` and `pointSegmentDistance`,
`shriekerVerdict`, `wardenWarning`, `summarizeSculk`), the adapter census
`_sculkCensus` (throttled by `SCULK_RESCAN_MS`, `ready: false` on an unloaded
world, shrieks counted once per `active` transition inside a ten-minute window),
`_wardenView`, the `sculk`/`sneak` blocks in `observe()` and the routes
`GET /observe.sculk` / `GET /observe.sneak`; the whole `SCULK_FAMILY` joins
`DIG_PROTECTED`, and a `dig_*` whose target cell lies inside a sensor sphere is
refused with a typed `vibration_risk_<label>` before anything is broken. **W1**
turns sneak into a movement mode (`_moveTo(..., { sneak: true })`, flag held on
every tick, declared on the wire once through the `start_sneaking`/
`stop_sneaking` transition) and, more importantly, *verifies* it: the distance
the server accepted is compared with the sneak ceiling, so a walk that was not
actually crouched fails with `not_sneaking`, and a track with no real step is
`no_measurement` rather than a silent success. Action `sneak_to` sits next to
`goto_waypoint` and is refused while riding. Tests: `tests/vibration.test.mjs`
(11 pure cases) and `tests/bedrock-vibration-adapter.test.mjs` (14 cases: the dig
refusals, the loaded-world gate, shriek counting, the Warden census, the wire
transition, the speed verdict, the riding refusal); merged suite **1569/1569**.
Nothing is live-verified: the Bedrock numbers (sphere, relay, sneak silence,
3-shriek summon) come from the reference, not from the deployed build, and the
world holds no loaded Deep Dark.

## [2026-10-06] feat | The waiting escort says where it waits

On 06/10 the user asked whether the bot tells them in chat "ti sto aspettando,
sono alle coordinate x, y, z". The answer was no: `_escortTo`
(`bedrock-adapter.mjs`) only logs `escort_wait_over`/`escort_lost`/…, and the only
waiting line in the code was the follow `lost` notice
(`human-replies.mjs:94` → `chat-lang/it.mjs:17`), which carries no coordinates.
Now the escort tells the human where it is, **once per waiting episode**: new key
`escort_waiting` in the five `chat-lang/*.mjs` catalogues (the phrase is data, not
a string in the code), `escortWaiting` in `human-replies.mjs` (returns `null`
without a readable `x`/`z` — `Number(null)` is `0`, so the raw value is checked —
and `?` for a missing height), and `noticeEscortWaiting` in `controller.mjs` with
`ESCORT_WAITING_COOLDOWN_MS` (60000 ms by default), wired at the two places where
the escort stops: the human beyond `ESCORT_MAX_GAP` (`reason: 'gap'`) and out of
view (`reason: 'no_track'`, inside `escortHold`). Both episodes re-arm when the
human comes back, and the line is sent with the same `replyChat` used by the rest
of the human channel. Tests: `tests/human-replies.test.mjs` (14 cases, the
rounding and the silence among them) and `tests/controller-escort.test.mjs`
(exactly one `/say` and one `escort_waiting` event while `escort_to` is
re-issued). Docs:
[human-command](wiki/human-command.md) "Follow semantics", [verification](wiki/verification.md)
47.53 and the `ESCORT_*` bullet in `AGENTS.md`. Residual: the wording and the
rate have never reached a real human on the BDS.

## [2026-10-06] ingest | Deep Dark stealth roadmap: sculk sensors, shriekers and the Warden

Spec for crossing a Deep Dark / Ancient City sculk field without waking the
Warden, tracked as [`docs/raw/DEEP_DARK_ROADMAP.md`](raw/DEEP_DARK_ROADMAP.md)
and synthesized in [deep-dark](wiki/deep-dark.md). The answer to "can the bot
navigate the sculk field and avoid the Warden?" is **no, not today** — and the
roadmap records why, from the code: the `ancient_city` marker rule
(`structures.mjs:86-96`) has never fired live, `deep_dark` is only an alias
(`exploration.mjs:19`) with no `find_deep_dark` action, `DIG_PROTECTED`
(`bedrock-adapter.mjs:85`) and `FORBIDDEN_BLOCKS` (`circuits.mjs:79,87`) protect
sculk blocks from *breaking* but not from *being heard*, sneak exists only as a
construction input (`bedrock-adapter.mjs:10188-10204`, cleared by `_moveTo` at
`:10203-10204`), the Darkness effect is parsed but unused
(`bedrock-adapter.mjs:1526`) and the Warden is a generic hostile with the wrong
flee (`bedrock-survival.mjs:17,37,44-46`).

The seven milestones are W0 vibration awareness (`bedrock-vibration.mjs` +
`GET /observe.sculk`, full `SCULK_FAMILY` in `DIG_PROTECTED`), W1 verified
sneak-walk (authoritative speed vs the sneak ceiling, typed `not_sneaking`), W2
vibration-cost stealth pathfinding with a mandatory return route, W3 shrieker
and Warden warning with the anti-run tactic, W4 underground 3D navigation +
`find_deep_dark`, W5 Darkness/kit/escape budget, W6 limits (never loot, never a
Warden in the shared world without consent, no client-side silence trick).
Nothing is implemented or live-verified; the Bedrock numbers must be re-probed
before the model is trusted.

## [2026-10-06] deploy | HEAD meets the live container

The five debrief fixes were on `main` (`84192dd`, `27bf89b`, `e913e04`, `71d0c8b`)
while the bot kept running the 05/10 image, so the deployed code and the repo said
different things (the live build had `craft_iron_pickaxe` but no `escort_to`, no
`observe().kit`, no `GET /stats`, no run ledger). Aligned.

- **Drift measured first**: local vs the VM's copy of the repo by
  `rsync -ani --checksum` (~280 entries), and the running image by sha256 —
  `bedrock-adapter.mjs` live `5e1b7279…` against HEAD `d0b6dacc…`. The VM
directory is a **plain copy** (its `.git` is a leftover gitdir file pointing at a
  local worktree path), so no `git pull` there: files are synced, the image is
  rebuilt.
- **Before touching anything**: no controller and no HTTP client (`ss -tn | grep
  3077`), only `node bedrock-harness.mjs`; the previous image was tagged
  `hermes-jev-bedrock-rollback-20261006` (`9fa732c59504`) for a one-command
  rollback.
- **Deploy**: rsync of HEAD with `.env`, `.private`, `runs`, `nmp-cache` excluded,
  then `docker compose build && docker compose up -d` (container recreated
  11:19 CEST). Verified after: the five key files' sha256 equal HEAD's, `GET
  /stats` answers (`{"run":"demo","pid":1,"attempts":0…}`), `/observe` shows the
  bot reconnected at the same position, and `observe().kit` is present. The
  in-memory plan was lost with the old process (`plan: null`), which is expected:
  a restarted harness has to be given a plan again.
- **What this does not prove**: the escort is still untested with a real human
  (row 47.52 of [verification](wiki/verification.md) keeps its residual), and the
  run ledger starts empty — its numbers only exist for runs started after this
  deploy.

## [2026-10-06] feat | An escort order makes the bot lead, not follow

The owner's third question in the 06/10 debrief — *"se ti chiedo di guidarmi fino
lì riusciresti ad accompagnarmi?"* — had been answered "Sì" by a session that
had no escort at all: `follow_player` is the bot following the human, the
opposite, and while the human is out of view it cannot even be offered. Point
2b of the debrief is now a feature instead of a sentence.

- **`escort_to`** (`bedrock-adapter.mjs`, `_escortTo`/`_escortView`/
  `_escortTarget`): walks the named human toward a destination — the order's
  `plan.escort.to`, else the plan `waypoint`, else the active replay route — and
  **waits** for them: beyond `ESCORT_MAX_GAP` (12) it stops and resumes when the
  gap is back to `ESCORT_RESUME_GAP` (5), and it gives up with a reason instead
  of drifting away: `escort_left_behind` after `ESCORT_WAIT_MS` (60 s) of waiting,
  `escort_lost` after `ESCORT_LOST_MS` (20 s) with no trace, `escort_timeout` at
  the action ceiling, `escort_failed: <msg>` after three pathfinding failures.
  Every threshold is in `observe().escort.limits`, so the controller never has to
  guess a number.
- **The option is offered only when it is real**: `escort_to` appears in
  `/options` when `plan.escort` names a human, a destination resolved and that
  human is tracked; `observe().escort` says which of the three is missing.
- **The order is deterministic** (`controller-decisions.mjs` +
  `controller.mjs`): `isEscortOrder` recognises a lead verb
  ("guidami/accompagnami/portami/vieni con me/lead me…"), `humanCommandPlan`
  publishes `plan.escort = { from, to }` and clears `plan.follow`, and while
  `goal.escort` is open the controller picks `escort_to` without a model
  decision. When the human is out of view it **holds** (the same way it holds a
  lost follow, spending no budget) and releases the order after
  `LOST_HOLD_MAX_STEPS` with an `escort_released` reason. An order with no
  destination degrades to a follow rather than lying about leading.
- **Tests**: 10 adapter cases (`tests/bedrock-escort.test.mjs`: the wait/resume
  gate, both refusals, both give-ups, the limits) plus a scripted-harness
  integration test (`tests/controller-escort.test.mjs`: the order becomes
  `plan.escort`, the act chosen is `escort_to`, no model decision, one
  `goal_met`).
- **Wiki**: row 47.52 of [verification](wiki/verification.md) (🧪 — offline only),
  the follow-semantics bullet of [human command](wiki/human-command.md), and M3 in
  [exploration](wiki/exploration.md) is no longer "blocked by the environment":
  what stays blocked is a *real* escort with a human on the BDS.

## [2026-10-06] fix | The map points at the vein, and the kit is a state

Two of the five gaps found in the 06/10 debrief (the diamond report was accurate
in substance, off in detail).

- **The ore position, not the chunk centre** (`bedrock-adapter.mjs`,
  `_rememberDiscoveries`): every resource site was anchored on
  `(cx*16+8, pos.y, cz*16+8)` — up to 8 blocks from the block that was seen — so a
  `goto_waypoint` sourced from the memory walked to the chunk centre while the
  vein sat one block away (reported z=231, vein at z=232). The scan now keeps the
  nearest ore block's own position (`found.position`, distance from the block or
  computed), and falls back to the centre only when the block is in the palette
  but unreadable; an ore still counts as observed when its position cannot be
  resolved, so no site disappears. Tests: 2 cases in
  `tests/adapter-memory.test.mjs`; memory suite 101/101.
- **`observe().kit`: what is carried, not what could be crafted**
  (`_tripKitView` + `TRIP_KIT_REQUIREMENTS`): bed, torches, pickaxes and food with
  `sparePickaxe`, `missing` and `ready`. `observe().travel` keeps its
  preparation semantics (`light: true` for coal+sticks) — that is exactly how a
  plan gets read as state, and the two now say different things on purpose. The
  tags `torches` (torch/soul_torch, not the redstone torch) and `pickaxes`
  (pickaxes only, unlike `picks`) were added to `survival/item-tags.mjs`.
- **`prep_cave_trip`** (`skills/gameplay/survival/`): the same four numbers as
  success criteria, so the sentence *"porterei letto, torce e piccone di riserva"*
  becomes something to do and verify; a test asserts the skill's thresholds equal
  `TRIP_KIT_REQUIREMENTS` so the promise and the state cannot drift apart.
- **Wiki**: [survival intelligence](wiki/survival-intelligence.md) documents the
  kit/plan distinction, [memory](wiki/memory.md) the ore position, rows 47.50 and
  47.51 of [verification](wiki/verification.md).

## [2026-10-06] feat | A run leaves its own numbers

The owner asked what the first-diamond run had cost. The diamond had been mined
live that morning, but the run was driven **by hand over `/act`** by an agent
session, so it left no `controller.jsonl` and no metrics; the agent answered
*"circa 7 minuti e 17 secondi di lavoro attivo"* **without reading any file**, and
nothing in `runs/construction-live-house/` could confirm or contradict it. The same
turn claimed the bot would "accompany" the owner to the vein, which no action
could do either.

- **`run-ledger.mjs`**: `createRunLedger(dir)` appends one line per `POST /act` to
  `runs/<run>/actions.jsonl` (`{t,key,ok,ms,error}`) and aggregates it;
  `readRunFacts(dir)` reads a run back and reports whether it is verifiable at all.
  A **refused** call is not work: `busy` (the adapter's lock), `not_connected`,
  `dead` and `sleeping` are counted under `refusals` and never in
  `actionSeconds` — the old failure mode of counting lock answers as steps is why
  `tests/controller-busy.test.mjs` exists.
- **Harness**: the `/act` route records the attempt, `GET /stats` returns the
  aggregate (`pid`, `uptimeMs`, attempts, executed, failures, refusals, action
  seconds, wall clock, per-key), and `shutdown()` writes `summary.json`, so a
  killed run still has data on disk.
- **Controller**: SIGINT/SIGTERM now logs `run_end` with `stepsUsed`/`totalCost`
  before exiting (the deploy timeout that killed `diamond-20261006-4` left the last
  record a `result` and no total).
- **`tools/run-facts.mjs <run> [--json]`**: prints actions, action seconds, wall
  clock, per-key counts, controller steps and `totalCost`; for a run with no ledger
  it answers `verificabile: NO` instead of guessing.
- **Rules**: `AGENTS.md` (operational safety + harness gotchas) and the
  `minecraft-bounded-agent` skill now require every quoted number to come from a
  file or route read in the same turn, and a capability to be checked in
  `GET /options` before being described as available.
- **Tests**: `tests/run-ledger.test.mjs`, 3 cases (busy/refused classification and
  milliseconds; append-only lines plus `writeSummary`; `readRunFacts` over a
  controller run with its `totalCost`, an empty directory and a torn last line).
- **Wiki**: new page [observability](wiki/observability.md), row 47.49 of
  [verification](wiki/verification.md), and the benchmark bullet now records the
  live single diamond while keeping "5 diamonds" as not run.

## [2026-10-05] refactor | One chat catalogue file per language

The owner's suggestion: *"ti consiglio di dividere le etichette in file dedicati di
lang, uno per lingua"*. `chat-i18n.mjs` was 763 lines — the five language tables
inline (114 keys each) plus the API — so a translator had to scroll past four
languages to touch one, and a merge on a different language was a conflict in the
same file.

- **New layout**: `chat-lang/it.mjs`, `chat-lang/en.mjs`, `chat-lang/fr.mjs`,
  `chat-lang/es.mjs`, `chat-lang/de.mjs`, each `export default Object.freeze({…})`
  with its own header, keys and placeholders. `chat-lang/it.mjs` is the reference
  and the only file with the section comments (lifecycle / questions / greeting /
  fallbacks / phrases / chores / needs / narration).
- **`chat-i18n.mjs` is now the API** (138 lines): it imports the five tables into
  `MESSAGES` (`const CATALOGUES = { it, en, fr, es, de }`) and keeps `t`,
  `hasMessage`, `messageKeys`, `listAnd`, `LANG_NAMES`, `LANG_NATIVE_NAMES` and the
  `CHAT_LANG` resolution. No caller changed: the public surface is identical, so
  `human-replies.mjs`, `human-questions.mjs`, `human-greeting.mjs`,
  `chat-llm.mjs`, `chat-narration.mjs` and the controller are untouched.
- **The parity guarantee is unchanged and is now per-file**: `MESSAGES` is
  assembled from the imports, so `tests/chat-i18n.test.mjs` still proves every
  language defines every key with identical placeholders — adding a language
  means adding one file and its code to `LANGS`/`LANG_NAMES`/`LANG_NATIVE_NAMES`.
- **Verified**: `node --test tests/*.test.mjs` → **1499/1499** (the i18n/reply/
  question/greeting/llm/narration subset was 81/81 on its own);
  `npm run wiki:lint` clean; `node --check chat-i18n.mjs` and the five new files
  clean. `node_modules` still carries `chat-i18n.mjs`'s old shape nowhere — no
  runtime consumer reads the catalogue file directly.

## [2026-10-05] verify | "@bot che fai?" is answered, in every language

The owner asked that the bot also answer `@bot che fai?`. The capability was
already there — `q_activity` in `human-questions.mjs` (`che fai`, `cosa stai
facendo`, `what are you doing`, `que fais-tu`, `que haces`, `was machst du`,
with or without the `?`) is served by the **regex fast path**, so no model and
no key are needed, and `answerIntent('q_activity', …)` reads `observe().plan`:
`sto facendo: <phrase>` via `planPhrase` (drop/collect/equip/chore/need/
curriculum/opportunity), or `non ho un obiettivo: sono in attesa di ordini` when
no plan is active. Nothing in the order path can swallow it: `resolveQuestion`
runs **before** the order detectors, and in both IDLE and the goal loop.

What was missing was the **evidence**, so two integration cases now pin it in
`tests/controller-chat-ack.test.mjs`: an active plan is echoed from
`observe().plan` (`q_activity`, `via: 'regex'`, one `/say`, no `chat_command`,
no `human_order`) and the idle bot admits it has no objective instead of
inventing one. The M6 section of `docs/wiki/human-command.md` now names `che
fai?` as the canonical `q_activity` phrase and lists both cases.

## [2026-10-05] feat | Chat M9: getta e cattura

Two inventory orders the owner asked for, both planned **deterministically** — the
one state the bot can verify exactly is its own pack, so no model is needed to
know whether the diamonds left it:

- **`@bot getta i diamanti`** empties the named item out of the inventory
  (`drop_item`): `orderItem` reuses the chat item vocabulary (`ITEM_WORDS`, five
  languages), `inventoryMatchingToken` resolves "diamanti"/"ferro" into the
  concrete stacks (exact name wins, tools and armour are not what you throw
  away), the plan carries the baseline (`drop: {token, word, count, items,
  before}`) and `_dropItems` sends one `item_stack_request` with the protocol's
  own `drop` action per stack — no cursor, no fake `place`. `dropFulfilled`
  closes the order on the *accounting* (all of it, or exactly the quota).
- **`@bot cattura i diamanti` / `cattura spada`** picks the dropped item
  back up (`collect_drop`): the search is *filtered* to the token
  (`_nearestDrop({names})`, `_plannedCollectNames()`), so a coal drop next to the
  diamond is not swept up "while we're there"; `collectFulfilled` closes it when
  the token's total grew, so a drop that landed after the plan still counts.
- **A refusal, not a hopeless goal.** If the harness does not offer the action
  (item missing / nothing on the ground) the order is closed immediately with
  `drop_order {error:'item_not_in_inventory'}` or
  `collect_order {error:'no_matching_drop'}`, the human is told (`no_item`,
  `no_drop`) and the run ends with that reason — no mining detour, no exhausted
  budget. A verb with no item from the catalogue is not an inventory order
  (`@bot raccogli 4 terra` stays a planner gather quota).
- **The emergency filter respects the order.** `humanOrderProtectedKeys(plan)` in
  `survival/resolver.mjs` keeps `drop_item`/`collect_drop` alongside the
  follower of "seguimi", so one policy drives both the `/options` route and the
  governor.
- **A defect the tests forced, fixed.** `_refreshInventory` counted a zeroed slot
  as `1` (`item.count || 1`), so a stack dropped to zero stayed "1" and
  `dropFulfilled` could never close — now a slot with `amount <= 0` is skipped.
- **Evidence.** `tests/controller-drop-order.test.mjs` (vocabulary, verbs, the
  `raccogli 4 terra` non-case, quotas, item-tuple preferences, both criteria),
  `tests/bedrock-drop.test.mjs` (request shape, quota/multi-stack, the
  failure/no-progress/empty paths, `_plannedDrop`, `_plannedCollectNames`, the
  filtered `collect_drop`) and four integration cases in
  `tests/controller-chat-ack.test.mjs` (drop success/refusal, collect
  success/refusal). The `drop` action has **not** been sent to a live BDS yet —
  same standing as M6.4.

## [2026-10-05] feat | The work comes home (M3c)

The last piece of the economic cycle the user asked for (*"a fine task scarica"*):
a productive goal ended when the last block was mined, and the harvest stayed in
the pack until a threshold (8) made a chore worth it. Now a successful
`village`/`autonomous` goal queues one last child goal, `store_harvest` with
threshold 1, so the sequence is **produce → store → verify**.

- **Where the policy lives, the harness.** `bedrock-adapter.mjs` gained
  `_isKeptItem`/`_depositableItems` (tools, armour, buckets, seeds, torches and
  portable stations, and `DEPOSIT_KEEP_RESERVE = 16` of every food stack stay in
  the pack; wheat is *not* food), `_depositTargetFor` (a chest that already holds
  the item scores `+100000`, then the distance; `cachedOnly` keeps the moment
  cheap) and `observe().deposit` (`{items, total, target, at}`). `deposit_<item>`
  was generalised into the bounded `dump_inventory` (`DEPOSIT_MAX_STACKS = 8`,
  keeps the reserve), which shares `_depositStackInto` with the single-item
  action. `storableStack` now reads that census instead of keeping a second list
  of what is storable; the harness is the arbiter.
- **A child goal, not a step.** `maybeStoreEpilogue(goal, outcome)` runs in
  `main()` before `enterState('GOAL_COMPLETED')` and only on `success`, only for
  `village`/`autonomous`, never for a `store_harvest` itself. The child reuses
  `isChoreResolved`, so a full chest cannot rewrite the parent's outcome into a
  failure, and it does not count against `VILLAGE_MAX_CHORES`. It is
  `source: autonomous`, so a chat order that arrives first is served first.
- **A real cache bug found by the tests.** The open-window slot mirror is a
  photograph taken when the chest was opened and `_applyStackResponse` does not
  update other containers, so recomposing the contents from it after every stack
  *erased the previous deposits from the cache* (a three-item dump left only the
  last one) — and with them the "this chest already holds that item" score. The
  contents now accumulate across the stacks of one dump.
- **Tests**: 6 new cases in `tests/bedrock-storage.test.mjs` (51/51: keep list
  with reserve, the right chest chosen over the nearest, the census, a full dump
  checking inventory/cache/request count, the two clean failures, the option),
  2 in `tests/village-labor.test.mjs` (the chore follows the census; an empty
  census beats a full stack), 1 integration case in
  `tests/controller-session.test.mjs` asserting
  `STORE EPILOGUE after gN -> village chore gN+1 [store_harvest]` and the child
  persisted `completed` with `parameters.epilogueOf = gN` (10/10).
- **Open**: the epilogue consolidates nothing (it walks to the best chest it
  knows); smelting first is M9; in one-shot mode the child stays queued until
  `RESUME=on`.

## [2026-10-05] feat | The bot says what it is doing (M8)

Until now the bot worked in silence whenever nobody had asked it anything: a
village chore started, the human standing next to it saw it walk away and had no
idea why. The authorised plan was *"annuncio una volta a inizio goal, solo
autonomous/village, saySmart, range 24, throttle 5 min. Nessun annuncio finale"*,
with one hard rule: a fact is never decided by the model.

- **`chat-narration.mjs`** (new, pure): `narrateGoal(plan, {lang})` picks the
  frame (a chore first, then a need) and returns `null` when there is nothing to
  say; `narrateChore`/`narrateNeed` compose it from the catalogue;
  `targetWord(target)` names the concrete item (`item.potato`) or falls back to
  the family word (`kind.log`, `kind.ore`, …), never a raw id. A need carries its
  own frame (`narrate_need`), so it is not wrapped twice in
  `autonomy_narration`.
- **`chat-i18n.mjs`**: 32 new keys in all five languages — `autonomy_narration`,
  `narrate_need`, one `narrate.<choreId>` for each of the 11 chores, `item.<id>`
  for the 8 crop products, `kind.<x>` for the families. The placeholder-parity
  test keeps them honest.
- **`village-labor.mjs`**: every chore now declares a `target` (`targetOf`), and
  the controller copies it into `plan.choreTarget` — so the announcement names
  the crop the census actually saw.
- **`controller.mjs`**: `maybeNarrateGoal(goal)` runs in `main()` just before
  `runGoal(goal)`. It fires only when `CHAT_NARRATE` is on (default: follow
  `CHAT_REPLY`), the goal is `village`/`autonomous`, the cooldown elapsed, the
  bot is spawned and a human is within `CHAT_GREET_RANGE`; the goal is marked as
  narrated **only if the message is actually sent**, so a goal started in
  solitude can still speak later. The text goes to `saySmart` as both message and
  grounding: the M7 LLM may rephrase it, never invent it.
- **Tests**: `tests/chat-narration.test.mjs` (9 unit) proves every chore and
  every need is announceable in five languages; `tests/village-labor.test.mjs`
  covers `targetOf`; the integration case in `tests/controller-session.test.mjs`
  asserts that *"In autonomia: sto raccogliendo il grano"* reaches `POST /say`
  with an allowlisted human at distance 5 (9/9). Unit suites: 47 pass / 0 fail;
  full suite: **1458 pass / 0 fail**.
- **Also fixed here**: `.env.example` and `BEDROCK.md` still claimed DeepSeek has
  no "flash" model; the chat engine now documents `CHAT_LLM_MODEL=deepseek-flash`
  (V4.1-Flash) with its thinking-on-by-default caveat.
- Numbering: the label follows the request's wording (M8); it is a slice of
  milestone 3/4 (autonomy + social behaviour), not the `M8 Character` row of the
  roadmap table. Documented in `docs/wiki/ai-player-roadmap.md`.

## [2026-10-05] feat | One chat catalogue, five languages (M7.2)

The ask: *"facciamo una bella cosa, i18n per i messaggi con una proprietà env con
la lingua default, potremmo fare italiano, inglese, francese, spagnolo, tedesco
per iniziare"*. M7.1 had made the deterministic path Italian by hand; the general
case needs a catalogue, otherwise the next language duplicates every sentence and
the two copies drift.

- **`chat-i18n.mjs`** (new, pure): `MESSAGES` — one entry per key for `it`, `en`,
  `fr`, `es`, `de` — plus `t(lang, key, vars)`, `listAnd`, `LANGS`,
  `DEFAULT_LANG='it'`, `LANG_NAMES` (English, for the prompts),
  `LANG_NATIVE_NAMES` (`italiano`…`Deutsch`, to tell the model which language a
  clear message did not pick) and the `CHAT_LANG` resolution (`chatLangConfig`,
  `normalizeLang`, `isSupportedLang`). Region codes resolve (`en-US` → `en`) and
  an unknown value falls back with a single `CHAT_LANG="pt" non supportata`
  line at startup — a quiet typo is worse than a warning.
- **One trap caught by the tests**: `t()` without `vars` must return the
  *template* (`@{name} ok: {objective}`), not an interpolation with an empty
  object — the first run sent `'@ ok:'` to chat because every placeholder had
  been emptied before `renderReply` filled it. `interpolate` now leaves a
  placeholder with no value visible, so an incomplete template is readable
  instead of silent.
- **Deterministic first, again**: `orderAck`, `orderOutcome`, `lostNotice`,
  `renderAnswer`, `renderUnrouted`, `renderNoArmor`, `planPhrase`,
  `planGreetings` and the three planner fallbacks (`fallback.stop`,
  `fallback.follow`, `fallback.equip`) all take `lang` and are wired to
  `CHAT_LANG` in `controller.mjs`. No key is needed: the language is data, not a
  provider fee.
- **Labels are derived, not copied**: `CHORE_LABELS`/`NEED_LABELS` are built from
  the `chore.*`/`need.*` catalogue keys by `labelsFromCatalogue`, and
  `choreLabel(id, lang)`/`needLabel(id, lang)` answer in any language (unknown id
  → `null`, never an invented phrase).
- **The five languages reach the intent patterns**: `ITEM_WORDS`,
  `MATERIAL_WORDS`, `QUESTION_OPENERS`, `SMALL_TALK` and the seven
  `QUESTION_INTENTS` regexes take French/Spanish/German alternatives (`ou es-tu`,
  `donde estas`, `wo bist du`, `que fais-tu`, `quelle heure`, `quien eres`, `was
  kannst du`), and `normalizeForMatching` folds accents (`Kürbis` → `kurbis`,
  `¿dónde` → `donde`) so the word boundaries keep working.
- **The LLM follows the message.** `buildChatMessages` receives `lang` and the
  system prompt says: same language as the message, and if the message does not
  make it clear, `LANG_NATIVE_NAMES[CHAT_LANG]`. A clear message always wins.
- **Tests**: `tests/chat-i18n.test.mjs` (18 tests) proves every language defines
  every key, the placeholders of a key are identical across the five versions,
  the strings actually differ, every `VILLAGE_CHORES` id and every
  `NEED_PRIORITY` need has a label in all five languages, the ack/outcome/refusal
  /greeting follow `CHAT_LANG`, and the FR/ES/DE questions reach the right intent
  without a model. The six chat suites (`tests/chat-i18n.test.mjs`,
  `tests/human-questions.test.mjs`, `tests/human-replies.test.mjs`,
  `tests/human-greeting.test.mjs`, `tests/chat-llm.test.mjs`,
  `tests/chat-intent.test.mjs`) → **83 pass / 0 fail**; the four controller chat
  suites → **31 pass / 0 fail**. Full suite: `node --test tests/*.test.mjs` →
  **1446 pass / 0 fail** (153 s; +18 = the new catalogue tests).
- **Docs**: `.env.example` (block `CHAT_LANG`), `BEDROCK.md` (env +
  `chat-i18n.mjs` component), `README.md` (one catalogue, five languages),
  `docs/sources.md`, `docs/index.md` and this entry; the wiki page
  `docs/wiki/human-command.md` gained the M7.2 section.

## [2026-10-05] fix | The deterministic reply speaks the sender's language (M7.1)

The user's clarification: *"la risposta deterministica dovrebbe essere in
italiano se la domanda è in italiano, per questo chiedevo di introdurre llm e
farlo sembrare naturale"* — the LLM is for naturalness, not for the language.
M7 could rephrase only when a key was present, so without one the ack and the
outcome still pasted the planner's English, third-person objective (`Stay put and
wait for the next order`), and `activityAnswer` ("cosa stai facendo?") pasted the
knowledge-base objective of a chore or a need (`Harvest the ripe crops in the
village plots …`).

M7.1 moves the language into the deterministic path and leaves the model the
naturalness: the `humanCommandPlan` prompt now asks for `objective` in the same
language as the human message and in the first person (the ack sends exactly that
text), and the fallbacks that never reach the planner are Italian — `resto fermo
in attesa del prossimo ordine`, `seguo <name> ed eseguo il suo ultimo ordine:
"…"`, `mi metto l'armatura che ho in inventario (elmo, corazza, gambali,
stivali)`. `human-questions.mjs` gains `CHORE_LABELS`, `NEED_LABELS` and
`planPhrase(plan)`: a village chore, a survival need, `wear_armor`, a loot
recovery, a construction plan or an `opportunity:`/`curriculum:` note becomes an
Italian sentence, and `activityAnswer` falls back to `plan.objective` only for a
human order (already in the sender's language) — `targets` are deliberately
ignored for that reason.

Tests: `tests/human-questions.test.mjs` (+3: label coverage over every
`VILLAGE_CHORES` id and every `NEED_PRIORITY` need, `planPhrase` per goal form,
the Italian activity answer) and `tests/controller-follow-order.test.mjs` (the
stop-order fallback asserts the Italian outcome); `tests/human-questions` +
`tests/human-replies` **34 pass / 0 fail**, the three controller chat suites
**23 pass / 0 fail**.

## [2026-10-05] feat | Village labor: the bot is not furniture

The user's standing request: *"mi sta bene che si dichiari bot ma voglio che non
sia inutile, che sia semplicemente un arredo ma che contribuisca alle missioni e
al lavoro nel villagio, coltivazioni, pastorizia, legname, minerali, pesca, etc"*.
M7 gave the bot a voice; M3b gives it chores. `village-labor.mjs` is a pure,
deterministic producer (no LLM) that turns `observe()` into ranked **chores**:
`harvest_crops` (70), `store_harvest` (65), `shear_sheep` (60), `milk_cows`
(58), `collect_honey` (56), `tend_animals` (54), `plant_crops` (52),
`go_fishing` (50), `chop_wood` (46), `gather_stone` (42), `mine_ore` (40), each
worth `utility + min(count,5)*2`.

Two invariants, in the style of `idle-goals.mjs`: **the harness is the
arbiter** — a chore is only proposed when `GET /options` already offers one of
its intents (`offeredHas`/`offeredMatches`), so an invalid intent can never
become a goal; and **success is a state delta** — `isChoreResolved` compares
against a `villageSnapshot` captured at creation (`choreGain` for items gained,
a seed actually spent for `plant_crops`, a new baby for `tend_animals`), never
an absolute count and never the model's opinion. The drop list is fixed at
creation because after the harvest the crop is no longer visible. Chores are
`source: autonomous` (lowest priority: a chat order or an emergency always wins)
with `plan.chore`/`plan.choreBefore`, `VILLAGE_COOLDOWN_MS` as the anti-loop and
`VILLAGE_MAX_CHORES` as the session bound.

Implemented: `village-labor.mjs`; wiring in `controller.mjs` (import, the
`VILLAGE_WORK`/`VILLAGE_COOLDOWN_MS`/`VILLAGE_MAX_CHORES`/`VILLAGE_STORE_THRESHOLD`
constants, the `plan.chore` branch in `goalMet` and the `type: 'village'`
enqueue in the `IDLE` block after the autonomy one, sharing a lazily-fetched
`GET /options`); `tests/village-labor.test.mjs` (18 tests, no server) plus the
village case in `tests/controller-session.test.mjs` (integration: an offered
`harvest_*` becomes a completed `village` goal closed by the state delta).
Full suite: **1414 pass / 0 fail**. `.env.example` now documents the whole
enablement chain: `SESSION=on` (persistent session + `IDLE`), `AUTONOMY=on`, then
`VILLAGE_WORK`; `AUTONOMY_COOLDOWN_MS`/`AUTONOMY_MAX_GOALS`/
`SURVIVAL_IDLE_COOLDOWN_MS` and `VILLAGE_COOLDOWN_MS`/`VILLAGE_MAX_CHORES`/
`VILLAGE_STORE_THRESHOLD` carry their defaults.

## [2026-10-05] feat | Chat M7: the reply sounds like a player, not a status line

The family noticed the bot answering **in the third person** and sometimes **in
English**: *"ho notato che in chat il bot risponde come se fosse in terza persona
e non sempre nella lingua della domanda, ma a volte in inglese"*. The scaffold was
Italian, but the ack/outcome/answer interpolated `plan.objective` verbatim — and
the planner prompt is English and writes the objective as an infinitive/third
person. Live logs showed `@<name> ok: Follow <name> and stay close — arrivo da
<name>` and `@<name> fatto: Stay put and wait for the next order (6 azioni)`.

M7 puts an LLM between the composed reply and `POST /say`. The user's decision:
*"se la chiave deepseek flash è su env usi il motore, altrimenti deterministico"*
and, on the persona: *"mi sta bene che si dichiari bot ma voglio che non sia
inutile [...] che contribuisca alle missioni e al lavoro nel villagio,
coltivazioni, pastorizia, legname, minerali, pesca"*.

- **`chat-llm.mjs`** (new): OpenAI-compatible `/chat/completions` client, DeepSeek
  default. `chatLlmConfig`/`chatLlmKey` gate it on `DEEPSEEK_API_KEY` /
  `CHAT_LLM_API_KEY` (`CHAT_LLM=off` disables even with a key); `compactChatFacts`
  builds the only facts the model may use from `observe()`; `buildChatMessages`
  writes the prompt (same language, first person, one line, facts only, never
  start with a trigger); `composeChatReply` returns `{text, model, ms, cost}` or
  throws with a `code` (`no_key`/`timeout`/`transport`/`http_*`/`empty`/
  `self_trigger`); `createChatMemory` is a bounded per-sender history (6 turns, 8
  senders, RAM only).
- **`controller.mjs`**: one helper `saySmart(context, …)` is now the entry point
  for `question`, `unrouted`, `smalltalk`, `ack` and `outcome`; it tries the LLM
  and falls back to the deterministic text, logging one `chat_llm` line
  (`{ok, via:'llm'|'fallback', model, ms, cost, code}`). The order path
  (`humanCommandPlan` + `/options`) is untouched: the model never decides an
  action and never creates a goal. The proactive greeting stays deterministic
  (it teaches the order syntax, and the model could garble `{prefixes}`).
- **`human-questions.mjs`**: `SMALL_TALK` + `looksLikeSmallTalk` — an **exact**
  closed match on the normalised message, so `ciao`/`grazie` get a conversational
  reply and create no goal (`chat_smalltalk`) while `grazie prendi la legna`
  stays an order.
- **Tests**: `tests/chat-llm.test.mjs` (11 tests, stubbed `fetchImpl`, no
  network): config gating, `compactChatFacts`, bounded memory, prompt contents,
  every failure mode, `looksLikeSmallTalk`. Full suite: 1396 pass.
- **Docs**: `.env.example` (CHAT_LLM\*), `docs/wiki/human-command.md` (M7
  milestone + section + env table), `docs/index.md`, `docs/sources.md`.
- **Open**: the M7 path is unit-tested only (never exercised against the
  deployed BDS); the memory is per-process; the same-language rule is a prompt
  instruction, not an assertion.

## [2026-10-05] feat | Chat M6.4: the copper tier, not bronze

The family ordered *"equipaggiati con armatura in bronzo"* and objected when the
bot said bronze does not exist: *"in minecraft esiste l'armatura di bronzo da
qualche versione, anche le armi come spada e gli attrezzi come zappa, piccone,
ascia"*. The objection was half right. **Copper** armour, tools and a sword do
exist — *The Copper Age* (Bedrock 1.21.111 / Java 1.21.9, 30/09/2025) added them —
while **bronze** is not in vanilla Minecraft at all: no `bronze_*` item and no
recipe in any Java or Bedrock version (the only "Bronze" in the game files is the
dye colour `Bronze Olive`; bronze exists as a mod, tin + copper, and as
feedback-site proposals). M6.4 makes the bot agree with the game instead of the
phrase, and adds the crafting step that was missing.

- **`bronzo`/`bronze` mean copper** (`human-questions.mjs`): the alias sits in
  `ITEM_WORDS` and `MATERIAL_WORDS`, with the reason in the code, so `hai una
  spada di bronzo?` answers about the `copper_sword`.
- **A material is part of the question**: `matchMaterial` (legno/wooden,
  pietra/stone, rame/copper/bronzo, ferro/iron, oro/gold, chainmail, diamante,
  netherite, cuoio/leather) narrows `inventoryAnswer` to items whose name starts
  with that material, but only for tool/armour kinds (`MATERIAL_KINDS`) — `hai
  della pietra?` stays the question about `stone` and `cobblestone`. A missing
  material is no longer a flat refusal: `hai una spada di diamante?` → `no, non ne
  ho; ho: wooden_sword, copper_sword`.
- **The bot can craft copper gear** (`options()` in `bedrock-adapter.mjs`):
  `craft_copper_pickaxe|sword|axe|hoe|shovel` and `craft_copper_helmet|chestplate|
  leggings|boots`, offered only while the recipe exists, the materials are there
  (`_craftable(name)` → `_hasMaterials` over the slots or over the aggregate
  `inventory`, because a pickup updates the aggregate before the slots and
  `_craftItem` re-syncs) and the craft is an upgrade (no tool of that kind at
  harvest rank ≥ copper, no piece worn or carried). Mining with copper already
  worked (`TOOL_TIER_SPEED.copper` = 6, `TOOL_HARVEST_RANK.copper` = 2, like
  stone) and so did `raw_copper → copper_ingot` (`SMELT_RECIPES`); this is the
  first tier above stone/wooden that the option list offers on its own. Iron and
  diamond gear stay unoffered on purpose.
- **Equipping stays material-agnostic**: `equip_armor` matches the `_helmet`/
  `_chestplate`/`_leggings`/`_boots` suffixes, so "equipaggiati con l'armatura di
  rame" wears whatever pieces are carried — copper included. A per-material equip
  order is *not* implemented (the intent carries no material).
- **Tests**: `tests/human-questions.test.mjs` ('a question with a material is
  answered about that material': copper, the bronze alias, the informative
  fallback, `quanto rame hai?` remaining the question about the ingot) and
  `tests/bedrock-dig.test.mjs` ('options offer copper gear only while it is an
  upgrade and the ingots are there': the pickaxe/sword offered with 3 ingots,
  suppressed once a `stone_pickaxe` is carried, the chestplate only with 8 ingots
  and only while not worn or carried, nothing of the tier without ingots).
- **Docs**: `wiki/human-command.md` §M6.4 (and the M-list), `sources.md`
  (`human-questions.mjs` row: seven intents + material narrowing; `bedrock-
  adapter.mjs` row: the copper options and `_craftable`), `index.md`,
  `wiki/verification.md`.
- **Not verified live**: the containers still run the pre-M6 chat build, so the
  claim is unit-level for now.

## [2026-10-05] feat | Chat M6.3: what the bot wears, and an equip order that actually equips

A human asked in chat *"quanta vita hai? quanti cuori hai? quanta fame hai? cosa
hai nell'inventario? hai una spada?"* and then ordered *"equipaggiati con
l'elmetto"*, *"equipaggiati con armatura in bronzo"*. M6 answered inventory
questions as a ranked list and never read the equipment slots, and an equip order
was not an order at all: it fell through to the static fallback and became `follow
<sender>` — a bot walking to the sender instead of putting on a helmet.

- **`q_armor`, the seventh intent** (`human-questions.mjs`): `armorAnswer(obs)`
  answers from `observe().armor` (`{helmet, chestplate, leggings, boots, points}`,
  the equipment slots, **worn** ≠ carried) — `indosso: iron_helmet, iron_boots (9
  punti armatura)` / `non indosso armatura` / `non lo so: non ho letto la mia
  armatura` when the fact is missing. Inserted right after `q_health` so its
  phrases beat `q_inventory`'s; the closed option list for Jev is now `a0..a7`
  with `q_none` last (`intentCriteria` derives it, so the model sees it with no
  extra wiring).
- **A named item is the answer**: `inventoryAnswer` now detects the item in the
  message (`ITEM_WORDS`, `matchItemWord` over `normalizeForMatching`) and answers
  that single item (`hai una spada?` → `sì: wooden_sword`, `quanta terra hai?` →
  `dirt x64`, `no, non ne ho`); the ranked list is the fallback.
- **Hearts first**: `q_health` covers `quanti cuori hai?`/`quanta fame hai?` and
  `healthAnswer` leads with `ho 10 cuori (20/20 di vita) e 12/20 di cibo` — Bedrock
  counts half-hearts 0-20, so `round(health / 2)` is what a human expects.
- **Equip orders are deterministic, not model work**: `isEquipOrder`
  (`controller-decisions.mjs`) accepts an equip verb (`equipaggiati`, `mettiti`,
  `indossa`, `wear`, `put on`) **plus** an armor noun (elmo/elmetto/casco/armatura/
  corazza/pettorale/gambali/stivali/scudo/zucca + English), so `mettiti a lavorare`
  stays an ordinary order. `humanCommandPlan` then short-circuits to
  `{need: 'wear_armor', equip: true, follow: null}` with **no Hermes call**
  (`plan` event, `deterministic: 'equip'`), and the controller picks `equip_armor`
  itself whenever the harness offers it (`EQUIP ORDER … deterministico`,
  `equip_order` event).
- **Success is state**: `isNeedResolved('wear_armor', …)` uses the new
  `perception.wornArmorCount` (`survival/perception.mjs`, from `observe().armor`),
  so a helmet in the backpack resolves nothing; the goal closes on the
  confirmatory `goalMet` after exactly one successful action.
- **Nothing to wear is an answer, not a wandering**: with `plan.equip` set and
  `equip_armor` not offered, the bot replies `non ho armatura in inventario, non
  posso equipaggiarmi` (`renderNoArmor`), logs
  `equip_order {key: null, error: 'no_armor_in_inventory'}` and fails the goal with
  that reason, so the human gets `non ce l'ho fatta: …` instead of a silent
  timeout.

Tests: `tests/human-questions.test.mjs` (fast-path phrases, `q_armor` precedence,
item-named answer, hearts/food, missing fact), `tests/controller-decisions.test.mjs`
(`isEquipOrder` true/false pairs), `tests/idle-goals.test.mjs` (`wear_armor`:
worn, not carried), `tests/chat-intent.test.mjs` (the rerouted model-path
messages are ones the fast path does not cover) and
`tests/controller-chat-ack.test.mjs` (end-to-end over a scripted harness: the
equip order is acked, planned `deterministic: 'equip'`, executed as `equip_armor`
with the armor **worn** in `observe().armor`, and with an empty inventory it is
refused and fails with `no_armor_in_inventory`, no `/act` at all). Suite: 1340
pass / 0 fail for the unit files, `tests/controller-chat-ack.test.mjs` green.

Docs: `wiki/human-command.md` §M6.3 (and the M-list, seven intents),
`wiki/verification.md` row 18, `sources.md` (`human-questions.mjs`,
`controller.mjs`, `controller-decisions.mjs`, `idle-goals.mjs`), `index.md`.
No new env var. Not deployed; not pushed.

## [2026-10-05] ingest | The raw potato is safe food, not a poison: safe meals first, harmful ones only when starving

The previous entry (commit `552b562`) put the raw potato in `LAST_RESORT_FOODS`
with the other items that have a side effect. That was wrong, and the wiki says
so explicitly: `minecraft.wiki/w/Poison` lists **only the poisonous potato**
among the Poison sources (I, 0:05, 60% chance), and `minecraft.wiki/w/Potato`
gives *"Eating a potato restores 1 hunger and 0.6 saturation"* with no status
effect at all. The poisonous potato is the risky one *"2 hunger and 1.2 hunger
saturation and has a 60% chance of applying 5 seconds of Poison I"*, identical
in Java and Bedrock. So the policy has two levels and one boundary: a **safe**
meal (cooked food, bread, carrots, apples … and the raw potato last of all),
then — only below `STARVING_FOOD = 4` hunger — `rotten_flesh`, raw `chicken`,
`poisonous_potato` and `spider_eye`. Since `potato` now sits in `FOOD_PRIORITY`,
`perceive().hasFood` is true with a lone raw potato at hunger 12, so the governor
asks for `eat` instead of `obtain_food`, and the `eat` option appears from hunger
18 with nothing better in the inventory. `FOODS` (the "safe food" item tag)
inherits the change. Suite **1287 pass / 0 fail**; commit `17f39b0`.

## [2026-10-05] ingest | An order with an empty plan is no longer "done" at zero actions

Live, the order *"eat the potatoes you have"* closed with `GOAL MET after 0
actions`: `goalMet` treats `targets: {}` as vacuously satisfied, so a chat order
whose plan declares no terminal criterion (no targets, waypoint, follow, need or
skill) was reported as done before the bot touched anything. `controller.mjs`
now requires at least one **successful** action before such an order can close
(`(!humanOrder || !openPlan || hasWorked) && goalMet(...)`, with `lastResult`
kept from the previous step); an order that never succeeds ends on the step
budget. Covered by `tests/controller-chat-open-plan.test.mjs` (order picked up
from IDLE as a `chat` goal, and mid-goal). Same round: the branch
`wip-live-20261005` (`f3c8d46`, 1287 tests) was deployed to the live containers —
the sourcing ladder, the last-resort food rule, the survival ladder with its
rule-order policy and the chat-order guard all run there now, and the
diagnostic env vars (`MOVE_DEBUG`, `PACKET_DEBUG`, `BEDROCK_META_LOG`) were
removed.

## [2026-10-04] ingest | Material sourcing: the inventory first, then the chests, never a building

A human order to build something declares it in `plan.targets`; the harness now
derives the recipe, what is missing and *where* each missing ingredient can be
taken — a craftable intermediate already held (`craft_oak_planks`), a known
chest (`take_oak_planks`), or a natural block only if that option is already
offered. `observe().craft` exposes `{rule, targets, needs, next}` and the
controller runs that step deterministically (`CRAFT SOURCE …`, `craft_source`
event, anti-loop exonerated), so the model is not consulted again. Buildings are
not a source structurally: the mining census is a whitelist of natural blocks
and `DIG_PROTECTED` covers the dig paths. Same round: food corrections — eggs
are not food (cake/pumpkin-pie ingredient) and a raw potato counts only below
`STARVING_FOOD = 4`, so a hurt bot eats instead of going to gather. Tests:
`tests/bedrock-craft-source.test.mjs` (11), `tests/controller-craft-source.test.mjs`
(2), suite **1285 pass / 0 fail**. New page: [crafting](wiki/crafting.md); the
survival ladder (need → intent → action, `surface` for drowning) is documented in
[survival-intelligence](wiki/survival-intelligence.md). Not deployed yet.

## [2026-10-04] feat | Chat M6.2: the bot answers to its own name (`CHAT_SELF_NAME`)

`CHAT_PREFIXES` is static; the bot's **own name** is not, and it is the most
natural way to address it. `observe().self` now exposes `username`
(`BEDROCK_USERNAME`) and `name` (the gamertag the server attributes to the bot,
learned from the chat echo — live it differed from the username). `chatPrefixes(obs)`
composes `CHAT_PREFIXES` with `selfPrefixes(observe().self)`
(`human-replies.mjs`: `@` + lowercased name, deduped, rebuilt on every
observation so the learned gamertag works as soon as the server reveals it). The composed
list is used everywhere the triggers are: order matching, the question path, the
refusal, the reply guard (`isSelfTriggering`), the greeting syntax hint.
`CHAT_SELF_NAME=off` leaves only `CHAT_PREFIXES`. With several bots each answers
to its own name, but triggers must not be prefixes of each other (matching is
`startsWith` with the longest first: `@hermes` would also accept `@hermes2 ...`).
Docs: `wiki/human-command.md` §M6.2, `wiki/verification.md` row 18, `sources.md`,
`index.md`, `.env.example`, `AGENTS.md`, `BEDROCK.md`. Tests 1195/1195
(`human-replies`, `controller-chat-ack`).

## [2026-10-04] ingest | Chat questions M6.1: a router failure is not an order

The M6 question path failed **open**: with an unreachable Jev, `@bot quanti cuori
hai?` fell through to the order path and became the static `follow <sender>`
fallback — a failure that moved the bot. M6.1 closes that boundary with the pure
question guard `looksLikeQuestion` (evaluated on the **raw** text: an explicit
`?`/`¿` or an interrogative first word; bare `hai`/`sei`/`stai` are excluded so
`stai qui` stays an order), used as a **Jev pre-filter**: a message that is not
question-shaped never costs a decisions call (and up to
`CHAT_INTENT_TIMEOUT_MS` of latency) before its ack. `resolveQuestionIntent` now
always returns an `action`: `answer` (regex, or Jev above `CHAT_INTENT_MIN_P`),
`order` (not question-shaped, or `q_none` from a working model — a verdict, not a
failure) or `unrouted` (question-shaped and the router is off, without key, timed
out, errored, unparsable or below the floor). An `unrouted` message is refused by
`renderUnrouted` — `non ho capito la domanda. Se era un ordine, scrivi "@bot
<ordine>".` — logged as `chat_unrouted` with
`reason`/`probability`/`model`/`ms`/`cost`, and **creates no goal**. Transport
errors now carry a code (`no_key`, `http`, `api`, `unparsable`). Docs:
`wiki/human-command.md` §M6.1, `wiki/verification.md` row 18, `sources.md`,
`.env.example`, `AGENTS.md`, `BEDROCK.md`, `index.md`. Tests 1190/1190
(`human-questions`, `chat-intent`, `controller-chat-ack`).

## [2026-10-04] ingest | Chat questions (`CHAT_INTENT`, System One = Jev)

A `@bot <domanda>` message that asks about the bot is now **answered from
`observe()`** instead of being turned into a goal: `@bot dove sei?` used to
produce an ack plus `follow <sender>`, never an answer.

- **Code**: `human-questions.mjs` (pure: six intents with a regex fast path
  `q_position`/`q_health`/`q_activity`/`q_inventory`/`q_time`/`q_identity`, the
  closed option list `intentCriteria` with the `q_none` sentinel,
  `intentFromChoice`, and the answer bodies `answerIntent`/`clockFromTicks`/
  `renderAnswer`); `chat-intent.mjs` (router: regex → System One → "not a
  question", fails open); `system-one.mjs` (System One/Jev transport, now shared
  with `jevDecide`); `controller.mjs` (`resolveQuestion` before the order path,
  `CHAT_INTENT*` config, `chat_intent`/`chat_question` telemetry,
  `chat_reply {context:'question'}`).
- **Safety**: the model never writes the answer — it only picks an option from a
  closed list; a missing fact is admitted ("non lo so: …"). Any router failure
  (no key, timeout, error, low probability, `q_none`) leaves the message an
  order, so the channel is never silenced. A question creates no goal.
- **Config**: `CHAT_INTENT` (default `on` with a TypeSafe/OpenRouter key),
  `CHAT_INTENT_URL`, `CHAT_INTENT_MODEL`, `CHAT_INTENT_TIMEOUT_MS` (4000),
  `CHAT_INTENT_MIN_P` (0.4; probabilities rank options, they do not measure
  confidence).
- **Tests**: `tests/human-questions.test.mjs` (12), `tests/chat-intent.test.mjs`
  (10, stubbed decisions endpoint) and three new cases in
  `tests/controller-chat-ack.test.mjs` (a regex question is answered without a
  goal; a free-form question is routed by System One and still answered from the
  facts; with the router off the message stays an order). Complete suite
  **1181/1181**.
- **Docs**: [human-command](wiki/human-command.md) new *Chat questions (M6)*
  section plus the milestone list, [sources](sources.md) (three new modules,
  `controller.mjs` description) and [index](index.md) updated; env vars in
  `.env.example`, `BEDROCK.md`, `AGENTS.md` and `README.md`.

## [2026-10-04] ingest | Multi-trigger chat orders (`CHAT_PREFIXES`)

Implemented several triggers per bot: `CHAT_PREFIXES` (comma/space separated,
e.g. `@bot,@hermes`) alongside the legacy single `CHAT_PREFIX` (default
`@bot`, summed into the list). Motivation: one bot must answer to both a generic
word and its own name, and several bots on the same server need **distinct**
triggers each.

- **Code**: `human-replies.mjs` exports `DEFAULT_CHAT_PREFIX`,
  `normalizePrefixes(value, {fallback})` and `matchChatPrefix(message, prefixes)`
  → `{prefix, rest}` (longest trigger wins, so `@bot1` is not `@bot`);
  `isSelfTriggering` now checks the whole list. `controller.mjs` builds
  `CHAT_PREFIXES` from `CHAT_PREFIXES`+`CHAT_PREFIX`, strips the matched prefix
  and logs it in `chat_command`; `human-greeting.mjs` gained `formatPrefixes`
  and renders every trigger (`@bot o @hermes <ordine>`, `{prefixes}` in
  `CHAT_GREET_TEMPLATE`) and `chat_greet` carries `prefixes`.
- **Tests**: `tests/human-replies.test.mjs` (normalisation, longest-wins,
  self-trigger), `tests/human-greeting.test.mjs` (rendered syntax list) and
  `tests/controller-chat-ack.test.mjs` (an order with the second trigger is acked
  and stripped; an unconfigured prefix is ignored with no reply and no
  `chat_command`). Complete suite **1156/1156, zero failures**; the touched
  integration file is green (5/5).
- **Docs**: [human-command](wiki/human-command.md) new *Several triggers per
  bot* section plus updated env/open questions, [sources](sources.md) and this
  index refreshed; `README.md`, `BEDROCK.md`, `.env.example` and `AGENTS.md`
  document `CHAT_PREFIXES`. Bug found and fixed while testing: `planGreetings`
  passed the already-joined label to `renderGreeting`, which re-split it on
  whitespace (`@bot o @hermes` → `['@bot','o','@hermes']`), so a joined
  string must never be re-passed to `renderGreeting`.

## [2026-10-04] ingest | Apiculture merged into main with visibility/probe fixes

Merged `feat/bees-honeycomb` (`b2cb688`) into clean `main` after the concurrent
visibility/probe work was committed as `5652045`. No conflicts; both changes
are preserved. Complete merged suite: **1152/1152**, including 24 bee tests;
strict wiki lint is clean. Refreshed apiculture status, roadmap and verification
row 47.48. The bot was verified stopped and no controller was running before
integration; no deploy, live round or public push is part of this merge.

## [2026-10-04] ingest | Bees and honeycomb bounded actions

Added [apiculture](wiki/bees.md) after checking official Bedrock release notes,
Mojang bee entity data and the installed Bedrock palette. Implemented hive/smoke
observation, guarded honeycomb/honey harvest, flower feeding/breeding and four
recipe-driven crafts; protected hives/campfires and classified the new actions
as collection. **24 bee tests; complete suite 1150/1150, zero failures.** Work
is isolated from concurrent adapter edits on a feature branch, with no deploy
or live round; bot OFF policy remains in force.

## [2026-10-04] lint | Campaign close-out: documentation and evidence checks

Reviewed the report, verification policy and promoted tasks together; checked
historical log date/type order against the pre-rewrite copy. The campaign test
result remains the recorded **1126/1126** at `1eda391`; this documentation
close-out introduces no gameplay code or live proof. Concurrent adapter/test
changes are outside this close-out. Mechanical and privacy checks: `npm run wiki:lint:strict` passed with no
errors or warnings; the seven historical date-order inversions remain an
informational note.

## [2026-10-04] report | Pragmatic close-out: bot OFF, shield pending, reusable tasks

The user selected bot OFF by default, no full shield crafting chain, and concise
English rewriting of the historical log. SSH inspection confirmed the bot
container **exited** and no controller process was found; no bot start, BDS
restart or world interaction was performed for close-out. Future live rounds
must have one objective, a deadline, evidence collection and immediate shutdown.

The shield is code ready, material unavailable / live validation blocked.
Offhand slot **1** was proven with a nautilus shell; actual shield equipping,
raising and damage protection remain unverified. Riding, companion, trade,
social and fishing also remain declared live-only gaps. `6984ea8` stays
unit-tested and deployed without a conclusive live proof; the optional round is
deferred.

Promoted three reusable questions to queued tasks with acceptance criteria:
NetherNet transport/ghost-player lifecycle, bounded live validation rounds, and
remembered-storage invalidation/revalidation. These tasks are not implemented
by the close-out. See [open questions](wiki/open-questions.md),
[final report](wiki/final-report.md) and [verification](wiki/verification.md).

Rewrote the complete Italian span as **46 concise English entries** (the old
estimate was 47), retaining historical dates/types/order, results, evidence and
blockers. Detailed capability evidence remains in the English wiki and git
history. The campaign snapshot is **82 commits / 1126 tests** at `1eda391`;
close-out documentation commits are outside that historical count.

## [2026-10-04] verify | The session drops cost a death loop, not just an action

Four more transport drops in one evening, all around real work (a read that answered
`container_read_failed` after 33.5 s with `spawned:false` on the next request, a 121 s
read that collected two chests, a `take_shears` that ran two minutes before the session
closed and the container reconnected by itself). The new, measured part is the
consequence: **while the session is down the player entity stays in the world**, so at
night at the world spawn the bot was killed four times in a few minutes
(`[respawn_request]`, `[respawn_reconnect] {deadMs: 25042}`,
`[respawn_limbo_recover] {health: 0, deaths: 4}`), dropping its inventory (16 eggs) each
time and ending at 2 HP in `emergency`.

The respawn chain itself was re-observed working: `[respawn]` at health 20 after the
watchdog reconnect, `options()` falling back to `wait` ("Dead; respawning automatically")
while `dead`, and `recover_loot` offered with a fresh `deathSite`. Consequence for the
plan: the bot container was stopped once the deaths repeated (`docker stop
hermes-jev-bedrock`), the world is untouched, and the live-only tasks need a session that
survives a walk plus an interaction. Details in
[open-questions](wiki/open-questions.md) (row 47.34 section) and row 12 of
[verification](wiki/verification.md).

## [2026-10-04] fix | A container read stops spending its budget on containers that cannot open

A read is a walk plus an open plus a wait for `inventory_content`, so a chest that
cannot open costs the whole round. The live read of 04/10 collected **two** chests in
**121 s** while the eight-candidate budget went to cells that answered
`container_open_timeout`, and the round before it died with the session dropped.

The failure bookkeeping introduced for the remembered containers (row 47.46) already
knows which cells just refused to open. `_readContainers` now filters its candidates
through `_inOpenFailureCooldown` and logs `container_read_skipped` with the blocks it
left out, so the budget goes to the containers that can actually answer. The
reachability filter is untouched; a container is only skipped *after* it failed, and
the cooldown expires on its own (`STORAGE_OPEN_FAILURE_MS`, 10 min).

Offline: a new case in `tests/bedrock-storage.test.mjs` — with no recorded failure a
read opens two containers, with the cooldown on one it opens only the healthy one
(suite 1126/1126). Deployed to the live container (md5
`cb535ff974fb5b460fcd1fe0a617e6a7`). **The live proof is missing on purpose**: both
attempts ended with the server dropping the session at ~34 s
(`container_read_failed` → `not_connected`), the transport failure already recorded in
row 47.34 — not a fault of the filter, which is why the unit test carries the evidence
and the attempt is written down here instead.

## [2026-10-04] feat | The fishing bobber gets a verdict (and the rod is gone)

A cast used to be a blind bet: `_castRod` watched the bobber for the whole 5-30 s
bite window, and a hook that had landed on the grass ended in
`{ ok: true, note: 'no_bite' }` — a report that blames the server for a problem in
front of the bot. That ambiguity is exactly what the 03/10 five-run round could not
resolve, so it was removed first.

`bobberVerdict ({ bobber, blockAt })` in the pure module `bedrock-fishing.mjs`
answers where the hook landed. A bobber floats on the surface, so «in water» counts
both the cell it occupies and the cell below; a landed hook is
`{ ok: false, reason: 'not_in_water', at, below }` and `_castRod` now **refuses**
with `bobber_not_in_water`, logs the block names and reels the line back in
(`_reelIn({ timeoutMs: 1500 })`, best effort). A **covered** pool (a solid block
over the water surface — the village well is exactly this shape) is *not* refused:
the cast succeeds and carries `covered: true`, because whether a covered pool bites
is a game rule the harness must not invent. An unreadable world is **fail-open**
(`reason: 'unknown'`), so a missing chunk never becomes a false refusal.
`/observe.fishing.bobber` exposes the verdict for a cast already out.

Tests: `tests/bedrock-fishing.test.mjs` 14 → **20** (the verdict's land/surface/
inside/covered/unknown branches, `_castRod` refusing a landed hook and reeling in,
a covered surface casting with the flag), suite **1108 pass / 0 fail**. Deployed to
`hermes-jev-bedrock` (md5 verified host/container) and confirmed live: the new
`bobber` field is in `/observe.fishing` (`null` with no cast out).

**The live cast could not be repeated**: the bot died in a cave on the night of
03-04/10 and a Bedrock respawn empties the inventory, so `fishing_rod` and the 42
string went with it. The reachable world has no replacement — the seven readable
village chests (and the 27 containers in memory) hold no `string`, no
`fishing_rod`, no `stick`; the string of the 03/10 rod came from the bot's own drop
chest at `(92,73,165)`. The remaining string sources are spiders (night) or a
mineshaft's cobwebs, i.e. a weapon first: that errand was started and then
interrupted because sessions on the BDS now die every ~2 minutes (`connecterror:9`,
recorded in [open-questions](wiki/open-questions.md) § NetherNet instability,
including the `minecraft-public-ip-sync` timer that was checked and ruled out, and
the `players: 0` that makes this an ICE/signaling failure rather than the
single-slot limit).

## [2026-10-04] feat | Swimming M1: a measurement probe, and the water the bot cannot enter

The missing half of M1 (the vertical rates) stopped being a guess and became a
live measurement. `adapter.swimMeasure` (`POST /debug/swim-measure`, gated by
`BEDROCK_DEBUG`) forces the vertical intention through `_swimProbe` while sampling
the **server's own** position (`move_player` is authoritative), so one call next
to open water yields `ratePerSecond` for `up`, `down` and `none`.

Getting the bot there needed a deliberate entry primitive: `_standable` treats
deep water as a wall by design (M3 forbids *planning* a descent into water, since
a descent the bot cannot leave is a trap), so `enterWater` walks one node with
`_stepToward` instead of asking A*. `deepWaterColumns` groups the census cells by
column and probes each one up and down; the earlier version ranked by **depth**
first and truncated with `limit`, which filled the list with the 17-cell columns
and hid the pond at the bot's feet — with a reference point it now ranks by
distance. Two guards came from the live world: a **covered** column is skipped
(the step lands on the lid and the motion declares the target reached) and a
column more than four blocks below the feet is refused (`no_water_at_level`).

What the world actually offers: the village pond is a **well**, water at `y=73-74`
under a solid surface at `y=75` (the bot stands at `y=76`, `standingOn: air`; the
structure detector reports a `Village` at `(74,76,174)` right next to the
`(69-72, 172-176)` columns), and the only deep water is a **flooded amphitheatre**
13-17 blocks underground (`ys=56..58`, columns up to 17 cells, waterfall at
`(71,149)`). So the final live calls answer honestly:
`{ enter: true, mode: 'none', max_distance: 24, depth: 2 }` → `not_in_water` with
`entered: { ok: false, error: 'no_water_at_level', columns: [{71,43,153},{72,42,153},…] }`,
and a bare `swimMeasure` → `not_in_water`. **The blocker is world access, not
protocol**: the probe, the entry primitive and the typed refusals are implemented,
unit-tested and live-verified as refusals; one `enter: true` call next to open
water closes M1's last unknown.

Offline: `tests/bedrock-fluids.test.mjs` +2 (distance ranking, per-column grouping
and `limit`), `tests/bedrock-fluids-adapter.test.mjs` +5 (`swimMeasure` up/down and
its typed refusals; `enterWater` entering a deep column, refusing an invented swim,
an already-wet bot, a covered column and a ravine), suite **1102 pass / 0 fail**.

Operational note: a night walk toward the pond cost one death (the bot stepped
into the cave under the well while zombies were around) and the respawn emptied the
inventory. `sleep` first, and do not navigate the village at night.

## [2026-10-04] fix | Entity interactions respect a line of sight (and the packet family is proven accepted)

A live diagnostic round on the real BDS (probe route `POST /debug/probe-interact`,
container `hermes-jev-bedrock`, and a throwaway `jev-diag` clone) settled two
things at once.

**The entity transaction works.** `probe-interact {"action":"attack"}` on a pig
reported `healthBefore:10 → healthAfter:9` (`damage:1`) at 4.0 blocks, so the
standalone `inventory_transaction {transaction_type:'item_use_on_entity'}` is
accepted by BDS 1.26.52. That falsifies the campaign's earlier reading: the
`inventory_content` resync after an entity transaction is **not** a rejection (the
accepted attack produced 8, a refused villager interaction 0, `variant:"none"` 0).
The villager trade window still does not open, at 1.6-4.0 blocks, day or night,
with an unobstructed adult farmer and a free hand; the full list of ruled-out
hypotheses (packet shape, legacy ids, hotbar/held item, eye position, input flags,
`animate`, `mouse_over_entity`, `npc_open`, baby villagers, sleeping villagers,
behaviour packs) is in [trading](wiki/trading.md) and
[verification](wiki/verification.md) row 47.38.

**The real defect fixed here is geometry.** Villagers and mounts were being
interacted with through walls: `open_trade` burned 12-14 s and three attempts on
farmers **inside a house**, and `mount_donkey` hammered six `interact`s on a
donkey 4.6 blocks below the walkable component. New primitive
`_entityVisible (entity, { ratio, samples })` samples the eye→aim segment against
`this.world.blockAt` (fail-open on unloaded chunks) and both paths now refuse
before writing anything: `trade_target_blocked { blockedBy, distance }`,
`trader_moved_away`, `mount_target_blocked`, live-verified in seconds instead of
20 s. The trade loop also re-checks reach and sight **at every attempt** because
villagers walk (nearest trader changed identity three times, distance 2.1 → 5.1
blocks during one round), and `_nearbyTraders` reports the `baby` flag.

Tests: 2 new in `tests/bedrock-reachability.test.mjs`, 3 in
`tests/bedrock-trading.test.mjs`, 1 in `tests/bedrock-riding.test.mjs`, 1 in
`tests/bedrock-interact-probe.test.mjs`; suite 1080 → **1089**.


Chronological record of wiki operations; the 04/10 user-authorized English
rewrite preserves historical dates/types/order. Prefix: `## [YYYY-MM-DD] <type> | <title>`
where `<type>` is one of `ingest`, `query`, `lint`, `doc`, `feat`, `fix`,
`verify`, `report` (the last four joined as the wiki grew).

## [2026-10-03] verify | The session drops are a NetherNet data-channel close, not a kick

The environment defect that killed several live rounds (row 47.34 of
[verification](wiki/verification.md)) got a mechanism instead of a hypothesis, by reading
the code rather than the console.

- The close reason does **not** come from the game: `bedrock-lifecycle.mjs:12`
  (`trackNethernetClient`) stores `client._lifecycleCloseReason` from nethernet's
  `handleConnectionClosed(connection, reason)`, and nethernet calls
  `notifyClosed('disconnected')` when the WebRTC data channel fires `onclose`/`onerror`
  (`node_modules/nethernet/src/connection.js:31,35,43,47`). It is the SCTP/WebRTC session
  that dies, at the transport layer.
- It is not a game kick: the `client.on('kick')` handler in `bedrock-adapter.mjs` logs
  `kicked`, and no `kicked` line exists in the event log. The BDS console says only
  `Player disconnected: <player>, xuid: …`.
- It is not an idle timeout either: `_authTickInterval` (`bedrock-adapter.mjs:589` →
  `_authTick`) sends `player_auth_input` every 50 ms while spawned, so the client keeps
  talking. The only deliberate disconnect in the adapter is `_resyncByReconnect`
  (`bedrock-adapter.mjs:5889`), which logs `inventory_resync` first — absent in every drop.
- Recovery needs no operator: `onDisconnect` → `startConnectionWorker(10000)` →
  `connectLoop` (`bedrock-harness.mjs:124-138`) retries until the bot spawns again.
  Observed twice on 03/10 — the bot returned by itself with its inventory intact — so the
  `systemctl restart minecraft-bedrock.service` on CT 108 is a convenience for the
  `connecterror:9` state, not a requirement.
- Still open: the trigger. Seven of the eight drops happened around a `read_container`
  (many window open/close cycles and `inventory_content` bursts); a bounded experiment
  separating "many windows" from "a long walk with no movement" is still worth running.
  The verification row and [open-questions](wiki/open-questions.md) carry the full detail.

## [2026-10-03] fix | The fishing bite never arrives: the guard that swallowed it, and what the live cast measured

A live fishing round (rod crafted from chest string, 3×3 bench) proved the cast chain and
then measured the gap: `cast_rod` → `{ok:true, bobber:{x:72.1,y:75.1,z:178.1},
waterAt:{x:72,y:74,z:176}}`, the `fishing_hook` entity tracked at y=75 on the water surface
for 48 s — and **five `fish` runs all answering `{ok:true, note:'no_bite',
biteDetected:false, biteSource:null}`** with `grep -c fish_bite` over the whole event log
at **0**. The hook despawns about 40 s after the cast, nothing caught. So the server sends
neither `fish_hook_hook` (13) nor `fish_hook_tease` (14) to this client: the same family as
the mount/trade/offhand confirmations, and the next step is a packet capture of a real
player fishing.

Real defect found on the way: `_onEntityEvent` resolved the entity from
`runtime_entity_id` **before** looking at the event id, so a hook whose runtime id was not
in the entity map dropped the bite silently. The fishing branches now come first (the
entity is only needed for the log payload). New case in `tests/bedrock-fishing.test.mjs`
(14 tests, was 13) asserting that a bite from an unknown runtime id is still registered —
**falsified** against the old order. Suite 1068 → **1069**.

## [2026-10-03] fix | The 3×3 crafting window, stale container contents, and a bounded storage read

Three defects from the same live round on the deployed container, each one found by doing
the work on the real BDS instead of trusting the code:

1. **`craft_bucket` → `place_failed_55`** (18.2 s). `_placeGridIngredients` moved every
   ingredient to the cursor through `_takeToCursor`, which opened the *player* inventory
   first — and that closes any window that is not `inventory`, i.e. the open `workbench`
   holding the 3×3 grid. The event log shows the sequence: `container_open workbench
   (windowId 19)` immediately followed by `container_open inventory (windowId 20)`, a
   `take` that succeeds and a `place` refused with status 55. `_takeToCursor` now accepts
   `{ ensureInventory }` and the crafting path passes `false`.
2. **`read_container` reported `{}` for chests that were full**, and `take_iron_ingot`
   answered `item_not_in_container` with 795 ingots in the cache. Contents arrive in a
   separate `inventory_content` packet; only one window out of eight had sent it, and a
   stale `_openContainerContentAt` flag let the others be read with the previous window's
   (or an empty) slot array — which then **overwrote the cache**. The flag now records
   *which* window sent its contents (`_openContainerContentWindow`), is reset on every
   open/close, and `_ensureStorageOpen` waits for its own window (3 attempts, then the
   typed `container_content_timeout`) instead of a fixed 200 ms.
3. **A 16-chest read took 142 s and the server dropped the session right after it**
   (`connecterror:9` for minutes until a BDS restart, see
   [open questions](wiki/open-questions.md)). Reads are now capped
   (`STORAGE_READ_LIMIT = 8`, `STORAGE_READ_BUDGET_MS = 90000`,
   `STORAGE_READ_WALK_MS = 8000` for the walk to each container, reported as
   `considered`/`truncated`/`budgetExceeded`) and the scan no longer stops at six blocks
   per storage name (`STORAGE_SCAN_PER_NAME = 24`) — which is also why the iron chest two
   blocks away was invisible and why walking two blocks changed the answer.

Tests: `tests/bedrock-storage.test.mjs` (23 cases) and `tests/bedrock-crafting.test.mjs`
(16 cases), with the new cases falsified against the old behaviour (the workbench case
fails without the option; two storage cases fail with the fixed `delay(200)` wait). Suite
**1067 pass / 0 fail**. Live after the deploy: `take_iron_ingot` (64) → `craft_bucket` →
`milk_cow` (`milk_bucket` in the inventory), `craft_shears` → `shear_sheep`
(`sheared:true`), `harvest_carrots` (2 carrots + replant, server-confirmed), `eat`
(food 16 → 19) and `go_home` (47 path nodes), plus typed refusals (`tame_cat`
`missing_feed {cod/salmon}`, `open_trade` `trader_unreachable`, `mount_donkey`
`no_rideable_nearby`). Rows 47.32-47.34 of [verification](wiki/verification.md);
`AGENTS.md` unchanged — the new caps are module constants, not environment variables.

## [2026-10-03] fix | Bedrock item names in the gameplay tables: `cod`/`salmon` and `beetroot`

Found live while running the companion round: `POST /act {tame_cat}` answered
`missing_feed {feed: 'raw_cod/raw_salmon'}` **with nine salmon in the inventory** —
the cat/ocelot food table carried the Java names, so taming was impossible whatever
the bot was holding. Two more names in the same tables were Java spellings:
`SEED_TO_CROP.beetroot_seeds → 'beetroots'` and `CROP_MAX_GROWTH.beetroots`, plus
the crop census list and the `DIG_PROTECTED` pattern in `bedrock-adapter.mjs` —
Bedrock's block is `beetroot` (singular), so a beetroot crop could never be found,
harvested or protected.

Authority, in order: the prismarine registry for `bedrock_1.26.51` (the loader
`bedrock-world.mjs` already uses) has no `raw_cod`/`raw_salmon` item and no
`beetroots` block, while `cod`, `salmon`, `beetroot` all exist; and the server's own
behaviour pack agrees — `vanilla_1.26.10/entities/cat.json` declares
`"minecraft:tameable".tame_items: ["fish", "salmon"]`, with `fish` the legacy id of
`cod` (read from CT 108 through the Proxmox broker, read-only).

Fixed `TAME_FEED` (cat/ocelot) and the two beetroot entries; after the deploy the
same calls answer `missing_feed {feed: 'cod/salmon'}` and `/observe.nearby` exposes a
`beetroot` bucket. Added a **registry guard test** in
`tests/bedrock-survival.test.mjs`: every item name of `TAME_FEED_MAP`,
`ANIMAL_FEED_MAP`, `FOODS`, `PLANTABLE_ITEMS`, `BUCKET_INGREDIENTS`,
`SHIELD_INGREDIENTS` and every block name of `SEED_TO_CROP_MAP`,
`CROP_MAX_GROWTH_MAP` must exist in `itemsByName`/`blocksByName`, and `raw_cod` and
`beetroots` must never come back. Suite 466 → **1058**.

Limit recorded: the **positive** tame (feed → approach → `interact` → `tamed`) is
still unverified live — the village chest that held the only `cod`/`salmon`
(`73,71,153`) now reads empty, so nothing can be fed. See
[companions](wiki/companions.md) and [open questions](wiki/open-questions.md).


`md5sum` of every git-tracked file outside `docs/` and `tests/` compared against
`/app` inside the live container (`hermes-jev-bedrock`, VM 100): 119 local paths,
114 present in the container, **no differing file**. The five local-only paths are
build inputs and local drivers (`Dockerfile`, `docker-compose.yml`, `.gitignore`,
`explore-find.mjs`, `tools/respawn-capture.mjs`). Six files were stale in the
container before this check (`.env.example`, `AGENTS.md`, `BEDROCK.md`,
`README.md`, `skills/gameplay/progression/{beat_the_dragon,enter_nether}.json` —
`notes`/formatting only, semantically identical); they were copied in and the
container restarted. Conclusion: the live evidence recorded in
[verification](wiki/verification.md) was produced by the code at HEAD.
[Final report](wiki/final-report.md) updated with the three later fronts (semantic
recall, hit to waypoint, both retention layers) and this parity check.

## [2026-10-02] doc | LLM-wiki scaffolded and docs translated to English

- Restructured `docs/` into an LLM wiki (manifest `llm-wiki.md`, `index.md`,
  `log.md`, `sources.md`, `raw/`, `wiki/`).
- Translated `BEDROCK.md` (repo root) and `SURVIVAL-INTELLIGENCE.md`
  (now `docs/raw/SURVIVAL-INTELLIGENCE.md`) from Italian to English.
- Moved `REPRODUCTION-REPORT.md` and `evidence/` into `docs/raw/`; moved
  `HEADLESS-CLIENT.md` into `docs/wiki/headless-client.md`.
- Added synthesis pages: `wiki/overview.md`, `wiki/survival-intelligence.md`,
  `wiki/reproduction.md`, `wiki/open-questions.md`.

## [2026-10-03] ingest | Fishing implemented (rod crafting, cast/bite/reel, water detection)

- Added `bedrock-fishing.mjs` (pure, no socket/world access): `isWaterBlock`,
  `isFishItem`/`isEdibleFish`, `fishCount`/`fishItems`, `shoreCandidates`
  (ground cells adjacent to water within `CAST_RANGE`), `nextBiteDelay` (vanilla
  5–30 s window), `FISHING_ROD_INGREDIENTS`. Unit-tested
  (`tests/bedrock-fishing.test.mjs`, 7 tests).
- Wired `bedrock-adapter.mjs`: `/observe.fishing` context, `craft_fishing_rod`
  option (reuses `craft_` → `_craftItem`), `cast_rod`/`reel_in`/`fish` options +
  actions, and the methods `_findFishingSpot`/`_findBobber`/`_fishingContext`/
  `_castRod`/`_reelIn`/`_fish`. Bite detection = bobber `y` dip (best-effort) +
  timing fallback; reel confirmation is the inventory delta.
- Full suite green (277 tests). Live verification on the BDS pending.
- Updated `wiki/fishing.md` (status → implemented), `roadmap.md` (moved fishing
  from not-implemented to live-pending), `index.md`, `sources.md`.

## [2026-10-03] doc | Fishing roadmap (rod, cast/bite/reel, water detection)

- Added `wiki/fishing.md`: roadmap for fishing — string source (spiders/cobweb),
  `craft_fishing_rod` (recipe already indexed from `crafting_data`),
  `cast_rod`/`reel_in` via `_useItemTransaction(click_air)`, water/shore
  perception (`_findWater`), and the open bite-detection problem (bobber
  metadata vs. timing fallback). Roadmaps now live in the wiki layer, not in
  `.private/`.
- Noted existing reuse: `cod`/`salmon` already in `FOOD_PRIORITY` (→ `food` tag)
  and `SMELT_RECIPES` (`cooked_cod`/`cooked_salmon` via `smoker`).
- Updated `index.md`, `roadmap.md` (not-implemented + next planned work) and
  `open-questions.md`.

## [2026-10-02] doc | Human chat command channel roadmap

- Added `wiki/human-command.md`: roadmap for a human-in-chat natural-language
  command channel (`@bot seguimi`, `@bot aiutami coi mob`).
- Analyzed the current state: chat is already received (packet `text` id 9,
  fields `source_name`/`type`/`message`/`xuid`) but unused; player positions are
  tracked but gamertags are dropped; combat is ready; autonomous exploration is
  the hard gap.
- Defined milestones M1–M5 (capture/identify → follow → NL orders → guided
  mining → ack/exploration) and open questions (trigger syntax, follow
  semantics, plan-override priority, acknowledgement).
- Cross-linked from `index.md`, `overview.md` and `open-questions.md`.

## [2026-10-03] ingest | Trading with villagers/wandering traders + levelling

- Added trader detection (`isTraderType`: villager/villager_v2/wandering_trader/
  trader_llama), `open_trade` (`item_use_on_entity` `interact`), `update_trade`
  offer parsing (NBT → buyA/buyB/sell/uses/maxUses/tier), `trade_<index>` and
  `close_trade` to `bedrock-adapter.mjs`; `/observe` now exposes `traders` and
  `trade`.
- Added `bedrock-trading.mjs` (pure economy): profession map, item value
  classification (precious/emerald/cheap/neutral) and `pickBestTrade`.
- Added autonomous trader levelling `level_<profession>`/`level_trader`: loops the
  cheapest available offer (never emeralds nor precious resources) until
  `max_trade_tier`; profession verified live via `update_trade.display_name`.
- Tests: `tests/bedrock-trading.test.mjs` (11) and `tests/bedrock-leveling.test.mjs`
  (11); full suite green (246). Live verification on the BDS pending.
- New page `wiki/trading.md`; updated `index.md`, `sources.md`, `open-questions.md`.

## [2026-10-02] doc | Human chat command channel: M1-M3 implemented

- `bedrock-adapter.mjs`: `_onChat` (`text` id 9 → `chatInbox`), `chat` in
  `observe()`, `username` capture in `_trackEntity`/`_nearbyEntities`,
  `_playerByName`, `follow_player` option + `_followPlayer` action.
- `controller.mjs`: `CHAT_ALLOWLIST`/`CHAT_PREFIX`/`CHAT_CONTROL`, `maybeHumanCommand`
  → Hermes → `/plan` with priority; `goalMet` open-ended for `plan.follow`.
- `controller-decisions.mjs`: `follow_player` ranked tier 2. `tests/*` green
  (+ `follow_player` priority case). `.env.example` documents the new vars.
- Live verification on the BDS still pending.

## [2026-10-02] doc | Bot visibility to other players (not a ghost)

- Added `headless-client.md` §1.1: the bot is a real, fully-visible player
  (player list, default skin, server-authoritative movement); "headless" only
  describes its own missing rendering, not its visibility to others.
- Updated the page's recurring-questions list and the `index.md` summary.

## [2026-10-02] doc | Control-flow page with goal → plan → action diagram

- Added `wiki/control-flow.md`: end-to-end loop (Progression Engine → System
  Two/Hermes → Skill Resolver → harness `/options` → System One/Jev → world),
  with the Survival Governor as a cross-cutting deterministic override.
- Clarified what System Two does *not* do: it is a shallow planner and never
  emits an action sequence; task decomposition is deterministic (progression
  graph + declarative skills).
- Cross-linked from `index.md`, `overview.md` and `survival-intelligence.md`.

## [2026-10-02] doc | Architecture evolution thesis (strategic replanner + subgoal + multi-branch)

- Added `wiki/architecture-evolution.md`: the four-way split (Progression /
  Hermes / harness / Jev), the rename "System Two = strategic replanner, not
  hierarchical planner", and two proposed evolutions — a first-class `subgoal`
  field with receding-horizon planning, and a multi-branch progression graph
  (copper/iron/exploration) with Hermes as branch chooser.
- Mapped "already exists vs proposed" against the code (`milestone`/`skill`
  fields, the replan loop, `resolveMilestone` single-`next` DFS).
- Cross-linked from `index.md`, `overview.md`, `control-flow.md` and
  `open-questions.md`.

## [2026-10-03] doc | Consolidated roadmap + implementation status page

- Added `wiki/roadmap.md`: reorganizes the `.private/` roadmaps/task notes
  (`ROADMAP.md`, `GOAL.md`, `JEV/DEFENSE/FARMING/STORAGE/TRADING-TASK.md`) into
  one current-status view — done/verified-live vs implemented-pending-live vs
  not-implemented — plus GOAL phases, gameplay milestones and next planned work
  (farming first).
- Marked `ROADMAP.md`/`GOAL.md` as historical (frozen 01/10, superseded by code).
- Cross-linked from `index.md`, `sources.md`, `overview.md`, `open-questions.md`.

## [2026-10-03] ingest | Farming slice: plant seeds, feed/hunt farm animals

- `bedrock-survival.mjs`: farm-animal whitelist (`cow`/`mooshroom`/`sheep`/`pig`/
  `chicken`/`rabbit`), `ANIMAL_FEED`, `SEED_TO_CROP`, crop/farmland predicates and
  farm-animal entity heights.
- `bedrock-adapter.mjs`: metadata flags `baby`/`tempted`/`inlove` + `owner_eid`;
  `/observe.farmAnimals`; `plant_<seed>` (click_block on free farmland, confirmed
  by the crop above), `feed_<animal>` (`item_use_on_entity` interact, confirmed by
  `inlove`/consumed), `attack_<animal>` (farm animals via `_entityOfType`);
  farmland/fences/crops added to `DIG_PROTECTED`.
- Tests: `tests/bedrock-farming.test.mjs` (10) + survival map assertions; suite
  257 green. Live verification on the BDS pending.
- `BEDROCK.md` action table + Farming section; `roadmap.md` status updated.

## [2026-10-03] ingest | Farming stretch: breed, tame, shear, throw_egg

- Fixed the metadata flag bits against `protocol.json` (`baby` = 11, `tamed` = 28,
  `sheared` = 31; `owner_eid` = key 5).
- `bedrock-survival.mjs`: tameable whitelist (`wolf`/`cat`/`ocelot`) + `TAME_FEED`
  (bone / raw cod).
- `bedrock-adapter.mjs`: refactored `_feedEntity` (feed a specific entity, base
  for feed/breed/tame); added `throw_egg`, `breed_<animal>`, `tame_wolf`/
  `tame_cat`, `shear_sheep`, `craft_shears`; `/observe.farmAnimals` now carries
  `sheared`; new `_nearbyTameable` census.
- Tests: `tests/bedrock-farming.test.mjs` extended (18); suite 265 green. Live
  verification on the BDS pending.

## [2026-10-03] ingest | Farming live-verified on the BDS

- Redeployed to VM 100 (`hermes-jev-bedrock`) and drove the harness HTTP API.
- ✅ `read_container` (6 chests/barrels), `mine_potatoes`/`mine_carrots` →
  `collect_drop` → `plant_potato` (re-sow, `server_world`), `throw_egg`,
  `feed_pig` (`inlove`), `breed_pig` (`babies: 1`, `baby:true`).
- ⚠️ Not tested: `attack_<animal>` (would kill a family animal), `tame_wolf`/
  `tame_cat` (no wolf/cat nearby), `shear_sheep` + `craft_shears` (no sheep).
- Note: first `feed_pig` attempt returned `feed_not_confirmed` while the pig
  wandered; a retry close-up succeeded — the action may need one retry for
  distant/wandering animals.
- `BEDROCK.md` action table and `roadmap.md` status updated.

## [2026-10-03] ingest | Companion animals: cats, wolves, parrots, mounts, axolotl, nautilus

- `bedrock-survival.mjs`: companion categories — food-tameable (`wolf`→bone,
  `cat`/`ocelot`→raw cod/salmon, `parrot`→seeds), ride-tameable
  (`horse`/`donkey`/`mule`/`llama`/`nautilus`), and `axolotl` (follows with a
  tropical-fish bucket, no tamed flag). `tameFeed` now returns a list.
- `bedrock-adapter.mjs`: parse `trusting` (flags_extended key 92 bit 1);
  `_nearbyCompanion` census + `/observe.companions`; generalized `_tameAnimal`
  (food vs ride via `_mountEntity` with an empty hand) and `_isCompanionTamed`.
- `nautilus` (recently added aquatic companion with its own armor set) is in the
  ride-tameable set; its exact taming mechanic still needs a live round.
- Tests: 270 green (`tests/bedrock-survival.test.mjs` + `bedrock-farming.test.mjs`).
- `BEDROCK.md` + `roadmap.md` updated.
- New page `wiki/companions.md` (categories, implemented taming vs missing riding,
  verification status); cross-linked from `index.md`, `overview.md`, `roadmap.md`.

## [2026-10-03] ingest | Riding as transport: boats, minecarts, mounts

- `bedrock-survival.mjs`: `isVehicleType` (boats `…_boat`/`…_chest_boat`/
  `…_raft`, minecarts `…_minecart`) + `isRideableType` (vehicles + ride-tameable).
- `bedrock-adapter.mjs`: `set_entity_link` handler → `this.riding`; handle
  `correct_player_move_prediction` `vehicle` type; `mount_<vehicle>` (empty hand
  + interact), `dismount` (`player_action` start_sneak), `_rideToward` (forward
  `player_auth_input` with `client_predicted_vehicle` flag, no local physics);
  `goto_waypoint` rides when mounted; options offer `mount_*`/`dismount`.
- Tests: `tests/bedrock-riding.test.mjs` (8); suite 285 green.
- `BEDROCK.md` + `companions.md` updated (riding wired; saddle/inventory/steering
  still open).

## [2026-10-03] doc | Verification checklist page (collaudi status)

- Added `wiki/verification.md`: the single collaudo checklist — every capability
  with status (live-verified / unit-tested / pending live / not implemented),
  how to run unit tests and a live round, and how to trigger each live collaudo.
- Cross-linked from `index.md`, `roadmap.md`, `open-questions.md`.

## [2026-10-03] ingest | Mission goal/episodic layer over the world graph

- `world-memory.mjs`: mission records carry `rawPrompt`/`intent`/`outcome`/
  `success`; `finishMission`; goal edges `linkMission`/`unlinkMission`/
  `missionRelations`; action history `recordAction`/`missionActions`; episodic
  queries `findPreviousMissions({intent,target})` and
  `findSuccessfulLocationsFor(resource)`.
- `sqlite-memory.mjs` v4 + `memory-store.mjs`: new tables `mission_relation`
  (goal edges, separate from `memory_relation`) and `action_event`.
- Tests: `tests/memory-missions.test.mjs` (15, both backends); suite 435 green.
- `wiki/memory.md` + `verification.md` updated; controller wiring deferred.

## [2026-10-03] ingest | Controller wiring: goal → mission + action events

- `bedrock-harness.mjs`: new routes `POST /mission/link`, `POST /mission/action`,
  `POST /mission/finish` (goal edges, action history, outcome/success).
- `controller.mjs`: each goal becomes a mission (`POST /mission` with `rawPrompt`
  + `intent`), plan targets become `seeks` edges, each executed action is an
  `action_event` (`POST /mission/action`) and the goal end closes the mission
  (`POST /mission/finish`); the controller log carries `missionId` on `result`
  lines. All best-effort (a harness without `/mission` degrades gracefully).
- Tests: `tests/controller-mission.test.mjs` (2); suite 437 green.

## [2026-10-03] doc | Open tasks consolidated on the wiki

- `roadmap.md`: added the goal/episodic memory layer + controller wiring to
  "done", refreshed the test count (437), and added the episodic → semantic
  consolidation to the memory follow-ups.
- `open-questions.md`: added the goal/episodic memory bullet (done + next slice).

## [2026-10-03] lint | Roadmap status refresh (test count + riding)

- Verified the consolidated tracker `wiki/roadmap.md` against the code: every
  `.private/` task note is represented; the "not implemented" list is accurate
  (`place_torch`, `craft_*_sword`, `retreat`/`go_home`, `close_door`, `barricade`,
  armor, shield, milk, mature-crop detection, chat M5, autonomous exploration).
- Fixed stale test count (265 → 285) and added riding-as-transport to the
  implemented-pending-live list (boats/minecarts/mounts).
- No contradictions found between `roadmap.md`, `open-questions.md` and the code.

## [2026-10-02] lint | Live round blocked: bot dead + respawn stuck on BDS

- Drove the deployed harness on VM 100 (`docker exec hermes-jev-bedrock`,
  `/observe`): bot `health:0 deaths:1`, inventory `{potato:2, egg:1}`.
- `/options` → `wait` only ("Dead; respawning automatically"); container logs
  show `respawn_request` every 2.5 s with **no** `respawn` packet back from the
  server. Death→respawn (claimed verified earlier) is currently regressed.
- Root cause TBD (NetherNet session state vs BDS 1.26.52 respawn trigger).
  Documented in `wiki/open-questions.md` + `wiki/verification.md` (row 12 → ⚠️).

## [2026-10-02] query | Respawn-stuck resolved: stale NetherNet session

- Live round: stopped the bot container → BDS at 0 players → `systemctl restart
  minecraft-bedrock` (first attempt raced on the port; auto-restart brought it
  up, `/v1/join` OK) → started the container.
- Bot respawned alive (`health:20, spawned:true`, spawn point, empty inventory —
  death dropped the items). Conclusion: the stuck respawn was stale NetherNet
  session state, not a protocol bug. Updated `open-questions.md` + `verification.md`.

## [2026-10-02] query | Live trading attempt: open_trade fails on BDS 1.26.52

- After the respawn unblock, surveyed spawn: 2 `villager_v2` (~1.7 m and ~9 m),
  cat, 5 pigs, crops (potatoes/carrots/wheat/beetroots), ores (coal/iron/copper),
  logs (oak/spruce/cherry). No chests in radar.
- `/options` offered `open_trade`/`level_farmer` → `/act open_trade` failed twice
  (`trade_not_opened`). The `interact` was sent but the server answered
  `inventory_content` (`anvil_input`) instead of `update_trade`/`container_open`.
  Root cause TBD. Documented in `trading.md` + `verification.md` row 16.

## [2026-10-02] query | Trading open_trade: definitive live finding (server ignores interact)

- With `BEDROCK_PACKET_LOG=1` on the container: got a `villager_v2` at ~1.9
  blocks; `open_trade` sent `item_use_on_entity` interact 3× (logged) but the
  server sent **no** `update_trade` and **no** `container_open(trading)`.
  Approach >5 blocks also stalls (`trade_approach_failed: stuck`).
- Conclusion: `open_trade` does not work live on BDS 1.26.52; root cause needs a
  protocol-level capture (real client / gophertunnel). Documented in `trading.md`
  + `verification.md` row 16.

## [2026-10-02] ingest | Defense slice: swords, torch placement, go_home/retreat

- `bedrock-adapter.mjs`: added `craft_wooden_sword`/`craft_stone_sword` options
  (reuse `_craftItem`), `place_torch` option (reuse `_placeBlock`), and
  `go_home`/`retreat` (home = spawn at first spawn or `HOME_WAYPOINT` env JSON;
  `_goHome` reuses `_moveTo`). Dispatch wired; 6 new unit tests.
- Docs: `BEDROCK.md` action table + `roadmap.md` + `verification.md` updated
  (defense gap narrowed to `close_door`/`barricade`/armor/shield).
- Full suite green (291 tests).

## [2026-10-02] query | Defense slice live-verified: go_home works on the BDS

- Deployed the new code to VM 100 (rsync + `docker compose up -d --build`).
- `go_home` live round: set a waypoint at (115, 180), `goto_waypoint` (39 nodes),
  `/options` offered `go_home` ("Return home to {96,74,161} (25 blocks away)"),
  `/act go_home` walked back and ended ~1.9 blocks from home (`pathNodes: 35`).
- `place_torch` and `craft_*_sword` reuse the already-live-verified `place_*` /
  `craft_*` paths (option generation unit-tested); a dedicated live round is
  deferred. `BEDROCK.md` + `verification.md` updated.

## [2026-10-02] ingest | AI-player roadmap + post-goal lifecycle audit

- New raw source `docs/raw/AI_PLAYER_ROADMAP.md` (Italian) digested into a new
  wiki page `wiki/ai-player-roadmap.md`: persistent-agent north star, milestone
  0–8 table (Goal Manager, emergency, autonomy, social, world awareness,
  navigation, hierarchical planning, personality), deferred features.
- **Lifecycle audit (milestone 0) answered from the code**: the bot stays
  connected/spawned after a goal ends — `controller.mjs` is a one-shot loop
  (`break` on `GOAL MET`, then `process.exit(0)`), while `bedrock-harness.mjs`
  keeps the `BedrockAdapter` alive and reconnects on drop; no route disconnects
  the bot (only `SIGTERM`/`SIGINT`). Gap: no explicit `IDLE` state / goal queue,
  so new `@bot` orders are no longer acted on after the controller exits.
- `index.md`, `sources.md`, `wiki/roadmap.md` (post-goal lifecycle section +
  "Next planned work" item 1), `wiki/open-questions.md` (planned) updated.

## [2026-10-02] ingest | Autonomous Exploration v1 spec (GOAL_EXPLORATION)

- New raw source `docs/raw/GOAL_EXPLORATION.md` (Italian) digested into a new
  wiki page `wiki/exploration.md`: find-biome MVP (persistent mission model,
  Minecraft-ID biome targets, deterministic expanding-square/spiral planner,
  checkpoints, biome detection, structured report, HOLD_POSITION), M2 route
  replay, M3 escort, M4 search blocks/resources, M5 search structures, the
  `explore.*` skill API and the responsibility split (Hermes / Exploration
  Planner / Jev / Survival Governor).
- Status recorded as **spec only, not implemented** — matches the existing
  "no real exploration" limitation. Cross-links added from `roadmap.md` and
  `open-questions.md`; `index.md` + `sources.md` updated.

## [2026-10-02] ingest | Defense: equip_armor + close_door

- `bedrock-adapter.mjs`: `equip_armor` (take→cursor→place armor pieces into the
  `armor` container slots 0..3) and `close_door` (clicks `_openDoors` doors shut,
  clearing the set on the runtime-id change). Both offered from `/options`.
- 6 new unit tests; full suite green (297 tests).
- `BEDROCK.md` action table + `roadmap.md` + `verification.md` (rows 35-36)
  updated; defense gap now only `barricade` + armor points + shield.

## [2026-10-02] ingest | Defense complete: barricade + armor points

- `bedrock-adapter.mjs`: `_placeBlock` refactored into a reusable `_placeAtCell`
  (top-face placement at an arbitrary cell); added `barricade` (seals a 1×2
  opening with 2 blocks, feet + head) and armor tracking (`this.armor` +
  `_armorPoints`, exposed in `/observe.armor`). `equip_armor` now records the
  worn pieces. 7 new unit tests; full suite green (304).
- `BEDROCK.md` action table + `roadmap.md` + `verification.md` (rows 37-38)
  updated: defense only leaves the shield (stretch).

## [2026-10-02] ingest | Fluids roadmap (swimming, drowning, waterfalls, lava)

- New raw source `docs/raw/FLUIDS_ROADMAP.md` (Italian) digested into a new wiki
  page `wiki/fluids.md`: the bot cannot currently enter water (`_passable()`
  returns false for `water|lava`), there is no air/breathing tracking,
  `/observe.nearby` does not scan fluids, and digging only refuses a fluid cell
  at the target. The roadmap defines M0–M6: fluid awareness (`bedrock-fluids.mjs`,
  `/observe.fluids`, governor `drowning`/`lava_contact`/`lava_near`, lava
  forbidden in A*, dig adjacency check), swimming physics + air budget,
  controlled dives, waterfall descent/ascent + bubble columns, lava avoidance
  (gated crossing), buckets/boats/potions, and Survival Intelligence integration
  (skills/progression/verifier tags).
- Status recorded as **spec only, not implemented**; two protocol-discovery
  items block M1 (Bedrock water-movement `input_data`/`delta` semantics, and
  whether self metadata exposes `breathing`/air).
- Cross-links added from `roadmap.md` (not-implemented + next work),
  `open-questions.md` and `verification.md` (rows 39–43); `index.md` +
  `sources.md` updated. Private handoff: `.private/FLUIDS-TASK.md` (not committed).

## [2026-10-02] doc | Creeper defense: map the new defence actions onto intents

- Gap found: `go_home`/`retreat`/`close_door`/`barricade`/`equip_armor` were
  `unknown` intents, so the governor's emergency filter removed them — exactly
  in a creeper emergency. `survival/intents.mjs` now maps them
  (`go_home`/`retreat` → `['escape','shelter']`, `close_door`/`barricade` →
  `['shelter']`, `equip_armor` → `['heal']`, `place_torch` → `['build','shelter']`).
- `knowledge/survival-rules.json`: `creeper_immediate` now allows
  `["escape","shelter"]` (retreat/barricade stay available, melee does not).
- Tests added/updated; suite green (305). Documented in
  `wiki/survival-intelligence.md`; bow/arrow gap recorded in
  `wiki/open-questions.md`.

## [2026-10-02] ingest | Redstone roadmap (sensing, oriented placement, primitive circuits)

- New raw source `docs/raw/REDSTONE_ROADMAP.md` (Italian) digested into a new
  wiki page `wiki/redstone.md`. Findings from the code/registry: no redstone
  support today, but `bedrock-world.mjs` already decodes component state via
  `blockAt().getProperties()` (`redstone_wire.redstone_signal` 0..15,
  `lever.open_bit`, `repeater.repeater_delay` + `cardinal_direction`,
  `observer.powered_bit`, `dispenser.triggered_bit`, `piston.facing_direction`,
  ...); `DIG_PROTECTED` does **not** cover redstone; `_placeAtCell` cannot set
  orientation; `_refreshNearby`/`findBlocks` are name-only.
- Roadmap R0–R6: protect redstone + `/observe.redstone` + state-aware search;
  oriented placement (blocked on a placement packet capture); interaction/sensing;
  declarative `circuits/*.json` (`lamp_switch`, `delay_line`, `auto_lamp`,
  `auto_harvest`, `hopper_chain`, ...) with `build_circuit_<id>`; verification,
  `teardown_circuit` and guardrails; Survival Intelligence integration
  (skills/progression/verifier/tags); limits (no TNT/command blocks, lag caps).
- Status **spec only, not implemented**. Cross-links added from `roadmap.md`,
  `open-questions.md` and `verification.md` (rows 44–48); `index.md` +
  `sources.md` updated. Private handoff: `.private/REDSTONE-TASK.md` (not committed).

## [2026-10-02] query | Barricade collaudo blocked: no valid 1×2 gap at the base

- Deployed the defence slice (incl. `barricade`, `equip_armor`); bot spawned at
  home. `mine_dirt`/`mine_grass_block` gave dirt (note: a drop 3.6 blocks below
  the bot is unreachable — the known "drop below" quirk).
- Enabled `BEDROCK_DEBUG` and used `/debug/geom`: the base is an **open garden**
  (grass paths, trees, a crafting table) with a cliff/hole to the east (no floor
  at x≈93-95, z≈144-148). `_barricadeGap` never found a 1×2 opening with a solid
  floor + flanking walls, so `barricade` was never offered. Live verification
  needs a doorway/corridor or an artificial gap.
- `verification.md` row 37 + `open-questions.md` (design limitation) updated.
  `equip_armor` live round deferred (no armor in inventory).

## [2026-10-02] query | craft_wooden_sword verified live

- Chain: `mine_oak_log` ×2 (auto-pickup) → `craft_oak_planks` ×2 → `craft_stick`
  → `craft_crafting_table` → `place_crafting_table` (91,72,144) →
  `craft_wooden_sword`. Result `{ok:true, crafted:"wooden_sword", count:1}`;
  `/observe.inventory.wooden_sword = 1`. Option was offered with 2 planks + 1
  stick at the table.
- Torch chain derailed by the "drop below/on canopy" quirk (a log at y=77 was
  not picked up → no planks → no pickaxe → no coal), so `place_torch` stays
  unit-tested. `verification.md` row 32 → ✅.

## [2026-10-02] ingest | Goal-driven gameplay proposal (Goal Contract + 5 benchmarks)

- New raw source `docs/raw/GOAL_ACHIEVEMENT_MINECRAFT.txt` (Italian) digested
  into a new wiki page `wiki/goal-achievement.md`: the pipeline (User Goal →
  Goal Interpreter → Planner → Task Graph → Executor → Skills → Verifier +
  Replanner), the **Goal Contract** (`target`/`constraints`/`success`/`failure`
  → `RUNNING/SUCCESS/FAILED/BLOCKED`), the deterministic primitive skill API,
  interrupt/suspend/resume, semantic goals, and 5 progressive seed-independent
  benchmarks.
- The 5 benchmarks were mapped onto the existing progression graph: 16 logs →
  `wood`; shelter + night → `first_night`; iron pickaxe → `iron_age`/`iron_tools`;
  5 diamonds → `diamonds`; Nether portal → `enter_nether`. None is run end-to-end.
- Relationship recorded: the progression engine + gameplay skills + verifier are
  the deterministic execution half; the Goal Contract, persistent Goal Manager
  and task graph are missing (AI-player milestones 1 and 7). Flagged the
  contradiction that `goals.beat_the_dragon` is aliased only to `enter_nether`.
- Cross-links added from `roadmap.md` (benchmarks table + not-implemented + next
  work), `ai-player-roadmap.md` (milestones 1/7), `open-questions.md` and
  `verification.md`; `index.md` + `sources.md` updated.

## [2026-10-02] ingest | Nether/End roadmap + fix beat_the_dragon contradiction

- **Contradiction fixed in code**: `knowledge/progression.json` now has the full
  chain `diamonds → nether_portal → enter_nether → nether_survival →
  {piglin_barter, obtain_blaze_rods, obtain_ender_pearls} → craft_eyes_of_ender →
  find_stronghold → enter_end → beat_the_dragon`, and `goals.beat_the_dragon`
  points to the real `beat_the_dragon` milestone (no longer to `enter_nether`).
  Added 9 declarative skills in `skills/gameplay/progression/` and 6 item tags
  (`gold_ingots`, `obsidian`, `blaze_rods`, `blaze_powder`, `ender_pearls`,
  `eyes_of_ender`). Tests updated; full suite green (307).
- New raw source `docs/raw/NETHER_ROADMAP.md` (Italian) digested into a new wiki
  page `wiki/nether.md`: locate/build/light/enter a portal (reuse the base one),
  Nether survival (fire/lava), **ghast fireball dodge**, **piglin gold
  bartering**, **enderman gaze discipline**, fortress/blaze rods, stronghold/End
  and the dragon (stretch). Status: chain present, capabilities not implemented.
- Extended `wiki/goal-achievement.md` with the concrete plan to fill the missing
  agentic meta (Goal Contract wrapping `plan`, reuse the existing vocabularies,
  progression+subgoal task graph, interpreter as a Hermes artifact) and with the
  benchmark execution table (`CURRICULUM` commands + blockers).
- Cross-links from `roadmap.md`, `open-questions.md`, `verification.md`
  (rows 49–55); `index.md` + `sources.md` updated. Private handoff:
  `.private/NETHER-TASK.md` (not committed).

## [2026-10-02] doc | Exploration spec: travel survival kit + night survival

- Added a "Travel survival kit and adaptation" section to
  `wiki/exploration.md`: a mission can last several in-game days, so it needs a
  pre-departure kit (food, blocks, torches, sword/armor, bed or wool+wood,
  crafting table, free inventory) and night survival in order of preference —
  bed, provisional hut, pillar-up (unreliable vs flying mobs such as phantoms).
- Recorded the gaps in `wiki/open-questions.md` ("Exploration travel kit"):
  `craft_bed`/`place_bed`, travel-kit/loadout, inventory-full handling,
  pillar-up, provisional-hut skill.

## [2026-10-02] doc | Finding: no persistent memory (landmarks, chests, chunks)

- Audited persistence: the only files read at startup are static config
  (`knowledge/*.json`, `skills/gameplay/**`); no runtime state is restored.
  `this.containers` (chest cache) is a volatile in-memory Map, `home` comes from
  spawn/`HOME_WAYPOINT`, and `runs/*.jsonl` are append-only and never read back
  (`survival/experience.mjs` logs skill stats "for a future retrievable
  experience").
- Consequence: the bot cannot remember where the sheep pen or the wool chest is,
  nor the chunks it has explored.
- Recorded in `wiki/open-questions.md` ("No persistent memory") and
  `wiki/exploration.md` (current status).

## [2026-10-02] feat | Goal Contract thin slice (Slice A)

- New pure module `survival/goal-contract.mjs`: `normalizeContract`,
  `evaluateContract`, `contractFromEnv`, `hasContractConfig`,
  `CONTRACT_STATUSES`. A contract is `{goal,target,constraints,success,failure}`
  and evaluates to `RUNNING | SUCCESS | FAILED | BLOCKED` (success wins, then
  failure/constraint violation, then running; invalid/static contradictions are
  blocked). Exported through `survival/index.mjs`.
- New verifier criteria in `survival/verify.mjs`: `deathsAtLeast n` and
  `itemPreserved [item]` (compares the `before` inventory; a held item must not
  decrease). Validation + `CRITERIA_KEYS` updated.
- `controller.mjs` wiring: opt-in via `GOAL_CONTRACT` (JSON), `MAX_DEATHS`,
  `PRESERVE_ITEMS`; evaluates the contract before the loop and every step, logs
  `goal_contract` / `goal_contract_met` / `goal_contract_stop` to
  `runs/<run>/controller.jsonl` and stops on SUCCESS/FAILED/BLOCKED. No contract
  configured = previous behaviour (backward compatible).
- 18 unit tests (`tests/goal-contract.test.mjs`); full suite green (325).
- Docs: `docs/raw/SURVIVAL-INTELLIGENCE.md` (module + criteria + Goal Contract
  section), `wiki/survival-intelligence.md`, `wiki/goal-achievement.md` (G1 thin
  slice implemented), `wiki/roadmap.md`, `wiki/open-questions.md`,
  `wiki/verification.md` (row 56), `.env.example`.

## [2026-10-02] verify | Goal Contract live (Slice A)

- Overlaid the Slice A files into the running `hermes-jev-bedrock` container
  (`docker cp`, non-destructive; the running harness keeps its own code) and ran
  the controller against the live harness (`http://127.0.0.1:3077`).
- **A — pre-loop SUCCESS**: `{"goal":"smoke_ok","success":{"inventoryGte":{"dirt":1}}}`
  → `GOAL CONTRACT SUCCESS` at step 0, evidence `inventory.dirt=2`; log
  `goal_contract` + `goal_contract_stop` written.
- **B — pre-loop FAILED**: `failure:{"deathsAtLeast":0}` → `GOAL CONTRACT FAILED`
  at step 0, reasons `failure criteria met`, evidence `deaths=0`.
- **C — in-loop RUNNING (real actions)**: `success:{"inventoryGte":{"dirt":3}}`,
  `constraints.maxDeaths=1`, `CONTROLLER=jev` ran 8 steps (sleep, mine_dirt ×4,
  collect_drop ×3) and exhausted the budget. Logged `goal_contract RUNNING` at
  step 0. The inventory never reached 3 because the mined dirt drops were not
  collected (`collect_drop` → `item_not_collected`), so the natural in-loop
  SUCCESS transition was not observed. The transition uses the same
  `evaluateContract` call verified live in A.
- Operational finding: the deployed container's `JEV_MODEL=typesafe/jev-1.13`
  with `TYPESAFE_API_KEY` returns TypeSafe `400 Unknown model`; `JEV_MODEL=jev-latest`
  works. `.env.example` already documents the correct value.
- `verification.md` row 56 updated to ✅ with the caveat.

## [2026-10-02] ingest | Exploration M6 — underground targets

- Extended `docs/raw/GOAL_EXPLORATION.md` with **M6 — Ricerca sotterranea**:
  caves (`cave_air`, lush/dripstone caves), abandoned mineshafts, Deep Dark /
  Ancient City (sculk, shriekers, Warden hazard), spawners (`mob_spawner`), plus
  amethyst geodes. Heuristic detectors, hazards (warden/lava/spawner/collapse),
  3D navigation and the underground kit; acceptance criteria and new skill API
  (`explore.findCave/findMineshaft/findSpawner/findDeepDark`).
- `wiki/exploration.md` updated (M6 row, "Underground targets (M6)" section,
  skill API, status), `wiki/open-questions.md` and `index.md` cross-links.

## [2026-10-02] feat | Goal Contract: action budget → EXHAUSTED outcome

- `survival/goal-contract.mjs`: `CONTRACT_STATUSES` adds `exhausted`; new
  `contractStop(contract, obs, {stepsUsed, maxSteps})` = `evaluateContract` plus
  the action budget. While actions remain the contract is `running`; when
  `stepsUsed >= maxSteps` and no success/failure fired it becomes terminal
  `exhausted` (reason `step budget exhausted (n/m)`). Success/failure still win.
- `controller.mjs`: contract evaluated with `stepsUsed = step - 1`; the loop
  stops on `exhausted` too; a post-loop check re-reads `/observe` and closes a
  still-running contract as `exhausted` (or `success` if the last action met it).
  Exit code: `0` on success/no-contract, `2` on `FAILED`/`BLOCKED`/`EXHAUSTED`.
- Tests: +4 in `tests/goal-contract.test.mjs` (22 total). My suite green (329,
  0 fail; the 3 failures in `*memory*.test.mjs` are the concurrent session's
  uncommitted work, not mine).
- Live (2026-10-02): `MAX_STEPS=1` + impossible success → `GOAL CONTRACT
  EXHAUSTED step budget exhausted (1/1)`, log `goal_contract_stop` exhausted,
  real exit code `2`; `MAX_STEPS=0` pre-loop → exhausted, exit `2`; pre-loop
  SUCCESS → exit `0`. `docs/raw/SURVIVAL-INTELLIGENCE.md`,
  `wiki/goal-achievement.md`, `wiki/verification.md` (row 56) updated.

## [2026-10-02] feat | Persistent world memory (SQLite + abstract repository)

- New infrastructure: `world-memory.mjs` (service) over an abstract repository —
  `sqlite-memory.mjs` (**node:sqlite**, WAL, chunk index; default) and
  `memory-store.mjs` (JSON repository, fallback/tests). Same interface
  (get/upsert/find/remove/markStaleBefore/count/flush), so skills/planner never
  see the storage.
- First slice: **landmarks** (`rememberLandmark`; `home` registered at spawn) and
  **container observations** (`rememberContainer`, updated on every chest read).
  Records carry `discoveredAt`/`lastSeenAt`/`confidence` and `known/stale/invalid`
  status — memory is *historical*, not current truth.
- Wired into `bedrock-adapter.mjs` (`/observe.memory`, `_setContainerContents`) and
  `bedrock-harness.mjs` (create `MEMORY_DIR` default `runs/memory`, periodic
  WAL checkpoint, close on shutdown).
- Tests: `memory-store`, `sqlite-memory`, `world-memory` (both backends, incl.
  persistence + chunk-restricted spatial query), `adapter-memory`. Suite green (356).
- Docs: new `wiki/memory.md`; `open-questions.md`/`exploration.md`/`index.md`/
  `sources.md`/`BEDROCK.md` updated; `memory/`, `*.sqlite*` git/image-ignored.

## [2026-10-02] query | Persistent memory verified live on the BDS

- Deployed the memory slice and drove the container via HTTP: on spawn the memory
  registered the `home` landmark; `read_container` read **8 chests/barrels** and
  all were written to the memory (`container_105_72_138` chest had 122 emeralds,
  ...).
- **Restart test**: `docker restart` → boot reloaded
  `{"records":9,"landmarks":1,"containers":8}` from `runs/memory/world.sqlite`
  (SQLite + WAL). Direct SQL (`json_extract` to find the emerald chest, chunk
  spatial sort) works; schema version 2.
- `verification.md` row 39 → ✅; `wiki/memory.md` notes the live result.

## [2026-10-02] feat | Persistent session loop + Goal Manager (AI-player M0→1)

- New pure module `goal-manager.mjs`: goal `{id, type, source, priority, status,
  objective, plan, parameters, parentGoal, attempts, createdAt, startedAt,
  finishedAt, reason, result}`; sources `EMERGENCY/CHAT/WORLD_EVENT/
  PLAYER_BEHAVIOR/CURRICULUM/AUTONOMOUS` with default priorities (emergency >
  chat > curriculum > autonomous); statuses `PENDING → RUNNING → (SUSPENDED) →
  COMPLETED/FAILED` plus `CANCELLED`; at most one `RUNNING` at a time;
  `pull()` (priority then FIFO), `preempt()`, `suspend/resume`, `snapshot/
  restore`, persistence through the memory-repository interface (`kind: 'goal'`).
- `controller.mjs` refactor: the goal body is now `runGoal(goal)` returning an
  outcome instead of `process.exit`; a session loop (`main`) does
  `pull → start → runGoal → complete/fail/cancel → IDLE`. `SESSION=on` keeps the
  process alive in `IDLE`, polling `/observe` for a new goal (an in-game `@bot`
  order becomes a `chat` goal) and running it on the same connection;
  `SESSION=off` (default) preserves the historical one-shot behaviour and exit
  codes. Queue: `runs/<RUN_ID>/goals/world.json`; a `running` goal left by a
  previous run is suspended on startup; transitions logged as `session_state`/
  `goal_start`/`goal_end`. New env vars `SESSION`, `IDLE_POLL_MS`,
  `IDLE_TIMEOUT_MS`.
- Tests: `tests/goal-manager.test.mjs` (12, unit) and
  `tests/controller-session.test.mjs` (3, integration against a fake harness:
  goal → COMPLETED → IDLE with timeout; an idle `@bot` order becoming a new
  completed `chat` goal; one-shot default). Suite green (371).
- Docs: `wiki/ai-player-roadmap.md` (milestone 0→1 implemented + new section),
  `wiki/roadmap.md` (post-goal lifecycle + next planned work), `wiki/
  open-questions.md`, `sources.md`, `BEDROCK.md` (env vars + "Agent session").

## [2026-10-02] feat | Memory producers: resource sites, portals, entities

- `world-memory.mjs`: added `rememberResourceSite`/`findResources({ contains })`,
  `rememberPortal`/`findPortals` (nether-side coords, verified flag),
  `rememberEntity`/`findEntities` (keyed by `uniqueId`, `state`); `observeView`
  now exposes portals + per-kind counts; `findLandmarks` = landmark/structure/home.
- Repositories: `data` JSON now carries **all** extra fields (observations,
  nether, state, ...), not just label/tags/contents; `find` supports `kinds`.
- `bedrock-adapter.mjs`: `_rememberDiscoveries` producer (once per chunk via
  `_maybeRememberDiscoveries`): the `portal` block → portal; nearby ores
  (common from `nearbyBlocks`, rare scanned) → resource site; rideable entities
  → entity.
- Tests for both backends + the adapter producer; suite green (374).
- `wiki/memory.md` + `open-questions.md` updated.

## [2026-10-02] feat | Idle autonomy: needs-driven goals (AI-player M3 first slice)

- New pure module `idle-goals.mjs`: `deriveIdleGoals(observation, {rules})` maps
  the governor/`deriveNeeds` output to ranked candidate goals (survive, escape,
  eat, heal, sleep, shelter, obtain_food/weapon/armor, replace_tool), boosting
  emergency needs (`source: emergency`) above autonomous ones;
  `nextIdleGoal(...)` filters needs attempted within `AUTONOMY_COOLDOWN_MS`
  (anti-loop); `isNeedResolved(need, observation)` is the deterministic,
  harness-side success predicate (the need disappears from observed state).
  `continue_progression` is excluded (no resolvable state; handled by CURRICULUM).
- `controller.mjs`: new `waitForGoal` branch (requires `SESSION=on` and
  `AUTONOMY=on`): with no human order it enqueues the top-need goal as
  `autonomous`/`emergency` with a need-anchored plan (`plan.need`). `goalMet`
  short-circuits on `plan.need` via `isNeedResolved`; such goals skip replanning
  (`replan_skipped`) so the planner cannot detach them from their need. New env
  vars `AUTONOMY`, `AUTONOMY_COOLDOWN_MS`, `AUTONOMY_MAX_GOALS`; autonomous goal
  count is capped per session.
- Tests: `tests/idle-goals.test.mjs` (7 unit) + an autonomy case in
  `tests/controller-session.test.mjs` (night-without-bed → completed
  `autonomous` shelter goal). Suite green (382).
- Docs: `wiki/ai-player-roadmap.md` (M3 first slice + "Still missing"),
  `wiki/roadmap.md`, `wiki/open-questions.md`, `sources.md`, `BEDROCK.md`.

## [2026-10-02] query | Memory producers verified live

- Deployed the producers; the discovery scan dedup was purely per-chunk, so the
  first scan (often before the world was loaded) marked the chunk as done and no
  site was recorded. Moved the bot across chunks and the producers fired:
  `counts {landmark:1, resource_site:2, entity:3, container:8}`.
- Recorded live: `resource_site_7_10` / `resource_site_8_10` (`observations:
  coal_ore/iron_ore/copper_ore/lapis_ore`) and 3 `entity` (2 donkeys + 1 horse,
  keyed by `uniqueId`).
- Fix: `_maybeRememberDiscoveries` now re-scans the same chunk after
  `DISCOVERY_RESCAN_MS` (15 s), not only on chunk change. Test added.
- `verification.md` row 40 → ✅; `wiki/memory.md` notes the live result.

## [2026-10-03] lint | Wiki-lint tool, git hooks, and status reconciliation

- Added `tools/wiki-lint.mjs`: broken-link check, `raw/` → `sources.md` and
  `wiki/` → `index.md` coverage, orphan pages, `log.md` entry format,
  `open-questions.md` "Last lint" vs `log.md`, privacy gate (`.private/`, `.env`,
  `runs/`, `nmp-cache/`, `auth.json`, `memory/` must not be tracked) and a
  secret/personal-data scan (this repo is public).
- Wired the routine: `tools/hooks/pre-commit` (errors block) and
  `tools/hooks/pre-push` (`--strict`: warnings block, incl. privacy), activated
  with `git config core.hooksPath tools/hooks`; npm scripts `wiki:lint` /
  `wiki:lint:strict`. Documented in `docs/llm-wiki.md` and `AGENTS.md`.
- Reconciled stale status: `open-questions.md` said farming and fishing were
  "not started" and listed implemented defense actions as missing — aligned with
  `roadmap.md` (farming core live-verified 03/10, fishing implemented/live
  pending, defense first slice mostly live, only shield left). Added a
  "Documentation integrity" section (interleaved `log.md` dates; stale counts in
  immutable sources).
- Fixed `verification.md` duplicate row numbers (39/40 reused for fluids):
  renumbered the fluid/redstone/nether/Goal-Contract rows to 41–58 and updated
  every internal reference.
- Refreshed the current test count to **383 green unit tests** (2026-10-03) in
  `roadmap.md`, `companions.md`, `survival-intelligence.md`; updated the
  `ai-player-roadmap.md` and `companions.md` one-line summaries in `index.md`.

## [2026-10-02] feat | Chunk memory (visited/frontier, batched) + biome

- `world-memory.mjs`: exploring chunks — `markChunkVisited` (buffered),
  `flushChunks`, `isChunkVisited`, `visitedChunks`, `chunksWithBiome`,
  `unexploredFrontier` (chunks adjacent to a visited one but not visited);
  `flush()`/`close()` flush the buffer; `_kindCounts` accounts for the buffer.
- Repositories: `upsertMany` (SQLite runs it in a transaction; JSON loops);
  the JSON repo now derives `chunk` from the position like SQLite.
- `bedrock-world.mjs`: `biomeAt(pos)` → biome name (e.g. `cherry_grove`).
- `bedrock-adapter.mjs`: the discovery producer records the visited chunk with
  its biome once per chunk.
- Tests both backends + `biomeAt`; suite green (386).
- `wiki/memory.md` + `open-questions.md` updated.

## [2026-10-03] lint | Private-reference and environment-fingerprint checks

- Extended `tools/wiki-lint.mjs`: references to the private Proxmox wiki clone,
  to the host agent schema files or to the private bootstrap/stack repositories
  are now **errors**; environment fingerprints (private LAN/VPN or WAN IPs,
  private domains and DDNS names, the environment SSH username) are **warnings**,
  so the strict pre-push blocks them. The meta-docs are written without the
  literal private tokens on purpose.
- Broadened the secret scan to **every tracked text file** (not just docs):
  private keys, SSH key material/paths, `sk-`/`ts-`/GitHub/Slack/AWS/Google/
  bearer tokens, hardcoded keys, auth-cache JSON, xuid, personal emails,
  plaintext passwords, real usernames/names. Positive control verified
  (injected fake key/IP/username were caught).
- History audit: no real API token, SSH key, `.env`, `auth.json` or token cache
  was ever committed (the only env-like file in history is `.env.example` with
  empty placeholders). The historical leak is limited to the private LAN IPs,
  the environment username and links to the Proxmox wiki pages noted below.
- Current tree verified clean: no link to the Proxmox wiki, no real IP/domain,
  no account identifier. Anonymised the remaining real SSH username in
  `verification.md` (now a `<ssh-user>@<ip-host>` placeholder).
- History note: an earlier scrub commit removed the same data from the tree but
  it is still present in earlier commits already on the public fork (private LAN
  IPs, the environment username, and links to the Proxmox wiki pages) in commits
  `26417f9`, `367f175`, `1a0e3bb`, `d21aaca`, `45822aa`. Removing it from the
  published history needs a rewrite; tracked in
  [open-questions](wiki/open-questions.md).

## [2026-10-02] feat | World knowledge graph (nodes + edges) over SQLite

- `sqlite-memory.mjs` v3: `world_memory` (nodes, `category: spatial|conceptual`,
  nullable coords, `biome` column + index) and a real `memory_relation` table
  (`from_id`/`to_id`/`type`/`confidence`/`status`/timestamps + indexes, FK
  enforced). Migration v2→v3 rebuilds the node table (verified live on 23 rows).
- Repository edges API: `link`/`unlink`/`invalidateRelation`/`relationsFrom`/
  `relationsTo`/`relationCount`; `find` supports `category`, `biome` and a
  `relation: {type,target,direction}` filter. JSON repo has parity.
- `world-memory.mjs`: conceptual nodes (`rememberConcept`, `resource:*`/`biome:*`),
  `link` (auto-creates endpoints → referential integrity), `unlink`,
  `invalidateRelation`, `relationsFrom/To`, `neighbors`, `traverse`, direct
  `find({ kind, relation, nearestTo })`, and derived (never stored) `near`/
  `withinRadius`/`nearest`. Containers/sites materialize `contains` edges, and a
  re-read invalidates the items that are gone (observation ≠ relation).
- Tests both backends (graph, traverse, per-relation query, derived near);
  suite green (394).
- `wiki/memory.md` + `verification.md` row 41 updated.

## [2026-10-02] verify | Session loop + idle autonomy verified live on the BDS

- Deployed the committed controller into the `hermes` container (isolated
  `/tmp/session`, no image rebuild, no restart of `hermes-jev-bedrock`) and ran
  it against the live harness on VM 100 (bot connected, night).
- **Session loop** (`SESSION=on`, `AUTONOMY=off`): a Goal Contract satisfied at
  step 0 → `GOAL g1 COMPLETED`, then `IDLE — waiting for a new goal`, then
  `IDLE timeout (12000 ms)` and exit 0. Queue persisted in
  `runs/collaudo-session/goals/world.json` (`g1 completed`); transitions logged
  (`session_state GOAL_RUNNING → goal_start → goal_end → GOAL_COMPLETED → IDLE`).
- **Idle autonomy** (`SESSION=on`, `AUTONOMY=on`): after the seeded goal the bot
  generated, in `IDLE`, goals from real needs and closed them deterministically:
  - `g2 [escape]` — a zombie villager at ~8.5 blocks; `flee` succeeded and pushed
    it to ~18.8 blocks → `isNeedResolved('escape')` → `GOAL MET`, `COMPLETED`.
  - `g3 [sleep]` — a bed nearby; `sleep` → `{slept:'night_skipped'}` →
    `isNeedResolved('sleep')` → `GOAL MET`, `COMPLETED`.
  Final queue: `g1/g2/g3 completed` (all `autonomous`); `idle_goal` and
  `goal_end` logged.
- **Operational finding**: a *concurrent* session was driving the same harness
  (`goto_waypoint` for 36 s, `path_failed`), so the first autonomy attempt got
  `{"ok":false,"error":"busy"}` on every `/act` (adapter `busy` flag, one action
  at a time). Re-run when the adapter was free → all actions succeeded. Lesson:
  run controllers strictly one at a time against the shared bot.
- `verification.md` rows 59–60 added (✅); `wiki/ai-player-roadmap.md`,
  `wiki/roadmap.md`, `BEDROCK.md` note the live result.

## [2026-10-02] feat | Cross-session goal resume

- `controller.mjs`: at startup a goal left `running` by a previous run is
  suspended (`session restarted`), then — if `RESUME` is on — every `suspended`
  goal is re-queued as `pending` and resumed from its **persisted plan** (no
  reconnect, no LLM re-planning). A new initial goal is seeded only when nothing
  is pending, so a restart continues the previous queue instead of starting over.
  New env var `RESUME` (default: on when `SESSION=on`, off otherwise) and a
  `session_resume` log entry + `RESUME n goal(s) ...` line.
- Tests: two integration cases in `tests/controller-session.test.mjs` (a
  pre-seeded `running` goal is resumed and completed; `RESUME=off` leaves a
  suspended goal parked and seeds a fresh goal). Suite green (399).
- Docs: `wiki/ai-player-roadmap.md` (M0/M1 rows + "Still missing"), `wiki/roadmap.md`,
  `wiki/open-questions.md`, `sources.md`, `BEDROCK.md` (env var + resume bullet).

## [2026-10-02] verify | Cross-session resume verified live on the BDS

- Pre-seeded a goal left `running` by a "previous session" in
  `runs/collaudo-resume/goals/world.json` (a `chat` goal with a persisted plan
  targeting `dirt:1`), then ran the controller (`SESSION=on`, `RESUME` default).
- Result: `RESUME 1 goal(s) from a previous session: live-g1` → the goal was
  suspended on startup, re-queued and executed from its persisted plan →
  `GOAL live-g1 COMPLETED`; **no new initial goal was seeded**; store ended with
  the single resumed goal `completed`. Logs: `session_resume → session_state
  GOAL_RUNNING → goal_start → goal_end → GOAL_COMPLETED → IDLE`. Exit 0 after the
  idle timeout.
- `verification.md` row 61 added (✅ live). Cleanup of `/tmp/session` and the
  `collaudo-resume` run.

## [2026-10-02] feat | Missions + sparse checkpoints (route replay)

- `world-memory.mjs`: mission nodes (`createMission`/`updateMission`/`completeMission`/
  `failMission`/`missions`, lifecycle in `state`, linked `mission --targets--> bi:t`)
  and sparse checkpoint nodes (`addCheckpoint`, `missionCheckpoints`,
  `lastCheckpoint`, `missionRoute` with ordered checkpoints + total distance);
  graph links `has_checkpoint`/`next`.
- `bedrock-adapter.mjs`: records a checkpoint only while a mission is active and
  every ~48 blocks (`CHECKPOINT_MIN_DISTANCE`), hooked to motion end
  (`_finishMotion`) and discovery; the ore scan no longer depends on
  `nearbyBlocks` and also runs at motion end.
- `bedrock-harness.mjs`: `GET /mission`, `POST /mission`, `POST /mission/complete`.
- Tests both backends + the adapter hook; suite green (397).
- **Verified live**: mission created/activated, a sparse checkpoint recorded
  (biome `bamboo_jungle_hills`), completed (`found`); `has_checkpoint`/`targets`
  edges in SQLite. `wiki/memory.md` + `verification.md` row 42 updated.

## [2026-10-02] feat | Travel kit: craft_bed/place_bed + readiness

- `bedrock-adapter.mjs`: `craft_bed` option (3 wool + 3 planks at a table; the
  `wool` item tag now matches any colour) and `place_bed` (reuses `place_*`).
  New `_travelReadiness()` exposed in `/observe.travel`: food, sword, armor,
  blocks, light, night (bed **or** ≥3 wool), crafting table, free inventory +
  the `missing` list.
- Tests: `wool` tag matching, `craft_bed`/`place_bed` options, readiness;
  suite green (402).
- `BEDROCK.md` action table + `verification.md` (rows 43-44) + `exploration.md`
  + `open-questions.md` updated.
- **Live**: `/observe.travel` verified (`missing: [food, armor, light, night,
  craftingTable]`; `sword/blocks/space` present). `craft_bed`/`place_bed` live
  round still pending — **no wool** on the server (no chest holds wool; shears
  need the iron chain).

## [2026-10-02] feat | Emergency producers: PLAYER_DIED → recover_loot (M2 first slice)

- New pure `world-events.mjs`: transition-based `detectEvents(prev, curr)` →
  `PLAYER_DIED` (dead flag flip **or** a new death site, since a poll can miss
  the dead frame), `LOW_HEALTH`, `HOSTILE_AMBUSH`; each event carries a
  `dedupKey` so a persistent condition fires once.
- New pure `emergency-goals.mjs`: `emergencyGoalFor(event, {parentGoal, attempts,
  cooldownMs})` maps events to `EMERGENCY` goals — today `PLAYER_DIED →
  recover_loot` (priority 100, plan `{recover:true}`, loot-priority list,
  `parentGoal`) — with a cooldown/dedup map. Events without a builder (low
  health, ambush) stay with the Survival Governor.
- `controller.mjs`: inside the running goal, `runGoal` compares observations and
  on a critical event returns `{status:'preempted', emergency}`; `main` calls
  `goalManager.preempt()` (the running goal → `SUSPENDED`), enqueues the
  emergency goal, runs it on the next iteration and — via the existing
  `parentGoal` handling — resumes the parent when it completes. `goalMet` closes
  a `plan.recover` goal when the harness clears `deathSite`. New env `EMERGENCY`
  (default on with `SESSION`) and `EMERGENCY_COOLDOWN_MS`.
- Tests: `tests/world-events.test.mjs` (7), `tests/emergency-goals.test.mjs` (4),
  and `tests/controller-session.test.mjs` case 6 (death mid-goal → preempt →
  `recover_loot` → parent resumed and completed). Suite green (414).
- Docs: new `docs/wiki/emergency.md` (producer taxonomy, action-level vs
  goal-level emergency, the preemption flow diagram, boundary rule, dedup,
  status); updated `index.md`, `sources.md`, `wiki/ai-player-roadmap.md`,
  `wiki/roadmap.md`, `wiki/open-questions.md`, `wiki/verification.md` (row 62),
  `BEDROCK.md`.

## [2026-10-02] feat | Exploration M1 core (deterministic planner + driver)

- `exploration.mjs` (pure): `resolveBiomeTarget` (natural language → `minecraft:<id>`,
  aliases for cherry_grove/pale_garden/badlands/mushroom_fields/deep_dark/meadow),
  `spiralOffsets`/`nextExplorationWaypoint` (first unexplored spiral point —
  deterministic sweep), `biomeReached`, `planExplorationStep`
  (move/found/hold/exhausted), `buildExplorationReport`.
- `bedrock-harness.mjs`: `POST /explore {target}` (resolve + create/activate the
  mission) and `GET /explore` (one deterministic step; on `found` it records
  `targetPosition` + completes the mission).
- `explore.mjs`: driver — loop planner → `POST /plan` + `POST /act goto_waypoint`.
- Tests: `tests/exploration.test.mjs` (6); suite green (420).
- `wiki/exploration.md` + `verification.md` (rows 45-46) + `index.md`/`sources.md`
  updated.
- **Verified live**: `POST /explore 'Trova un Cherry Grove'` → `minecraft:cherry_grove`
  and `GET /explore` → `move` to the first unexplored spiral point; the driver
  loop runs but the bot was stuck on a built platform (`target_not_found`).

## [2026-10-02] doc | Track next activities + bot-stuck blocker

- `wiki/roadmap.md` "Next planned work" extended with items 10–12: Exploration
  (M1 core done → end-to-end then M2–M6), Memory follow-ups (structure detector,
  observation log, vector index), Travel kit (loadout/pillar-up/hut/inventory).
  "What is not implemented" updated: exploration now says M2–M6 (M1 core done).
- `wiki/open-questions.md`: new "Bot stuck on a built platform" blocker — the
  deployed bot spawned on `oak_planks`, `path_failed` everywhere and `protected_*`
  on dig; remedy = BDS restart at zero players (or move the structure).

## [2026-10-02] verify | Emergency preemption verified live on the BDS

- Started the controller on the live harness with an unsatisfied goal (`g1`,
  target `diamond:1`) and forced a death via the BDS console (`kill "<bot>"`
  through `screen -S minecraft -X stuff`, the bot being the only player — a test
  fixture, not a gameplay shortcut).
- **Result**: `EMERGENCY PLAYER_DIED: suspend g1 -> run g2` → `g2 [emergency]`
  ran `recover_loot` → `deathSite` cleared → `GOAL g2 COMPLETED` (success via the
  deterministic `plan.recover` predicate) → `g1` resumed and re-planned.
- **Real bug found and fixed**: a periodic replan replaced the emergency goal's
  plan, dropping `plan.recover`, so `g2` never closed (it kept running until the
  budget). `controller.mjs` now skips replanning for `plan.need` **and**
  `plan.recover`; a regression test asserts `replan_skipped {recover:true}` and
  was confirmed to fail without the fix.
- **Known blocker (pre-existing)**: both forced deaths re-triggered the
  respawn-stuck (server ignored `player_action respawn`); each required a BDS
  restart at zero players (verification row 12). The emergency could only
  recover after that.
- Evidence: `runs/collaudo-emergency2/controller.jsonl` (`emergency_preempt`,
  `replan_skipped {recover:true}`, `goal_end completed`, `g1` re-planned).
  Cleaned up `/tmp/session` and the collaudo runs. `verification.md` row 62 → ✅,
  row 12 updated; `wiki/emergency.md` and `wiki/ai-player-roadmap.md` updated.

## [2026-10-02] fix | Respawn stuck after death: auto-reconnect mitigation (verified live)

- Investigated the death→respawn block. Packet capture (`PACKET_DEBUG=1`, new
  env-gated diagnostic logging clientbound packet names after a death) showed the
  connection stays alive (thousands of entity packets) but the BDS **ignores**
  `player_action respawn` (13 requests, 0 `respawn` packets back). A client
  `respawn` packet (`state: 2`, CLIENT_READY) *does* make the server run the
  handshake (`SERVER_SEARCHING` 0 → `SERVER_READY` 1, spawn position) but it still
  never restores health → server-side bug, not client-fixable.
- **Mitigation**: `bedrock-adapter.mjs` watchdog — if the bot is still dead
  `RESPAWN_RECONNECT_MS` (default 25 s) after dying it closes the client; the
  harness reconnects (fresh login) and the player spawns healthy. **Live-verified**
  (twice): `kill` → `respawn_reconnect {deadMs: 25000}` → harness reconnect →
  `health: 20`, **without a BDS restart**. New env var `RESPAWN_RECONNECT_MS`;
  the packet diagnostic is gated behind `PACKET_DEBUG` (default off).
- Docs: `wiki/open-questions.md` (respawn section rewritten with the findings and
  the mitigation), `wiki/verification.md` row 12 → ✅ (mitigated), `BEDROCK.md`
  (env vars + Known issues). Tests green.

## [2026-10-02] doc | Respawn page: state, limits and refinement path

- New `docs/wiki/respawn.md`: the death→respawn flow, the stuck finding (BDS
  ignores `player_action respawn`; a client `respawn` packet runs the handshake
  but the server does not restore health), the **mitigation** (25 s watchdog →
  reconnect), its **limits** (25-40 s gap, fresh session, depends on the harness
  reconnect), and the **refinement path**: confirm with a vanilla client (relay
  capture) to decide server vs client-library bug, then try the in-place ack
  (`player_auth_input` after `SERVER_READY`, `handled_teleport`), then reduce the
  watchdog. Also records where to report: **Mojira only if a vanilla client
  reproduces** (no personal data), otherwise upstream `bedrock-protocol`.
- `index.md`, `open-questions.md` and `verification.md` (row 12) link the page.

## [2026-10-02] feat | Episodic → semantic consolidation (P0) + productivity hints read path

- `world-memory.mjs`: terminal missions are consolidated into a **productivity
  hint** on the spatial node (`productivity.<resource>` = attempts/successes/
  failures/found/confidence/contradicted/outcome/first/last/lastFailureAt/
  sources/sourcesCutoff) — a hint, not a fact (the node keeps its status).
  Anchor resolution: `targets` node → last successful action position → mission
  `targetPosition` → last checkpoint → current position (never the origin);
  chunk episodes fuse on the discovery producer's `resource_site_<cx>_<cz>` id.
  Idempotent (dedup by mission id + `sourcesCutoff` + `consolidated_into`
  relation), contradiction-aware, bounded (`maxHintSources`, `maxHintsPerNode`).
- Read path: `productivityScore`, `productivityHints`, `provenLocationsFor`,
  `observeView().hints`; harness `GET /memory/hints?resource=&limit=` and
  `POST /memory/consolidate` (backfill); the controller adds a "proven
  locations … these are hints, not facts" line to the planner prompt and now
  records `data.position` on every mission action (the anchor evidence).
- Two real bugs fixed: action events with identical `missionId|actionType|
  startedAt` overwrote each other in both repositories (`#<seq>` suffix added,
  collision loop in JSON); and auto-consolidation was skipped when
  `completedAt` landed before the outcome (now attempted on every terminal
  patch). `rememberLandmark`/`rememberResourceSite` now preserve
  `productivity` across a rescan (the discovery loop used to rebuild the record
  from a fixed field list). `addCheckpoint` stores the `label` it accepts.
- Tests: new `tests/memory-consolidation.test.mjs` (27 cases × json/sqlite) plus
  the adapter read-path test; full suite 465 pass / 0 fail. `npm run wiki:lint`
  clean.
- Docs: `wiki/memory.md` (new section + next slices), `wiki/open-questions.md`,
  `wiki/roadmap.md` (done list + next planned work), `wiki/survival-intelligence.md`
  (test count), `index.md`, this log.

## [2026-10-02] lint | Respawn refinement attempt: self-health metadata (failed)

- Tested the hypothesis that the BDS does restore health but the adapter missed
  it: `_applyEntityMetadata` ignored the self player's health (only
  `set_health`/`update_attributes` updated it). Patched it to honor self health
  from metadata and re-ran the death test → the bot still stayed `dead` and the
  watchdog fired. Reverted: the server genuinely does not restore health after
  the respawn handshake, so it is not a missing parse on our side.
- `docs/wiki/respawn.md` "Refinement path" records the failed attempt; remaining
  options are the vanilla-client capture and the in-place ack experiments.

## [2026-10-02] feat | Respawn capture tool (vanilla-client relay)

- New `tools/respawn-capture.mjs`: a ready-to-run MITM relay (`bedrock-protocol`
  `Relay`, `jsp-raknet`, no native binding) that records the death→respawn packet
  sequence of a real client. Logs `respawn`/`player_action`/`set_health`/
  `update_attributes`/`move_player`/`play_status` (+ `player_auth_input` for 6 s
  after a death) to `runs/respawn-capture.jsonl` (git-ignored) and prints a
  timeline on Ctrl+C. This is the step-1 capture of the respawn refinement
  (settle server vs client-library before filing anything).
- `docs/wiki/respawn.md` documents the tool and usage; `sources.md` lists it.
- Verified locally: the relay starts and listens on the configured port.

## [2026-10-02] verify | Goal → mission live collaudo (P1)

- **Deployment realigned** to the container `hermes-jev-bedrock` on VM 100
  (`docker cp` overlay over the baked image — a `docker restart`, never a
  recreate, preserves it; the image rebuild is the proper future deploy).
  Backup of the live DB first (`runs/memory/backup-20261002-232059/`); the
  schema migrated v3→v4 live with **no data loss** (`world_memory` 51 records
  kept, `mission_relation`/`action_event` created, `schema_version=4`).
- **Full chain observed live** (`RUN_ID=p1-live-2`): goal from `GOAL`/`TARGETS`
  → `POST /mission` (`mission_autonomous_murgzqlh`, `source: controller`,
  `intent: autonomous`, rawPrompt = objective) → `seeks → resource:dirt` →
  8 `action_event` rows carrying `data.position`/`dimension` → close
  `state: cancelled` / `outcome: exhausted` / `success: false`; checkpoints and
  `GET /mission` served the closed mission. Planning (`PLAN`, static fallback
  when Hermes is unavailable), options filtering and the survival verdict were
  logged step by step in `runs/<run>/controller.jsonl`.
- **P0 consolidation verified live** too: the terminal mission wrote
  `consolidated_into resource_site_7_9` (`{"resources":["dirt"],"outcome":"failed"}`),
  the hint is readable from `GET /memory/hints` and `/observe.memory.hints`, and
  `POST /memory/consolidate {limit:20}` answered `already_consolidated` on the
  second pass (idempotency).
- **Two live findings, both closed here.** (1) A fatal controller error left the
  mission `running` forever: `runGoal` is now wrapped, the error is logged as
  `goal_error`, the outcome becomes `failed` with `reason: controller_error: …`,
  the mission closes (`/mission/finish`, `state: failed`) and the run exits
  non-zero instead of retrying silently. Regression test `a fatal controller
  error closes the mission instead of leaking it` in
  `tests/controller-mission.test.mjs`; proven live (`p1-live-4-fatal`).
  (2) The deployed `.env` still carried the stale `JEV_MODEL=typesafe/jev-1.13`
  that makes every decision call die with TypeSafe `400 Unknown model` — removed
  (duplicate key, kept `jev-latest`; `.env` backed up). The container environment
  keeps the old value until the next recreate, so runs must pass `JEV_MODEL`.
- **Regression**: `p1-live-5` re-ran the normal path after the fix → expected
  `CANCELLED (exhausted)`, `exit=0`.
- **New live blocker found (P2)**: `mine_dirt` succeeds (`destroyedEvent: true`)
  but returns `picked: []`, and the following `collect_drop` fails with
  `item_not_collected` ×4 (`inventory: {}`) — the auto-pickup path
  (`_pickupNearby` + fresh-drop priority) collects nothing either. Mining works,
  the items stay on the ground, so every inventory goal is unreachable. This
  contradicts the earlier ✅ on `verification.md` row 4, now ⚠️
  with the evidence; tracked in `open-questions.md` as the P2
  inventory/interaction front.
- Tests: full suite **466 pass / 0 fail**; `npm run wiki:lint` clean. Docs:
  `wiki/verification.md` (rows 4, 42.1, new 42.2), `wiki/open-questions.md`,
  `wiki/roadmap.md`, this log.

## [2026-10-02] feat | Opportunity layer: valuable-ore goals (data + producer)

- **New data layer** (`ore-value.mjs`, pure): one value table for every ore/item
  drop (diamond 100, emerald 60, gold 40, lapis 30, redstone 25, iron 15, copper
  8, coal 5) and the thresholds the two consumers share — `ORE_EVENT_MIN_VALUE` 5
  (what is worth *reporting*), `ORE_OPTION_PRIORITY_MIN_VALUE` 40 (what earns the
  option-priority lift), `OPPORTUNITY_MIN_VALUE` 40,
  `OPPORTUNITY_MIN_RELATIVE_VALUE` 5, `OPPORTUNITY_STOCK_CAP` 16.
- **Detection**: the adapter scans the valuable ore names within 24 blocks (5 s
  TTL, rescan after moving 8) and exposes `observe().ores`
  (`{name, position, distance, value, harvestable}`); `world-events.mjs` raises a
  new `VALUABLE_ORE_SEEN` event per *newly seen* vein (`dedupKey`
  `ore:<name>@<x>,<y>,<z>`, transition-based like the other events).
- **Decision** (`opportunity-goals.mjs`, pure): `evaluateOpportunity` /
  `opportunityGoalFor` map the event to a **suspending** goal — new
  `GOAL_SOURCE.OPPORTUNITY`, priority 55 (between `WORLD_EVENT` 60 and
  `PLAYER_BEHAVIOR` 50), `type: mine_opportunity`, `plan.targets` = one more drop
  than already held, waypoint on the vein. Gate: gold-and-above always
  (absolute); otherwise strictly more valuable than the plan target with a
  scarcity cap (coal and copper count early — cheap ≠ worthless); never over a
  chat order, an emergency or another opportunity; not when the current goal is
  ≥ 90 % done; danger-free and within 24 blocks; 120 s cooldown on the dedup key.
- **Visibility**: the adapter offers `mine_<ore>` for a harvestable valuable ore
  outside the fixed mining list, and `controller-decisions.mjs` ranks it in a new
  tier 4.5 (gold and above), after the plan target (4) and before craft (5). The
  copper→iron case is resolved at the *goal* level (the seen iron becomes the
  plan target), not by the tier.
- Tests: `tests/opportunity-goals.test.mjs`, `tests/adapter-opportunity.test.mjs`
  and four ore cases in `tests/world-events.test.mjs`; full suite **488 pass /
  0 fail** (was 466).
- **Not wired**: `controller.mjs` is untouched (the emergency preempt path has no
  opportunity sibling yet), so an in-flight goal is still never interrupted by a
  vein; no `OPPORTUNITY*` environment switch; no live round.
- Side finding, left unfixed on purpose: `_tradeAt` in `bedrock-adapter.mjs`
  never forwards its `timeoutMs` to `_waitTradeResult`, so trades wait 5 s
  instead of 20 s — recorded in `wiki/open-questions.md`.
- Docs: new `wiki/opportunity.md`; updated `wiki/emergency.md` (producer table
  and boundary), `wiki/ai-player-roadmap.md` (milestones 1/5/8),
  `wiki/roadmap.md`, `wiki/open-questions.md`, `docs/index.md`, `docs/sources.md`.

## [2026-10-03] feat | Proactive human greeting (Attention System §6)

Added `observe().humans`, the pure greeting policy in `human-greeting.mjs`,
`sendChat` and `POST /say`. The controller greets trusted nearby humans in both
goal and IDLE loops, with range and cooldown guards. The 1.26.51 text packet
round-trips through the serializer. Eight new tests; suite **510/510**, wiki lint
clean. At this point order acknowledgements, persistent greeting state,
emergency suppression and a real-human live round remained open. See
[human-command](wiki/human-command.md), verification row 18.

## [2026-10-03] doc | Open questions for proactive greetings recorded

Documented five greeting gaps: order acknowledgement, public chat versus
whisper, emergency suppression, cooldown lost across controller restarts, and
no live `/say` or real-human greeting round. No code changed; strict wiki lint
clean. See [human-command](wiki/human-command.md) and
[open questions](wiki/open-questions.md). These are historical findings;
later entries record the acknowledgement and echo fixes.

## [2026-10-03] feat | Reachability primitives filter impossible actions

Added BFS reachability, approach/drop/mining/entity checks and gated
`GET /debug/reach` in `bedrock-adapter.mjs`/`bedrock-harness.mjs` (commit
`23c25c0`). Filters apply where options originate; a one-cell or truncated
component remains fail-open. Live: `read_container` returned
`container_unreachable` in **19 ms**, previously 30,355 ms; the diagnostic
component contained 10 cells. Fourteen reachability tests; suite **502/502**
at this front, 514 after trading. See verification row 42.3.

## [2026-10-03] verify | Trading packet capture and _tradeAt budget fix

Forwarded the remaining `_tradeAt` budget to `_waitTradeResult`, added a
packet-debug window before interaction, and tried `npc_open` plus entity-use
fallbacks with `item_interact`. Live: three attempts returned `trade_not_opened`
in **12.6 s**, with no `container_open` or `update_trade`. Packet shapes,
legacy ids, daylight and custom packs were investigated; a zero-player BDS
restart recovered a `connecterror:9` loop. Fifteen trading tests passed.
The initial interpretation of inventory resync as rejection was later
disproved by the accepted attack probe (04/10). See [trading](wiki/trading.md).

## [2026-10-03] verify | first_night scenario tests and live wood prerequisite

Added two staged controller scenarios and fixed premature curriculum
completion plus inheritance of the demo `WAYPOINT`. Live after deployment:
sleep and wood mining worked; `p3-curriculum-live-3` reached
`acquire_wood SUCCESS` with **8 logs after 5 actions (39.9 s)** and replanned
to the table skill. Emergency replanning preserved the milestone. The
12-action budget ended before the final night milestone; no human was
connected. Suite **516 tests**. See [survival intelligence](wiki/survival-intelligence.md).

## [2026-10-03] verify | first_night completed live; table target and busy retries fixed

`p3-first-night-3` completed **GOAL MET after 25 actions**, with food acquired
and `first_night SUCCESS {sawNight:true, phase:day, health:20}` after sleeping
in the base bed. The successful mission produced positive productivity hints.
Added `planTargets: {crafting_table:1}` to prevent repeated planks/sticks;
controller `busy` retries now wait up to 90 s without consuming an action.
Suite **517/517**, including curriculum and busy scenarios. Remaining live
failures included animal combat, unreachable drops and a home timeout;
surviving awake without a bed was not tested. Verification row 30.

## [2026-10-03] fix | Combat locks one target by runtimeId

The live log showed **102 attacks across at least 15 chickens**: resolving
the nearest animal before every hit spread the damage. `_combat` now locks
one runtimeId, confirms death by health or prompt removal, and distinguishes
`target_lost`, `target_gone` and failed approaches. Four regression cases;
suite **521/521**. Live `attack_pig` returned `cannot_reach_target: movement
timeout`, zero hits, in **24.3 s**; no animal was killed in that probe. A
reachable-animal happy path remained pending. Verification rows 8.1 and 23.

## [2026-10-03] fix | Fishing uses protocol bite events; payloads cannot rename log events

Replaced the cast-descent false bite with settling, `fish_hook_hook` (event
13), or two dips below the settled height; event 14 records teasing.
`bobber_lost` is explicit. Log merges now preserve the event type and use
`entityType`/`chatType` for payloads. This also corrected the combat evidence:
earlier chicken deaths existed outside the 102-hit combat window. Seven new
tests; suite **528/528**. Bite success still required live verification.
See [fishing](wiki/fishing.md), verification rows 8.2 and 28.

## [2026-10-03] fix | Automatic pickup skips unreachable drops

Live `p3-first-night-3` confirmed crop, wood and egg pickup; residual dirt
failures came from drops below the plank floor, outside the walkable
component. `_pickupNearby` now skips those cells without movement, records
`failedAt` and `pickup_skipped`, and remains fail-open with unresolved feet.
Two new reachability tests; suite **530/530**, wiki lint clean. A live probe
of the new skip branch was blocked by the sealed room and protected floor.
Verification rows 4 and 42.3.

## [2026-10-03] feat | Mature crop harvesting and block-state preservation

`findBlocks` now preserves the Prismarine Block instead of spreading away
`getProperties()`. Added crop maturity, seed selection, guarded
`harvest_<crop>` and best-effort replanting. Fifteen new tests; suite
**543/543**, wiki lint clean. Live: potatoes reported growth **7/7/6/6** and
carrots 7; missing wheat and unreachable potatoes returned typed refusals.
End-to-end harvesting remained blocked by the walkable component at this
round. See verification row 19.1 and [headless client](wiki/headless-client.md).

## [2026-10-03] feat | Chat M5 acknowledges orders and outcomes; echo and stale inbox fixed

Added `human-replies.mjs` and controller acknowledgement/outcome replies.
Live bot-echo testing exposed self-orders because the server sender name
differed from the authentication name; text matching within 15 s now records
`chat_echo` and learns `selfName`. Orders older than 5 min are dropped, and
repeat rejection logs are deduplicated. Live `/say` → inbox → goal → outcome
worked; after the echo fix the test message produced one echo and no order.
Suite **564/564**. A real-human sender and closely spaced, rate-limited replies
remained unverified. See [human command](wiki/human-command.md), row 18.

## [2026-10-03] feat | Milking: craft_bucket and milk_<animal> (P4.1)

Added bucket crafting and cow/mooshroom milking with reachability gates,
inventory-delta confirmation and typed failures. Ten milk tests; suite
**574/574**. Live `/options` offered neither action without ingredients;
`milk_cow` returned `missing_bucket` immediately and `craft_bucket` returned
`missing_ingredients`, confirming the recipe existed. No cow or accessible
iron was available in the sealed-room round, so the happy path remained
pending at this date. Verification row 19.2.

## [2026-10-03] feat | Shield craft/equip/raise/lower: offline tests and live gates (P4.3)

Implemented shield crafting (1 iron ingot + 6 planks), offhand stack
requests, equipment confirmation and `start_using_item` in auth input.
Fourteen shield cases; suite **588/588**. Live gates returned
`missing_shield` (25 ms), `shield_not_equipped` (14 ms), already lowered
(21 ms) and `missing_ingredients` (18 ms); the server supplied the recipe.
Actual equipping and raising remained pending for materials and a reachable
threat. The later 04/10 A/B corrected the offhand index to slot 1;
this entry does not prove shield protection. Verification row 19.3.

## [2026-10-03] feat | Exploration M1 hardening and M2 route replay verified live

Fixed truthful `found` reports, isolated biome stepping from other mission
types, and superseded abandoned searches. Added replay from persisted
missions/places with forward-only guide checkpoints. Live: five stale
searches closed, a replay walked **4 path nodes** and completed `arrived`
with a `replay_of` relation. Replay to remembered home returned `path_failed`.
Eleven replay cases plus a found assertion; suite **599/599**. Long-range
biome exploration and multi-checkpoint replay remained unverified because
the room prevented travel. See [exploration](wiki/exploration.md), row 45.1.

## [2026-10-03] feat | Exploration M4 searches observable blocks and entities

Added natural aliases with word boundaries, `block:`/`entity:` escape
hatches, bounded scan reports, `POST/GET /explore/find` and its driver.
Live `block:oak_log` reported **16 matches across 125 loaded chunks** and
closed successfully; absent mushrooms, pumpkins and cows returned spiral
steps without false positives. A biome request returned
`unknown_search_target`; new searches superseded old ones. Five tests;
suite **604/604**. Unloaded targets still required travel, blocked by the
room. See [exploration](wiki/exploration.md), row 45.2.

## [2026-10-03] feat | Exploration M5/M6 detects structures and cavities

Added bounded nearest-section block surveys, deterministic structure
scores and persistent structure landmarks. Bedrock names `bed` and
`stonecutter_block` were corrected live. A 60,000-cell survey found a
village at **(113,73,156), score 6**, and a cave at **(112,71,144), 831 air
cells below**; repeat surveys did not duplicate landmarks. Cave search
reported found; Ancient City search did not invent a match. Suite
**612/612**. Histograms do not follow cavities, only loaded cells are visible,
and Ancient City detection remained offline. Verification row 45.3.

## [2026-10-03] feat | Travel kit, pillar-up, hut and placement fixes

Added `travel_kit`, `pillar_up`, `build_hut` and placement diagnostics.
Live: the kit crafted a sword/table but lacked armor/night supplies;
pillar-up returned `no_headroom`; the hut placed **one server-confirmed log
(6 → 5)**, skipped eight solid cells and reported `hut_incomplete`.
Fixed placement into occupied non-solid cells, clickable furniture supports,
and a jump path that crashed motion updates. Twenty travel-kit cases;
suite **634/634**. A complete hut and live pillar ascent remained pending.
See [exploration](wiki/exploration.md), row 45.4.

## [2026-10-03] feat | Observation log and derived vector index (P6)

Added schema-v5 observations, idempotent materialization and a derived
2048-dimension hashed lexical vector index. Live v4 → v5 preserved
**141 records, 39 missions and 80 relations**; repeated materialization
kept the same counts. Reindex produced **44 documents** and productive-dirt
search ranked the consolidated site first (**0.407**). Suite **667/667**,
with both memory backends covered. At this point the planner did not yet
consume recall and retention was undefined; later P6 entries close those
gaps. See [memory](wiki/memory.md), rows 42.4/42.5.

## [2026-10-03] feat | Fluids M0: water/lava awareness and safe digging

Added fluid census, hazard levels, escape ranking, adjacent-fluid digging
guards and survival conditions/rules. Unloaded worlds remain `ready:false`.
Live: **259 fluid cells**, water 8 and lava 251; nearest lava was **15.4
blocks below**, so no escape option or false drowning alarm appeared.
`avoid_lava` returned `no_lava_nearby` without movement; protected digging
remained refused. Eighteen fluid cases; suite **685/685**. Actual escape and
drowning were not exercised, and air was still unknown. See
[fluids](wiki/fluids.md), verification row 47.

## [2026-10-03] feat | Fluids M1 partial: shallow wading and simulated air

Allowed water at feet with a dry head, at `WADE_SPEED_FACTOR=0.5`, while
deep water and lava remain excluded. Added `AirMeter` (300 ticks) with
explicit `airSource`; server attributes override simulation and health is
never simulated. Live: air **300 / 15 s**, dry hazard none, and the water
waypoint returned `path_failed`. Suite **698/698**. Wading speed remained
uncalibrated live; swimming, surfacing and water pathfinding were absent
pending protocol evidence and accessible water. See [fluids](wiki/fluids.md),
row 47.1.

## [2026-10-03] feat | Redstone R0: component awareness and protection

Added component census, nullable power/state readings, state-filtered
block search and protection of built redstone; ore remains mineable.
Live `/observe.redstone` reported a ready empty census across **125 loaded
columns**; protected up/down digging returned typed refusals. Suite
**714/714**, covering pure state interpretation, adapter census and digging.
The room had no components or iron pickaxe, so real signal readings and
redstone-ore mining were not demonstrated. See [redstone](wiki/redstone.md),
verification row 47.2.

## [2026-10-03] feat | Redstone R1: oriented placement and repeater delay

Added bounded cardinal-yaw placement with world rereads and correction,
plus repeater delay cycling verified after each click. Fixed a local
variable shadowing the imported delay function. Suite **730/730**.
Live: missing lever, missing repeater and invalid delay returned typed
failures; a torch placement was server-confirmed (**2 → 1**) and crafting a
wooden pickaxe enabled cobblestone mining. Full component placement was
blocked because reachable cobblestone belonged to the protected base;
temporary unloaded cells failed conservatively. Verification row 47.3.

## [2026-10-03] feat | Redstone R2: circuit interaction and sensing

Added readable input/output states, in-place census updates, verified
input toggling with restoration, and survival power criteria. Suite
**748/748**, including a modeled server that toggles a lever and lamp.
Live: nullable empty readings, `use_redstone → no_redstone_input`, and
`sense_redstone` returning an inactive census; no unusable option appeared.
The click → effect → restore happy path remained offline for lack of
materials. Delayed effects needed R4; summary activity did not prove circuit
topology. See [redstone](wiki/redstone.md), row 47.4.

## [2026-10-03] feat | Redstone R3: declarative circuit blueprints and builders

Added `circuits.mjs`, eight validated blueprints, site/material checks,
bounded placement, trigger restoration and one report per attempt.
Four blueprints were buildable and four carried explicit refusal reasons;
empty success was rejected. Suite **767/767**, with modeled builds of
`lamp_switch` and `delay_line`. Live catalogue returned eight circuits;
missing materials, unsupported blueprints and unknown ids failed in
milliseconds and were logged. Full builds remained offline: no redstone/
glowstone and base cobblestone could not be mined. Verification row 47.5.

## [2026-10-03] feat | Redstone R4: measured delay, owned teardown and rollback

Added bounded output-change traces, delay measurement (50 ms/tick,
±60 ms tolerance), placed-cell ownership, teardown and failed-step
rollback. Missing traces produce `circuit_delay_unmeasured`.
Suite **774/774**: 300 ms measured as 6 ticks, 900 ms rejected, changed or
unowned cells skipped. Live: `owned:0`, `teardown_circuit → nothing_to_tear_down`
and delay-line build → `missing_materials`. Real delay, rollback and removal
remained offline; measurement requires server output updates and ownership
does not establish electrical isolation. Verification row 47.6.

## [2026-10-03] feat | Redstone R5: progression, skills and craftable materials bridge

Added the `redstone_ore → redstone_basics → redstone_automation` chain,
six skills, item tags and `circuitBuilt` verification of a fresh builder
report; an already-standing circuit cannot close the skill. Missing
materials offer only immediately craftable next actions. Suite **780/780**.
Live graph loading resolved automation and the curriculum advanced to
`stone_age`, with **three server-confirmed cobblestone mines**. A complete
build remained blocked by inaccessible drops, base protection and absent
glowstone. The bridge handles crafting, not smelting. See
[redstone](wiki/redstone.md), row 47.7.

## [2026-10-03] feat | Redstone R6: forbidden blocks, lag limits and site safety

Enforced forbidden placements, **48 steps / 24 working components**,
minimum clock period **8 ticks**, a **500 ms** same-input toggle interval,
and bot/piston-path exclusion. Suite **789/789**. Live gated diagnostic
probes refused TNT, command blocks and respawn anchors while the target
cell stayed unchanged; torch passed the ban and failed later on support.
Builds still lacked materials. Toggle timing and piston safety remained
unit-tested; limits apply per blueprint, and the forbidden set is explicit.
See [redstone](wiki/redstone.md), row 47.8.

## [2026-10-03] feat | Nether N0: hazards, projectiles, gaze and governor rules

Added portal/fire/magma/spawner census, projectile prediction, enderman
gaze detection and seven governor rules; namespaced entity names were
fixed in tests. Suite **818/818**, wiki lint clean. Live Overworld probes
reported no hazards or portals; five cached calls took **56 ms**. A thrown
egg was tracked moving away (**14.3 → 18.4 blocks**) without a false incoming
threat. Nether/End behavior, dangerous beds and hostile projectile/gaze
branches remained offline. See [nether](wiki/nether.md), row 47.9.

## [2026-10-03] feat | Nether N1: reach, build, light and enter a portal

Added frame planning/validation and four portal actions. Entry requires
the server's `change_dimension`, and placement avoids the bot's cells.
Suite **830/830**, including geometry, option gates and modeled server
confirmation; tests exposed a half-block approach error. Live: no portal
across 125 loaded columns, `no_portal_known`, missing **14 obsidian** and
`missing_flint_and_steel`, all in **13–14 ms**. No portal happy path was
exercised because the base lacked materials. See [nether](wiki/nether.md),
verification row 47.10.

## [2026-10-03] feat | Nether N2: non-flammable hub and safe landings

Added hazardous-support rejection, maximum falls of **4 blocks in the
Overworld / 2 in Nether/End**, and a shared shelter plan using non-flammable
materials. Home is remembered only for a complete hub. Fixed a constructor
field shadowing `_netherHub`; suite **843/843**. Live Overworld reported
`maxFall:4` and `build_nether_hub → wrong_dimension`, while wait still worked.
Nether hub/fall behavior, void protection and lava traversal remained
unverified. Deployment checks now compare file md5s to catch stale VM
copies. See [nether](wiki/nether.md), row 47.11.

## [2026-10-03] feat | Nether N3: lateral projectile dodge

Added velocity-based perpendicular candidates and `dodge_projectile`,
filtered for line clearance, reachability, safe support and lava. Success
requires the observed threat to disappear. Suite **851/851**; corrected
negative zero in pure directions. Live quiet-world and outgoing-egg probes
both returned `no_projectile_incoming`; the bot remained healthy with its
inventory intact. No ghast/fireball was encountered, so the happy path
remained offline and the fixed **3-block** dodge distance uncalibrated.
See [nether](wiki/nether.md), row 47.12.

## [2026-10-03] feat | Nether N4: piglin barter without attacks

Added gold-equipment awareness, adult/non-brute target selection,
shared hotbar preparation and `barter_piglin` using interaction only.
Confirmation is a new nearby drop; timeouts report whether the ingot was
spent. Piglin attack options are removed. Suite **859/859**, including the
real transaction shape in a fixture. Live: no piglin, no barter option,
`no_piglin_nearby` immediately, normal zombie attacks unchanged.
No barter completed on the server; that acceptance criterion remained
pending. See [nether](wiki/nether.md), row 47.13.

## [2026-10-03] feat | Nether N5: gaze discipline, pumpkin mask, torso aim and pearls

Added torso aiming below enderman eyes, explicit gaze versus perceived
aggression, pumpkin-mask equipping and observed pearl counts. Namespaced
enderman lookup was fixed. Suite **870/870**. Live: `enderman:null`,
`pearls:0`, `pumpkin:false`; gaze avoidance returned `no_enderman` and
equipping returned `missing_pumpkin` in **10 ms**, with no invalid options.
No real enderman or mask was available, so those happy paths remained
unit-tested. See [nether](wiki/nether.md) §N5, verification row 47.14.

## [2026-10-03] feat | Nether N6: fortress detection and blaze hunting with cover

Added dimension-aware fortress scoring/search and blaze tactics that
prioritize health, fire and verified cover before combat. Tests fixed the
wrong `inFire` field and unknown cells falsely treated as cover; suite
**885/885**. Live `hunt_blaze → no_blaze_nearby`; fortress search was accepted
but found **0 across 125 loaded chunks** in the Overworld, then the diagnostic
mission was cancelled. No fortress or blaze was present; successful
hunting remained offline. See [nether](wiki/nether.md) §N6, row 47.15.

## [2026-10-03] feat | Nether N7: eyes, stronghold, End portal and boss verdict

Added eye crafting, throwing and bounded triangulation, world-confirmed
frame filling and End entry. `bossDefeated` reads real boss-bar state;
dragon combat is absent and `beat_the_dragon` retains `success:null`.
Suite **909/909**, with 13 pure and 11 adapter cases. Live: zero frames,
pearls/powder missing, no boss bar; six actions returned typed refusals in
**19–21 ms** and their options stayed hidden. No End happy path or dragon
fight was verified. See [nether](wiki/nether.md) §N7, row 47.16.

## [2026-10-03] feat | Fluids M2: breathing sources and dive work budget

Added real breathing-source tracking, effect expiry and descent/work/
ascent budgeting with a 3 s reserve; underwater mining/pickup share the
gate. Suite **920/920**. Live dry mining remained server-confirmed;
an isolated console diagnostic applied Water Breathing, observed as a
**600 s** effect and counted down. Expiry was live-confirmed without a
remove packet; explicit removal remained unobserved. Underwater refusal
and turtle helmets stayed offline, swimming was unavailable, and the
3 s work estimate did not consult the tool. Verification row 47.17.

## [2026-10-03] feat | Fluids M3: waterfall and bubble-column verdicts

Added vertical-column detection, landing checks, breathing budgets and
three traversal actions requiring real position change. `swimSupported:false`
explicitly blocks unsafe traversal; water pathfinding edges were deferred.
Suite **938/938**, including a corrected inverted run length. Live:
zero waterfalls/bubbles in a **2×2×2** pool, all three actions returned
`no_column` in **3.7–10.6 ms**, no false survival rule. No artificial water
was placed in the shared world. Actual traversal and unreadable/out-of-range
landings remained unverified. See [fluids](wiki/fluids.md), row 47.18.

## [2026-10-03] feat | Fluids M4: safe shores, destroyed loot and crossing gates

Added lava death/drop verdicts, safe-shore ranking, bounded gap
measurement and equipment/fire-resistance crossing checks. Lost loot is
refused before walking; crossing initially returned
`bridge_not_implemented` with its plan. Suite **955/955**. Live nearest lava
was **15.4 blocks below**; `move_to_safe → not_in_danger` and
`cross_lava → no_lava_ahead` returned immediately, with no false options.
Escape, destroyed-loot behavior and traversal remained offline; no lava was
created in the shared world. See [fluids](wiki/fluids.md), row 47.19.

## [2026-10-03] feat | Fluids M5: buckets, boats, brewing gate and lava bridge

Added source/placement verdicts, inventory-delta bucket confirmation,
boat actions, brewing plans and a bridge advancing only onto
server-confirmed cells. Brewing interaction explicitly remains
`brew_not_implemented`. Fixed dispatch where generic `place_`/`mount_`
branches intercepted water and boat actions. Suite **977/977**.
Live census found **four lava sources**; missing buckets, bottles, boat,
recipe and brewing stand returned typed failures in **14–21 ms**.
Fill/pour/obsidian, boat mounting and the bridge remained offline because
materials and accessible lava were absent. Verification row 47.20.

## [2026-10-03] feat | Fluids M6: gameplay skills, curriculum and spatial criteria

Added nine fluid skills, five with explicit `blocked` reasons, item
tags, breathing/spatial criteria and the `bucket → water_travel →
nether_cross_lava` chain. Suite **984/984**. Live load returned **35 skills
(9 fluid), 23 milestones**; the new curriculum resolved prerequisites.
A local verifier call measured `deltaY:-8` on supplied observations; this
was not an actual waterfall traversal. The two-action live curriculum
slept and mined cobblestone, then exhausted its budget. Swimming/brewing
skills stayed blocked; water travel was not completed. Verification row 47.21.

## [2026-10-03] verify | P2 live round: riding unconfirmed and action lock watchdog

Live saddled-donkey mounting at **0.75 blocks** returned
`mount_not_confirmed` after **20–26 s**: ten interactions opened saddle
inventory without an entity link; two packet shapes failed. Other actions
returned missing-supply refusals; eating a carrot succeeded with food
**19 → 20**. Four container walks timed out despite BFS reachability.
A death during reading exposed a permanent busy lock; a 180 s watchdog
now returns `action_timeout` and releases it. Three tests; suite **987/987**.
Diagnostic `ride`/`follow_player` errors became typed; live happy paths
remained pending. See [final report](wiki/final-report.md).

## [2026-10-03] report | P0 → P7 campaign report created

Created [final report](wiki/final-report.md) and indexed it: a historical
snapshot of **51 commits**, suite **466 → 987**, 11 goal tasks complete and
one skipped for the environment. The report distinguished implemented
fronts and live refusals from incomplete riding, companion, fishing,
trade, swimming and material-dependent builds, recorded blocker attempts,
and ordered five follow-ups by dependency. These counts describe this
03/10 snapshot; the report has since been updated.

## [2026-10-03] feat | Planner consumes semantic recall (P6)

Added bounded goal-derived recall before every Hermes plan, logged
queries/hits/errors and injected place hints with provenance. A failed
search leaves planning operational. Two controller integration cases;
suite **989/989**. Live recall returned **three hits**, `error:null`, then
two dirt mines were server-confirmed; the two-action round exhausted its
budget and exited 0. Recall-to-waypoint selection was still open at this
front. See [memory](wiki/memory.md), verification row 42.5.

## [2026-10-03] feat | Episodic retention: dry-run pruning of missions and episodes (P6)

Added `pruneEpisodic` and `POST /memory/prune`: default dry-run, only
terminal consolidated missions eligible, age protection, semantic hints
preserved and vector cache invalidated. Thirteen cases across both
backends; suite **1002/1002**. Live default kept **40 candidates**;
zero-window dry-run proposed **8 missions / 59 actions / 8 checkpoints /
13 relations**, protecting 32 unconsolidated missions. A real default-window
call deleted nothing and preserved all counts/hints. Destructive deletion
was tested offline; observation retention remained open. Row 47.23.

## [2026-10-03] feat | P6: semantic hit becomes a world-confirmed waypoint

Added reachability verdicts to memory search and candidate-to-waypoint
selection only when no explicit/curriculum waypoint exists. Creating a
destination fails closed on unknown reachability; action filters remain
fail-open. Suite **1007/1007**. Live three hits were `reachability_unknown`,
so `candidate:null` and `semantic_waypoint_skipped`; two dirt mines still
worked. Diagnostic neighbors exposed a one-cell component enclosed by
beds, a table and a log placed in P5 probes. Walking and drop pickup stayed
blocked; this round verified honest refusal, not waypoint travel. Row 47.24.

## [2026-10-03] feat | Observation retention: write dedupe and superseded evidence pruning

The live log held **5654 rows for 32 distinct facts**, growing about
280 rows/min. Added 5 min write dedupe (changed values always append)
and dry-run-first per-fact pruning on both backends. Suite **1019/1019**,
wiki lint clean. Live pruning reduced **5654 → 131 rows**, preserving
graph/mission/action counts and identical search hits/scores. After dedupe
deployment, growth stayed **0 for 180 s**. Unconsolidated episodes remain
protected by design; facts are distinct subject/predicate/object triples.
See [memory](wiki/memory.md), verification row 47.25.

## [2026-10-03] fix | Circuit delay measurement: injectable clock, load-independent test

`tests/bedrock-circuits.test.mjs` was the one documented flake under full-suite
load: the fixture stamped the simulated redstone update with
`Date.now() + delay` while the adapter pinned `triggeredAt = Date.now()`, so the
measured gap could drift past the ±60 ms tolerance and the exact assertion
(`measuredMs === 300`) failed.

- `bedrock-adapter.mjs`: `this._now = () => Date.now()` in the constructor (next
  to `_redstoneTrace`), read by `triggeredAt` in the R4 build path and by
  `_noteRedstoneUpdate(position, at = this._now())`. Production stays real-time;
  a test can now drive the clock.
- `tests/bedrock-circuits.test.mjs`: the fixture sets
  `adapter._now = () => clock` (fixed `1790000000000`) and the fake
  `_useRedstone` calls
  `_noteRedstoneUpdate(target.position, adapter._now() + linkDelayMs)`, plus two
  new cases — the tolerance boundary (360 ms of slack passes, 361 ms is
  `circuit_delay_mismatch`, exactly) and the repeatability of the measurement
  (three builds on the same fake clock give `[[300,6,true],[300,6,true],[300,6,true]]`).

Evidence: the file alone 21/21 pass, 15 sequential runs clean, 4 runs in parallel
with 4 CPU burners on 8 cores all clean (`# pass 21 # fail 0`); full suite
**1019 -> 1021 tests**, 1021 pass / 0 fail in 18.3 s. Investigated alongside: the
`go_home ... movement timeout` rows in the old live log are **historical** — the
same waypoints today fail in 20-60 ms with typed errors (`target_not_found`,
`path_failed`, and the near one succeeds in 195 ms with one path node), so no
budget was changed (a larger budget would only have stretched the failures).
Docs: [redstone](wiki/redstone.md) R4, [verification](wiki/verification.md) row
47.6, [final report](wiki/final-report.md).

## [2026-10-03] feat | The placement ledger survives a restart, and `mine_owned` recovers it (R4)

The R4 registry (`_placedBlocks`) lived in RAM: a redeploy erased it, so the bot
could no longer tell a wall it had built from a wall of the base. Now every
placement is mirrored into world memory as `kind: placement`
(`rememberPlacement`, `setPlacementCircuit`, `forgetPlacement`; one record per
cell, `placement_<x>_<y>_<z>`, with `block`, `item`, `circuitId`, `source`,
`placedAt`), `_hydratePlacements()` rebuilds the map at spawn
(`placements_hydrated {count, owned}`) and `GET /memory/placements` reads it over
HTTP. The new `mine_owned` action removes the nearest cell that is still the
bot's own, still in reach and still holding the block it left there: a claim
whose cell now holds something else is dropped from both ledgers
(`placement_claims_dropped`) instead of mined, which is what keeps recovery safe
inside a base. `DIG_PROTECTED` is not consulted by `_mineBlock`, so no protection
was relaxed — ownership, not pattern matching, decides. Persistence failures are
logged and never invalidate a placement the server already accepted.

Tests: `tests/memory-placements.test.mjs` (7 cases ×2 backends) and
`tests/bedrock-placements.test.mjs` (10 cases) — suite **1045 green** (was 1021).
Live (container `hermes-jev-bedrock`, md5 identical host/container, then a
restart): `GET /memory/placements` → `{placements: [], count: 0, circuitId: null}`,
`circuits.owned: 0`, and `POST /act {"key":"mine_owned"}` →
`{ok: false, error: 'nothing_owned_nearby', owned: 0, dropped: 0, hint: …}` in
**1 ms** with the attempt recorded as an `action` event. The positive cycle
(place → restart → rehydrate → recover) is block-tested only: the standing room
offers nothing to place (inventory `{dirt: 1}`; `place_*` exists only for
`crafting_table`/`furnace`/`torch`/`bed` or a redstone component), and the two
probe blocks of that room predate the ledger, so no action can claim them — see
[open questions](wiki/open-questions.md).

Docs: [redstone](wiki/redstone.md) R4, [memory](wiki/memory.md),
[verification](wiki/verification.md) row 47.26.

## [2026-10-03] fix | Low surfaces are floor: the bot walks out of the room that sealed it (P2)

`green_carpet` blocks in the corridor cell (feet height) were read as
`boundingBox: 'block'`, so the feet cell of the bot was a wall and the walkable
component of the base room stayed one cell wide — every live round that needs
walking was blocked by furniture, not by the world. New `_lowProfile(block)` in
`bedrock-adapter.mjs` (`/(_carpet|_path)$/` plus `moss_carpet`) is consulted by
`_standable`, `_standableWhy` and `_solidAt`: low surfaces (≈ 0.06–0.19 blocks,
what a real client auto-steps onto) are **floor** in the feet cell, while the
head cell stays strict (`_passable`/`_passableForPath` untouched) and slabs,
stairs and beds stay solid on purpose (0.5–0.56 blocks need a real step-up the
local model does not simulate; prismarine reports `bed` as a full block, so
guessing was not an option).

Live: the bot walked the corridor (`goto_waypoint` → `{ok:true, distance:2,
pathNodes:7}`, `standingOn: green_carpet`), reached the door cell and stepped out
of the house (`y 73 → 72.62`); the potato field 38 nodes away became reachable
and the P2/P4 live backlog reopened. Tests: 3 new in
`tests/bedrock-reachability.test.mjs` (head cell still a wall, no floor under a
bare carpet, slab/bed unchanged).

Docs: [headless-client](wiki/headless-client.md) §4.1,
[verification](wiki/verification.md) row 47.27.

## [2026-10-03] fix | Equipping needs an open inventory window (the shield take works live now) (P4)

`equip_shield` failed live with `shield_take_failed_50` (three reproductions,
4–6 ms): the client sent a well formed `item_stack_request` (`take`, hotbar slot
2, `stack_id` 762) and BDS answered status 50. The cause was neither the cursor
nor the packet shape — **the player-inventory window was never open**. The
adapter already knew the rule in `_moveItemViaCursor` (*"I take/place valgono
solo con una finestra aperta: senza container il server risponde 49/50"*), but
the equip paths never opened it. `_takeToCursor(slotIndex, count, {attempts: 2})`
now calls `await this._ensureInventoryOpen()` first (same route as the working
swaps: `interact`/`open_inventory` + `container_open`), re-reads the item
snapshot from the refreshed `inventorySlots`, retries once after giving a dirty
cursor back (`_returnCursorToInventory`), and both `_equipShield` and
`_equipArmor` use it, with typed errors (`shield_take_failed_*`,
`armor_take_failed`) and cursor recovery after a failed place.

Live: `take_shield` from the village chest → `{ok:true, item:'shield',
count:1, inventoryDelta:1}`; `equip_shield` → the take succeeds and the failure
moves to the `place` into `offhand`/0 (`shield_place_failed_50`,
`cursor_stack_id` 776) — a destination-form problem the project already
documents as needing a real-client capture, so the offhand place is the only
part of the shield round still open. `raise_shield` and `_equipArmor` against a
real `armor` destination remain untested live. Tests: 3 new in
`tests/bedrock-shield.test.mjs` (17 total) plus the `_equipArmor` assertion in
`tests/bedrock-survival.test.mjs`.

Docs: [verification](wiki/verification.md) row 19.3.

## [2026-10-03] fix | A door closed on the bot: open it, don't fight physics

A villager closed the base door on the bot's cell: `GET /debug/geom` (enabled
for this diagnosis) showed `wooden_door` on **both** the feet and the head cell
with `standingOn: wooden_door`, and every `goto_waypoint` answered `stuck` while
`/debug/path` proved that a 5-node path existed (`goalCount 8`, `start
{90,73,163}`). Two causes, two fixes:

1. the body's own cells counted as solid (`_collides` → `_solidAt`), so no
   candidate position was ever free; `_selfCells()` plus
   `_collides(..., { ignoreSelf: true })` (horizontal call sites only) exempt the
   cells the bot occupies. Kept as an invariant of the local model, but live it
   was **not** enough: the server itself refuses to move a player out of a
   closed-door cell;
2. `_doorAhead()` now checks the bot's **own** feet/head cell **first** (before
   the cell in front): the existing `click_block` machinery opens it and the
   door's runtime-id change confirms it (`[door_opened] { key: '90,73,163' }`),
   after which movement resumes (`{ok:true, distance:1.95, pathNodes:5}`). No
   world edit: a door opened, not broken.

Tests: 3 new in `tests/bedrock-reachability.test.mjs` (25 total: own cell before
the cell ahead, door ahead still found, `null` when free, no crossing into the
neighbouring closed-door cell). Docs: [headless-client](wiki/headless-client.md)
§4.1, [verification](wiki/verification.md) row 47.28.

## [2026-10-03] fix | `_moveTo` arrives at the reachable cell, not at the planner's stale coordinates

Live, a long `goto_waypoint` reported `path_failed` although the bot had arrived:
the waypoint call freezes `target.y` from the starting position
(`{ x, y: this.position?.y, z }`), and `_updateMotionState` accepts arrival only
within ±3 blocks vertically. Climbing out of a cave onto the village floor is a
7-block change, so the check could never be satisfied: the bot stood 0.5 blocks
from the waypoint while the action retried three times and failed after **28.5 s**.

A second live probe showed the same class of defect on the horizontal axis: from
the cave mouth the **first** complete candidate was the cell 2.18 blocks away
(stop distance 2) while the exact cell was four blocks lower, so the action spent
8.1 s and failed again.

Fix, in `_moveTo` only (the A* and the neighbour model are untouched):

- arrival is measured on the cell the path actually reaches (`path.at(-1)`) —
  the stale `y` of the request no longer decides success;
- among complete paths the candidate closest to the requested coordinates wins,
  instead of the first one in score order;
- `_findGoalNodes(target, { limit })` takes a limit (default 8, unchanged
  elsewhere) and `_moveTo` asks for 16, so the exact-but-lower cell is not cut
  off by the vertical penalty of the score;
- the result now carries `goal` (the cell reached) next to the unchanged
  `distance` to the requested coordinates.

Live after the fix, same two calls that had failed: `{ok:true, distance:4.05,
pathNodes:28, goal:{x:73,y:72,z:153}}` in 12.8 s and `{ok:true, distance:1.8,
pathNodes:3, goal:{x:76,y:65,z:127}}` in 0.6 s.

Tests: 2 new in `tests/bedrock-movement.test.mjs` (a pit under the waypoint, a
deliberately wrong `y`), both checked to fail against the previous
implementation; suite 466 → 1055. Residual limit: arrival is accepted inside the
vertical tolerance, so the action can return while the bot is still a couple of
blocks in the air. Docs: [headless-client](wiki/headless-client.md) §4.1,
[verification](wiki/verification.md) row 47.29.

## [2026-10-03] fix | Take options rotate across containers, so a rich chest can't hide the one item a goal needs

The companion round needs raw fish for the tame, but `/options` never offered it: the
take options were capped at **8 globally** and filled container by container, so two
potato chests (2216 potatoes each) plus a bone-meal chest used up every slot and the
fish chest two blocks away — `cod`, the food a cat is tamed with — was never offered.
The planner could not ask for an item it could not see.

Fix in the option generation (`options ()` in `bedrock-adapter.mjs`): the take entries
are ordered by their index **inside** the container, so the eight slots rotate across
every cached container instead of draining the first one, and the items named in
`plan.targets` pass first (a goal that needs one item gets it even from the farthest
chest). The cap stays 8.

Live with `POST /plan {targets:{cod:1}}` after a `read_container`: `take_cod` first,
then `take_poisonous_potato`, `take_bone_meal`, `take_tropical_fish` (the fish chest,
which the old order never reached), `take_honeycomb`, … — and `take_cod` answered
`{ok:true, item:'cod', count:6, from:'chest', inventoryDelta:6}` (row 15 of
[verification](wiki/verification.md) is now live for the take side).

Tests: 2 new in `tests/bedrock-storage.test.mjs` (the village's real cache shape, and a
plan target coming from the farthest container), both checked to fail against the
previous loop; suite 466 → 1057.

## [2026-10-04] fix | Mounting and trading need a free hand and no sneak

The first human player of the campaign joined the live BDS, and the rule
behind the mount failure of 03/10 became **observable**: an `interact` mounts only
with **no sneak and no tool in hand**; **sneak** opens the animal's inventory;
shears in hand are the "use tool" branch (saddle on/off, lead off); shift
dismounts. The bot was in the sneak/held-item state, which is why the server
answered with the donkey's saddle window instead of `set_entity_link`.

Two real defects were fixed, both in `bedrock-adapter.mjs`:

- `_selectHotbarSlot` refused **empty** slots (`if (!item?.network_id) return
  false`), so the "empty hand" the mount code asked for never happened; the new
  `allowEmpty` option sends `{network_id: 0}`.
- `player_action` was written as `{runtime_entity_id, action}` while 1.26.51 also
  wants `position`, `result_position` and `face`: it raised `SizeOf error for
  undefined … reading 'x'`, so the `start_sneak` of the dismount could never leave
  the client. All writes go through the new `_sendPlayerAction`, and `_dismount`
  clears the flag with `stop_sneak` after the link is gone.

New `_freeHands (reason)` (`stop_sneak` + empty hotbar slot, `hand_not_empty` when
the hotbar is full) runs before every mount and every trade attempt;
`mount_not_confirmed` and `trade_not_opened` now report `hand`.

Evidence: 6 new tests (`tests/bedrock-riding.test.mjs`, `tests/bedrock-trading.test.mjs`),
suite 1069 → **1075 pass / 0 fail**; the serialization assertion is the one that
caught the `player_action` defect. The live round with the bot is still pending
(the single NetherNet port is occupied by the human session), so
[verification](wiki/verification.md) row 47.35 records the fix with its proof and
marks the live confirmation as pending.

## [2026-10-04] feat | M1: the swim input flags, from the human session's input mapping (physics still pending)

The first human session described how swimming works in Bedrock (holding sneak
dives fast, doing nothing sinks slowly, the jump button rises from the bottom and
climbs the shore blocks), and the 1.26.51 `InputData` mapper names the bits, so the
client-side half of M1 is no longer a guess: `swimInputFlags` computes
`start_swimming`/`stop_swimming` (edge-triggered, one packet per transition),
`want_up`/`want_down` and `auto_jumping_in_water`, and `_sendAuthInput` merges them
while the head is under water, tracking `_swimming` and logging `swim_input`.
`swimSupported` stays `false`: the local physics has no buoyancy yet, so the real
rates must be measured with the bot in water before any column or waterfall action
is allowed to swim. Tests: `tests/bedrock-fluids.test.mjs` and
`tests/bedrock-fluids-adapter.test.mjs`, suite 1077 pass / 0 fail.

## [2026-10-04] fix | `set_entity_link` carries a single `link` (the mount confirmation was dropped)

While chasing the mount, the live packet dump (`GET /debug/packet-debug?ms=45000`
on the diagnostic container) showed what the schema had already said: BDS sends
**`set_entity_link`** with a **single** `link`
(`container([{ name: 'link', type: 'Link' }])`), but our handler iterated
`packet.links`. The loop never ran, so no link was ever applied: a mount the server
confirmed would have stayed invisible, and the `type 0` dismount link was dropped
the same way. The handler is now `_onEntityLink (packet)` (single `link`, arrays
still accepted, another rider is logged as `entity_link_other`, `type 0` clears
`riding`), with 2 new cases in `tests/bedrock-riding.test.mjs` (16 in the file, suite **1091 pass / 0 fail**).

The fix did not make the live mount work, and the round measured why instead of
guessing: on a saddled, tamed, adult donkey **0.75 blocks** away, clear sightline,
daytime, empty hand, the server's only answer to our
`item_use_on_entity { action_type: 'interact' }` is the donkey's **inventory
window** (`inventory_slot { window_id: 2, slot: 0, item: 'saddle:1:14' }`) — the
sneak rule applied to a client that declared no sneak (`stop_sneak` is now sent
unconditionally before every interaction). Ruled out with live measurements: the 13
`PROBE_VARIANTS` (all give 0 resyncs and no window on the donkey; the probe only
ever provokes a reaction in the action path), `interaction_model`
(`touch`/`crosshair`/`classic`), a stale sneak flag, and the packet-shape variants
already listed in [trading](wiki/trading.md). A packet census during the mount shows
no window packet at all.

Documented: [verification](wiki/verification.md) rows 47.39 (the fix, ✅) and 47.40
(the measured gap, ◑, with the DTLS note: a network capture cannot resolve it, it
takes a client-side dump or a DTLS-terminating proxy),
[companions](wiki/companions.md) §"the link packet was never read",
[open-questions](wiki/open-questions.md) §Mounting, and
[headless-client](wiki/headless-client.md) §4.5 (the probe's new options and the
`hex` packet dump).

## [2026-10-04] verify | Companion actions live: shears, shearing, wool — and why the cat waits

The round that the sealed room had blocked ran end to end on the live server:
`take_shears` (`{ok:true, item:'shears', from:'chest', position:(72,71,153),
inventoryDelta:1}`) → a 42-node walk to the shearing pasture → `shear_sheep`
(`{ok:true, sheared:true}`). The success was verified **from the server's side**, not from
our own flag: `/observe.drops` showed `gray_wool x3` appearing at the sheep, and
`collect_drop` (`{ok:true, picked:3}`) left `gray_wool: 3` in `/observe.inventory`.

The other half of `p2-companion` is blocked by material, not by protocol: the four untamed
cats are visible in `companions` (15.3-21.1 blocks) but `tame_cat` refuses with
`{"ok":false,"error":"missing_feed","feed":"cod/salmon"}` — correct for Bedrock
(`tameFeed`) and honest, since no chest holds raw cod or salmon (only tropical fish and
pufferfish) and fishing still cannot land a bite. See
[verification](wiki/verification.md) row 47.41 and
[companions](wiki/companions.md) §"shearing verified live".

Two operational notes from the round: the BDS transport dropped once
(`connecterror:9`) and recovered with a `systemctl restart minecraft-bedrock.service` on
CT 108 — the harness reconnected **on its own** within ~30 s with the inventory intact, so
the container does not need to be restarted when only NetherNet dies; and `mount_donkey`
reports `no_rideable_nearby` while no donkey is in the census.

## [2026-10-04] fix | A remembered chest that does not open stops being offered

The durable memory is a hint, not an oracle: the live round of 04/10 offered `take_egg`
from a chest remembered at (93,72,160), while the world has that chest one block higher —
so the bot walked there and paid `container_open_timeout` (9-10 s of attempts) on every
try, and the option came back at the next step.

`_ensureStorageOpen` now records the failure (`storage_open_failure` with block, position
and distance) and `STORAGE_OPEN_FAILURE_MS` (10 min) keeps that container out of
`/options` until the cooldown expires; an explicit `/act` still tries it — the operator
may know better — but `_rememberedContainerFor` prefers a remembered container that has
not just failed and logs `container_take_retrying` when only failed ones are left.

Live: the `take_egg` options went from 4 to 3 after the failed open (the memory keeps the
entry), and the next `take_egg` answered
`{"ok":true,"item":"egg","count":16,"from":"chest","position":{"x":72,"y":71,"z":153},"inventoryDelta":16,"ms":10613,"remembered":true}`.
Three new cases in `tests/bedrock-storage.test.mjs` (suite **1125/1125**).

## [2026-10-04] feat | Container targets come from the durable memory (with a walk budget)

`take_*` options came only from the **runtime** container cache (`_cachedContainers()`,
filled by a read and expiring with `CONTAINER_TTL_MS`), so after a restart — when the
durable memory still lists 27 chests — the bot was offered **no** `take_*` at all, and an
explicit `/act` answered `item_not_in_container` in milliseconds (`take_cobblestone`,
live 04/10: that branch fires when the cached contents no longer match the window that
actually opened, and it re-aligns the cache before refusing). The option and the action
were reading two different sources: now they read the same two.

`options ()` merges the runtime cache with `_rememberedStorage()` — the remembered
containers that hold items *and* are reachable when the walkable model is usable — and
labels the memory-sourced entries `(remembered: re-read on arrival)`.
`_takeFromContainer` accepts either source, walks to a remembered target with
`STORAGE_TAKE_WALK_MS` (75 s) instead of the 30 s default, opens the container and
re-reads it on the spot; when the memory declares the item but no remembered container is
reachable it answers `container_unreachable` with
`"<n> remembered container(s) hold <item>, none is reachable now"` instead of denying the
item exists.

The walk budget comes from a measurement: the first live attempt walked 21 blocks in
31 s and timed out three blocks short of the chest (`movement timeout`), and the second
attempt succeeded in 546 ms. Live evidence, after a container restart (empty runtime
cache): `POST /plan {"objective":"Milk a cow","targets":{"bucket":1}}` → 8 `take_*`
options all labelled `remembered`; `POST /act {"key":"take_bucket"}` →
`{"ok":true,"item":"bucket","count":1,"from":"chest","position":{"x":92,"y":73,"z":165},
"inventoryDelta":1,"ms":546,"remembered":true}`.

Nine new cases in `tests/bedrock-storage.test.mjs` (suite **1122/1122**), including the
typed refusal, the fail-open path with an unusable reachability model and the walk budget.

## [2026-10-04] fix | A dirty cursor paralysed the container take path; the offhand is slot 1

`take_<item>` from a chest ended in `{"ok":false,"error":"take_failed_50"}` while the
chest clearly held the item. The live A/B on the deployed container named the cause: the
cursor is **one** slot and the server validates it as the destination of every `take`, so
any stack parked on it makes the next take answer `50`
(`FailedToValidateDstSlot`) — even when the item being taken is the same one. With an
empty cursor the same two requests are `ok` (chest→cursor, cursor→`hotbar_and_inventory`).

What made it permanent was ours: `_moveItemViaCursor` cleared `_cursor` optimistically
after a failed place-back, while the server still held the stack, and every later cleanup
is guarded by `this._cursor?.count > 0` — so nothing ever gave that stack back.
`_takeFromContainer` now empties the cursor first and refuses with a typed `cursor_busy`
when it cannot, and `_moveItemViaCursor` keeps the model truthful (it applies a successful
undo instead of pretending). Three tests cover the order and the typed refusal; the suite
is at 1113.

The same round settled the offhand destination that was blocking the shield: with a
nautilus shell — an item the offhand accepts — `place` → `offhand`/1 answers `ok` while
`offhand`/0 answers `55`, and an offhand-illegal item (kelp) is refused with `50` on both.
`_equipShield` already targets slot 1 with slot 0 as a fallback, so the old
`shield_place_failed_50` was the wrong index; only a shield to equip is missing now (the
village chest that held one is gone). `POST /debug/isr` gained a container opener and an
`apply` flag so a hand-driven stack request records its answer in the local model exactly
like an action does — that is how the positive round was run: a tracked dirty cursor, then
a real `take_tropical_fish` → `{ok:true, count:1, from:'chest', inventoryDelta:1}` in 11.5 s
with the formerly stuck stack back in the inventory.

See [verification](wiki/verification.md) row 47.44, [headless-client](wiki/headless-client.md)
§4.3 and [open-questions](wiki/open-questions.md) §"Taking from a container".

## 2026-10-05 — Ingest: remembered resource sites in material supply

Integrated the existing construction work with current crafting on a dedicated
branch. The shared resource-site provider ranks historical compatible sites,
navigates with a bounded waypoint, refreshes the census and observes again, then
requires a live gather key. Failed/empty sites fall back locally; construction
retains explicit missing-material evidence and container authorization. Updated
crafting/construction wiki pages and the source catalogue. Offline verification
includes site ranking, stale/unreachable cases, live gathering and ownership guards;
real-server validation remains pending.

Verification: the integrated full suite passed **1333/1333** tests; the final
focused crafting/provider/controller/recall check passed **31/31**. The provider
file contains 13 targeted cases. Strict wiki/privacy lint and `git diff --check`
passed. Construction live validation and this new sourcing slice remain pending.

## [2026-10-05] ingest | Model-owned construction architecture

Natural-language construction now requires Hermes geometry, ordered stages, rooms,
furniture and explicit requirement coverage. A read-only preview returns failures
for model repair without granting new chest permissions or replacing the brief
with a prefab. Offline custom-house and controller/HTTP acceptance passed; the
real Hermes probe timed out. The live house remains partial at 18 confirmed floor
blocks, paused, with the harness off. See [construction](wiki/construction.md).

## [2026-10-05] ingest | Real architect repair confirmed offline

A real Hermes CLI response designed a 3 × 4 cobblestone platform. Feedback and
explicit ID/requirement constraints produced a corrected plan accepted by the
preview and completed by the real executor with 12 confirmed simulated placements.
The model chose the geometry; no prefab substitution or manual geometry repair
was used. Rich-house generation and live BDS construction remain separate checks.
See [construction](wiki/construction.md).


## [2026-10-05] ingest | Bounded architectural data repairs

Hermes can patch an unpublished design atomically through bounded JSON edits,
with validation feedback and storage/site authorization retained. A real
394-byte model repair added the missing workstation check to its own two-storey
house; the preview passed. Placement simulation then exposed missing early access
for the lower walls, so functional completion remains unproven. Clearance errors
now report local coordinates. See [construction](wiki/construction.md).

## [2026-10-05] ingest | Real model house and work-access repair completed offline

Hermes generated and repaired a custom two-storey spruce house with a bed,
crafting table and decorative brick chimney. The model added early temporary
work access after actual executor feedback; the simulated run verified 426
permanent placements, five functional checks and removal of 161 temporary
placements. The integrated suite passed 1422/1422 tests. Live BDS completion
remains pending: the existing house is paused at 18 placements after a daytime
movement timeout, with the harness off. See [construction](wiki/construction.md).

## [2026-10-05] ingest | Bounded construction approaches preserve physical progress

Movement timeouts now carry actual start/end positions and reached waypoints.
Construction can return a proven navigation segment to Jev without claiming
arrival, placement or functional completion. Stationary movement blocks, and
six consecutive partial segments bound retries. Accelerated real-physics tests
cover progress, a no-tick timeout, subsequent completion and exhausted retries.
The focused suite passed 81/81 checks and the complete integrated suite passed
1425/1425. Strict wiki lint and `git diff --check` passed.
See [construction](wiki/construction.md).

## [2026-10-05] ingest | Bounded trips to approved construction supply chests

Construction approaches distant authorized chests in bounded navigation segments
before starting a take or deposit. Each partial trip reports no supplied items;
stationary/exhausted movement still blocks with evidence. Warm cached chests in
open-failure cooldown are skipped. Real-physics offline acceptance covers an
approved remote chest, an ignored nearer unauthorized chest, actual approach,
withdrawal and subsequent construction completion. Live verification awaits the
user-confirmed server maintenance. See [construction](wiki/construction.md).

Validation: all five focused cases passed. After rebasing onto the current
inventory/deposit changes, the complete offline suite passed **1470/1470** tests
with exit status 0. Strict wiki lint and `git diff --check` passed. The live house
remains paused at 18 placements; merge/deploy await the other active session.

## [2026-10-05] ingest | Visible and reachable standing cells before sleeping

Live sleep attempts repeatedly failed near village beds. Bed use now requires
loaded foot/head cells, a complete path to a standing cell outside the bed,
precise arrival at that elevation, and an unobstructed collision-shape ray to
the bed. A nearby bed behind a wall triggers an approach through its doorway;
an inaccessible room or unknown geometry never causes a blind click. Bed access
searches have a 512-node budget per candidate. The shared visibility traversal
preserves the existing entity visibility policy. See
[verification](wiki/verification.md) and the
[bedroom regression cases](../tests/bedrock-sleep-access.test.mjs).

Validation: the 48 focused sleep/visibility/controller cases and all 64 survival
cases pass. The complete offline suite passes **1476/1476** tests with exit status
0. Strict wiki lint and `git diff --check` pass. The candidate is isolated and has
not been deployed or verified live.


## [2026-10-05] ingest | Player-specific sleep confirmation

The integrated release connected successfully and answered a real trusted player's
chat message, but bed attempts still returned `sleep_rejected`. The server moved
the bot to the bed without the generic `resting` signal. The adapter had ignored
player byte metadata 26: its sleep bit is 1, as defined by
[BedrockProtocol player metadata flags](https://github.com/pmmp/BedrockProtocol/blob/master/src/types/entity/PlayerMetadataFlags.php).

Player sleep metadata now takes precedence over generic actor flags in either
packet order. A later player byte explicitly confirms waking. Local motion
simulation pauses while sleeping and clears pending jumps, preserving the server
position instead of predicting standing gravity. Bed use reports
`player_sleep_flag` and does not send `stop_sleeping` after this confirmation.
Regression coverage: [player sleep](../tests/bedrock-player-sleep.test.mjs).
Live sleeping remains unverified until the new signal is observed on the server.


## [2026-10-05] ingest | Food and observed item names in inventory orders

Live chat orders for a baked potato went through the generic planner, which
closed after approaching the human without dropping anything. The vocabulary
now recognises cooked potatoes and singular quantities. Names present in the
observed inventory or ground items accept spaces or underscores before aliases,
so `raccogli spruce log da terra` selects `spruce_log` rather than dirt.

The native drop was accepted, but the human saw the bot pick its own potato back
up. Runtime drops now level the camera, face the sender when visible, and leave
the pickup radius on a short, loaded path at the same elevation. Without that
clearance they refuse before changing inventory. A regained item returns
`drop_recollected` rather than a successful action. Regression coverage includes
one cooked potato, names observed in the world, horizontal tossing, unavailable
clearance, and immediate re-collection.

## [2026-10-05] feat | Sleep during a thunderstorm, not only at night

The owner asked whether a daytime thunderstorm lets a player sleep. It does:
vanilla gates sleep on the internal sky light ≤ 11, so clear weather allows
sleep only on ticks 12523–23477, rain widens the window to 12002–23998 but stays
night, and **a thunderstorm lifts the restriction at any hour** (message "You
can only sleep at night or during thunderstorms"). The adapter knew only night,
and tracked no weather at all.

- **Weather tracking**: `WEATHER_LEVEL_EVENTS` maps the Bedrock `level_event`
  ids by number *and* name — `start_rain` 3001, `start_thunder` 3002,
  `stop_rain` 3003, `stop_thunder` 3004 — to a `_weather` patch; `_setWeather()`
  stores `{rain, thunder, at}` and logs `weather_change` only on an actual
  change. A thunderstorm implies rain, and `stop_rain` clears both flags, so a
  missing `stop_thunder` cannot leave the bot sleeping in the sun.
- **Perception**: `_timeInfo()` (and therefore `observe().time`) now carries
  `rain` and `thunder` next to the clock; `_isThundering()` and
  `_isSleepTime()` (`_isNight() || _isThundering()`) are the new primitives.
- **Gating**: both the offered `sleep` option (its description switches to "to
  wait out the thunderstorm") and `_sleepInBed()` use `_isSleepTime()`; the
  refusal code stays `not_night` and now means "neither night nor a
  thunderstorm". The Nether/End keep answering `beds_explode_here` first. The
  in-bed wake loop is deliberately left night-only — a Bedrock daytime
  thunderstorm may not clear time, so the bot must not stay stuck in the bed.
- **Verified offline**: `node --test tests/bedrock-weather-sleep.test.mjs` →
  6/6 (name and numeric ids, no stray flag on an unrelated `level_event`,
  `_timeInfo` exposure, the daytime storm offering the bed, plain daylight
  refused with `not_night`, Nether refusal), and the sleep/survival/nether/
  construction regression set → 167/167. Live verification of a real
  thunderstorm round is still pending.
- **Wiki**: the weather window and the new behaviour are recorded in
  [survival intelligence](wiki/survival-intelligence.md) and in row 10 of
  [verification](wiki/verification.md).

## [2026-10-06] ingest | Village reconnaissance and the farm order

- Added the raw spec
  [`docs/raw/VILLAGE_RECON_ROADMAP.md`](raw/VILLAGE_RECON_ROADMAP.md) and the
  wiki page [`wiki/village-recon.md`](wiki/village-recon.md) (V0–V5, **spec
  only**), answering an operator question: should the bot be able to survey a
  village (houses, free beds, pens, plots, storage) like a robot vacuum, so that
  `raccogli le carote dal campo, rimpianta e metti il raccolto nel baule più
  vicino` becomes one order?
- **What already exists** (read from the code, not recalled): the histogram
  survey `surveyBlocks` (`bedrock-world.mjs:294`) and the pure marker detector
  `structures.mjs:150` with the village rule at `structures.mjs:35`
  (`minScore: 5`); the live round in [exploration](wiki/exploration.md) —
  village at (113, 73, 156), score 6, `bed: 30`, `villagers: 11`,
  `missing: bell (0/1)`, with the declared limit that the survey is "an
  histogram of names, not a map"; the memory record kinds and writers
  (`world-memory.mjs:174/332/378/426/837`); the three steps of the order as
  option keys (`harvest_<crop>` at `bedrock-adapter.mjs:4383`, which already
  **replants**, `plant_<item>:4702`, `deposit_<item>:4689` / `dump_inventory:4681`);
  the censuses `_findBeds:13211`, `_nearbyFarmAnimals:11581`,
  `_cachedContainers:7041`; and the chore layer `village-labor.mjs:94`
  (`harvest_crops`, verified by a state delta).
- **Two gaps named**: (1) nothing aggregates a house, a plot or a pen — the
  beds/animals/containers are recomputed on demand and never written as a
  village fact; (2) the shortcut is ambiguous — `controller-decisions.mjs:173`
  resolves the noun only against the inventory and the visible drops, so
  `isCollectOrder:221` reads "raccogli le carote" as *pick up carrot items* when
  the bot carries carrots (the empty case refuses with `no_drop`,
  `chat-lang/it.mjs:60`) — and the deposit side has no memory:
  `_depositTargetFor:7000` scores only the runtime cache
  (`_cachedContainers:7041`, TTL 5 min), so after a restart the bot forgets
  which chest holds the carrots although `rememberContainer` persisted it.
- **Roadmap**: V0 pure census `village-survey.mjs` + `GET /observe.village`
  (with `checked: true`), V1 a bounded read-only `survey_village` sweep (typed
  refusals `village_too_far`/`survey_budget_exhausted`, throttled, idempotent,
  never a dig and never a villager), V2 deposit target from memory with a
  stale re-read, V3 the farm order as `plan.farm = {crop, replant, store,
  field}` driving the chain against `GET /options` and closing on a state delta,
  V4 confidence/evidence/`missing` plus protection, V5 the wiki wiring. New env
  vars proposed: `VILLAGE_SURVEY_MS`, `VILLAGE_SURVEY_CELLS`,
  `VILLAGE_HOUSE_RADIUS`, `VILLAGE_PLOT_MIN_CELLS`, `VILLAGE_MEMORY_TTL_MS`.
- **Non-objectives**: voxel maps or room segmentation, renovating houses,
  villager engineering, redstone farming, looting the village chests,
  slaughtering the base's animals, and letting the model supply a village fact.
- Recorded in [index](index.md) (wiki + raw tables) and
  [sources](sources.md); the open questions from the spec go to
  [open-questions](wiki/open-questions.md) when the implementation starts.

## [2026-10-06] ingest | Village census reads the world memory, not only the radius

- Operator question on the V0–V5 spec: *"sfrutta la memory per il censimento?"*
  Answer: in the baseline, no — the memory is written and then not read, and the
  spec was sensor-first. Fixed in
  [`raw/VILLAGE_RECON_ROADMAP.md`](raw/VILLAGE_RECON_ROADMAP.md) (new section
  "Register vs sensor (the memory contract)") and in
  [`wiki/village-recon.md`](wiki/village-recon.md) (new **Gap 3** + section
  "Register or sensor?").
- **What the code actually does** (verified): writers are all called —
  `rememberStructure` (`bedrock-adapter.mjs:1306`, inside `_surveyStructures`),
  `rememberContainer:7057` (on every open), `rememberEntity:1251`,
  `rememberResourceSite:1237`, `rememberLandmark:749`/`:12223`,
  `markChunkVisited` (~`:1257`) — while readers with a production caller are only
  three: `scanStructureTarget` (`bedrock-harness.mjs:78`, live survey ∪
  `findLandmarks({kind:'structure'})`, explicitly so a landmark survives a
  restart, but only on the `find_structure` path), `_rememberedStorage:7183` +
  `_rememberedContainerFor:7207` for `take_*`, and `visitedChunks`
  (`bedrock-harness.mjs:508`/`:609`, the explore route). `findEntities:449` is
  read by tests only; `unexploredFrontier` (`world-memory.mjs:512`) has **no**
  production caller; `observe()` publishes a runtime field
  (`this.structures`, 60 s TTL `STRUCTURE_RESCAN_MS:233`) instead of the memory.
- **Spec changes**: V0's deliverable is now the read path —
  `villageRegister({near, dimension, includeStale})` merging remembered facts
  (`findLandmarks` for houses, `resource_site` for plots, `findEntities` for pens
  — the first production reader of `rememberEntity` — `findContainers`/
  `containersWithItem` for storage) with the live radius, each row carrying
  `source: 'memory' | 'live'`, `status`, `observedAt`, `verifiedAt`; the restart
  check is an explicit acceptance criterion (a just-restarted harness must still
  name the village and its plots from memory). V1 plans its route from
  `visitedChunks` + `unexploredFrontier` instead of a blind ring. V2 asks for
  `known` records only, because `findContainers` defaults to
  `includeStale: true` (`world-memory.mjs:213`) and `_rememberedStorage` tolerates
  stale rows — acceptable for an explicit `take_*`, not for a deposit target.
  New test row `tests/village-register.test.mjs`; new risk 9 (freshness is per
  fact, so a half-finished sweep must not look like one village-wide rescan).
- Rule recorded for the whole roadmap: **the memory is the register, the survey
  is the sensor** — a village fact comes from a record with a status or from a
  fresh measurement that immediately becomes one, never from the model.

## [2026-10-06] ingest | A chest search costs a sweep once, a lookup forever

- Question that produced this (from the owner): *if I ask the bot to find iron
  in the chests, does it still have to do reconnaissance?* Answer recorded in
  the spec as a new section, `docs/raw/VILLAGE_RECON_ROADMAP.md`
  ("The chest search: reconnaissance in two depths") and summarised in
  [`docs/wiki/village-recon.md`](wiki/village-recon.md).
- The two depths: **where** the containers are is cheap and interaction-free
  (`_findNearbyStorageBlocks:7029`, `STORAGE_BLOCKS` in the loaded palette,
  radius 32, `STORAGE_SCAN_PER_NAME = 24` at `bedrock-adapter.mjs:159`), while
  **what is inside** costs one open per chest (`read_container:4595`, batched at
  `STORAGE_READ_LIMIT = 8` at `:164`). A chest is opaque from outside, so the
  sweep is unavoidable the first time — and never again for the same chest:
  `_rememberedStorage:7183` → `_rememberedContainerFor:7207` answers from the
  record, with `take_*` re-verifying on arrival.
- Design consequence added to V0: the register needs `contentsKnown` next to the
  contents, so a chest the sweep only *saw* is a known place with an unknown
  inside instead of a missing fact. Today that row is impossible:
  `rememberContainer` has exactly one call site, `_setContainerContents:7057`,
  i.e. it only fires **after an open**, so a merely-seen chest is not remembered
  at all — not even by position.
- Honest bound kept: the register says *where to look*, not *what you will
  find* — a remembered "13 iron_ingot" may already be gone, which is why a
  `stale` row is a candidate to verify and not a promise. "Find the iron in the
  chests" is now the first V0/V2 acceptance case because it exercises register,
  memory read path, staleness discipline and the take/deposit symmetry without
  involving a single farming mechanic.

## [2026-10-06] ingest | Boarding the human's vehicle: detect, decide, act

- Question that started this (from the owner): *"if I tell the bot 'follow me' and
  then get on a boat, does it sit behind me or does it stay on dry land?"* The
  answer was "it stays ashore", for two independent reasons — `follow_player` is
  a locomotion intent whose only primitive is `_moveTo` (`survival/intents.mjs`),
  and its option disappears on deep water because the gate is
  `entityApproachable(follow, {range: 3, dy: 2})`; the mount itself is blocked by
  the server never sending `set_entity_link` for our `interact`. The owner then
  asked for the mission: `follow_player → detect_mount_state →
  join_same_mount_if_seat_available → resume_follow_on_dismount`, with three
  adjustments — capacity per **entity** (`mountCapacity`/`seatInfo`) instead of
  per type name, `human_mount_full` and `human_mount_unsupported` kept as
  distinct typed refusals, and `join_human_mount` ranked above **every**
  locomotion fallback (not only above `mount_*`), because chasing a boat is not
  a way of reaching it.
- Split implemented: **detect** (rider links kept for every rider in
  `entityLinks`, `riding` flag read on non-self entities, `_humanMountView()` with
  sources `link`/`proximity`), **decide** (`bedrock-mount-follow.mjs`: pure state
  machine `FOLLOWING → HUMAN_MOUNT_DETECTED → JOINING_HUMAN_MOUNT →
  RIDING_WITH_HUMAN → FOLLOWING`, exits to `WAITING_AT_SHORE` with typed reasons),
  **act** (`join_human_mount` dispatched before `mount_boat`/`mount_*` and every
  locomotion fallback, `optionPriority` 1.5, `_joinHumanMount` targeting the
  human vehicle's `runtimeId`).
- Boundary chosen: the real join is behind `BEDROCK_JOIN_HUMAN_MOUNT=1` (default
  off), because the server does not confirm the interact — the capture described
  in [open-questions](wiki/open-questions.md) §Mounting is still the unblocking
  fact. What runs in production is the *refusal*: no 45 s of silent stalling, a
  typed reason in the logs and a `mount_waiting_shore` line with coordinates, once
  per episode.
- Evidence: `tests/bedrock-mount-follow.test.mjs` (15 cases) and
  `tests/controller-mount-follow.test.mjs` (2 scripted-harness cases); full suite
  1602/1602. Synthesis in [companions](wiki/companions.md) (§2026-10-06) and
  [open-questions](wiki/open-questions.md) §Mounting.

## [2026-10-06] ingest | Discovery and inspection are separate facts, and the ladder orders them

- Owner's refinement (m00302): formalise the difference between **discovery** and
  **inspection**; persist chests that were merely *seen*; the register must
  distinguish discovered position, `contentsKnown`, `inspectedAt`, known
  contents and the stale/TTL; and Hermes must always choose the cheapest source
  of knowledge *before* ordering exploration to Jev. Spec updated:
  `docs/raw/VILLAGE_RECON_ROADMAP.md` ("Discovery and inspection are two
  different facts" — state table, escalation ladder, the four-case acceptance
  test and the code verification table), summarised in
  [`docs/wiki/village-recon.md`](wiki/village-recon.md).
- The ladder for an item order ("cerca del ferro nei bauli"): rung 1 a container
  whose contents are *known* to hold it, rung 2 a container merely *discovered*,
  rung 3 a local scan of the loaded area, rung 4 the sweep — **only rung 4 is
  exploration**, and it is the fallback. Two clocks, because the two facts age
  differently: `CONTAINER_DISCOVERY_STALE_MS` (6 h — containers do not move) and
  `CONTAINER_INSPECTED_STALE_MS` (5 min — other players move things).
- **Verification (asked for explicitly — can the current implementation separate
these?): no, and here is what blocks it.**
  - *Ready*: `containerId:169` is spatial so a re-write upserts in place, and
    `rememberContainer:174` already preserves `discoveredAt` across upserts
    (`existing?.discoveredAt ?? now`) — the discovery timestamp exists and is
    never written by a discovery.
  - *Blocking*: `_materializeContains:204` invalidates **every** `contains` edge
    of the id before rebuilding them from the contents passed in, so a naive
    discovery write with `contents: {}` would **erase** the "13 iron_ingot"
    learned earlier; `contents = {}` is overloaded (
    *unknown* vs *opened and empty*) and the write unconditionally stamps
    `status: KNOWN`, `confidence: 1`; `source` is free text, not a state field.
  - *Missing*: rung 2 has no query at all — `containersWithItem:226` filters on
    known contents and no `findContainers:213` parameter carries `contentsKnown`.
  - *Partial*: `refreshStatuses:1398` is called only by `hydrate:1405` (no
    timer), so a long session never promotes anything to `stale` while
    `findContainers` defaults to `includeStale: true`; and `STORAGE_BLOCKS:157`
    is an exact-name list (`chest`, `trapped_chest`, `barrel`, `shulker_box`), so
    dyed shulker boxes are invisible and the scan is capped at radius 32 with
    `STORAGE_SCAN_PER_NAME = 24`.
- Ownership assigned in the milestones: V0 the two-depth record + ladder read +
  the non-destructive discovery write, V1 is rung 4, V2 makes the deposit path
  climb the ladder instead of asking only the 5-minute runtime cache. New test
  rows: the ladder ordering, a discovery write that never erases known contents,
  a discovery row outliving an inspection TTL, and a live four-case chest test.

## [2026-10-06] feat | Riding as a passenger holds the follow order and resumes it

- Gap closed after the mount-join commit: while the bot was a passenger with a
  `follow me` order open, the controller still offered `follow_player`, so the
  bot tried to walk after a boat it was sitting in (the harness answers
  `riding`), and the steps without a pursued target could even start the
  "where are you?" notice.
- Fix in `controller.mjs`: `mountRiding` (`obs.mountFollow?.state ===
  'RIDING_WITH_HUMAN'`) suppresses `follow_player`, `seek_player` and
  `join_human_mount`, and excludes the step from `lostFollow`; while the state
  lasts the controller holds (log `mount_ride_hold`, no action, no step budget,
  no model call — a survival need still runs), mirroring the existing
  `lostHold`/`escortHold` pattern. On dismount the state returns to `FOLLOWING`
  and the deterministic follow resumes with no second order; `dismount` is never
  acted on by the bot.
- Deferred on purpose (owner's call): the shore *hold* primitive — the `ti
  aspetto qui` line stays a separate mission, to be built when a reliable hold
  exists.
- Evidence: third scripted-harness case in
  `tests/controller-mount-follow.test.mjs` (all four locomotion/exit options
  offered while carried; nothing acted, one `mount_ride_hold`, no `follow_lost`,
  then `follow_player` resumed) — 3/3; synthesis updated in
  [companions](wiki/companions.md) §2026-10-06.

## [2026-10-06] feat | Discovery and inspection are two facts in the data model (V0)

- `world-memory.mjs`: `rememberContainer` now takes a *write kind*. Without a
  `contents` payload (or with `contentsKnown: false`) it is a **discovery**: it
  updates `type`/`position`/`discoveredAt`/`lastSeenAt` and never touches
  `contents`, `inspectedAt` or the `contains` edges. With a payload it is an
  **inspection**, the only write that stores contents and re-materializes the
  edges. The old default `contents = {}` conflated the two, so a discovery would
  have erased the contents learned earlier via `_materializeContains` (which
  invalidates every `contains` edge before rebuilding them).
- `contents: null` = *not measured*, `{}` = *measured and empty*: four states are
  now distinguishable (`describeContainer`, `CONTAINER_INSPECTION_STATE`:
  `never_inspected` / `empty` / `contents` / `stale`).
- Staleness is **computed on read** from `inspectedAt`/`discoveredAt`
  (`containerStaleMs` 5 min, new `containerDiscoveryStaleMs` 6 h), so no timer and
  no `hydrate` are needed for a container to stop being trusted;
  `findContainers({ includeStale })` answers with the derived value and a status
  already marked stale stays stale (staleness is monotone). `refreshStatuses`
  remains for landmarks and as a convenience write.
- New rung-2 query `containersToInspect({ from, limit, includeDiscoveryStale })`:
  never inspected or inspection expired, ordered by distance.
  `findContainers` also accepts `contentsKnown` and `needsInspection`.
- `storage-blocks.mjs` replaces the adapter's exact-name whitelist with a matcher:
  exact names plus families (`*_shulker_box`, so every dye colour) and the
  extension points `addStorageBlockName` / `addStorageBlockFamily`.
- `storage-ladder.mjs` holds the four-rung order (`known item` → `inspect
  discovered` → `local scan` → `recon sweep`) as a pure decision with a `reason`
  and a `blocked` list, so a caller that jumps to the sweep while a remembered
  container could have answered is visible instead of implicit.
- Tests: `tests/world-memory-container-facts.test.mjs` (json + sqlite) closes V0
  with *"a later discovery never erases known contents"* and *"a stale inspection
  never makes the discovery disappear"*; `tests/storage-ladder.test.mjs` (13
  cases) and `tests/storage-blocks.test.mjs` cover the ladder and the matcher.
  Full suite: 1621 pass, 0 fail.
- Not yet wired (next step, deliberately after the model): nothing in the live
  path *writes* a discovery (the only writer is still post-open in
  `_setContainerContents:7052`), and `_depositTargetFor:7000` still reads only the
  runtime cache instead of climbing the ladder.
- Commit `0650877` on `docs/village-recon-roadmap`; wiki status updated in
  [`docs/wiki/village-recon.md`](wiki/village-recon.md).

## [2026-10-06] feat | A human order suspends the running goal; the parent resumes revalidated

- Gap: a human `@bot` order arriving while another goal was running used to
  **reorient** it — `controller.mjs` replaced `goal.plan` in place, set
  `goal.humanOrder` and cleared `skillRun`, so the parent's objective/plan no
  longer matched its record and the outcome of a *second* human's order went to
  the first human (the sender was read from `goal.parameters.from`, i.e. the
  goal's original `from`).
- Fix (`controller.mjs`): the order now **suspends** the parent and runs as a
  child goal. `runGoal` returns `{status:'preempted', human:{plan, entry}}`;
  `main` calls `goalManager.preempt('human_order:<from>')`, enqueues
  `{type:'chat', source:CHAT, plan, parameters:{from, message}, parentGoal}`,
  prints `HUMAN ORDER <from>: suspend <parent> -> run <child>` and logs
  `human_preempt {from, parentGoalId, goalId}`. Kept as reorientations: a **stop**
  order (`isStopOrder`), an order from the same requester, an `EMERGENCY` parent,
  and a chain already `MAX_GOAL_DEPTH` deep (default 3, logs
  `human_order_override`).
- Resume: the post-goal parent block moved **before** the `outcome.error` /
  `!SESSION` exits (a failed, cancelled or errored child still hands the parent
  back) and revalidates first — `goalAlreadySatisfied(parent, obs)`
  (`goalMet(obs, plan, null) && !planIsOpen(plan)`, the same `planIsOpen` guard
  `runGoal` uses for a human order) completes the parent with zero actions and
  logs `goal_resume_satisfied`, else `goalManager.resume(parent.id)` +
  `RESUME <id> (suspended while <child> ran)` + `goal_resumed`. Resume is a
  re-plan from a fresh `observ()`, never a mid-action resume.
- Requester attribution: `reportHumanOutcome(goal, {status, steps, reason})`
  resolves the sender as `goal.humanOrder?.from ?? (source === CHAT ?
  goal.parameters?.from : null)`, so ack and outcome reach the human who sent
  the order that just closed.
- Goal Manager (`goal-manager.mjs`): added `ancestors(id)` / `depth(id)`
  (nearest-first, orphan-safe, cycle-safe) over the existing `parentGoal` field;
  no new status, no second scheduler.
- Evidence: new `tests/controller-goal-stack.test.mjs` (scripted harness) —
  autonomous A → human B (done / failed) → resume A; an emergency inside the
  human order unwinds `RESUME B` then `RESUME A` with the persisted chain
  `E.parentGoal = B`, `B.parentGoal = A`; a parent already satisfied while
  suspended (0 actions, `goal_resume_satisfied`); two consecutive humans each
  with their own outcome; a restart with two suspended goals (child before
  parent); the same-requester revision. 7/7 green.
  `tests/goal-manager.test.mjs` ancestry unit test (13/13). The pre-existing run
  `node --test tests/controller-*.test.mjs tests/goal-manager.test.mjs` stayed at
  112 pass before the new file; the only test touched
  (`tests/controller-chat-ack.test.mjs`, the `chatFromObserve` knob) now lands the
  drop-order case in IDLE, because `drop_item` empties the harness inventory.
- Docs: new [goal-stack](wiki/goal-stack.md) (plus `index.md`/`sources.md` rows
  and cross-links in emergency/human-command/ai-player-roadmap/goal-achievement),
  verification row 63, the open-questions lifecycle bullet, and `MAX_GOAL_DEPTH`
  in `AGENTS.md`.
- Open: startup resume stays flat (no world revalidation — `goalAlreadySatisfied`
  needs a live observation the startup path does not fetch, and
  `tests/controller-session.test.mjs` asserts the current ordering); a
  depth-capped order silently degrades to the old reorientation; no live round
  with a real human yet.

## [2026-10-06] deploy | The day's branches converge on `main`, and `main` goes to the container

The 06/10 work grew on two branches from the same `main` (`60f6572`), while the
container kept running the image deployed at 11:19. Both are closed here.

- **Converged**: `feat/join-human-mount` (`2bdba00`: the mount join, the held
  follow, the goal stack) merged as `52ce925`; `feat/village-discovery-inspection`
  (`4693640`: the village reconnaissance spec and the V0 discovery/inspection
  model) merged as `30f03b0`. One conflict, in `docs/log.md` (both branches
  appended entries after the same point): resolved by interleaving the five
  entries chronologically. `docs/village-recon-roadmap` (`aac821b`) is contained
  in the second merge.
- **Not merged, because superseded**: `fix/bed-access-sight` (`25ddc3b`) — the
  same fix is already in `main` as `ce8582c` (same message, author and time), and
  `main`'s adapter carries its identifiers (`requireLoaded`, `targetCell`,
  `bed_access_unavailable`, `bed_click_obstructed`).
- **Verified before touching the VM**: full suite on the merged tree **1647 pass,
  0 fail** (`node --test tests/*.test.mjs`, 188 s) and `npm run wiki:lint` clean
  (48 files, 697 relative links). Gate: no controller and no client on 3077
  (`ss -tn | grep 3077` empty), only `node bedrock-harness.mjs`.
- **Deploy**: the live image was tagged `hermes-jev-bedrock-rollback-20261006-premerge`
  (`edcddf35eae0`) first; `rsync --checksum` of HEAD to the VM's project copy (a plain copy, not a
  git clone) excluding `.git`, `.env`, `.private`,
  `runs`, `nmp-cache`, `node_modules`, `memory`, `*.sqlite*` and `.pi` (50 files
  updated; `.pi` holds the VM's own Pi goal state and must not be deleted), then
  `docker compose build && docker compose up -d`.
- **Verified after**: the sha256 of `bedrock-adapter.mjs` (`4b2591e7…`),
  `world-memory.mjs` (`c4d0727a…`), `storage-ladder.mjs` (`39cb4da4…`),
  `bedrock-mount-follow.mjs` (`afce4ac7…`) and `controller.mjs` (`fe810124…`)
  inside the container equal HEAD's; `GET /stats` answers (run `demo`, uptime
  44 s); `/observe` shows the bot reconnected in the overworld
  (108.34/-0.38/230.47).
- **What this does not prove**: the container now runs today's *code*, not
  today's features *used live*. The village V0 is a data model with no HTTP route
  and its two unwired steps (the discovery write, the deposit ladder) stay open;
  no live read-only village round ran.
- **Not pushed**: `main` is 151 commits ahead of `origin/main` and stays local —
  nothing was pushed, and the privacy scrub on that history precedes any push.

## [2026-10-06] feat | The bot discovers containers while it walks, and deposits by the ladder (V1+V2)

- **The gap**: `rememberContainer` had exactly one production caller
  (`bedrock-adapter.mjs:7057`, after an open), so a chest the bot merely *saw* was
  not remembered at all and the rung-2 query
  (`world-memory.containersToInspect`) had no source; and the deposit side
  (`_depositTargetFor:7000`) read only the 5-minute runtime cache
  (`CONTAINER_TTL_MS`), so after a restart the bot forgot *which* chest held the
  carrots even though the register still knew.
- **V1 — the write** (`c897399`): `_surveyStorage()` is inherited by the chunk
  sweep (`_rememberDiscoveries`) and throttled by `STORAGE_DISCOVERY_RESCAN_MS`
  (60 s) with radius `STORAGE_DISCOVERY_RADIUS` (32); every storage block in the
  loaded area goes through `_rememberStorageDiscovery()` as a *discovery*
  (`contentsKnown: false`, `source: 'discovered'`), so a sighting is a known place
  with an unknown inside. The live fallback of `_depositTargetFor` calls the same
  writer before choosing a block, so the register learns while the bot works.
  `STORAGE_BLOCKS` is now `storageBlockNames()` — the four base names plus the
  `*_shulker_box` family instead of an exact-name whitelist.
- **V2 — the ladder**: `_storageSearchPlan()` separates the ranking from the write
  (`memory.containersWithItem` + `containersToInspect`, decorated with distance and
  reachability) and calls `planStorageSearch` in `storage-ladder.mjs`.
  `_depositTargetFor` returns `rung`, `step`, `verify`, `stale`, `remembered` and
  the full `ladder`: remembered-with-the-item → discovered-not-inspected →
  runtime cache → live scan (which becomes a discovery). A stale inspection is
  re-read on arrival by the open; a remembered target that fails to open falls
  back **once** to a live container (`retriedAfterStale`), never on
  `missing_item`. `observe().deposit` exposes the rung without walking and
  `observe().storage` the register (known, to-inspect, last survey).
- **Tests**: 10 new cases in `tests/bedrock-storage-memory.test.mjs` (the target
  after a simulated restart, the stale re-read, rung 2, the live scan learning the
  sighting, an unreachable target blocked, the survey throttle with the
  `observe()` shape, the single fallback, no fallback on a missing item). The
  scan-cap test in `tests/bedrock-storage.test.mjs` now asks the matcher how many
  names there are instead of hardcoding four. Full suite **1657 tests, 0 fail**.
- **Still open**: the bounded sweep (`survey_village`, rung 4) and the farm-order
  classifier (V3) stay spec; the four-case live row ("find the iron in the
  chests") has not run — see [open-questions](wiki/open-questions.md) and
  [village-recon](wiki/village-recon.md).

## [2026-10-06] deploy | V1+V2 reach the container, and the ladder shows up live

- The container `hermes-jev-bedrock` was found **stopped** (`Exited (0)`, clean
  shutdown in the log: "Disconnecting bot and waiting for NetherNet teardown /
  world memory saved"), and its code did not coincide with `1388000`
  (`bedrock-adapter.mjs` was still the previous deploy's `4b2591e7…`), so the
  deploy was warranted.
- `rsync --checksum --delete` moved 6 files whose content differed
  (`bedrock-adapter.mjs`, `tests/bedrock-storage-memory.test.mjs`,
  `tests/bedrock-storage.test.mjs`, the three docs) with no deletions;
  `docker compose build && docker compose up -d` recreated the container.
- Verified inside the container: `bedrock-adapter.mjs`
  `95832b12fac231b099236644b92bdb14eca9cbde9c6d92c03f207b256f798bf8`,
  `world-memory.mjs` `c4d0727a…`, `controller.mjs` `fe810124…`, `docs/log.md`
  `3c9923a4…` — all equal to HEAD; API on `127.0.0.1:3077`, bot joined on the
  first attempt.
- **First live proof of the new path**: at startup `_surveyStorage()` scanned 26
  storage blocks and wrote 26 discoveries; `observe().storage` reports
  `known: 0`, `toInspect: 16` (nearest a chest at 92,73,165,
  `discoveryStale: false`) and `observe().deposit.target` already walks the
  ladder — rung 2, `step: "inspect"`, `reason: "discovered_not_inspected"`.
  The four-case live row in [open-questions](wiki/open-questions.md) is now the
  next thing to watch.

## [2026-10-06] spec | The sweep splits its budgets, and protection becomes a global invariant

- Rung 4 (`survey_village`) had one cell budget and one throttle. The design now
  separates **three** limits because a cell count is not a cost:
  `VILLAGE_SURVEY_MS` (600000) is the **cooldown** between two sweeps and never
  bounded one sweep, `VILLAGE_SURVEY_CELLS` (4096) is the **exploration** budget
  and `VILLAGE_SURVEY_MAX_MS` (120000, first-pass value to be tuned by the first
  live run) is the **execution** budget — pathfinding, detours, chunk loading and
  obstacles make 4096 cells cost very different amounts of wall clock, so neither
  budget implies the other. Termination is deterministic: the first limit reached
  stops the sweep, which reports `stoppedBy` (`"cells"` / `"time"` /
  `"distance"`) next to `truncated`.
- **A refusal is not a truncation.** `truncated: true` describes the census that
  *was* returned; `village_too_far` / `survey_budget_exhausted` are **action
  results** meaning the mission could not proceed at all. Hermes reasons on
  fields, never on strings.
- **`DIG_PROTECTED` is a global invariant**, not survey logic: a sweep may detour
  or fail but never modify the world to reach a cell — villages, beds, farmland,
  fences and crops stay intact, and "just this one block" is not in the contract.
  Villages and structures carry persistent state (beds, jobs, trades, mob
  behaviour) that is not sacrificial terrain.
- **The property that carries the milestone** is "a second sweep over an already
  scanned ring plans zero movement": it proves persistence, `visitedChunks`,
  frontier planning and idempotence at once. The test list now adds a **restart
  between the first and the second sweep**, so that idempotence cannot come from
  RAM state.
- Scope frozen for the implementation: no biome heuristics, no "intelligent"
  village search, no `/locate` — a command that hands over a position would skip
  exactly the observation this roadmap exists to produce.

## [2026-10-06] spec | Rung 4 is the exploration capability, specialized

- The bounded sweep is not a village-only engine: it is the general
  **Autonomous Exploration & Discovery** capability (`GOAL_EXPLORATION.md`, the M1
  "find a biome" vertical slice in `exploration.mjs`) pointed at a village. The
  spec now names the one-to-one mapping instead of describing a second engine:
  deterministic spiral over unexplored cells
  (`exploration.mjs:53`/`:68`/`:106`), persistent visited state
  (`world-memory.mjs:581`/`:618`/`:631`), mission + checkpoints + route replay
  (`world-memory.mjs:777-911`, `replayRouteFromMission:251`), pause/resume/restart
  (`POST /explore` supersedes stale `running` missions), bounded execution and
  progressive structure discovery.
- The **reuse contract** is explicit: V1 adds a *configuration* of the existing
  planner (anchor, spiral radius, three limits) and a *consumer* at the end (the
  V0 census), plus the budget bookkeeping (`truncated`/`stoppedBy`, typed
  refusals). It must not add a second frontier/spiral, a second visited-chunk
  bookkeeping, a second checkpoint format or a second "mission exhausted"; a
  behaviour the general planner lacks (e.g. a radius-bounded spiral) goes into
  `exploration.mjs`, where the biome and `find_structure` searches get it too.
  `survey_village` is a door to rung 4, not *the* door: any later "explore this
  area" order is the same planner with a different target and census.
- **Structure evidence is graded**, so the census carries
  `detection: { state: NOT_FOUND | CANDIDATE | CONFIRMED, evidence: [...] }`:
  `CONFIRMED` needs the markers `structures.mjs` scores, `CANDIDATE` is a stored
  lead, `NOT_FOUND` is a scanned, empty cell. This is the vocabulary that makes
  `/locate` obviously out of scope — a command would hand over a position with no
  evidence, inverting the order the register exists to record.
- Also fixed a stale line reference: `unexploredFrontier` is
  `world-memory.mjs:631`, not `:512`.

## [2026-10-06] feat | The sweep planner is anchored, pure and reproducible (rung 4, milestone 1)

- `exploration.mjs` gains `planExplorationSweep({ anchor, visited, spacing,
  maxRadius, cells, radius })` and `SWEEP_STOP` (`cells` / `radius` /
  `exhausted`): the M1 spiral, bounded by an **anchored** geometric limit and a
  cell budget, returning the ordered waypoints (`{ x, z, distance }`) plus
  `next`, `truncated`, `stoppedBy`, `boundary.pendingBeyond` and `remaining`.
- **The bound is geometric and anchored.** `distance` is measured from the
  anchor, never from the bot, and the planner takes neither the clock nor the
  current position as input — `(anchor, visited, config)` reproduces the same plan
  and the same stop cause after a serialise/reload, which is the acceptance
  criterion of this milestone. `time` stays an executor-side stamp, because a
  clock in the plan would make the same state produce different answers.
- **No second spiral.** The planner shares `spiralOffsets`/`chunkKey` with
  `nextExplorationWaypoint`, and a test pins the equivalence (`cells: 1`,
  `radius: null` → the same next waypoint as the single-step planner), so
  `find_biome` and `find_structure` inherit whatever this gains instead of
  growing a parallel path.
- `tests/exploration-sweep.test.mjs` (9 offline cases): determinism and
  serialise/reload, anchor-relative bound (the diagonals outside the radius stay
  out), the cell budget, an exhausted spiral, a radius stop carrying
  `pendingBeyond`, the spiral order preserved, `visited` as a `Set`, and
  `no_anchor` as a refusal rather than a truncated census. The four exploration
  test files: 32 tests, 0 fail.
- Next, in the order approved: the village census (`village-survey.mjs`), then
  `survey_village` as a configuration of this planner, then the action-level
  tests and the live row. The spec now uses `radius` where it used to say
  `distance` (the old name was ambiguous: travelled distance, or from the bot?),
  and says explicitly that `time` is stamped by the executor.

## [2026-10-06] feat | The village census is pure, and the sweep is a configuration of the planner

- New `village-survey.mjs`: `surveyVillage({nearby, farmAnimals, beds,
  containers, anchor, dimension, scanned, limits})` → `{checked, anchor, houses,
  plots, pens, storage, missing, detection, counts, survey}`. Pure and
  deterministic (no I/O, no clock): the same observation gives the same census,
  including through a shuffled input. Houses are bed clusters with their own
  containers and doors; plots carry `{crop, seed, cells, ready, immature,
  unknown, center}`; pens count adults/babies and say whether a fence stands
  within `VILLAGE_PEN_RADIUS` (12); storage is ordered from the anchor and keeps
  `contentsKnown`, so an unopened chest reads `contains: null` — *a known place
  with an unknown inside* — instead of a missing fact.
- **The detector is reused, not copied.** `structures.mjs` splits into
  `structureRows({survey, entities})`, `scoreStructure(def, {blockRows,
  entityRows, dimension})` and `scoreStructures({survey, entities, dimension,
  defs})` (every verdict, including the sub-threshold ones) with
  `detectStructures` keeping its exact output (`tests/structures.test.mjs` 6/6
  before and after). `village-survey.mjs` feeds that same rule, so
  `NOT_FOUND`/`CANDIDATE`/`CONFIRMED` and the `missing` list cannot drift from
  `GET /observe.structures`. `checked: false` with `detection.state: null` says
  *nobody looked*, which is not `NOT_FOUND` (*looked and empty*).
- **`survey_village` is a configuration of the general sweep, not a second
  engine.** `villageSweepConfig({anchor, radius = 48, spacing = 24, visited})`
  (in `village-survey.mjs`) returns exactly the input of
  `planExplorationSweep`: the detector's anchor, `maxRadius` **derived** as
  `floor(radius / (spacing * √2))` (so no waypoint is ever planned outside the
  bound and the assigned area closes with `stoppedBy: 'exhausted'`), `cells:
  null`, and `visited` as an **array** so the configuration survives
  `JSON.stringify`. `VILLAGE_SURVEY_CELLS` bounds the *blocks* one waypoint's
  census may scan (`surveyVillage`'s `limits.maxCells`), while the planner's
  waypoint budget is the spiral itself: two budgets, two facts, pinned by a
  test.
- `tests/village-survey.test.mjs` (13 cases) and `tests/village-sweep.test.mjs`
  (7 offline cases): the key set the planner receives, the anchor as the first
  waypoint, a JSON serialise/reload giving the identical plan, array vs `Set`,
  `visited` shrinking the plan instead of moving it, no waypoint beyond the
  bound, the `no_anchor` refusal — plus empty input vs looked-and-empty,
  candidate vs confirmed, two houses each with its own container, occupancy
  enrichment without double-counting, `unknown` maturity never guessed, crops
  that never merge, and determinism under a shuffled input.
- Still open on V0/V1: `GET /observe.village`, the memory-first read
  (`villageRegister`), the `VILLAGE_PLOT_MIN_CELLS` threshold (cells are
  reported now, the threshold is not applied), the `survey_village` action and
  the four-case live row.

## [2026-10-06] feat | The village census reaches a client, and its scan has no name whitelist

- **Two inputs the detector wants and the pens must not receive.**
  `surveyVillage` gains `entities` and `survey`. `entities` is the detector's
  entity evidence (`observe().entities`, villagers included) and is a *different
  list* from `farmAnimals`, which lives in the pens: the live path fed the
  livestock to `detectStructures`, so a real village could never reach
  `CONFIRMED`. `survey` is the executor's own `surveyBlocks().names` histogram,
  merged into the census histogram: its **counts** cover the whole radius while
  the cell lists are capped per name, so the verdict, the `evidence` numbers and
  the anchor stay identical to `GET /observe.structures` while `counts` keeps
  describing the cells the census could actually cluster. `withBeds` now
  *enriches* (`observe().bed` adds `occupied`) instead of replacing the bed
  cells: a capped bed list must never shrink a census.
- Pure exports that make the scan possible without a whitelist:
  `villageCensusNames(surveyed)` returns `bed` + `CROP_BLOCKS` + the names the
  survey says are fences (`isVillageFenceName`, `VILLAGE_FENCE =
  /fence|_wall$/`), deduplicated and ordered — the fence family is **discovered**
  from the histogram. `CROP_BLOCKS` is now exported by `bedrock-survival.mjs`
  instead of being private, `cellKey` and `triState` keep the pure code free of
  nested ternaries.
- Adapter: `_villageCells({point, radius = STRUCTURE_RADIUS, limit})` runs one
  `world.surveyBlocks` pass to learn which names exist and then
  `world.findBlocks(name, point, 48, VILLAGE_CELL_CAP)` (64) for `bed`, the crops
  and those fences, reading maturity per cell via `cropMaturity` with a
  live-column fallback — unreadable stays `null`, never guessed. A name that hits
  the cap is declared in `blocks.cappedNames` (`blocks.capped: true`): that count
  is a lower bound, not a measurement. `_villageView({force, limits})` memoizes
  the census for `VILLAGE_RESCAN_MS` (60000) and publishes it as
  `observe().village` and `GET /observe.village?force=1`, adding `at`, `origin`
  and `blocks` to the pure payload.
- `observe().nearby` is a **sample**, not a census: it is built with
  `findBlocks(name, position, 96, 4)`, four cells per name, while the live village
  holds thirty beds. So the read path does not read it, and
  `tests/village-view.test.mjs` (6 adapter cases, no server) leaves it empty on
  purpose: cells come from the world, the detector reads the villagers while the
  cattle is a pen, memoization answers without re-reading while `force` re-reads,
  the per-name cap is declared (70 beds ⇒ `cappedNames: ['bed']`, `counts.beds:
  64`), the register arrives with both states ordered from the anchor, and an
  adapter with nothing to read says `checked: false, state: null`.
- `tests/village-survey.test.mjs` grows to 16 cases: `entities` is the detector's
  evidence and `farmAnimals` are the pens, a world survey keeps the counts (the
  evidence can read `beds 30` while `counts.beds` stays 2 and the anchor comes
  from the survey), and a capped bed list enriches without shrinking (six beds
  stay six). Full suite **1694/1694**, `npm run wiki:lint` clean.
- Still open: the `survey_village` action (rung 4) and the four-case live row, the
  memory-first read (`villageRegister`) and the `VILLAGE_PLOT_MIN_CELLS`
  threshold.

## [2026-10-06] feat | The village sweep becomes an action, and remembers what it censused

- `survey_village` lands in `bedrock-adapter.mjs` as a *configuration* of the
  general planner, never a second engine: `_surveyVillage` (`:1514`) plans with
  `planExplorationSweep(villageSweepConfig({ anchor, visited }))`, walks each
  waypoint with `_moveTo` and re-reads the census at every stop with
  `_villageView({ force: true, limits: { maxCells: budget } })`, debiting the cell
  budget by what each look actually read. Offered in `options()` (`:4654`, guarded
  by a known anchor and an expired cooldown) and dispatched at `:5461`.
- Three independent limits, the first one reached wins: `VILLAGE_SURVEY_MS`
  (600000) cooldown, `VILLAGE_SURVEY_CELLS` (4096) exploration budget,
  `VILLAGE_SURVEY_MAX_MS` (120000) execution budget, `VILLAGE_SURVEY_MAX_DISTANCE`
  (256). Running out returns `ok: true` with `truncated: true` and `stoppedBy:
  'cells' | 'time' | 'exhausted'`; a mission that cannot start refuses with a
  typed code (`village_unknown`, `village_too_far`, `survey_cooldown`) and writes
  nothing. `DIG_PROTECTED` remains an invariant: the sweep may detour or fail,
  never modify the world.
- Idempotence is the register's, not the RAM's: `world-memory.mjs` gains
  `villageSurveyId`, `rememberVillageSurvey` (`kind: village_survey`, `cells` =
  censused chunk keys, `censuses` counter) and `villageSurvey`, and
  `_villageVisited` (`:1498`) reads it back only when the record sits within
  `VILLAGE_MEMORY_RADIUS` (8) blocks of this anchor. `visitedChunks` is
  deliberately **not** the sweep's `visited` — the chunk index records travel, and
  a village is detected by walking through it, so travel-keyed idempotence would
  make the first pass plan nothing.
- Only a *reached* waypoint is marked censused: the register may under-claim,
  never over-claim, so a truncated or blocked pass still records what it reached
  and the next pass resumes there.
- `tests/village-sweep-action.test.mjs` (9 cases, no server) replaces `_moveTo`
  with a logging walk: completed pass, cell budget, time budget, blocked waypoint,
  second pass planning zero, restart with fresh RAM, another village's cells, the
  three refusals, the option's guards. Full suite **1703/1703**.
- `docs/raw/VILLAGE_RECON_ROADMAP.md` V1 records the landed codes, the
  `village_survey` record, `VILLAGE_SURVEY_MAX_DISTANCE` and the `visitedChunks`
  deviation with its reason; `docs/wiki/village-recon.md` gains "the V1 sweep
  action — a census on legs".
- Still open: the farm-order classifier (V3), the memory-first read
  (`villageRegister`), the `VILLAGE_PLOT_MIN_CELLS` threshold and the four-case
  live row.
## [2026-10-06] feat | The farm order is a chain, and it closes on a delta

- `farmOrderFromText` (`controller-decisions.mjs`, pure, next to
  `isDropOrder`/`isEquipOrder`) classifies the order that started this roadmap:
  a crop token plus a farm verb emits
  `plan.farm = {crop, block, seed, word, replant, store, field}` instead of being
  read as a pick-up-from-the-ground. It returns `null` — the order stays with
  the planner — when a number is present ("raccogli 4 carote"), when the verb is
  `cattura` and when the token is not a crop. `ITEM_WORDS` now knows carrot,
  wheat and beetroot in all five languages (accent-free patterns, because
  `normalizeForMatching:321` strips them).
- The ambiguity is settled by evidence, not by wording: the farm branch sits
  before the collect branch in `humanCommandPlan` and defers to it only when a
  drop of *that* crop is really on the ground. A crop named in front of a field
  is never a `no_drop` refusal and never an LLM call.
- `farmStep(farm, obs, options, {progress, maxHarves})` picks one step per
  decision: `collect_drop` → `harvest_<block>` (offered by the harness only with
  a ripe reachable crop, capped by `DEFAULT_FARM_MAX_HARVES = 8`) →
  `plant_<seed>` (only after a harvest that reported `replanted.ok !== true`, so
  an order never seeds the whole village) → `deposit_<crop>` / `dump_inventory`.
- The chain closes on a **delta**: `farmSnapshot` records the crop held and the
  crop already in known containers at plan time, `farmStored` sums
  `observe().containers` ∪ `observe().storage.known` deduplicated by position,
  and `farmFulfilled` = "the container grew and the backpack did not". A `null`
  step closes the goal — "nothing to do" before any work, a measured outcome
  (`produce_stored` / `produce_not_stored`) after it.
- The food reserve no longer holds the harvest hostage:
  `_depositableItems({reserve, exempt})` exempts `plan.farm.crop` by default and
  the deposit section of `options()` offers that crop even though `_isValuable`
  does not match it — the offer and the action that executes it read the same
  rule. `farmOptionKeys` joins the protected keys of `/options`, because
  `plant_*`, `deposit_*` and `dump_inventory` carry intent `unknown` and an
  emergency would otherwise hide the steps the human asked for.
- `tests/controller-farm-order.test.mjs` (10 cases) covers the classifier, the
  step order (carrots in the backpack with no drop ⇒ `harvest_carrots`), the
  cap, the delta gating, the two-source dedupe and the adapter's exemption.
  Full suite **1713/1713**.
- `docs/raw/VILLAGE_RECON_ROADMAP.md` V3 gains its landed block and the plan
  field's real shape (`block`, `seed`, `word`, `store: null`, `before`);
  `docs/wiki/village-recon.md` gains "the farm order, a chain that closes on a
  delta". Gap 2 is closed on both halves.
- Still open: V4 (honesty, protection), the four-case chest ladder and the
  farm-order A/B on the host, plus the memory-first read (`villageRegister`) and
  the `VILLAGE_PLOT_MIN_CELLS` threshold.

## [2026-10-06] feat | The census says how much it read, and a village bed is finally protected

V4 of [`docs/raw/VILLAGE_RECON_ROADMAP.md`](raw/VILLAGE_RECON_ROADMAP.md) — the
honesty, protection and limits layer of the village reconnaissance. A census
that guesses is worse than a census that says nothing, because once the guess is
in the payload it is indistinguishable from a measurement.

- **Confidence is the read share, not an adjective.** Every house, plot, pen and
  storage row in `village-survey.mjs` carries `confidence` (`shareOf(known,
  total)`, `null` when the denominator is 0), `evidence` (the numbers that
  produced it: `{beds, doors, containers}`, `{cells, ready, immature, unknown}`,
  `{animals, adults, babies, fenced}`) and `missing` (a named hole: `occupancy`,
  `door`, `container`, `ripeness`, `fence`, `contents`). A house with one unread
  bed out of two is `0.5` with `missing: ['occupancy']`, never "a free bed
  exists". `detection.confidence` reuses the detector's own formula
  (`structures.mjs:226`), so a `CANDIDATE` verdict carries a number below 0.5
  instead of a fake 1.
- **Below threshold is absent *and visible*.** A crop cluster under
  `VILLAGE_PLOT_MIN_CELLS` (now applied in the census, and overridable from the
  adapter with the `VILLAGE_PLOT_MIN_CELLS` env var) produces no plot, and the
  dropped clusters are counted in `ignored.plots`; an animal without coordinates
  is `ignored.animals`, a storage row without a position `ignored.containers`.
  Without `ignored`, "seen and below the threshold" would look exactly like
  "never looked at".
- **`checked` and `scanned` cannot contradict the payload.** `checked` is now
  `observed || scanned > 0` (at least one cell, animal or storage row means the
  payload reports something, therefore somebody looked), `survey.scanned` is
  `max(scanned, cells)`, and a payload nobody looked at names **no** `missing`
  marker: a hole is relative to a measurement. The payload also carries
  `thresholds` (the clustering rules) and `limits` (radius, per-name cell cap,
  rescan throttle, survey radius, maximum distance), so "how much does this map
  cover" is answerable from the data.
- **Unknown contents is not an empty chest.** `contentsKnown: false` is
  `contains: null`, `confidence: 0`, `missing: ['contents']`; a stale item stays
  usable only through `planStorageSearch`, which answers `verify: true` — the
  ladder orders the walk, it does not license belief.
- **A protection bug, found by the new test.** `DIG_PROTECTED` matched beds with
  `_bed$` while the Bedrock block is named plain `bed`: a village bed was
  diggable. It is now `(^|_)bed$` (`bedrock-adapter.mjs:98`), which covers `bed`
  and the Java-style `oak_bed` and leaves the crop exemption at `:9145` intact
  (a *mature* crop must stay breakable or `harvest_<block>` could not work).
  `farmland$`, `_fence$` and the crop names already covered the rest.
- `tests/village-honesty.test.mjs` (14 offline cases) fixes all of it: a payload
  that reports data is never `checked: false`; a payload nobody looked at claims
  nothing; "looked and empty" names every rule below its `min`; confidence is
  the read share for plots, houses and pens; unknown contents is not an empty
  chest; a sub-threshold cluster is absent and counted; the thresholds travel; a
  stale memory is used only with `verify: true`; no key returned by
  `farmOptionKeys` (nor any source line of the census) is destructive; and
  `farmland`, `bed`, `oak_fence` and an immature `carrots` all stop `_digTargets`
  with a typed `protected_*` error, while the chain still breaks the ripe crop
  it harvested and never the farmland underneath it.
- `tests/village-survey.test.mjs` (16 cases) and `tests/village-view.test.mjs`
  (6 cases) were extended for the new fields; the full suite is **1727 pass / 0
  fail**. [`docs/wiki/village-recon.md`](wiki/village-recon.md) gains "honesty,
  protection and the limits of the map".
- Still open: the live rounds — the farm-order A/B and the four-case chest
  ladder — plus the memory-first read (`villageRegister`).

## [2026-10-06] docs | Document the village recon end to end, from the bedrock notes to the collaudo

- `BEDROCK.md` gains the `survey_village` row in the "Bedrock action status"
  table (a bounded read-only sweep whose geometry is a configuration of the
  general planner, three independent limits, three typed refusals distinct from
  `truncated: true` + `stoppedBy`, a `village_survey` register for idempotence,
  never digging and never touching an entity, `DIG_PROTECTED` as a global
  invariant) and a new section "Village reconnaissance and the farm order
  (update 06/10/2026)" that explains the two census inputs, why villagers are the
  detector's evidence while livestock belongs to the pens, the memoised read
  (`VILLAGE_RESCAN_MS`, `?force=1`), the honesty fields, the `plan.farm` chain
  and the open live rows. The "Crop cycle" and "Still not implemented" bullets
  were corrected: ripeness is read per cell (`cropMaturity`) and `milk_<animal>`
  is implemented (only a *scheduled growth estimate* is still unmodelled).
- [verification](wiki/verification.md) rows **47.54–47.57** add the collaudo for
  the four landed slices (the village register, `survey_village`, the farm-order
  chain, honesty + the `bed` protection bug), each with its offline evidence and
  its residual live round.
- [memory](wiki/memory.md) documents the two-fact container model
  (`discoveredAt` vs `inspectedAt`/`contentsKnown`, the four states derived by
  `describeContainer`, the stale verdicts computed on read with no periodic
  `refreshStatuses()`, the throttled discovery pass `_surveyStorage` /
  `_rememberStorageDiscovery`) and the `kind: village_survey` register
  (`rememberVillageSurvey` / `villageSurvey`, chunk keys merged across passes,
  the caller verifying the distance from the anchor).
- [roadmap](wiki/roadmap.md) item 10 now records that the village side of M5/M6
  grew into its own spec (V0–V5 landed, offline-tested) and that only the live
  rows are open; [open questions](wiki/open-questions.md) no longer describes
  `survey_village` as spec — it lists what the first live rows must show, for the
  sweep, the census read and the farm order alike.

## [2026-10-07] feat | A human can teach the bot a fact, and the fact says who said it

The chat channel could answer questions and execute orders; a fact about the
world — «ricordati che il ferro sta nel baule a 120, 64, -230», «l'ingresso
principale della miniera sta a…», «il punto dove mi trovo adesso è il campo di
patate» — had no way in: the memory's producers were all the bot's own sensors.
M10 adds the missing direction, and it adds it *without* collapsing the one
distinction that matters: **a fact that was said is not a fact that was seen.**

- `world-memory.mjs` gets a provenance (`TOLD_SOURCE = 'told'`), the teller
  (`toldBy`/`toldAt`) and `permanent: true` for a place a human named. A named
  place has **no TTL** — `markStaleBefore({keepPermanent: true})` skips it,
  because nobody re-visits a mine entrance by accident and time alone is not
  evidence that it moved; a *container* a human names is not permanent, and its
  position ages like any other chest.
- The four operations are methods, not routes: `rememberToldPlace` /
  `tellPlace` (create **or** correct: repeating a name at another position is a
  correction, not a duplicate), `correctToldPlace` (same `id`, the old position
  in `history[]`, and the **provenance kept** — a human correcting a place the
  bot had discovered does not turn that discovery into a told fact),
  `resolvePlace`/`placesForName` (`action: 'ambiguous'` with the candidates: the
  code never resolves a name by distance) and `forgetPlace` (`status:
  'invalid'`, never a delete — out of search, answers and navigation by default,
  still in history).
- A chest's content is the one case where the model had to change shape.
  «Nel baule c'è del ferro» does not mean knowing the inventory, so
  `claimToldContents` writes a *discovery* of the chest (`contentsKnown: false`,
  `source: 'told'`, the human `label`) plus a **claim** in the observation log
  (`predicate: 'claimed_contains'`, `data: {count, toldBy, partial: true}`) —
  never `contents`, never `contentsKnown: true`, and never at the cost of an
  inventory the bot had already read. `claimsFor` derives the verdict from the
  *reading*: `unverified` (not re-read since the claim), `confirmed` (a later
  read found it), `contradicted` (re-read and it was not there), `stale` past
  `toldClaimStaleMs` (7 days). `whereToFind` ranks an observed reading above a
  claim and never offers a contradicted one.
- `memory-chat.mjs` reads the sentence — a pure module, no network, no model,
  five languages. `toldIntentFromText(text, {sender, names})` returns an intent
  or `null` (not a memory order → the ordinary chat flow), with the branch order
  FORGET → CORRECT → REMEMBER → GOTO → CONSULT. Two decisions are worth
  recording: **coordinates need an explicit marker** (a bare run of numbers must
  not become a waypoint: «ricorda che ne ho 120»), and the rewriting is done on
  **tokens** (`analyze`/`drop` mark the tokens a match starts inside), which is
  what stops the final "a" of "ricorda" from being read as a preposition and
  what lets accented letters survive. A deictic («questo», «il punto dove mi
  trovo») needs the sender's live position; without one the answer is a question
  (`no_sender_position`) and nothing is written.
- `bedrock-harness.mjs` exposes the write path (`POST /memory/tell/place`,
  `/container`, `/contents`, `/forget`; `GET /memory/places`, `/where`,
  `/claims`) behind `TOLD_FACTS`, so the chat channel and a future console call
  the same operations instead of reimplementing them.
- `controller.mjs` gains `handleToldFact` inside `maybeHumanCommand`, after the
  dedup and **before** `resolveQuestion`. It answers (write / answer /
  clarification) and returns `true` — remembering, consulting, correcting and
  forgetting never interrupt the running goal — or a plan, only for the movement
  order: «vai al campo di patate» is a normal order to the remembered position
  (`deterministic: 'told_goto'`, no model call), with the usual preemption and
  resume. An escort phrased with a remembered name stays an escort, and a name
  the memory does not know goes back to the ordinary path. Every reply is
  composed from the catalogue (22 new `told_*` keys in `chat-lang/{it,en,fr,es,de}.mjs`),
  addressed to the sender like the other replies, and states the recorded value
  («Registrato: campo di patate a 120, 64, -230, Overworld») — the LLM is not
  involved, so a number cannot be rephrased into a different number.
- Three bugs were found by the tests and fixed: a label arriving on a chest the
  bot had already read was dropped (the container was only written when it did
  not exist), the told reply was not addressed (and `{name}` was overwritten by
  the sender's name, so an ambiguous answer said *«ho 2 posti chiamati "Ale"»*),
  and the container phrase in Spanish kept the verb inside the name
  (*«cofre de hierro esta»*).

**Evidence.** `tests/memory-chat.test.mjs` (10: the three original phrases, the
negatives, the bounds, the formatting), `tests/memory-told.test.mjs` (22: the
owner's matrix — persistence, the sender's position, a partial claim that
cannot erase an observed inventory, ambiguity, correction, invalidation, the
differentiated TTL, navigation by name — over both backends) and
`tests/controller-told-facts.test.mjs` (6: chat integration against a scripted
harness, `tell_place` with the live sender position, clarify with no sender,
consult with provenance, ambiguity, `told_goto` with no write, memory
unavailable). Suite: 1815 pass, 0 fail. **Not yet exercised against a live
BDS**; the raw reference is [TOLD-FACTS](raw/TOLD-FACTS.md), the wiki sections
are [memory](wiki/memory.md#told-facts-what-a-human-said) and
[human-command](wiki/human-command.md#told-facts-m10-the-human-teaches-the-bot-remembers),
and the residual rows are in [open questions](wiki/open-questions.md).

## [2026-10-07] feat | Told facts: the writes pass the sender gate, and a repeated fact writes nothing

Closing pass on the M10 told facts (the commit below is the one amended with
this): three things were missing or wrong at the edges, and the HTTP path got
its first live exercise.

- **The write routes now pass the same gate as the orders.** A dictated fact
  *is* an order a human gives, so a `POST /memory/tell/*` whose `toldBy` is
  outside `CHAT_ALLOWLIST` (when that variable is set in the harness
  environment too) answers `403 {error:'told_sender_not_allowed', toldBy}`. A
  write with **no** `toldBy` is not a human order — a local console or
  maintenance call — and stays possible: the API is in loopback and the chat
  gate lives in the controller, this is a second wall for the writes that claim
  «tizio me l'ha detto». Verified live: `toldBy: 'Mallory'` → 403, `'Ale'` → the
  place is written, no `toldBy` → written.
- **Repeating a fact is not correcting it.** `tellPlace` resolved the name,
  found the place and called `correctToldPlace` unconditionally, so the most
  common sentence — the human saying the same thing again, not knowing they
  already said it — appended a history row for an identical fact (seen live:
  two POSTs of «campo di patate a 120, 64, -230» gave `historyCount: 1`). Now a
  phrase whose position, dimension and name match what is stored answers
  `{action: 'unchanged'}` and writes nothing; a *different* label on the same
  position is still a real correction. The chat confirms (`told_place_ack`) and
  the correction branch no longer mistakes `unchanged` for «non conosco il
  posto» — that regression is pinned by a new integration case.
- **The index follows a correction (measured, not assumed).** After
  `POST /memory/tell/place` moved the place 120,-230 → 900,-900, a live
  `GET /memory/search?q=campo di patate` returned the same `id`
  (`campo_di_patate_120_64_-230`) at the **new** position. Worth writing down:
  the id is an identity, not a location — it keeps the slug of the first time —
  so a position is always read from the record.

**Evidence.** New cases: `tests/memory-told.test.mjs` 22 → 24 (the repetition
property over both backends, and the rename-is-a-correction counterpart) and
`tests/controller-told-facts.test.mjs` 6 → 7 (an `unchanged` correction answered
with the confirmation). Full suite: 1840 pass, 0 fail. Live HTTP round on a
harness without a Minecraft server (`MEMORY_DIR` in a temp dir):
create → restart → find again, correct (same id, `historyCount` 1),
search after the correction, forget → out of `/memory/places`, allowlist
refusal. Docs touched: [TOLD-FACTS](raw/TOLD-FACTS.md),
[memory](wiki/memory.md#told-facts-what-a-human-said),
[human-command](wiki/human-command.md#told-facts-m10-the-human-teaches-the-bot-remembers)
§M10, [verification](wiki/verification.md) 47.58–47.59,
[open questions](wiki/open-questions.md#told-facts-2026-10-07--live-over-http-the-in-game-chat-round-still-open),
`AGENTS.md`, `BEDROCK.md`. The live **in-game** round is still open.

## [2026-10-07] deploy | Told facts live on the production harness (`c70acc5`)

Requested after the push: deploy the feature live. The production runtime on VM
100 (`hermes-jev-bedrock`) matched `main` (`3c6122e`) file for file before the
deploy — the md5 of `bedrock-harness.mjs`, `controller.mjs`, `memory-store.mjs`,
`sqlite-memory.mjs`, `world-memory.mjs` and `chat-lang/{it,en,fr,es,de}.mjs` was
identical in the container and in the committed base — so the branch could be
laid down as a **targeted deploy** rather than a rebuild. `git archive`-style
tree transfer of the eleven changed files (tarball 118840 byte, sha256
`38c5dab0ab494f5aa979d5ab8a2d2f2cf43568a555176d8e645dc03a36ea48de`, served from
the Proxmox host on port 8099), applied to both places the runtime lives: the
container's `/app` (`docker cp` + `node --check` on all eleven files) and the VM
source tree the controller mounts as `/app/project`. md5 host = container = VM
tree for all eleven. Backups
before touching anything: `/tmp/hermes-jev-bedrock-pre-c70acc5.tar.gz` (source
tree, `.git`/`node_modules`/`runs`/`nmp-cache` excluded) and
`/tmp/app-pre-c70acc5.tar.gz` (the nine replaced files out of the container).

`docker restart hermes-jev-bedrock` (nothing else: the container's `/app` is not
a bind mount, only `runs` and `nmp-cache` are). The restart alone did **not** let
the bot in — `[connect] attempt 1..3 failed: connecterror:9` with the discovery
answering `protocol 2193 / 1.26.52` — the known NetherNet failure, and the
remedy that worked was the documented one: `pct exec 108 -- systemctl restart
minecraft-bedrock` (the usual `rc=1` from the startup-check, systemd restarted
it, `Started Minecraft Bedrock Server.`), after which the bot went in at attempt
6 then attempt 1 of a later reconnect and BDS reported `players: 1`.

Live round against the real world memory, bot connected, **no controller**
(none was running before or after): the four writes and three reads behind
`TOLD_FACTS`, all with `toldBy: 'Ale'`:

- `POST /memory/tell/place` «campo di patate» at 92/74/169 → `created`,
  `source: 'told'`, `permanent: true`, `historyCount: 0`; `GET /memory/places`
  finds it by name; the **same phrase again** → `unchanged` and still
  `historyCount: 0` (the last branch of the feature, exercised live);
- the same name at 130/70/-240 → `corrected`, **same id**
  (`campo_di_patate_92_74_169` — the id is identity, not position), position
  moved, `historyCount: 1`, `previous` carrying the old position and `toldAt`;
- `POST /memory/tell/contents` of 5 iron on a chest the bot had **already read**
  (91/73/160, 411 iron observed) → the container keeps `source: 'discovered'` and
  `permanent: false`, gains the label «baule di casa» and a separate claim
  `verdict: 'unverified'`; `GET /memory/where?item=iron_ingot` still answers the
  **observed** 411 for that chest, and the claim is readable through
  `GET /memory/claims?containerId=container_91_73_160` — a human's statement did
  not overwrite what the bot had read;
- **persistence after restart**: the container was restarted again and the
  corrected place (with its history) and the claim were both still there;
- `POST /memory/tell/forget` → `status: 'invalid'` with `previous` returned,
  out of `GET /memory/places`, still readable with `includeInvalid=1` —
  invalidated, never deleted;
- governance sanity after the deploy: `GET /options` → 25 keys, `GET /survival`
  → `normal` (the harness's own paths are intact with the new code).

Two test artefacts were left in the production memory and are disclosed rather
than silently cleaned: the invalidated landmark `campo_di_patate_92_74_169`
(status `invalid`, excluded from every read) and the label «baule di casa» plus
the unverified iron claim on the container at 91/73/160 — the next real reading
of that chest will confirm or contradict the claim, and a different name told by
the human replaces the label. `CHAT_ALLOWLIST` is **not** set in the container's
environment, so the sender gate on the writes is inert there (the route is as
open as `/act` on the loopback API); the 403 was verified in the integration
tests and in the local live round. Still open: the **in-game chat** round, which
needs a human typing `@bot Ricorda che questo è il campo di patate` with a
chat-enabled controller running (`CHAT_ALLOWLIST` is a *controller* variable —
the harness alone never reads the chat). Docs touched:
[TOLD-FACTS](raw/TOLD-FACTS.md),
[verification](wiki/verification.md) 47.58–47.59,
[open questions](wiki/open-questions.md#told-facts-2026-10-07--live-over-http-the-in-game-chat-round-still-open).
Branch `feat/told-facts` = `c70acc5`, pushed to `origin`; the deploy was a
targeted one, so `main` still carries the other session's uncommitted
`bedrock-adapter.mjs` and was left alone.

## [2026-10-07] fix | A chat reply that is true: the four defects the owner read in the live chat

The owner asked what was wrong with the last answers in the in-game chat, and
the answer was read from the artefacts instead of guessed: the controller journal
(`runs/told-chat-main/controller.jsonl` in the `hermes` container) holds every
`chat_reply` with its `context`, and the harness journal
(`runs/diamond-20261007-1/actions.jsonl`) holds every action attempt. Four
defects, all in the controller and all now pinned by a test that **fails without
its edit** (each fix was reverted on purpose to prove it):

- **(A) a complaint written as a memory.** «mi avevi detto un diamante a 29 -4 208
  ma non è vero» was parsed as a *declaration* — the «è» of "non è vero" is a
  position verb and the coordinates were there — so `handleToldFact` created the
  landmark `mi_avevi_detto_un_diamante_ma_29_-4_208` at 29/-4/208. The parser now
  refuses a denial (`DENIAL`) and a report of speech (`REPORT_OF_SPEECH`) unless
  the message carries an explicit memory verb.
- **(B) a question answered from the wrong source.** «dimmi le coordinate dei
  diamanti» was answered with the **bot's own** position: first because the bare
  word `coordinate` matched the `q_position` intent, then — after a first small
  fix — because `POSITION_NOUN` was a single **global** regex used with `.test()`,
  so the second message in the same process no longer matched. The noun pattern is
  now anchored to the end of the question, the possessive form has its own branch,
  `extractPlaceName(mode: 'where')` drops the noun, and the consult falls through
  to the live vein the bot can see (`nearestLiveOre` → `told_ore_near`).
- **(C) an order closed as done.** The bot had really mined three
  `deepslate_diamond_ore`; the human had already collected the drops; then a
  replan emptied `plan.targets` ((«libera uno slot» is a construction step) and
  `Object.entries({}).every(...)` is vacuously true, so `goalMet` reported
  `GOAL MET` and the chat said «fatto». The order's own targets are now saved when
  the goal is born and used as a floor (`humanOrderTargets`), so a replan may add
  work but never remove the reason the order existed.
- **(D) a refusal nobody saw.** «non ho diamanti in inventario, non posso
  gettarlo» was addressed to `@?` (the goal's `humanOrder` had no `from` for a
  chat-born goal) and then **discarded** by the send rate limit
  (`CHAT_MIN_INTERVAL_MS`), leaving the optimistic ack as the only message. One
  `humanSender` now feeds both `from:` and `to:` in the four blocking replies, and
  `replyChat` retries once after `retryInMs` (`chat_reply_retry`).

Tests: 14 position-word cases over five languages and five resources
(`tests/human-questions.test.mjs`, `tests/memory-chat.test.mjs`), 8 chat
integration cases (`tests/controller-told-facts.test.mjs`), the order floor
(`tests/controller-chat-open-plan.test.mjs`, with a new prompt-aware fake planner
because a replan makes the call order unpredictable), the sender and the retry
(`tests/controller-chat-ack.test.mjs`). Full suite 1866 pass, 0 fail. Docs:
[CHAT-REPLY-TRUTH](raw/CHAT-REPLY-TRUTH.md),
[human command](wiki/human-command.md),
[verification](wiki/verification.md) 47.60,
[open questions](wiki/open-questions.md#the-chat-replies-that-were-not-true-2026-10-07).
Still open: nothing is deployed yet (the controller fixes need a controller
restart), and the order floor does not cover an order that had *no* numeric
target.

## [2026-10-07] feat | The bot says what it found: one alert per vein (M11)

Asked by the owner while the bot was slow to dig («posso chiedere appena vedi un
diamante comunicami la posizione»). The **adapter** owns the census of valuable
ores and the chat socket, the **harness** owns the language: `adapter.oreAlertText`
is composed from the five-language catalogue (`ore_alert`), so a coordinate never
passes through a model and the adapter stays without i18n. One sentence per vein,
once per position, with `ORE_ALERT` choosing the ores (default `diamond`, `off`
= silence), `ORE_ALERT_RANGE` (32) and `ORE_ALERT_COOLDOWN_MS` (5000) bounding
when it may speak; the cells are remembered in a FIFO-bounded set, the nearest
fresh vein wins and every vein within `ORE_ALERT_SPOT_RADIUS` of it counts as the
*same* sighting — a far vein is postponed, never swallowed. The tests found a
real bug: `now - last < cooldown` blocked the **first** alert when `now` was
small. 7 cases in `tests/bedrock-ore-alert.test.mjs`,
[verification](wiki/verification.md) 47.61,
[human command](wiki/human-command.md#the-bot-reports-what-it-finds-m11). The
alert lives in the harness, so it needs a `hermes-jev-bedrock` restart (bot out
and back, ~30 s) and has never been read in game.

## [2026-10-07] feat | «ragiona»: the answer that is reasoned, not recalled (M12)

The owner asked whether a word in the middle of a question could skip the canned
sentences and reach the deliberative half of the bot. With `ragiona` (or
`pensa`, `think`, `reason`, `réfléchis`, `piensa`, `überlege`, …) in a **question**,
the controller strips the marker before the dedup key and before the question
router and answers from the chat model of M7, with facts instead of a template:
the last six actions and whether they were stagnant, the last result (action, ok,
error) and the three nearest ores (`reasonFacts`), under a 220-token budget and a
per-sender cooldown. The marker is matched as a **word** and compared folded, so
`réfléchis` and `reflechis` are the same word, and only its own punctuation
leaves with it (the `?` and the `¿` are the human's). The guardrail is the point:
it changes the **reply**, never the action — no goal, no memory write, the
address (`@<sender>`) added by the controller, and the cooldown or a failed call
falls back to the catalogue instead of going quiet. A reasoned **order** keeps its
ack/outcome pair with both composed by the model (`reasoned` travels through
`goal.humanOrder`). The unit tests found two real defects in `reasonRequest` (the
trailing `?` of the question was stripped, and an orphan `:` was left where the
marker stood). 15 unit + 4 integration cases
(`tests/chat-llm.test.mjs`, `tests/controller-chat-reason.test.mjs`),
[verification](wiki/verification.md) 47.62,
[human command](wiki/human-command.md#ragiona-the-answer-that-is-reasoned-not-recalled-m12).
M7 — and therefore «ragiona» — was **off** in the deployed controller (no key in
its environment): the canned answers the owner read were the deployed
configuration, and turning it on is an env change
(`CHAT_LLM_API_KEY`/`CHAT_LLM_URL`/`CHAT_LLM_MODEL`), with `DEEPSEEK_API_KEY`
kept only as the legacy alias.

## [2026-10-07] feat | The welcome prompt teaches «ragiona»

Il saluto proattivo del bot — la chiave `greet` del catalogo, in `human-greeting.mjs`
e inviata cruda con `POST /say` — ora annuncia anche il verbo del ragionamento,
con un esempio: «Per una risposta ragionata scrivi ragiona nel messaggio, es.
"@bot ragiona: perché sei fermo?"». Un percorso deliberativo che nessuno conosce è
invisibile: il saluto è l'unico posto in cui l'umano lo scopre senza chiedere.

Il segnaposto `{reason}` è riempito con `CHAT_REASON_MARKERS[0]` quando è
configurato un verbo, altrimenti con quello della lingua (`reason_word`:
`ragiona`, `think`, `réfléchis`, `piensa`, `denk` — tutti marker veri), così il
saluto non insegna mai una parola che il controller non riconoscerebbe.

Evidenze offline: `tests/human-greeting.test.mjs` verifica per ogni lingua che
l'esempio ci sia, che il verbo configurato vinca su quello della lingua e che la
riga resa sia accettata dal `sendChat` dell'adapter — il tetto di 256 caratteri è
provato attraverso l'adapter e non con un numero magico, perché un messaggio
troppo lungo viene scartato **in silenzio** (`message_too_long`). Entrambe le metà
sono state provate per revert (senza il riempimento di `{reason}` e con la riga
italiana allungata oltre il tetto il test fallisce). Misure: 178–215 caratteri con
un gamertag lungo e due trigger. `tests/chat-i18n.test.mjs` continua a garantire
chiavi e segnaposto allineati fra le cinque lingue. Suite completa: 1867 pass /
0 fail. **Residual**: il testo non è stato ancora letto in gioco.

## [2026-10-07] fix | The chat line does not pay for reasoning

Il modello che l'utente vuole per la chat (`deepseek-flash`, DeepSeek-V4.1-Flash)
**pensa di default**, con `effort: high`. Misurato contro l'API reale con il corpo
che il client manda davvero (`temperature` 0.7, `max_tokens` 120): la risposta
torna **vuota** con `finish_reason: 'length'`, perché l'intero budget finisce in
`reasoning_content`; con `reasoning_effort: 'low'` è vuota lo stesso. Con
`{"thinking":{"type":"disabled"}}` la stessa chiamata risponde in 5 token di
completion, e senza switch ma con `max_tokens: 2000` servono 6605 caratteri di
ragionamento e 1795 token per una riga: un costo che nessuno ha chiesto.

`chat-llm.mjs` ha ora l'interruttore del client — `chatThinkingLevel`,
`chatThinkingFields`, `DEFAULT_CHAT_THINKING = 'off'`, `CHAT_LLM_THINKING` — che
spento manda `{"thinking":{"type":"disabled"}}`, acceso (`low|high|max`) manda
`reasoning_effort` e alza il budget (1200, 2000 per la risposta ragionata), e per
`default|auto` non manda nulla lasciando decidere il provider; `minimal|medium`
sono tradotti in `low` invece di far fallire la richiesta. Il controller passa
`thinking: CHAT_LLM.thinking` a entrambi i call site.

Evidenze live: con la chiave DeepSeek e i fatti di un `observe()` reale, una
domanda normale è stata risposta in 868 ms e una domanda `ragiona:` in 886 ms,
entrambe in italiano, ancorate ai fatti e in una riga. Evidenze offline:
`tests/chat-llm.test.mjs` (16 casi, incluso il nuovo «the chat line never pays for
reasoning unless it is asked to»); suite completa: 1868 pass / 0 fail.
**Residual**: misurato su un provider solo; uno che ignora il campo risponde
comunque, al massimo con `finish_reason: length`, che il fallback al catalogo
copre.
