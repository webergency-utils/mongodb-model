---
title: Per-ID Observability Attribution Across Deduplicated Aggregator Batches
date: 2026-10-23
category: architecture-patterns
module: AbstractBaseModel
problem_type: architecture_pattern
component: observability
severity: high
applies_when:
  - Attaching per-call metadata (context, traceID, operation) to microtask-batched Aggregator queries
  - Deduplicating in-flight IDs across concurrent get() and getMany() calls
tags: [observability, aggregator, batching, context-propagation, get-many]
---

# Per-ID Observability Attribution Across Deduplicated Aggregator Batches

## Context
`AbstractBaseModel` (`src/base-model.ts`) batches concurrent `get()` and `getMany()` lookups within the same microtask tick using `@webergency-utils/aggregator`. Because `Aggregator` hashes its additional arguments to decide which calls can share a batch, passing per-call `context`, `traceID`, or `operation` (`'get'` vs `'getMany'`) directly as `Aggregator` arguments would fragment batches whenever two callers supply different metadata.

Conversely, storing per-call metadata in a simple FIFO queue keyed only by `(conversion, scopeKey, access)` and clearing it via `process.nextTick()` fails when an ID is already in flight from an earlier tick: `Aggregator` piggybacks the duplicate ID onto the existing in-flight promise without invoking the batch callback a second time, leaving stale entries in the queue or deleting metadata needed by a newly queued sibling ID.

## Guidance
Keep `Aggregator` batch keys limited to query-affecting parameters (`conversion`, `access`, `scopeKey`, and symbol-hidden `[RESOLVED_ACCESS]`), and track per-call observability metadata in an ID-indexed pending queue (`#pendingBatchMeta`) that is drained by matching normalized DTO IDs inside the `Aggregator` callback and cleaned up in a `finally` block after `await this.#findAggregator.call(...)`:

1. **Skip queue allocation on the fast path:** Only enqueue batch metadata when `#hasAnyObservabilityActive()` is true (`this[GET_OBSERVABILITY_OPTIONS]()` is enabled or event listeners are registered).
2. **Track normalized IDs per entry:** Each `ObservabilityBatchEntry` stores `ids: Set<string>` containing `String(this.dtoID(id))` alongside `operation` (`'get' | 'getMany'`), `context`, and `traceID`.
3. **Consume only the IDs executed by the current batch:** When `#findAggregator` invokes its batch callback with `ids`, convert them via `String(this.dtoID(id))` and remove only those IDs from matching entries in `#pendingBatchMeta`, splicing an entry out when `entry.ids.size === 0`.
4. **Always clean up in `finally`:** After `await this.#findAggregator.call(...)` settles, call `#cleanupBatchMetaEntry(...)` in `finally` so any entry whose IDs were entirely satisfied by an already in-flight batch is removed deterministically without `process.nextTick()` races.

## Why This Matters
- Preserves microtask query batching across `get()` and `getMany()` even when callers pass distinct `options.context` or `options.traceID`.
- Prevents cross-request metadata leakage or unbounded `#pendingBatchMeta` growth when duplicate IDs piggyback on in-flight `Aggregator` promises.
- Respects selective operation filtering (`observability.operations`): when a batch combines `get` and `getMany` callers and only one of the two operations is observed, the batch query event is attributed to the observed operation (`src/base-model.ts`).

## When to Apply
- Any model read path that funnels per-caller options (`context`, `traceID`, operation name) through a shared microtask batcher or deduplicating loader (`Aggregator`).
- Adding new per-call observability fields to `GetOptions` or `GetManyOptions` in `src/types/external.ts`.

## Examples
In `src/base-model.ts`:

```ts
const batchEntry = this.#enqueueBatchMeta( conversion, options?.access, scopeKey, missing,
{
    operation   : 'getMany',
    context     : options?.context,
    traceID     : options?.traceID
});

let fetchedDbes: Array<DBE | null>;

try
{
    fetchedDbes = await this.#findAggregator.call(
        missing,
        conversion,
        { access: options?.access, scopeKey, [RESOLVED_ACCESS]: resolved }
    );
}
finally
{
    this.#cleanupBatchMetaEntry( conversion, options?.access, scopeKey, batchEntry );
}
```

Inside the `#findAggregator` callback in `src/base-model.ts`:

```ts
for( let i = 0; i < queue.length; i++ )
{
    const entry = queue[i];
    let matched = false;

    for( const reqId of requestedIdSet )
    {
        if( entry.ids.delete( reqId ) )
        {
            matched = true;
        }
    }

    if( matched )
    {
        batchEntries.push( entry );
    }

    if( entry.ids.size === 0 )
    {
        queue.splice( i, 1 );
        i--;
    }
}
```

## Related
- `src/base-model.ts` (`#findAggregator`, `#enqueueBatchMeta`, `#cleanupBatchMetaEntry`)
- `src/events.ts` (`isOperationObserved`, `dispatchObservabilityEvent`)
- `src/tests/observability.test.ts`
