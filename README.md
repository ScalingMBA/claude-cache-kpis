# cache-kpis

A Claude Code mod that shows the prompt-cache KPIs of the active session: hit rate, whether the last turn invalidated the cache, and how many cache misses the session has had, with their likely cause. Subagents are tracked separately.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-kpis --marketplace ScalingMBA/claude-cache-kpis
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; Enter selects it).

From a shell:

```
claude plugin install cache-kpis --marketplace ScalingMBA/claude-cache-kpis
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ScalingMBA/claude-cache-kpis`, then Add plugin.

## What it shows

**Status line under the prompt** (after the first measured request):

```
cache 94.1% · last turn ✓ 99.8% · 3 Req · Misses 2 (TTL 1 · Prefix 1) · Agents 3 · /cache-kpis
```

**`/cache-kpis`** opens a pane with the full table:

- Main thread: session hit rate, last request, last turn, misses by cause, last miss, tokens lost, requests, tokens read / written / uncached
- Subagents: one row each with hit rate, misses and requests
- `r` resets the counters, `Esc` closes the pane

## How a miss is detected

- A request is a miss when it fails to read at least 1,024 tokens of the prefix the thread's previous request had cached (read + written).
- The first request of the main thread or of a subagent is a cold start, not a miss.
- Cause, first that applies: **Compaction** (fewer messages than before), **Model** (model changed), **TTL** (pause of 5 min or more), otherwise **Prefix** (system prompt, tools or memory files changed).
- Hit rate = cache read / (uncached input + cache read + cache written).

Limitation: the mod cannot see whether the cache TTL is 5 min or 1 h. With a 1 h TTL, a miss after a 5–60 min pause is still labelled TTL; the pane shows the pause length so you can judge.

## Tests

```
claude plugin test .
```
