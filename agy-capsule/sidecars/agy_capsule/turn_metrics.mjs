// One user message, including queued time. No steps-as-requests or token estimates.
const ACTIVE = new Set([1, 2, 8, 9, 11]);
const TOKEN_KEYS = ['read', 'cachedRead', 'uncachedRead', 'write', 'thinking'];
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;

export function summarizeTurnMetrics(requests, steps, userStepIndex, executors = []) {
  const user = steps.find(step => step.idx === userStepIndex && step.step_type === 14);
  if (!user) return null;
  const scope = steps.filter(step => step.idx >= userStepIndex);
  const attributable = requests.filter(request => request.lastStepIndex >= userStepIndex);
  const ambiguous = requests.some(request => request.lastStepIndex < 0 && request.stepIndices?.some(idx => idx > userStepIndex));
  const attempts = attributable.flatMap(request => request.attempts || []);
  const pending = attributable.some(request => request.pendingAttempt);
  const knownTotals = Object.fromEntries(TOKEN_KEYS.map(key => [key, attempts.reduce((sum, attempt) => sum + (attempt.usage[key] ?? 0), 0)]));
  const totals = Object.fromEntries(TOKEN_KEYS.map(key => [key,
    ambiguous || pending || attempts.some(attempt => attempt.usage[key] === null) ? null : knownTotals[key],
  ]));

  let state = 'unknown';
  let endedAtMs = null;
  const active = scope.some(step => step.step_type !== 14 && ACTIVE.has(step.status));
  const executor = executors.filter(item => item.lastStepIndex >= userStepIndex).at(-1);
  const finalStep = executor && scope.find(step => step.idx === executor.lastStepIndex);
  const laterExecution = executor && scope.some(step => step.idx > executor.lastStepIndex && ![14, 101, 17].includes(step.step_type));
  const executionMatches = finalStep && (!executor.executionId || !finalStep.executionId || executor.executionId === finalStep.executionId);
  if (user.status === 11) state = 'queued';
  else if (active) state = 'running';
  else if (executor && executionMatches && !laterExecution && ![0, 7, 12].includes(executor.reason)) {
    state = executor.reason === 1 ? 'failed' : [2, 3, 6, 11].includes(executor.reason) ? 'interrupted' : 'completed';
    if (executor.reason === 2) {
      // Last DONE step may predate cancellation. Never pretend it is cancel time.
      const lastCompleted = timestamp(finalStep.completedAtMs) || timestamp(finalStep.terminalAtMs);
      const cancellations = scope.filter(step => [6, 12].includes(step.status) && (!executor.executionId || !step.executionId || step.executionId === executor.executionId))
        .map(step => timestamp(step.terminalAtMs) || timestamp(step.completedAtMs)).filter(value => value && (!lastCompleted || value >= lastCompleted));
      endedAtMs = cancellations.length ? Math.max(...cancellations) : null;
    } else {
      const errorStep = executor.reason === 1 && scope.findLast(step => step.step_type === 17 && step.idx >= executor.lastStepIndex);
      const end = errorStep || finalStep;
      endedAtMs = timestamp(end?.completedAtMs) || timestamp(end?.terminalAtMs);
    }
  } else if ([6, 12].includes(user.status) && scope.every(step => step.step_type === 14)) {
    state = 'interrupted';
    endedAtMs = timestamp(user.terminalAtMs);
  }
  const startedAtMs = timestamp(user.createdAtMs);
  if (startedAtMs && endedAtMs && endedAtMs < startedAtMs) endedAtMs = null;
  return {
    userStepIndex, state, startedAtMs, endedAtMs,
    duration: startedAtMs && endedAtMs ? (endedAtMs - startedAtMs) / 1000 : null,
    requestCount: ambiguous || pending ? null : attempts.length,
    knownRequestCount: attempts.length,
    missingUsageRequests: attempts.filter(attempt => TOKEN_KEYS.some(key => attempt.usage[key] === null)).length,
    pending, associationIncomplete: ambiguous, knownTotals, ...totals,
  };
}
