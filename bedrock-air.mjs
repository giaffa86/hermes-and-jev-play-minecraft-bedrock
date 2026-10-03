// Aria (M1 di docs/wiki/fluids.md): il budget d'aria del giocatore non arriva nei
// metadata che l'adapter segue (l'attributo `minecraft:air` non è mai stato
// osservato dal vivo), quindi lo *simuliamo* col modello vanilla — 300 tick
// (15 s) con la testa sott'acqua, recupero di 4 tick per tick fuori dall'acqua.
// Modulo puro e deterministico: nessun socket, nessun timer, nessun danno.
// La salute resta del server: qui l'aria serve solo a decidere (regola
// `drowning`, bisogno `surface`, scala di pericolo di `bedrock-fluids.mjs`).

export const MAX_AIR = 300;          // tick di aria piena (15 s a 20 tick/s)
export const AIR_RECOVER_PER_TICK = 4; // tick recuperati per tick fuori dall'acqua

// Un passo del contatore. `ticks` è il numero di tick di gioco trascorsi (la
// fisica del movimento li interpola quando recupera il ritardo).
export function airStep (air, { headInWater = false, ticks = 1 } = {}) {
  const current = Number.isFinite(air) ? air : MAX_AIR;
  const steps = Number.isFinite(ticks) && ticks > 0 ? ticks : 1;
  if (headInWater) return Math.max(0, current - steps);
  return Math.min(MAX_AIR, current + AIR_RECOVER_PER_TICK * steps);
}

export function airSeconds (air) {
  const value = Number.isFinite(air) ? air : MAX_AIR;
  return Math.round((value / 20) * 100) / 100;
}

// Contatore con memoria: l'adapter ne tiene uno e lo avanza una volta per tick.
export class AirMeter {
  constructor ({ air = MAX_AIR, max = MAX_AIR } = {}) {
    this.max = max;
    this.air = air;
  }

  update ({ headInWater = false, ticks = 1 } = {}) {
    this.air = airStep(this.air, { headInWater, ticks });
    return this.air;
  }

  // Verità del server (se un giorno l'attributo arrivasse): allinea il contatore.
  set (air) {
    if (Number.isFinite(air)) this.air = Math.max(0, Math.min(this.max, air));
    return this.air;
  }

  get value () {
    return this.air;
  }

  get fraction () {
    return this.max > 0 ? this.air / this.max : 0;
  }
}
