# @argszero/dsh-overflow-recovery

A session that overflows the model's context window **and** cannot be summarized
has no way out: every later message replays the same oversized history into the
same 400, so the session is unusable until someone edits the persisted log by
hand. This plugin is the missing fallback — a deterministic, model-free drop of
the oldest part of the model-visible surface, made only when nothing else claimed
the retry.

A [Cordis](https://github.com/deepseek-ai/deepseek-harness) plugin for the
DeepSeek Harness — an independent npm package, mounted through `dsh.bundle.patch`.
It changes no core package and works on the released lines `0.1.7-rc.2`,
`0.2.0-rc.2` and `0.2.1-alpha.2`.

## The defect

When a request exceeds the context window the provider answers a 400, the harness
classifies it as `CONTEXT_WINDOW_EXCEEDED`
(`packages/llm/llm/src/error.ts`), and the turn fails. The shipped recovery is
compaction: summarize the oldest region and retry against the summary.

That works — until summary is itself what cannot fit. The compaction engine sends
the region it is about to remove **through the same route that just refused it**,
so a conversation that overflowed by more than a summary's worth of context
overflows again while summarizing. Thread #9635 reports exactly that shape: one
automatic attempt and three manual `/compact`s failing identically, after which
every message — including a bare `?` — fails the same way. The session is dead,
and the only exit is hand-editing the log.

There is a second shipped reducer, and it does not reach this case either:
`@deepseek-ai/dsh-compaction-tool-result-pruner` shortens the **middle of
tool-result text**. A conversation's weight sits in its user and assistant
messages, which that pruner never touches.

So the product has: a summarizer that cannot fit, and a pruner that reaches the
wrong content. Nothing in it can make an oversized history smaller without a
model — and a model is precisely what is not available.

## What it does

The plugin registers one listener on `agent/request-error`, the waterfall the
agent loop runs its retry decision through
(`packages/llm/llm-retry/src/index.ts` shows the shipped handler). It **calls
`next()` first**:

```ts
const downstream = await settleDownstream(next)
if (downstream.type === 'decision' && downstream.decision !== undefined) return downstream.decision
```

so whichever listener owns the retry — the compaction engine, a provider retry,
another plugin — decides before this one. Only when the chain returns **no
decision at all** (the ordinary outcome once the overflow budget is spent or the
summarizer has failed) does this plugin drop history and answer
`{ kind: 'retry' }`.

Deciding *after* `next()` is what makes listener order irrelevant: mounted before
or after the compaction engine, the summarizer still answers first, and this
plugin is reached only when its answer was "no".

### The drop

One durable replacement, in exactly the shape the shipped producers append
(`packages/compaction/compaction-basic/src/region.ts`):

```text
compaction/prune     shadowedRange, shadowedSeqs, shadowedTokenCount
user/message         surfaceOp: { op: 'replace', startSeq, endSeq }
                     sourceEventSeqs: [pruneSeq, ...shadowedSeqs]
```

The two appends are synchronous and adjacent, because the token meter's surface
fold reads them that way (`packages/token-meter/src/surface-projection.ts`): a
shadow-price event arms a claim for the very next event, and a replacement
consumes it. A replacement with no adjacent claim folds with a **zero** delta,
which would leave the pressure estimate holding the price of content that is no
longer sent — so the pair cannot be split.

The prices come from the meter, never from arithmetic done here, and the two
quantities are deliberately different ones:

| Quantity | Field | Why |
|---|---|---|
| dropped span, retained tail | `node.tokens` | the request pressure the route really charges |
| shadow claim | `node.heuristicTokens` | the value the meter's own O(1) fold re-derives |

They are equal for text-only content and differ for images (a routed adapter that
declares a visual price overrides the heuristic), which is why the suite carries
an image-bearing fixture: without one the distinction is not observable, and a
test asserting it would prove nothing.

### Why the cut cannot wedge the session

Three rules, each one a way a cut could be fatal:

1. **Never surface node 0.** `assertSystemHeadRewrite`
   (`packages/session/src/surface.ts`) permits a replacement covering node 0 only
   when the replacement is itself a `system/message` over exactly that node. The
   system prompt is not this plugin's to rewrite, so the drop starts at index 1.
2. **Never split a tool-call/tool-result pair.** The cut obeys the shipped
   `toolPairingBalancedBefore` predicate from `@deepseek-ai/dsh-compaction`. An
   unbalanced cut would leave an unanswered tool call on the surface — the orphan
   `tool/call` shape that wedges a session permanently — so the cut is moved back
   until it is balanced, not merely until the budget is met.
3. **Retain a priced newest tail**, floored by a node count so one oversized node
   cannot pull the retained tail back past the current exchange.

A replacement that would not be **smaller than the span it shadows** is refused
outright: trading one overflow for the same overflow and spending the incident's
retry doing it is worse than leaving the error alone. This is the same refusal
the shipped compaction makes when its summary does not shrink the span.

The log keeps every dropped event — nothing is deleted, and a replay can still
read them. Only the model-visible surface changes.

## Install

```sh
npm install @argszero/dsh-overflow-recovery
```

Then mount it from your profile's bundle patch (`dsh.bundle.patch`):

```yaml
- insert:
    - id: overflow-recovery
      name: '@argszero/dsh-overflow-recovery'
```

Or, if you compose `cordis.yml` by hand:

```yaml
- set:
    - id: overflow-recovery
      name: '@argszero/dsh-overflow-recovery'
      config:
        mode: recover
```

## Configuration

| Key | Values | Default | Meaning |
|---|---|---|---|
| `mode` | `recover` | ✅ | Drop the oldest droppable region and retry the request. |
| | `report` | | Write nothing; log the reduction `recover` would have made. Diagnostic only — the turn still fails, because the request did not change. |
| | `off` | | Install no listener at all. |
| `retainTokens` | number | `24000` | Estimated tokens to keep verbatim at the newest end of the surface. |
| `retainMinNodes` | number | `4` | Never retain fewer than this many newest surface nodes. |
| `maxRecoveries` | number | `3` | Most recoveries performed on one live session before it stops claiming the retry. |

An unrecognised `mode` is refused at mount rather than quietly replaced, because a
deployment that misspells a mode must not silently get a different one. The
numeric knobs are **clamped** instead: a nonsensical bound (`NaN`, a negative, a
non-number) falls back to its default, because refusing it would turn a
recoverable deployment into a plugin that never loads.

`maxRecoveries` bounds attempts to un-wedge **one incident**, not one session: a
committed `assistant/message` is the session answering again, so the counter
resets there. A long-lived session that overflows twice months apart is two
incidents and gets two budgets. Only a performed recovery counts — a refused drop
or a `report`-mode observation spends nothing.

## Diagnostics

`recover` logs what it dropped, how much it estimates that was worth, and the
price of the notice that replaced it:

```
overflow-recovery: dropped 9 surface message(s) worth ~7046 tokens in session … (the notice prices at ~120); the shadowed events remain in the log and this request is retried against the reduced surface
```

`report` logs the same reduction with `would drop …; this mode writes nothing and
the request is left to fail unchanged` — the wording differs because writing a
line about a drop in a mode that performs none would make the two modes
indistinguishable in the log a user reads.

Every refusal explains itself the same way: nothing droppable between the system
head and the retained tail, a session that refused the append, a downstream
listener that threw, or the recovery bound being reached.

## What it is not

- **It is not lossless, and it does not pretend to be.** Content the model would
  otherwise have seen is gone from the request, and the notice left in its place
  says so and tells the model to ask rather than guess. The user can still see the
  full conversation; only what is sent changes.
- **It is not a summarizer.** It is the last resort for the case where
  summarization is exactly what cannot fit. When a summary *can* be produced, the
  shipped engine answers first and this plugin never acts.
- **It is not the fix.** Two of the three mechanisms behind the dead end are core,
  and both are algorithm changes this plugin deliberately does not attempt: the
  surface-token estimate can sit below what the provider counts, and the
  summarizer replays the very region it means to remove through the route that
  just refused it. The third — that nothing can shrink a history without a model —
  is a missing capability rather than a wrong number, and that one this plugin
  supplies from the outside.
- **It cannot help when the overflowing content is not in the middle of the
  surface.** The system prompt and the tool definitions are not droppable by
  anyone; when those alone exceed the window, `maxRecoveries` bounds the cost and
  the original error is what the user finally sees.

## Evidence

- `test/guard.spec.mjs` — the real `agent/request-error` waterfall through the
  shipped `agentEvents` dispatcher: the decision, the deferral to a downstream
  claim (both registration orders), the refusal shapes, and the bound.
- `test/surface.spec.mjs` — the shape of the surface a drop leaves: the system
  head survives, the retained tail is byte-identical and in order, no tool pair is
  split (including a fixture where the token budget **alone** would land
  mid-pair), and each price is read from the field it belongs to.
- `test/harness.mjs` — a real Cordis context carrying the real `LlmRuntime`,
  `SessionProjectionRegistry`, `TokenMeter` and `SessionStore`, so the surface
  fold, the append validation and the prices are the shipped ones.
- `npm run test:inject` — mutates the source, rebuilds, and requires each mutation
  to be caught by the suite. An arm whose mutation leaves the suite green proves
  nothing about the test that was supposed to hold the line, and is reported as
  `SILENT`.
- `npm run probe:lines` — runs the suite once per released line, which is where
  the supported-lines list above comes from.

## License

MIT.
