import type {
  CacheSample,
  CacheStats,
  CacheThread,
  CacheTurn,
  MissCause,
} from '../types'

export const MAIN_ID = 'main'

/**
 * A request counts as a miss when it fails to read at least this many tokens
 * of the prefix the previous request left cached. Small drifts (a reminder
 * near the tail changing) stay below it; a real invalidation is far above.
 */
export const MIN_LOST_TOKENS = 1024

/** The shortest prompt-cache TTL; a longer pause most likely let it lapse. */
export const TTL_MS = 5 * 60 * 1000

const MAX_AGENTS = 50

export const CAUSE_LABEL: Record<MissCause, string> = {
  ttl: 'TTL',
  model: 'Model',
  compaction: 'Compaction',
  prefix: 'Prefix',
}

export const emptyThread = (id: string, label: string): CacheThread => ({
  id,
  label,
  requests: 0,
  input: 0,
  read: 0,
  write: 0,
  misses: 0,
  causes: { ttl: 0, model: 0, compaction: 0, prefix: 0 },
  lost: 0,
  last: null,
  lastRequestHit: null,
  lastMiss: null,
})

export const EMPTY_STATS: CacheStats = {
  main: emptyThread(MAIN_ID, 'Main thread'),
  agents: [],
  lastTurn: null,
}

export type Verdict =
  | { kind: 'cold' }
  | { kind: 'hit' }
  | { kind: 'miss'; cause: MissCause; lost: number; gapMs: number }

/**
 * Compares a request with the thread's previous one: the prefix the previous
 * request read or wrote should now be read from the cache.
 */
export const classify = (
  prev: CacheSample | null,
  cur: CacheSample,
): Verdict => {
  if (prev === null) {
    return { kind: 'cold' }
  }

  const lost = prev.read + prev.write - cur.read

  if (lost < MIN_LOST_TOKENS) {
    return { kind: 'hit' }
  }

  const gapMs = cur.at - prev.at
  const cause: MissCause =
    cur.messageCount < prev.messageCount
      ? 'compaction'
      : cur.model !== prev.model
        ? 'model'
        : gapMs >= TTL_MS
          ? 'ttl'
          : 'prefix'

  return { kind: 'miss', cause, lost, gapMs }
}

const recordThread = (
  thread: CacheThread,
  sample: CacheSample,
  verdict: Verdict,
): CacheThread => {
  const requests = thread.requests + 1
  const isMiss = verdict.kind === 'miss'

  return {
    ...thread,
    requests,
    input: thread.input + sample.input,
    read: thread.read + sample.read,
    write: thread.write + sample.write,
    misses: thread.misses + (isMiss ? 1 : 0),
    causes: isMiss
      ? { ...thread.causes, [verdict.cause]: thread.causes[verdict.cause] + 1 }
      : thread.causes,
    lost: thread.lost + (isMiss ? verdict.lost : 0),
    last: sample,
    lastRequestHit: verdict.kind === 'cold' ? null : !isMiss,
    lastMiss: isMiss
      ? {
          request: requests,
          cause: verdict.cause,
          lost: verdict.lost,
          gapMs: verdict.gapMs,
        }
      : thread.lastMiss,
  }
}

const recordTurn = (
  turn: CacheTurn | null,
  turnId: string,
  sample: CacheSample,
  verdict: Verdict,
): CacheTurn => {
  const base: CacheTurn =
    turn !== null && turn.turnId === turnId
      ? turn
      : { turnId, requests: 0, input: 0, read: 0, write: 0, misses: 0, causes: [] }
  const isMiss = verdict.kind === 'miss'

  return {
    ...base,
    requests: base.requests + 1,
    input: base.input + sample.input,
    read: base.read + sample.read,
    write: base.write + sample.write,
    misses: base.misses + (isMiss ? 1 : 0),
    causes: isMiss ? [...base.causes, verdict.cause] : base.causes,
  }
}

export type StepRecord = {
  /** Absent on the main thread. */
  agentId?: string
  /** Shown for a subagent seen for the first time. */
  agentLabel?: string
  turnId: string
  sample: CacheSample
}

/** Folds one finished API request into the session's stats. */
export const record = (stats: CacheStats, step: StepRecord): CacheStats => {
  if (step.agentId === undefined) {
    const verdict = classify(stats.main.last, step.sample)

    return {
      ...stats,
      main: recordThread(stats.main, step.sample, verdict),
      lastTurn: recordTurn(stats.lastTurn, step.turnId, step.sample, verdict),
    }
  }

  const agentId = step.agentId
  const existing = stats.agents.find(one => one.id === agentId)
  const thread =
    existing ?? emptyThread(agentId, step.agentLabel ?? agentId.slice(0, 8))
  const updated = recordThread(thread, step.sample, classify(thread.last, step.sample))
  const others = stats.agents.filter(one => one.id !== agentId)

  return { ...stats, agents: [...others, updated].slice(-MAX_AGENTS) }
}

/** Share of input tokens served from the cache, or null before any request. */
export const hitRate = (t: {
  input: number
  read: number
  write: number
}): number | null => {
  const total = t.input + t.read + t.write

  return total === 0 ? null : t.read / total
}

export const formatRate = (rate: number | null): string =>
  rate === null ? '–' : `${(rate * 100).toFixed(1)}%`

export const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n)

export const formatGap = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`

export type TurnStatus =
  | { kind: 'none'; text: string }
  | { kind: 'hit'; text: string }
  | { kind: 'miss'; text: string }

/** Whether the main thread's latest turn kept the cache, in a few words. */
export const turnStatus = (turn: CacheTurn | null): TurnStatus => {
  if (turn === null) {
    return { kind: 'none', text: '–' }
  }
  if (turn.misses === 0) {
    return { kind: 'hit', text: `✓ ${formatRate(hitRate(turn))} · ${turn.requests} Req` }
  }

  const causes = [...new Set(turn.causes)].map(cause => CAUSE_LABEL[cause]).join(', ')

  return { kind: 'miss', text: `✗ invalidated (${causes})` }
}

/** The line under the prompt; undefined before the main thread's first request. */
export const statusLine = (stats: CacheStats): string | undefined => {
  const { main, agents, lastTurn } = stats

  if (main.requests === 0) {
    return undefined
  }

  const misses =
    main.misses === 0 ? 'Misses 0' : `Misses ${main.misses} (${formatCauses(main.causes)})`
  const agentPart = agents.length === 0 ? '' : ` · Agents ${agents.length}`

  return `cache ${formatRate(hitRate(main))} · last turn ${turnStatus(lastTurn).text} · ${misses}${agentPart} · /cache-kpis`
}

export const formatCauses = (causes: Record<MissCause, number>): string =>
  (Object.keys(CAUSE_LABEL) as MissCause[])
    .filter(cause => causes[cause] > 0)
    .map(cause => `${CAUSE_LABEL[cause]} ${causes[cause]}`)
    .join(' · ')
