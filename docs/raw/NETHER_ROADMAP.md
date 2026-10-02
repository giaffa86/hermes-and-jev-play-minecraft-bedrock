# Roadmap — Nether ed End (sopravvivenza, ghast, piglin, enderman, portali)

> Fonte grezza (spec). Sintesi in [`wiki/nether.md`](../wiki/nether.md).
> Stato: **parzialmente tracciato nel grafo di progressione, non implementato**.
> Il grafo ora contiene la catena completa (vedi
> [`knowledge/progression.json`](../../knowledge/progression.json)) e la
> contraddizione `beat_the_dragon → enter_nether` è stata corretta: `beat_the_dragon`
> è un milestone reale che richiede `enter_end`.
> Riferimenti: `bedrock-adapter.mjs`, `bedrock-survival.mjs`, `survival/*`,
> [`docs/raw/FLUIDS_ROADMAP.md`](FLUIDS_ROADMAP.md).

## Obiettivo

Portare il bot dal primo portale fino all'End, sapendo **sopravvivere nel Nether**:

- **localizzare un portale nelle vicinanze** (riusare quello della base se esiste);
- attraversare, ambientarsi e non morire (fuoco, lava, cadute);
- **evitare gli attacchi del Ghast** (fireball in arrivo);
- **commerciare oro con i Piglin** (bartering, senza farli arrabbiare);
- **evitare di guardare gli Ender** (gaze discipline);
- raccogliere **blaze rod** nella fortezza e **perle di ender**;
- craftare **occhi di ender**, trovare la **stronghold**, aprire il **portale
  dell'End**;
- (stretch) **sconfiggere l'Ender Dragon**.

Principio invariato: il harness possiede la validità, i modelli scelgono strategie,
le skill sono dati deterministici, la verifica legge il mondo.

## Stato attuale (verificato dal codice e dal grafo)

1. **`enter_nether` non è implementato.** La skill esiste e ha `success:
   {dimension: nether}`, ma **nessuna azione portale** esiste: niente
   `place_obsidian`, niente `light_portal`/`flint_and_steel`, niente ricerca di un
   `portal` vicino.
2. **Il Nether è ostile e non supportato.**
   - `HOSTILE_TYPES` (`bedrock-survival.mjs`) include già `ghast`, `blaze`,
     `piglin`, `piglin_brute`, `hoglin`, `zoglin`, `magma_cube`, `enderman`,
     `wither_skeleton`, `ender_dragon`.
   - **Nessun tracciamento di proiettili** (fireball del Ghast): le entità
     proiettile non sono classificate né evitate.
   - **Nessuna disciplina di sguardo** per gli enderman: `_lookAt` è usata per
     mirare/scavare e non c'è alcuna regola che impedisca di puntare gli occhi.
   - **Nessun hazard di fuoco/lava** (dipende da `FLUIDS_ROADMAP` M0/M4).
3. **Il bartering non esiste.** `_feedAnimal`/`_tameAnimal` usano
   `item_use_on_entity`, ma non c'è `barter_piglin` (oro in mano, interazione,
   raccolta drop). I Piglin sono già classificati ostili, quindi oggi una regola
   di emergenza li tratterebbe come nemici.
4. **Nessuna azione "fortezza"/"stronghold"/"end portal".** `_refreshNearby` non
   cerca `portal`, `end_portal_frame`, `nether_wart`, spawner.
5. **Il grafo di progressione è stato esteso e corretto** (questo task):
   `diamonds → nether_portal → enter_nether → nether_survival →
   {piglin_barter, obtain_blaze_rods, obtain_ender_pearls} →
   craft_eyes_of_ender → find_stronghold → enter_end → beat_the_dragon`.
6. **Item tag nuovi**: `gold_ingots`, `obsidian`, `blaze_rods`, `blaze_powder`,
   `ender_pearls`, `eyes_of_ender`.
7. **Bedrock-specifico da ricordare**:
   - nel Nether **l'acqua evapora** (niente secchi d'acqua come MLG);
   - **i letti esplodono** nel Nether/End (mai dormire lì);
   - il **respawn anchor** carica con glowstone e va usato solo nel Nether;
   - i Piglin diventano **zombified** nell'Overworld; indossare un pezzo d'oro li
     rende passivi;
   - il Ghast spara fireball **deviabili** colpendo il proiettile.

## Vocabolario proposto

### Nuove chiavi azione `/options`

| Key | Significato |
|---|---|
| `goto_portal` | Raggiungi il `portal` più vicino (localizzato via `_refreshNearby`). |
| `build_portal` | Costruisci il frame di ossidiana (10-14 blocchi) nel posto scelto. |
| `light_portal` | Usa `flint_and_steel` (o fire charge) sul frame e conferma il blocco `portal`. |
| `enter_portal` | Attraversa il portale e verifica `dimension: nether`. |
| `barter_piglin` | Oro in mano → `item_use_on_entity` sul piglin → raccogli i drop. |
| `dodge_projectile` | Passo laterale/indietro per schivare una fireball in arrivo. |
| `break_spawner`?/`find_fortress` | Trova/raggiungi la fortezza (stretch, richiede esplorazione). |
| `throw_eye_of_ender` | Lancia un occhio, leggi la direzione, avanza (stronghold). |
| `fill_end_portal` | Inserisci gli occhi nei frame (`click_block` sul frame vuoto). |
| `enter_end_portal` | Salta nel portale dell'End e verifica `dimension: the_end`. |

### Nuovi intenti

`swim`/`descend`/`ascend` (fluidi) e qui servono `barvagliare`→ in inglese
`barter`, `dodge`. Aggiungere `barter` e `dodge` al vocabolario, con mapping
`barter_piglin → barter`, `dodge_projectile → dodge`, `goto_portal`/`build_portal`/
`light_portal`/`enter_portal` → `travel`/`build`.

### Nuove condizioni governor / criteri verifier

- Condizioni: `inLava`/`lavaWithin` (fluidi), `fireNearby`, `projectileIncoming`,
  `gazedAtEnderman` (bool), `goldArmorEquipped`, `piglinNearby`.
- Criteri: `bossDefeated` (per `beat_the_dragon`, oggi mancante), `blockStateAt`
  (per il portale), `inventoryTagGte` con i nuovi tag.

---

## Milestone

### N0 — Awareness e pericoli del Nether

**Deliverable**

- `_refreshNearby` esteso con `portal`, `end_portal_frame`, `end_portal`,
  `nether_wart`, `magma_block`, `spawner`, `lava`/`flowing_lava` (o delegato a
  fluidi M0), `fire`, `soul_fire`.
- **Localizzazione portale**: `/observe.portals = [{type: 'nether'|'end',
  position, distance, active}]`; il bot **preferisce riusare** un portale vicino
  invece di costruirlo.
- **Sensing proiettili**: classificare le entità proiettile (`fireball`,
  `small_fireball`, `arrow`, `snowball`, ...) con velocità stimata dal delta di
  posizione; `projectileIncoming` = proiettile la cui traiettoria punta il bot.
- **Sensing sguardo**: la testa del bot è rivolta all'entità? `gazedAtEnderman` =
  enderman entro ~16 blocchi e linea di vista sulla testa/occhi.
- Regole governor: `lava_near`, `fire_near`, `projectile_incoming`,
  `enderman_gaze` (quest'ultima forza a distogliere lo sguardo, non a fuggire).
- Protezioni: mai scavare in lava (fluidi M0), mai dormire nel Nether, mai
  piazzare acqua nel Nether.

**Accettazione**: live `/observe.portals` trova un portale della base; unit test
su sensing proiettili e sguardo.

### N1 — Portale: localizzare, costruire, accendere, entrare

- **`goto_portal`**: naviga al `portal` esistente più vicino; se non c'è,
  `build_portal` (10 ossidiane + 4 angoli, o 10 minimo senza angoli) nel posto
  scelto e `light_portal` con `flint_and_steel` (craft: iron + flint).
- Verifica: il blocco `portal` compare nella cella, poi `dimension === 'nether'`.
- Sicurezza: non rompere portali esistenti della base; non accendere il portale
  dentro una costruzione (rischio fuoco).
- **Accettazione**: `build_circuit`-style: costruire/accendere un portale live e
  attraversarlo; `CURRICULUM=enter_nether` arriva al Nether.

### N2 — Sopravvivenza nel Nether

- Hazard fuoco/lava (da fluidi M0/M4): non camminare sulla lava, non scavare in
  lava, fuggire dal bordo.
- **Nether hub minimo**: cella protetta (pareti) attorno al portale, baule/fornace
  se serve; **mai** letto; opzionale respawn anchor + glowstone.
- Cadute: le sezioni del Nether hanno grandi dislivelli → usare `descend_waterfall`
  non è possibile (niente acqua); servono `dig_down`/ponti/scavare.
- **Accettazione**: il bot resta vivo nel Nether per un ciclo giorno/notte senza
  morire di fuoco/lava/caduta; `CURRICULUM=nether_survival` verde.

### N3 — Evitare gli attacchi del Ghast

- Tracciare le fireball: quando `projectileIncoming`, **schivare** perpendicolarmente
  alla traiettoria (o colpire la fireball per deviarla); mai fuggire dritto in lava.
- Governor: `projectile_incoming` → intento `dodge` (emergency se health basso).
- Priorità: distogliere il fuoco dal combattimento, non inseguire il Ghast.
- **Accettazione**: test unitario sulla geometria di schivata; live: sopravvivere
  a un Ghast in campo aperto senza morire.

### N4 — Piglin: bartering e neutralità

- **Rendersi passivi**: equipaggiare un pezzo di armatura d'oro (`equip_armor`) se
  disponibile.
- **`barter_piglin`**: oro in mano, `item_use_on_entity` su un piglin adulto,
  attendere il drop e `collect_drop`. **Mai** colpire un piglin (aggro); evitare i
  `piglin_brute`.
- Loot: ender pearl, obsidian, fire resistance (pozione), gravel, soul sand, ...
  → aggiornare il censimento item e il grafo.
- **Accettazione**: live un barter completa (`piglin_barter` verificato) e i drop
  raccolti; nessun piglin ostile a fine test.

### N5 — Ender: disciplina dello sguardo e perle

- **Gaze discipline**: mai puntare gli occhi di un enderman. Il resolver/il
  controllore impongono che `_lookAt` non miri alla testa; in caso di sguardo,
  distogliere e allontanarsi. Opzione: indossare una **carved pumpkin**.
- **Perle**: da bartering (N4) o da enderman colpiti **al corpo/piedi**. Un
  enderman colpito si teletrasporta: combattimento paziente con copertura.
- **Accettazione**: nessun aggro di enderman durante i test; `obtain_ender_pearls`
  raccoglie le 12 perle (o il target concordato).

### N6 — Fortezza e blaze rod

- Trovare la **fortezza** (esplorazione/`find_structure`; oggi l'esplorazione non
  esiste — vedi `GOAL_EXPLORATION`), raggiungere lo spawner dei blaze.
- Combattere i blaze: sono ranged e incendiano; usare copertura, arco, e non
  cadere nelle fessure di lava. Raccogliere `blaze_rod` (target 7).
- **Wither skeleton** (carbone/ossa) e **nether wart** (breeding) come sottoprodotti.
- **Accettazione**: `obtain_blaze_rods` con 7 rod e ritorno vivo al portale/hub.

### N7 — Endgame: occhi, stronghold, End, drago

- `craft_eyes_of_ender` (blaze powder + ender pearl).
- `throw_eye_of_ender` per triangolare la stronghold; `find_stronghold` quando
  `end_portal_frame` è entro 24 blocchi.
- `fill_end_portal` (contare i frame già pieni!) → `enter_end_portal` →
  `dimension: the_end`.
- (stretch) **Ender Dragon**: distruggere i cristalli (archi/proiettili), poi il
  drago. Serve un criterio di verifica `bossDefeated` (oggi inesistente).
- **Accettazione**: `CURRICULUM=enter_end` arriva all'End; `beat_the_dragon`
  resta gated finché non esiste la verifica del boss.

---

## Integrazione con il grafo (già fatta in questo task)

```text
diamonds
  └── nether_portal        (localizza o costruisci; satisfiedWhen nearby portal / 10 obsidian)
        └── enter_nether   (dimension: nether)
              └── nether_survival
                    ├── piglin_barter
                    ├── obtain_blaze_rods        (blaze_rods >= 7)
                    └── obtain_ender_pearls      (ender_pearls >= 12)
                          └── craft_eyes_of_ender (eyes_of_ender >= 12)
                                └── find_stronghold (end_portal_frame within 24)
                                      └── enter_end (dimension: the_end)
                                            └── beat_the_dragon
```

`goals.beat_the_dragon` ora punta a `beat_the_dragon` (non più a `enter_nether`).
Le skill dichiarative sono in `skills/gameplay/progression/`.

## Dipendenze

- **Fluidi M0/M4** (lava, fuoco, `inLava`, `lavaWithin`) — prerequisito per N0/N2.
- **Esplorazione** (`GOAL_EXPLORATION`) — prerequisito per N6 (trovare la fortezza)
  e per la stronghold via occhi (parziale).
- **Goal Contract / Goal Manager** ([goal-achievement](../wiki/goal-achievement.md))
  — prerequisito per persistere un run Nether lungo con suspend/resume.
- **Combat/ranged**: oggi `_combat` è melee; servono archi per i cristalli e per i
  blaze a distanza.

## Rischi e questioni aperte

1. **Perdita totale alla morte** (`keep-inventory=false`): un run Nether lungo
   senza respawn anchor/hub significa perdere tutto. Priorità a N1/N2.
2. **NetherNet** (instabilità, `connecterror:9`): un run Nether è lungo e fragile.
3. **Fuoco/lava** sono la prima causa di morte; dipendono dai fluidi.
4. **Ghast fireball**: la geometria di schivata è semplice (perpendicolare), ma
   va tarata con la velocità reale del proiettile e la latenza.
5. **Bartering**: il piglin può essere ucciso per errore da un attacco AoE o da un
   drop; evitare di colpirlo e di rubare nei bastioni.
6. **Stronghold/End**: i criteri statici dipendono dal caricamento delle sezioni;
   `end_portal_frame` potrebbe non essere ancora caricato quando serve.
7. **`bossDefeated`** non esiste: `beat_the_dragon` non è verificabile oggi.

## Non-obiettivi (per ora)

- Speedrun/seed-specific routing.
- Farm di mob nel Nether o sfruttamento di glitch.
- Elytra/End cities (dopo il drago, in una roadmap separata).
- Commercio con i Piglin per automazione su larga scala (solo bartering primitivo).
