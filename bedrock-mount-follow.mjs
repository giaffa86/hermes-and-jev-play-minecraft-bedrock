// Missione «segui l'umano che si imbarca»: macchina a stati pura.
//
//   FOLLOWING -> HUMAN_MOUNT_DETECTED -> JOINING_HUMAN_MOUNT -> RIDING_WITH_HUMAN -> FOLLOWING
//
// con due uscite controllate:
//   JOINING_HUMAN_MOUNT  -> WAITING_AT_SHORE  (mezzo non raggiungibile, join fallito)
//   HUMAN_MOUNT_DETECTED -> WAITING_AT_SHORE  (mezzo pieno o non porta passeggeri)
//
// La macchina è pura: nessun I/O, nessuna entità, nessun pacchetto. Il chiamante
// (`BedrockAdapter._mountFollowView`) raccoglie i fatti — il link del server, il
// flag `riding` dei metadata, la raggiungibilità del cammino — e conserva i
// tentativi; qui si decide solo *cosa* fare.
//
// Il join vero è dietro feature flag (`BEDROCK_JOIN_HUMAN_MOUNT=1`): senza flag
// la missione si ferma a `WAITING_AT_SHORE` con `reason: 'join_disabled'`, così
// rilevazione e rifiuti tipizzati entrano in produzione subito e il bot dice
// dove aspetta invece di inseguire la barca per 45 s.

export const MOUNT_FOLLOW_STATES = Object.freeze({
  IDLE: 'IDLE',
  FOLLOWING: 'FOLLOWING',
  HUMAN_MOUNT_DETECTED: 'HUMAN_MOUNT_DETECTED',
  JOINING_HUMAN_MOUNT: 'JOINING_HUMAN_MOUNT',
  RIDING_WITH_HUMAN: 'RIDING_WITH_HUMAN',
  WAITING_AT_SHORE: 'WAITING_AT_SHORE',
});

// Quante volte si prova a salire sullo stesso mezzo prima di smettere. Il join
// dura fino a 20 s per tentativo: due bastano a distinguere "il server non
// conferma" da "ho sbagliato il momento", e non bruciano il budget dell'ordine.
export const MOUNT_JOIN_ATTEMPTS = 2;

// `mount` è la vista del mezzo dell'umano (`seatInfo` + posizione) o null se
// l'umano è a piedi: `{ type, seats, riders, free, joinable, reason, distance }`.
export function mountFollowTransition ({
  state = MOUNT_FOLLOW_STATES.IDLE,
  following = false,
  botRiding = false,
  ridingHumanMount = false,
  mount = null,
  reachable = false,
  joinEnabled = false,
  joinAttempted = false,
  joinError = null,
  attempts = 0,
  attemptLimit = MOUNT_JOIN_ATTEMPTS,
} = {}) {
  const s = MOUNT_FOLLOW_STATES;
  // Nessun ordine di follow aperto: la missione non esiste (non è "in attesa").
  if (!following) return { state: s.IDLE, action: 'none', reason: 'no_follow_order' };
  // A bordo: si resta in RIDING_WITH_HUMAN finché il link non dice il contrario.
  // `ridingHumanMount` distingue il sedile dell'umano da un altro veicolo del bot.
  if (botRiding) {
    return {
      state: s.RIDING_WITH_HUMAN,
      action: 'ride',
      reason: ridingHumanMount ? 'riding_with_human' : 'riding_other_mount',
    };
  }
  // Smontati: la missione riparte da FOLLOWING (e al prossimo detect si richiude).
  if (state === s.RIDING_WITH_HUMAN) return { state: s.FOLLOWING, action: 'follow', reason: 'dismounted' };
  // Umano a piedi: niente da salire, si segue come sempre.
  if (!mount) return { state: s.FOLLOWING, action: 'follow', reason: 'human_on_foot' };
  // Il mezzo c'è: `full` e `unsupported` sono rifiuti definitivi per *questo*
  // mezzo (un altro ordine o un altro mezzo li superano da soli).
  if (mount.reason === 'unsupported' || (mount.seats ?? 0) < 2) {
    return { state: s.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_unsupported' };
  }
  if (mount.reason === 'full' || (mount.free ?? 0) <= 0) {
    return { state: s.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_full' };
  }
  if (!joinEnabled) return { state: s.WAITING_AT_SHORE, action: 'wait', reason: 'join_disabled' };
  if (!reachable) return { state: s.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_unreachable' };
  // Un tentativo fallito ha già una ragione tipizzata (`mount_not_confirmed`,
  // `human_mount_gone`...): si aspetta a riva invece di riprovare in loop.
  if (joinAttempted && joinError) return { state: s.WAITING_AT_SHORE, action: 'wait', reason: joinError };
  if (attempts >= attemptLimit) {
    return { state: s.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_attempts_exhausted' };
  }
  return {
    state: s.JOINING_HUMAN_MOUNT,
    action: 'join',
    reason: state === s.JOINING_HUMAN_MOUNT ? 'joining' : 'human_mount_joinable',
  };
}

// Chi aspetta a riva è fermo: lo stato è terminale finché il fatto non cambia
// (l'umano sbarca, il mezzo si libera, il mezzo cambia). Serve a chi deve
// decidere se *dire* qualcosa in chat, non a chi decide l'azione.
export function mountFollowWaiting (state) {
  return state === MOUNT_FOLLOW_STATES.WAITING_AT_SHORE;
}
