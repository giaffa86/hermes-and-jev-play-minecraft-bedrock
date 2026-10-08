// Skill experience: statistiche leggere per ogni skill completata o fallita.
//
// Niente embedding o vector database: una riga JSON per skill run in
// runs/<id>/skills.jsonl. Serve a preparare il terreno per una futura
// esperienza recuperabile senza implementarla prematuramente.

export function buildSkillRecord ({
  skill, status, actions = 0, startedAt, endedAt = Date.now(),
  failureReason = null, context = null, failure = null,
} = {}) {
  const id = typeof skill === 'string' ? skill : skill?.id ?? null;
  return {
    t: endedAt,
    skill: id,
    success: status === 'success',
    status,
    actions,
    elapsedMs: startedAt != null ? Math.max(0, endedAt - startedAt) : null,
    failureReason,
    context,
    // R4: il rifiuto tipizzato che ha portato al fallimento (`{step, stepId,
    // key, error, kind, retryable, evidence}`), quando c'e' stato. `null` per
    // una skill riuscita o per un fallimento che non viene da un rifiuto.
    failure,
  };
}

// I/O: appende una riga JSONL. Il chiamante garantisce che la directory esista
// (il controller usa già runs/<RUN_ID>/ per i suoi log).
export async function appendSkillRecord (file, record) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, JSON.stringify(record) + '\n');
}
