---
title: "Query Context, Rich Caller Metadata, and Selective Operation Observability - Plan"
type: feat
date: 2026-10-23
status: completed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Query Context, Rich Caller Metadata, and Selective Operation Observability - Plan

## Goal Capsule

- **Objective**: Enable applications using `@webergency-utils/mongodb-model` to log every MongoDB query and mutation with full request context, caller query inputs, and internal pre-query attribution while incurring zero observability overhead on disabled read queries.
- **Means**: Extend `ObservabilityOptions` and `dispatchObservabilityEvent` in `src/events.ts` with precomputed O(1) operation filtering (`observability.operations`), three-tier synchronous `context` merging (`options.context` > `flowGet('context')` > `observability.context`), structured `ModelQueryContext` metadata, and `internal: true` pre-query emission across `src/base-model.ts`, `src/model.ts`, and `src/property-model.ts` (`KTD1`, `KTD2`, `KTD3`, `KTD4`).
- **Authority hierarchy**: Product Contract `### Requirements` (`R1`–`R5`) govern product behavior; `## Planning Contract` `### Key Technical Decisions` (`KTD1`–`KTD4`) govern implementation mechanisms within those constraints; `## Implementation Units` (`U1`–`U4`) execute those decisions without overriding either.
- **Stop conditions**: Stop and surface to the user if any change would break existing `Aggregator` batching for `get`/`getMany`, alter compiled MongoDB aggregation pipelines when `context`/`traceID` are passed, or regress existing test suites.
- **Execution profile**: Sequential unit execution (`U1` -> `U2` -> `U3` -> `U4`) enforcing `radixxko-format` code style and unit/integration verification gates.
- **Tail ownership**: `ce-work` owns implementation, verification, and commit steps.

---

## Product Contract

*Product Contract preservation: Product Contract unchanged.*

### Summary

Extend the `mongodb-model` observability system so applications can log every MongoDB query and mutation with full request context and caller query inputs while keeping read-heavy workloads fast when only specific operations (such as mutations) are observed. This adds three-tier `context` resolution (`options.context` > `models.scope` `flowGet('context')` > `observability.context`), richer caller metadata on query/mutation/error events, `internal: true` pre-query emission with `parentOperation` attribution, and configurable operation filtering (`observability.operations`) backed by an O(1) fast-path check before payload or context assembly.

### Problem Frame

Applications using `@webergency-utils/mongodb-model` in multi-tenant or request-scoped backend services need audit and diagnostic visibility into which user, tenant, or HTTP route triggered a database operation, what high-level model query inputs produced a given aggregation pipeline, and why extra MongoDB queries ran before a mutation. At the same time, many production deployments only log mutations (`create`, `update`, `delete`) plus slow queries and errors, so assembling rich query metadata or resolving `@liqd-js/flow` context on every `get`, `find`, or `list` call when read logging is disabled would add unnecessary CPU and allocation overhead on the hot path.

### Key Decisions

- **Ambient + per-call context and richer query metadata** (`session-settled: user-approved — chosen over only ambient context or only query metadata: both caller correlation and high-level model query inputs are required to diagnose queries`):
  - Rationale: Request correlation (`traceID`, `userID`, `tenant`, `route`) and high-level model query inputs (`filter`, `smartFilter`, `computedProperties`, `sort`, `limit`, `skip`, `cursor`, `access`, `ids`, `parentID`) are both required to understand why a query or mutation executed and who initiated it. Governs `R3`, `R4`.
- **Three-tier context merge priority** (`session-settled: user-approved — chosen over a single context source: supports zero-boilerplate ambient context while allowing scoped and per-call overrides`):
  - Rationale: Merging `per-call options.context` (highest priority) > `flowGet('context')` set via `models.scope` (`start`/`assign`/`set`/`execute`) > `observability.context` (a synchronous resolver `() => Record<string, unknown> | undefined` or array of `@liqd-js/flow` key names `string[]`) supports zero-boilerplate ambient context while allowing scoped and per-call overrides. Governs `R3`.
- **Internal pre-query emission with `internal: true` and `parentOperation`** (`session-settled: user-approved — chosen over silent internal pre-queries or a separate event type: makes every DB round-trip visible on the query channel while remaining filterable`):
  - Rationale: Mutations that run preliminary DB queries (`AbstractModel.#resolveFilterMatch` when `smartFilter.pipeline` is present, `AbstractModel.#findOneAndUpdateWithSnapshots` when fetching `documentBefore`, `AbstractModel.create` when `duplicateIgnore: true` falls back to `findOne`, and `AbstractPropertyModel.#findMatchingSubdocIds`) perform real MongoDB round-trips; emitting `query` events with `internal: true` and `parentOperation` makes every DB trip visible and attributable. Governs `R4`, `R5`.
- **Selective operation filtering (`observability.operations`) with zero-overhead fast path** (`session-settled: user-approved — chosen over coarse-only categories or strict suppression of slowQuery/internal when reads are disabled: allows mutation-only logging with zero read overhead while preserving slowQuery and error visibility`):
  - Rationale: Supporting both high-level categories (`'query'`, `'mutation'`, `'create'`, `'update'`, `'delete'`, `'cache'`, `'error'`, `'slowQuery'`, `'internal'`) and exact operation names (`'get'`, `'getMany'`, `'find'`, `'list'`, `'stream'`, `'aggregate'`, `'count'`, `'exists'`, `'create'`, `'createFrom'`, `'createMany'`, `'update'`, `'updateOne'`, `'updateMany'`, `'delete'`, `'deleteMany'`) as either an array or boolean map lets users log only mutations in production. Skipping payload and context construction when an operation is disabled — unless `slowQueryMs` is exceeded or an `error` occurs, and inheriting internal pre-query enablement from `parentOperation` — eliminates read-path overhead. Governs `R1`, `R2`, `R5`.

### Requirements

**Selective Operation Filtering and Fast-Path Gating**

- R1. **Selective Operation Filtering (`observability.operations`)**:
  - `ObservabilityOptions` in `src/events.ts` must accept `operations?: ObservabilityOperationFilter[] | Partial<Record<ObservabilityOperationFilter, boolean>>`.
  - `ObservabilityOperationFilter` must include category tokens (`'query'`, `'mutation'`, `'create'`, `'update'`, `'delete'`, `'cache'`, `'error'`, `'slowQuery'`, `'internal'`) and exact `ModelQueryOperation | ModelMutationOperation` names (`'get'`, `'getMany'`, `'find'`, `'list'`, `'stream'`, `'aggregate'`, `'count'`, `'exists'`, `'create'`, `'createFrom'`, `'createMany'`, `'update'`, `'updateOne'`, `'updateMany'`, `'delete'`, `'deleteMany'`).
  - Category tokens expand as follows:
    - `'query'` -> `'get'`, `'getMany'`, `'find'`, `'list'`, `'stream'`, `'aggregate'`, `'count'`, `'exists'`.
    - `'mutation'` -> `'create'`, `'createFrom'`, `'createMany'`, `'update'`, `'updateOne'`, `'updateMany'`, `'delete'`, `'deleteMany'`.
    - `'create'` -> `'create'`, `'createFrom'`, `'createMany'`.
    - `'update'` -> `'update'`, `'updateOne'`, `'updateMany'`.
    - `'delete'` -> `'delete'`, `'deleteMany'`.
  - When `operations` is omitted, all operations and event types are enabled.
  - When `operations` is provided as an array or boolean map:
    - Only the specified categories/operations are enabled for `query`, `mutation`, and `cache` events; boolean map entries set to `false` explicitly disable an operation or category even if a broader category (such as `'mutation'` or `'internal'`) is `true`.
    - `error` events remain enabled by default unless `'error'` is explicitly set to `false` in a boolean map (or `onError` / `logger` / `error` listeners are absent).
    - `slowQuery` events remain enabled whenever `slowQueryMs` is configured (unless `'slowQuery'` is explicitly set to `false` in a boolean map), even when regular `'query'` events are disabled.
    - Internal pre-queries (`internal: true`) are enabled when either their `parentOperation` is enabled OR `'internal'` is explicitly enabled, unless `'internal': false` is explicitly set in a boolean map.
- R2. **Zero-Overhead Fast-Path Gating**:
  - `ModelEventEmitter` in `src/events.ts` must expose `hasListeners(event?: ModelEventName): boolean` (O(1) check on `#listeners`).
  - `resolveObservabilityOptions` must precompute an internal lookup structure so checking whether an operation/event should be observed is O(1).
  - `AbstractBaseModel` must check whether an event has any active consumer (either local `this._events.hasListeners(event)`, global `this._models` event listeners, or enabled `ObservabilityOptions` for that operation, or `slowQueryMs` threshold reached for `query`/`mutation`) **before** building `query` metadata objects or resolving `context` / `traceID` from `@liqd-js/flow`.

**Context Resolution and Caller Metadata**

- R3. **Three-Tier Context Resolution (`context` & `traceID`)**:
  - `ObservabilityOptions` must accept `context?: string[] | (() => Record<string, unknown> | undefined)`.
    - When `context` is `string[]`, each key is looked up via `flowGet(key)` and keys with `undefined` values are omitted.
    - When `context` is a function, it is invoked synchronously inside `safeCall` (catching errors safely without breaking the query) when an event is emitted.
  - Ambient scoped context stored via `models.scope` under the `'context'` key (`flowGet('context')`) must be merged on top of `observability.context` if it is a plain object.
  - Public query and mutation option types in `src/types/external.ts` (`GetOptions`, `GetManyOptions`, `ModelFindOptions`, `PropertyModelFindOptions`, `ModelListOptions`, `PropertyModelListOptions`, `ModelStreamOptions`, `PropertyModelStreamOptions`, `ModelAggregateOptions`, `PropertyModelAggregateOptions`, `ModelCreateOptions`, `ModelUpdateOptions`, `ModelDeleteOptions`, and `ModelExistsOptions`) must accept optional `context?: Record<string, unknown>` and `traceID?: string`.
  - When an event is emitted, `context` is merged in priority order (`per-call options.context` > `flowGet('context')` > `observability.context`) and attached to `ModelQueryEvent`, `ModelMutationEvent`, `ModelSlowQueryEvent`, `ModelCacheEvent`, and `ModelErrorEvent` (omitted when all three sources are empty/undefined).
  - Per-call `options.traceID` takes priority over `flowGet('traceID')`.
- R4. **Rich Caller Query & Mutation Metadata**:
  - `ModelQueryEvent` (and `ModelSlowQueryEvent` when triggered by a query) must include:
    - `context?: Record<string, unknown>`
    - `internal?: boolean`
    - `parentOperation?: ModelMutationOperation`
    - `query?: ModelQueryContext` containing the caller's inputs when present: `ids?: unknown[]`, `parentID?: unknown`, `filter?: Document`, `smartFilter?: Record<string, unknown>`, `computedProperties?: string[]`, `sort?: Record<string, 1 | -1>`, `limit?: number`, `skip?: number`, `cursor?: string`, `access?: string | boolean | Document`.
  - `ModelMutationEvent` (and `ModelSlowQueryEvent` when triggered by a mutation) must include:
    - `context?: Record<string, unknown>`
    - `smartFilter?: Record<string, unknown>`
    - `parentID?: unknown`
    - alongside existing `ids`, `filter`, `update`, `matchedCount`, `modifiedCount`, `deletedCount`, `insertedCount`, `duration`, `converterDuration`, `traceID`.
  - `ModelCacheEvent` and `ModelErrorEvent` must include `context?: Record<string, unknown>`, and `ModelErrorEvent` must include optional `query?: ModelQueryContext`, `filter?: Document`, `smartFilter?: Record<string, unknown>`, and `parentID?: unknown` when an error occurs during a query or mutation.

**Internal Pre-Query Observability**

- R5. **Internal Pre-Query Observability**:
  - Every internal MongoDB query executed as part of a mutation must measure its duration and emit a `query` event with `internal: true` and `parentOperation` set to the enclosing mutation operation (plus `context` and `traceID` inherited from the enclosing mutation call):
    1. `AbstractModel.#resolveFilterMatch` (`src/model.ts`) when `smartFilter.pipeline` runs `this.collection.aggregate(pipeline)` -> `operation: 'aggregate'`, `internal: true`, `parentOperation: 'updateOne' | 'updateMany' | 'deleteMany'`.
    2. `AbstractModel.#findOneAndUpdateWithSnapshots` (`src/model.ts`) when fetching `documentBefore` via `this.collection.findOne(match)` -> `operation: 'get'`, `internal: true`, `parentOperation: 'update' | 'updateOne'`.
    3. `AbstractModel.create` (`src/model.ts`) when `duplicateIgnore: true` catches error `11000` and runs `this.collection.findOne(e.keyValue)` -> `operation: 'get'`, `internal: true`, `parentOperation: 'create'`.
    4. `AbstractPropertyModel.#findMatchingSubdocIds` (`src/property-model.ts`) when running `this.collection.aggregate(pipeline)` -> `operation: 'aggregate'`, `internal: true`, `parentOperation: 'update' | 'updateOne' | 'updateMany' | 'delete' | 'deleteMany'`.

### Acceptance Examples

- AE1. **Mutation-only logging with ambient & per-call context**:
  - **Covers**: `R1`, `R2`, `R3`, `R4`
  - **Given**: `Models` configured with `observability: { operations: ['mutation'], context: ['userID', 'tenant'], onMutation: (e) => logs.push(e), onQuery: (e) => queryLogs.push(e) }` and an active `models.scope.start` containing `{ userID: 'u1', tenant: 't1', context: { route: 'POST /users' } }`.
  - **When**: `users.find({ filter: { active: true } })` and `users.updateOne({ active: true }, { $set: { role: 'admin' } }, { context: { reason: 'promote' } })` execute.
  - **Then**: `onQuery` receives 0 events and context resolution is not invoked for `find`; `onMutation` receives 1 event with `context: { userID: 'u1', tenant: 't1', route: 'POST /users', reason: 'promote' }` and `filter: { active: true }`.
- AE2. **Slow read query still fires when only mutations are enabled**:
  - **Covers**: `R1`, `R2`, `R3`, `R4`
  - **Given**: `observability: { operations: ['mutation'], slowQueryMs: 50, onQuery, onSlowQuery }`.
  - **When**: `users.list(...)` takes `80ms`.
  - **Then**: `onQuery` is not called, while `onSlowQuery` is called once with `duration >= 50`, `thresholdMs: 50`, `context`, and `query` metadata (`filter`, `sort`, `limit`, `cursor`).
- AE3. **Internal pre-query attribution on mutation**:
  - **Covers**: `R1`, `R4`, `R5`
  - **Given**: `observability: { operations: ['update'] }` on a `PropertyModel`.
  - **When**: `propertyModel.updateMany({ status: 'pending' }, { $set: { status: 'done' } }, { context: { jobID: 'j1' } })` runs, and then runs again with `operations: { update: true, internal: false }`.
  - **Then**: In the first call, `#findMatchingSubdocIds` emits a `query` event (`operation: 'aggregate'`, `internal: true`, `parentOperation: 'updateMany'`, `context: { jobID: 'j1' }`) followed by the `mutation` event (`operation: 'updateMany'`, `context: { jobID: 'j1' }`). In the second call (`internal: false`), only the `mutation` event is emitted.
- AE4. **Fine-grained operation selection**:
  - **Covers**: `R1`, `R2`
  - **Given**: `observability: { operations: ['find', 'aggregate', 'update', 'delete'] }`.
  - **When**: `get`, `getMany`, `count`, `exists`, `create`, `find`, `aggregate`, `updateOne`, and `deleteMany` execute.
  - **Then**: `get`, `getMany`, `count`, `exists`, and `create` emit no events (unless slow or error), while `find`, `aggregate`, `updateOne`, and `deleteMany` emit events with full context and caller metadata.

### Scope Boundaries

- External logging/tracing SDK integrations (OpenTelemetry spans, Pino/Winston transports) are out of scope; callers consume typed callbacks (`onQuery`, `onMutation`, `onSlowQuery`, `onCache`, `onError`, `logger`, or `.on(...)`).
- Asynchronous `observability.context` functions are out of scope to guarantee event dispatch remains synchronous and non-blocking.
- Driver-level `MongoClient` command monitoring is out of scope.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Precomputed non-enumerable operation filter and O(1) `_shouldObserve` fast path** (`session-settled: user-approved — chosen over per-event array/map scanning or unconditional payload construction: keeps disabled read queries zero-overhead while preserving Object.keys(options) compatibility`). Governs `R1`, `R2`, `R5`.
  - `resolveObservabilityOptions` compiles `options.operations` once into a non-enumerable symbol property `[RESOLVED_OPERATION_FILTER]` containing `{ queryOps: Set<ModelQueryOperation>, mutationOps: Set<ModelMutationOperation>, cache: boolean, error: boolean, slowQuery: boolean, internal: boolean | 'inherit' }`, re-attaching `[RESOLVED_OPERATION_FILTER]` whenever `parentOptions` is spread (`config === true` or `config.operations === undefined`) and caching `#resolvedObservability` on both `AbstractModels` and `AbstractBaseModel`.
  - `ModelEventEmitter.hasListeners(event)` and `AbstractModels[HAS_OBSERVABILITY_LISTENERS](event)` provide O(1) listener checks.
  - `AbstractBaseModel._shouldObserve(event, operation, duration, extra)` evaluates in O(1) whether `(isOperationObserved(options, event, operation, extra) && hasActivePrimaryConsumer)` or `(isSlowQueryObserved(options, duration) && hasActiveSlowQueryConsumer)`. When false, `_emitQuery` / `_emitMutation` / `_emitCache` return immediately before constructing `ModelQueryContext` or resolving `@liqd-js/flow` context.
  - When a `query` or `mutation` operation is disabled in `options.operations` but `duration >= options.slowQueryMs` (and `slowQuery` is enabled), `dispatchObservabilityEvent` suppresses the primary `query`/`mutation` callbacks and emits only the `slowQuery` event.
- KTD2. **Lazy synchronous three-tier context resolution in `dispatchObservabilityEvent`** (`session-settled: user-approved — chosen over eager per-call context resolution before query execution: avoids flowGet and callback overhead when operations are not observed`). Governs `R2`, `R3`.
  - `resolveObservabilityContext(optionsContext, payloadContext)` runs inside `dispatchObservabilityEvent` only after `_shouldObserve` passes.
  - It evaluates `options?.context` first (calling `flowGet(k)` for `string[]` or invoking the function inside a `try/catch` warning guard), overlays `flowGet('context')` when it is a plain object, and finally overlays `payload.context` (per-call `options.context`). If no keys are produced across all three tiers, `context` remains `undefined` on the event payload.
- KTD3. **Shared batch metadata queue on `#findAggregator` and distinct `'getMany'` / `'count'` operations** (`session-settled: user-approved — chosen over string keys on accessCtx or delegating count() directly to public aggregate(): preserves same-tick get/getMany batching and lets operations filter get vs getMany and count vs aggregate`). Governs `R1`, `R3`, `R4`.
  - `@webergency-utils/aggregator` groups batch items by `objectStringify(args)` (which serializes enumerable `Symbol` keys) and only retains the first call's `args` for a given batch ID. To preserve same-tick batching and capture every caller's metadata in a batch, `AbstractBaseModel` accumulates per-call `{ operation: 'get' | 'getMany', context, traceID, access }` entries in a private `#pendingBatchMeta = new Map<string, ObservabilityBatchEntry[]>()` keyed by the batch's `${String(conversion)}:${accessCtx.scopeKey ?? ''}:${accessCtx.access ?? ''}` key and drains that queue at the start of the `#findAggregator` batch callback.
  - When `#findAggregator` executes a batch, if all callers in the drained queue used `'getMany'`, `operation` is `'getMany'`; otherwise `'get'` (or whichever of `'get'` / `'getMany'` is enabled in `options.operations`). Any per-call `context` objects in the batch are shallow-merged in call order, and `query.ids` records the deduplicated batch IDs.
  - `AbstractBaseModel.count` delegates to a shared `#executeAggregate(pipeline, options, operation)` helper with `operation: 'count'` instead of calling `this.aggregate` directly, so `model.count()` emits `operation: 'count'` (with `resultCount` set to the count value) and is gated by `'count'` rather than `'aggregate'`.
- KTD4. **Clean option stripping in `aggregate()`, `list()`, and `src/operations.ts` disambiguators**. Governs `R3`, `R4`.
  - `AbstractBaseModel.#executeAggregate` strips `context` and `traceID` before checking `isSet(pipelineOptions)` so root `model.aggregate(pipeline, { context })` does not inadvertently trigger `this.pipeline()` and inject `computedProperties`.
  - `AbstractModel.list` and `AbstractPropertyModel.list` strip `context` and `traceID` before calling `resolveBSONObject(options)` so request context is never BSON-cloned or treated as a pipeline parameter.
  - `isCreateOptionsObject` and `isFindOptionsObject` in `src/operations.ts` include `'context'` and `'traceID'` in their recognized option keys, and `normalizeFindMatch` / `normalizeExistsOptions` accept `optionsOrAccess?: string | { access?: string, context?: Record<string, unknown>, traceID?: string }` and forward `context` and `traceID` only when `!== undefined` so existing return shapes remain unchanged when omitted.

### High-Level Technical Design

```mermaid
flowchart TB
    Caller["Model Method Call (get, find, list, create, update*, delete*)"]
    PreQuery{"Runs Internal Pre-Query?"}
    ExecPre["Execute Pre-Query (#resolveFilterMatch, #findOneAndUpdateWithSnapshots, create 11000, #findMatchingSubdocIds)"]
    FastPathPre{"_shouldObserve('query', op, duration, { internal: true, parentOperation })?"}
    EmitPre["dispatchObservabilityEvent('query', { internal: true, parentOperation, query, ... })"]
    ExecMain["Execute Main MongoDB Operation"]
    FastPathMain{"_shouldObserve(event, op, duration)?"}
    Skip["Return Result (Zero Context/Metadata Overhead)"]
    ResolveCtx["Resolve traceID & Merge 3-Tier Context (observability.context < flowGet('context') < options.context)"]
    PrimaryCheck{"Primary Operation Enabled in operations?"}
    DispatchPrimary["Emit to localEmitter, models, onQuery/onMutation, logger"]
    SlowCheck{"duration >= slowQueryMs & slowQuery Enabled?"}
    DispatchSlow["Emit 'slowQuery' to localEmitter, models, onSlowQuery, logger.warn"]

    Caller --> PreQuery
    PreQuery -->|Yes| ExecPre
    ExecPre --> FastPathPre
    FastPathPre -->|Yes| EmitPre
    FastPathPre -->|No| ExecMain
    EmitPre --> ExecMain
    PreQuery -->|No| ExecMain
    ExecMain --> FastPathMain
    FastPathMain -->|No| Skip
    FastPathMain -->|Yes| ResolveCtx
    ResolveCtx --> PrimaryCheck
    PrimaryCheck -->|Yes| DispatchPrimary
    PrimaryCheck -->|No (Slow-only path)| SlowCheck
    DispatchPrimary --> SlowCheck
    SlowCheck -->|Yes| DispatchSlow
    SlowCheck -->|No| Skip
    DispatchSlow --> Skip
```

### Sequencing

1. **U1** establishes the core types, symbols, operation filter compiler, `hasListeners`, and three-tier context resolver in `src/symbols.ts`, `src/events.ts`, `src/models.ts`, `src/types/external.ts`, `src/operations.ts`, and `src/index.ts`.
2. **U2** wires fast-path gating (`_shouldObserve`), lazy metadata construction, `#findAggregator` symbol metadata, and `#executeAggregate` (`count` vs `aggregate`) in `src/base-model.ts`.
3. **U3** wires caller query/mutation metadata, `context`/`traceID` propagation, and the 4 internal pre-query emission sites in `src/model.ts` and `src/property-model.ts`.
4. **U4** adds comprehensive unit test suites in `src/tests/observability.test.ts` and `src/tests/operations.test.ts` covering `AE1`–`AE4` and edge cases.

---

## Implementation Units

### U1. Observability Types, Selective Operation Filter, and Three-Tier Context Dispatcher

- **Goal**: Extend observability types, option normalizers, and `dispatchObservabilityEvent` to support selective `operations` filtering, O(1) listener checks, and three-tier `context` + `traceID` resolution.
- **Requirements**: `R1`, `R2`, `R3`, `R4`
- **Dependencies**: None
- **Files**:
  - `src/symbols.ts`
  - `src/events.ts`
  - `src/models.ts`
  - `src/types/external.ts`
  - `src/operations.ts`
  - `src/index.ts`
- **Approach**:
  1. In `src/symbols.ts` (and re-exported in `src/index.ts`), add `HAS_OBSERVABILITY_LISTENERS` and `RESOLVED_OPERATION_FILTER` symbols (`KTD1`).
  2. In `src/events.ts`, define `ObservabilityOperationCategory`, `ObservabilityOperationFilter`, `ObservabilityContextResolver`, and `ModelQueryContext`; extend `ModelQueryEvent`, `ModelMutationEvent`, `ModelCacheEvent`, `ModelErrorEvent` (including `query`, `filter`, `smartFilter`, `parentID`, `context`), and `ObservabilityOptions` per `R1`, `R3`, `R4`.
  3. Implement `compileOperationFilter(operations)` in `src/events.ts` and attach the compiled result to `[RESOLVED_OPERATION_FILTER]` (via `Object.defineProperty(..., { enumerable: false })`) inside `resolveObservabilityOptions`, preserving `parentOptions?.[RESOLVED_OPERATION_FILTER]` when `config === true` or `config.operations === undefined` (`KTD1`). Export helper predicates `isOperationObserved(options, event, operation, extra)` and `isSlowQueryObserved(options, duration)` for `AbstractBaseModel` and `dispatchObservabilityEvent`.
  4. Add `hasListeners(event?: ModelEventName): boolean` to `ModelEventEmitter` in `src/events.ts`, and implement `[HAS_OBSERVABILITY_LISTENERS](event?: ModelEventName): boolean` plus cached `#resolvedObservability` in `AbstractModels` (`src/models.ts`).
  5. Update `dispatchObservabilityEvent` in `src/events.ts` to lazily resolve `traceID` and three-tier `context` (`KTD2`), gate primary event emission (`localEmitter`, `models`, `onQuery`/`onMutation`/`onCache`/`onError`, `logger`) using `isOperationObserved`, and independently evaluate `isSlowQueryObserved` so slow read queries still emit `slowQuery` even when `'query'` is disabled (`R1`, `KTD1`).
  6. Extend all public query/mutation option types in `src/types/external.ts` (including adding `ModelExistsOptions`) with `context?: Record<string, unknown>` and `traceID?: string`, re-export the new observability types in `src/types/external.ts` and `src/index.ts`, and update `isCreateOptionsObject`, `isFindOptionsObject`, `normalizeFindMatch(match, optionsOrAccess)`, and `normalizeExistsOptions(idOrFilter, optionsOrAccess, idField)` in `src/operations.ts` (`KTD4`).
- **Patterns to follow**:
  - Symbol-based internal communication in `src/symbols.ts` and `src/models.ts`
  - `safeCall` error-isolation wrapper in `src/events.ts`
  - `radixxko-format` code style (Allman braces, spaces inside parens, aligned colons)
- **Test scenarios**:
  - `resolveObservabilityOptions` compiles array and boolean-map `operations` configs without adding enumerable properties to the returned `ObservabilityOptions` object.
  - Category expansion maps `'query'`, `'mutation'`, `'create'`, `'update'`, `'delete'` to their exact operations, and boolean map `false` entries override broader `true` categories (e.g. `{ mutation: true, delete: false }` or `{ update: true, internal: false }`).
  - `dispatchObservabilityEvent` merges `observability.context` (`string[]` or function) < `flowGet('context')` < `payload.context`, handles throwing `observability.context` functions via `safeCall` without throwing, and omits `context` when all tiers are empty.
  - `isCreateOptionsObject`, `isFindOptionsObject`, `normalizeFindMatch`, and `normalizeExistsOptions` recognize `{ context, traceID }` as option keys without mutating return shapes when `context`/`traceID` are undefined.
- **Verification**: TypeScript compiles cleanly and unit tests in `src/tests/operations.test.ts` and `src/tests/observability.test.ts` pass.

### U2. Base Model Fast-Path Gating, Batched Get Metadata, and Read Query Context

- **Goal**: Wire O(1) `_shouldObserve` gating, lazy `ModelQueryContext` construction, batched `get`/`getMany` observability metadata, and `count` vs `aggregate` separation in `AbstractBaseModel`.
- **Requirements**: `R1`, `R2`, `R3`, `R4`
- **Dependencies**: `U1`
- **Files**:
  - `src/base-model.ts`
- **Approach**:
  1. Cache `#resolvedObservability` on `AbstractBaseModel` in `[GET_OBSERVABILITY_OPTIONS]()` and add `protected _shouldObserve(event: ModelEventName, operation?: string, duration?: number, extra?: { internal?: boolean, parentOperation?: ModelMutationOperation }): boolean` returning `true` iff `(isOperationObserved(options, event, operation, extra) && hasActivePrimaryConsumer)` or `((event === 'query' || event === 'mutation') && isSlowQueryObserved(options, duration) && hasActiveSlowQueryConsumer)` (`KTD1`).
  2. Guard `_emitQuery`, `_emitMutation`, `_emitCache`, and `_emitError` (extending `_emitError` with `extra?: Partial<Omit<ModelErrorEvent, 'collection' | 'model' | 'error' | 'operation' | 'duration'>>`) with `_shouldObserve`, and accept a lazy metadata builder or `extra` object so callers can avoid building `ModelQueryContext` when `_shouldObserve` returns `false` (`R2`, `KTD1`).
  3. In `get` and `getMany`, push `{ operation: 'get' | 'getMany', context: options.context, traceID: options.traceID, access: options.access }` into `this.#pendingBatchMeta` keyed by `${String(conversion)}:${accessCtx.scopeKey ?? ''}:${accessCtx.access ?? ''}` before calling `#findAggregator.execute` (keeping `accessCtx` identical for `objectStringify` batching per `KTD3`), pass `context` and `traceID` to `_emitCache('hit' | 'miss' | 'set')`, and drain the batch queue in `#findAggregator` to resolve the batch `operation` (`'get'` vs `'getMany'`), merged `context`, `traceID`, and `query: { ids: flatIds, ...(access !== undefined ? { access } : {}) }`.
  4. Update `find`, `exists` (typed with `options?: ModelExistsOptions`), and a shared `#executeAggregate(pipeline, options, operation: 'aggregate' | 'count')` helper so `find` and `exists` attach `query` metadata (`filter`, `smartFilter`, `sort`, `access`, `ids`), `context`, and `traceID`, while `aggregate` and `count` strip `context` and `traceID` before `isSet(pipelineOptions)` and emit `'aggregate'` and `'count'` respectively (`KTD3`, `KTD4`).
  5. Wrap the MongoDB driver execution calls in `find`, `#executeAggregate`, and `exists` in `try/catch` blocks that pass `{ query, filter, context, traceID }` to `this._emitError(e, operation, Date.now() - start, ...)` before rethrowing `e` (`R4`).
- **Patterns to follow**:
  - `[RESOLVED_ACCESS]` symbol attachment on `accessCtx` in `src/base-model.ts`
  - Existing `_emitQuery` / `_emitCache` / `_emitError` helpers in `src/base-model.ts`
- **Test scenarios**:
  - Same-tick `model.get('1', { context: { a: 1 } })` and `model.getMany(['2', '3'], { context: { b: 2 } })` still execute a single `collection.aggregate` batch call and emit merged `query.ids: ['1', '2', '3']` and `context: { a: 1, b: 2 }`.
  - Standalone `model.getMany(['1', '2'])` emits `operation: 'getMany'`, and `model.count({ status: 'active' })` emits `operation: 'count'` (not `'aggregate'`).
  - Passing `{ context: { reqId: 'r1' }, traceID: 't1' }` to `model.aggregate(pipeline, { context: { reqId: 'r1' }, traceID: 't1' })` on a root model with `computedProperties` does not trigger `this.pipeline()` or inject `$addFields`.
  - When `operations: ['mutation']` is configured and no `.on('query')` listener is registered, calling `get`, `getMany`, `find`, `aggregate`, `count`, or `exists` does not invoke `observability.context`.
- **Verification**: All existing `src/tests/model.get.test.ts`, `src/tests/model.find.test.ts`, and `src/tests/model.aggregate.test.ts` test suites pass without regression; new base-model observability assertions are verified in `U4`.

### U3. Root and Property Model Mutations, List/Stream Metadata, and Internal Pre-Queries

- **Goal**: Wire caller metadata (`query`, `smartFilter`, `parentID`), `context`/`traceID` propagation, and `internal: true` pre-query events across `AbstractModel` (`src/model.ts`) and `AbstractPropertyModel` (`src/property-model.ts`).
- **Requirements**: `R1`, `R2`, `R3`, `R4`, `R5`
- **Dependencies**: `U1`, `U2`
- **Files**:
  - `src/model.ts`
  - `src/property-model.ts`
- **Approach**:
  1. **Root `AbstractModel` (`src/model.ts`)**:
     - In `create`, `createFrom`, and `createMany`: forward `context: options?.context` and `traceID: options?.traceID` to `_emitMutation` and `_emitError`. In `create`'s `duplicateIgnore: true` (`e.code === 11000`) branch, measure the duration of `this.collection.findOne(e.keyValue, ...)` and emit `_emitQuery('get', [{ $match: e.keyValue }, { $project: { _id: 1 } }], findDuration, { resultCount: existingDoc ? 1 : 0, internal: true, parentOperation: 'create', query: { filter: e.keyValue }, context: options?.context, traceID: options?.traceID })` (`R5`).
     - In `#findOneAndUpdateWithSnapshots`: accept `parentOperation: 'update' | 'updateOne'`. When `options.documentBefore && options.documentAfter` runs `this.collection.findOne(match, ...)`, measure duration and emit `_emitQuery('get', [{ $match: match }], preDuration, { resultCount: beforeDoc ? 1 : 0, internal: true, parentOperation, query: { filter: match }, context: options.context, traceID: options.traceID })` (`R5`).
     - In `#resolveFilterMatch`: pass trailing `options` into `normalizeFindMatch(matchInput, options)` so `options.context` and `options.traceID` merge over `matchInput.context` and `matchInput.traceID`. When `resolvedSmart?.pipeline?.length` runs `this.collection.aggregate(pipeline, ...).toArray()`, measure duration and emit `_emitQuery('aggregate', pipeline, preDuration, { resultCount: docs.length, internal: true, parentOperation: method as ModelMutationOperation, query: { filter: rawFilter, smartFilter }, context: mergedContext, traceID: mergedTraceID })` (`R5`). Return `smartFilter`, `context`, and `traceID` from `#resolveFilterMatch` so `updateOne`, `updateMany`, and `deleteMany` pass them to `_emitMutation` and `_emitError` (`R3`, `R4`).
     - In `update`, `updateMany`, `updateOne`, `delete`, `deleteMany`, `list`, and `stream` (and update `exists` signature to `options?: ModelExistsOptions`): wrap MongoDB driver execution calls in `try/catch` blocks calling `this._emitError(e, operation, Date.now() - start, { filter, smartFilter, query, context, traceID })` before rethrowing `e`, and pass `context`, `traceID`, and `smartFilter` (when present) to `_emitMutation`.
     - In `list` and `stream`: strip `context` and `traceID` before `resolveBSONObject(options)` (`KTD4`), build `query: ModelQueryContext` (`filter`, `smartFilter`, `computedProperties`, `sort`, `limit`, `skip`, `cursor`, `access`) when `_shouldObserve` passes, and include `query`, `context`, and `traceID` on `_emitQuery('list' | 'count' | 'stream')` and `_emitError`.
  2. **Child `AbstractPropertyModel` (`src/property-model.ts`)**:
     - In `create`, `createFrom`, and `createMany`: include `parentID`, `context`, and `traceID` on `_emitMutation` and `_emitError` (`R3`, `R4`), wrapping `create`'s driver `updateOne` call in `try/catch` to emit `_emitError` on driver failure.
     - In `#findMatchingSubdocIds`: accept `parentOperation: ModelMutationOperation` and caller `{ context, traceID, smartFilter }`. Measure duration around `this.collection.aggregate(pipeline, ...).toArray()` and emit `_emitQuery('aggregate', pipeline, preDuration, { resultCount: docs.length, internal: true, parentOperation, query: { filter: findOptions.filter, smartFilter, limit, ...(findOptions.access ? { access: findOptions.access } : {}) }, context, traceID })` (`R5`).
     - Thread `parentOperation` and `{ context, traceID, smartFilter }` into `#findMatchingSubdocIds` from `#updateById` (`'update' | 'updateOne'`), `#resolveBatchTargetIds` (`'updateMany' | 'deleteMany'`), `updateOne` (`'updateOne'`), and `delete` (`'delete'`), wrap MongoDB driver calls in `try/catch` calling `this._emitError`, and include `filter`, `smartFilter`, `context`, and `traceID` on all `_emitMutation` and `_emitError` calls in `update`, `updateOne`, `updateMany`, `delete`, and `deleteMany` (and update `exists` signature to `options?: ModelExistsOptions`).
     - In `list` and `stream`: strip `context` and `traceID` before `resolveBSONObject`, and attach `query` (`filter`, `smartFilter`, `computedProperties`, `sort`, `limit`, `skip`, `cursor`, `access`), `context`, and `traceID` on `_emitQuery('list' | 'count' | 'stream')` and `_emitError`.
- **Patterns to follow**:
  - `#resolveFilterMatch` and `#findOneAndUpdateWithSnapshots` in `src/model.ts`
  - `#findMatchingSubdocIds` and `#resolveBatchTargetIds` in `src/property-model.ts`
- **Test scenarios**:
  - `AbstractModel.updateOne` / `updateMany` / `deleteMany` with a `smartFilter` producing a `$lookup` pipeline emits an `internal: true` `query` event (`operation: 'aggregate'`, `parentOperation: 'updateOne' | 'updateMany' | 'deleteMany'`) before the `mutation` event, and includes `smartFilter` on both events.
  - `AbstractModel.update` / `updateOne` with `{ documentBefore: true, documentAfter: true }` emits an `internal: true` `query` event (`operation: 'get'`, `parentOperation: 'update' | 'updateOne'`) for the `findOne` snapshot before the `mutation` event.
  - `AbstractModel.create` with `{ duplicateIgnore: true }` on error `11000` emits an `internal: true` `query` event (`operation: 'get'`, `parentOperation: 'create'`) for the fallback `findOne`.
  - `AbstractPropertyModel` mutations (`update`, `updateOne`, `updateMany`, `delete`, `deleteMany`) emit `internal: true` `query` events (`operation: 'aggregate'`, `parentOperation` matching the mutation method) from `#findMatchingSubdocIds` and attach `filter` and `smartFilter` to the `mutation` event, while `AbstractPropertyModel.create` / `createFrom` / `createMany` attach `parentID`.
  - `list` and `stream` on both `AbstractModel` and `AbstractPropertyModel` include `query` metadata (`filter`, `smartFilter`, `computedProperties`, `sort`, `limit`, `skip`, `cursor`, `access`) and per-call `context` / `traceID` without leaking `context` or `traceID` into the MongoDB aggregation pipeline.
- **Verification**: All root and property model unit tests pass with zero regressions.

### U4. Comprehensive Observability Unit Tests

- **Goal**: Add exhaustive unit tests in `src/tests/observability.test.ts` and `src/tests/operations.test.ts` verifying `AE1`–`AE4`, three-tier context merging, fast-path zero overhead, caller metadata shapes, and internal pre-query attribution.
- **Requirements**: `R1`, `R2`, `R3`, `R4`, `R5`
- **Dependencies**: `U1`, `U2`, `U3`
- **Files**:
  - `src/tests/observability.test.ts`
  - `src/tests/operations.test.ts`
- **Approach**:
  1. Extend `src/tests/operations.test.ts` to verify `isCreateOptionsObject`, `isFindOptionsObject`, `normalizeFindMatch`, and `normalizeExistsOptions` when `context` and `traceID` are passed alone or alongside `filter`/`smartFilter`/`access`.
  2. Extend `src/tests/observability.test.ts` with dedicated `describe` blocks for:
     - Three-tier `context` resolution (`observability.context` key array and function resolver, `models.scope` `flowGet('context')`, per-call `options.context`, priority overrides, error safety when resolver function throws, and per-call `options.traceID` override).
     - Selective operation filtering (`operations` array and boolean map, category expansion `'query'` / `'mutation'` / `'create'` / `'update'` / `'delete'`, exact operation names including `'get'` vs `'getMany'` and `'count'` vs `'aggregate'`, fast-path proof that disabled read queries do not call the `observability.context` resolver function, `slowQuery` firing on slow read queries when only `'mutation'` is enabled, and `error` firing by default unless `error: false`).
     - Rich caller `query` and `mutation` metadata across `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`, `exists`, `create`, `createMany`, `update`, `updateOne`, `updateMany`, `delete`, `deleteMany` on both `AbstractModel` and `AbstractPropertyModel`.
     - Internal pre-query events (`internal: true`, `parentOperation`) across all 4 pre-query sites and suppression when `operations: { update: true, internal: false }` is configured.
- **Patterns to follow**:
  - `TestModels` and mock MongoDB collection setup in `src/tests/observability.test.ts`
  - `radixxko-format` formatting and Vitest assertions
- **Test scenarios**:
  - Covers `AE1`: `operations: ['mutation']` with `context: ['userID', 'tenant']` and `models.scope.start` skips `find` completely (verify `contextResolverSpy` is not called on `find`) and logs `updateOne` with merged 3-tier `context` and `filter`.
  - Covers `AE2`: `operations: ['mutation']` with `slowQueryMs: 50` skips `onQuery` for a slow `list()` call (`duration >= 50`) while firing `onSlowQuery` with `thresholdMs: 50`, `context`, and `query` metadata.
  - Covers `AE3`: `PropertyModel.updateMany` with `operations: ['update']` emits both the `#findMatchingSubdocIds` pre-query (`internal: true`, `parentOperation: 'updateMany'`, `context`) and the `updateMany` mutation event; with `operations: { update: true, internal: false }`, only the `mutation` event fires.
  - Covers `AE4`: `operations: ['find', 'aggregate', 'update', 'delete']` skips `get`, `getMany`, `count`, `exists`, and `create`, while emitting events for `find`, `aggregate`, `updateOne`, and `deleteMany`.
  - All 4 internal pre-query sites (`#resolveFilterMatch` with `smartFilter.pipeline`, `#findOneAndUpdateWithSnapshots` with `documentBefore: true, documentAfter: true`, `create` with `duplicateIgnore: true` on `11000`, and `PropertyModel.#findMatchingSubdocIds`) emit `internal: true` and accurate `parentOperation`.
- **Verification**: `npm test` and `npm run build` pass with 100% of unit suites green.

---

## Verification Contract

| Gate | Command | Applies To | Expected Signal |
|---|---|---|---|
| Unit test suite | `npm test` | `U1`, `U2`, `U3`, `U4` | All Vitest unit test files pass with 0 failures |
| TypeScript build | `npm run build` | `U1`, `U2`, `U3`, `U4` | `tsc` exits 0 and emits declarations to `dist/` |
| Example typecheck | `npx tsc -p example/tsconfig.json --noEmit` | `U1`, `U2`, `U3`, `U4` | Example consumer project typechecks with 0 errors |

---

## Definition of Done

- All requirements (`R1`–`R5`) and acceptance examples (`AE1`–`AE4`) are implemented and covered by passing unit tests in `src/tests/observability.test.ts` and `src/tests/operations.test.ts`.
- Disabled operations incur zero context-resolution or metadata-allocation overhead on the read hot path (`_shouldObserve` fast path verified by spy assertion).
- All modified and added TypeScript files adhere strictly to `radixxko-format` (Allman braces, 4-space indentation, spaces inside parentheses, aligned colons, strict semicolons).
- `npm test`, `npm run build`, and `npx tsc -p example/tsconfig.json --noEmit` pass cleanly with no abandoned or experimental code left in the working tree.
