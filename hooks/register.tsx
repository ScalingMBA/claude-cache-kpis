import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheThread, CacheTurn } from '../types'
import {
  CAUSE_LABEL,
  EMPTY_STATS,
  formatCauses,
  formatGap,
  formatRate,
  formatTokens,
  hitRate,
  record,
  statusLine,
  turnStatus,
} from './stats'
import type { TurnStatus } from './stats'

const STATUS_COLOR: Record<TurnStatus['kind'], 'success' | 'error' | undefined> = {
  none: undefined,
  hit: 'success',
  miss: 'error',
}

const PANE = 'cache-kpis'
const TITLE = 'Cache'
const COMMAND = 'cache-kpis'
const LABEL_WIDTH = 17

// Change the tag when CacheStats changes shape: values an older version
// stored are then read as empty instead of being misread.
const stats = atom({ plugin: 'cache-kpis', key: 'stats' } as const, EMPTY_STATS, {
  shape: 'stats-1',
})

const reset = async ($: EngineInterface) => {
  await update($, stats, () => EMPTY_STATS)
  $.ui.status(undefined)
}

export const register: Register = on => {
  // Subagent labels, looked up once per agent; a reload looks them up again.
  const labels = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Zeigt die Prompt-Cache-KPIs dieser Session in einem Panel',
    })
    // A reload runs this again: the line under the prompt comes back from state.
    $.ui.status(statusLine(await read($, stats)))

    return next(e)
  })

  // With focus: on the terminal's main screen no click reaches the pane, so
  // its Button is pressed by key, which needs the pane to hold the keyboard;
  // Escape closes it, there being no close mark to click either.
  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })

    return { text: 'Cache-Panel geöffnet.' }
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await reset($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (result.usage === null) {
      return result
    }

    try {
      const usage = result.usage
      const agentId = e.agentId
      let agentLabel: string | undefined

      if (agentId !== undefined && !labels.has(agentId)) {
        const agent = (await $.agent.list()).find(one => one.id === agentId)
        labels.set(
          agentId,
          agent === undefined ? agentId.slice(0, 8) : `${agent.type} · ${agent.description}`,
        )
      }
      if (agentId !== undefined) {
        agentLabel = labels.get(agentId)
      }

      const sample = {
        at: await $.clock.now(),
        model: usage.model,
        input: usage.input_tokens,
        read: usage.cache_read_input_tokens,
        write: usage.cache_creation_input_tokens,
        messageCount: e.messageCount,
      }

      const updated = await update($, stats, current =>
        record(current, { agentId, agentLabel, turnId: e.turnId, sample }),
      )
      $.ui.status(statusLine(updated))
    } catch (error) {
      $.ui.log(`cache-kpis: request not recorded: ${String(error)}`, { to: 'debug' })
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { main, agents, lastTurn } = await read($, stats)
    const width = e.props.bodyColumns

    const row = (label: string, value: string, color?: 'success' | 'error' | 'warning') => (
      <Text>
        <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
        <Text color={color}>{value}</Text>
      </Text>
    )

    const turnRow = (turn: CacheTurn | null) => {
      const status = turnStatus(turn)

      return row('Letzter Turn', status.text, STATUS_COLOR[status.kind])
    }

    const lastRequestRow = (thread: CacheThread) =>
      thread.lastRequestHit === null
        ? row('Letzter Request', thread.last === null ? '–' : 'Kaltstart')
        : thread.lastRequestHit
          ? row('Letzter Request', `✓ ${formatRate(thread.last && hitRate(thread.last))}`, 'success')
          : row('Letzter Request', `✗ ${formatRate(thread.last && hitRate(thread.last))}`, 'error')

    const lastMissRow = (thread: CacheThread) => {
      const miss = thread.lastMiss

      if (miss === null) {
        return null
      }

      const pause = miss.cause === 'ttl' ? ` nach ${formatGap(miss.gapMs)}` : ''

      return row(
        'Letzter Miss',
        `#${miss.request} ${CAUSE_LABEL[miss.cause]}${pause} · ${formatTokens(miss.lost)}`,
        'warning',
      )
    }

    const agentLine = (agent: CacheThread) => {
      const rate = formatRate(hitRate(agent)).padStart(6)
      const tail = `${rate} ${String(agent.misses).padStart(2)}✗ ${String(agent.requests).padStart(3)}R`
      const room = Math.max(8, width - tail.length - 1)
      const label =
        agent.label.length > room ? `${agent.label.slice(0, room - 1)}…` : agent.label.padEnd(room)

      return (
        <Text>
          <Text dimColor>{label}</Text> <Text color={agent.misses > 0 ? 'warning' : undefined}>{tail}</Text>
        </Text>
      )
    }

    const shown = agents.slice(-Math.max(1, (e.viewport?.rows ?? 30) - 20))

    return (
      <Box flexDirection="column">
        <Text weight="bold">Hauptthread</Text>
        {row('Hit-Rate', formatRate(hitRate(main)))}
        {lastRequestRow(main)}
        {turnRow(lastTurn)}
        {row(
          'Misses',
          main.misses === 0 ? '0' : `${main.misses} (${formatCauses(main.causes)})`,
          main.misses === 0 ? undefined : 'warning',
        )}
        {lastMissRow(main)}
        {row('Verlorene Tokens', formatTokens(main.lost))}
        {row('Requests', String(main.requests))}
        {row('Gelesen', formatTokens(main.read))}
        {row('Geschrieben', formatTokens(main.write))}
        {row('Ungecacht', formatTokens(main.input))}
        <Text> </Text>
        <Text weight="bold">Subagents ({agents.length})</Text>
        {agents.length === 0 && <Text dimColor>Noch keine.</Text>}
        {agents.length > shown.length && (
          <Text dimColor>… {agents.length - shown.length} ältere ausgeblendet</Text>
        )}
        {shown.map(agentLine)}
        <Text> </Text>
        <Button key="reset" label="Zurücksetzen" hotkey="r" onPress={() => reset($)} />
      </Box>
    )
  })
}
