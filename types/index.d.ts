/** Why a request did not read the prefix the previous request had cached. */
export type MissCause = 'ttl' | 'model' | 'compaction' | 'prefix'

/** One API request's cache figures, as the thread's last request. */
export type CacheSample = {
  at: number
  model: string
  input: number
  read: number
  write: number
  messageCount: number
}

export type CacheMiss = {
  /** Request number in its thread, from 1. */
  request: number
  cause: MissCause
  /** Tokens of the previously cached prefix the request did not read. */
  lost: number
  /** Milliseconds since the thread's previous request. */
  gapMs: number
}

/** One loop's totals: the main thread, or one subagent. */
export type CacheThread = {
  id: string
  label: string
  requests: number
  input: number
  read: number
  write: number
  misses: number
  causes: Record<MissCause, number>
  lost: number
  last: CacheSample | null
  lastRequestHit: boolean | null
  lastMiss: CacheMiss | null
}

/** The main thread's latest turn. */
export type CacheTurn = {
  turnId: string
  requests: number
  input: number
  read: number
  write: number
  misses: number
  causes: MissCause[]
}

export type CacheStats = {
  main: CacheThread
  agents: CacheThread[]
  lastTurn: CacheTurn | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-kpis': { stats: Shaped<CacheStats> }
  }
}
