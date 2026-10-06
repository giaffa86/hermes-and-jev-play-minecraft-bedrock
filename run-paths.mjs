// Dove un run lascia i suoi file. `RUNS_DIR` esiste per la consegna del ledger:
// il harness gira dentro il container (`hermes-jev-bedrock`) e senza un volume
// montato `runs/` resta nel container, dove nessun lettore dell'host può
// verificare i numeri che un run dichiara (`docs/wiki/verification.md`). Il
// controller gira sull'host e non ne ha bisogno, ma legge la stessa variabile:
// così il run e il suo ledger restano nella stessa cartella anche quando il
// harness è in un container.
import { join } from 'node:path';

export const runsRoot = (env = process.env) => env.RUNS_DIR || 'runs';

export const runDir = (runId = process.env.RUN_ID || 'run', env = process.env) => join(runsRoot(env), runId);
