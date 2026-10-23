# @webergency-utils/mongodb-model

Type-safe MongoDB model abstraction for Node.js — converters, smart filters, computed properties, named access policies, cursor pagination, and streaming over root and embedded documents.

[![npm](https://img.shields.io/npm/v/@webergency-utils/mongodb-model)](https://www.npmjs.com/package/@webergency-utils/mongodb-model)
[![license](https://img.shields.io/npm/l/@webergency-utils/mongodb-model)](./LICENSE)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen.svg)](#maintenance)
[![dependencies](https://img.shields.io/badge/dependencies-6-brightgreen.svg)](https://www.npmjs.com/package/@webergency-utils/mongodb-model?activeTab=dependencies)
[![npm downloads](https://img.shields.io/npm/dm/@webergency-utils/mongodb-model)](https://www.npmjs.com/package/@webergency-utils/mongodb-model)
<br>
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/webergency-utils/mongodb-model/badge)](https://securityscorecards.dev/viewer/?uri=github.com/webergency-utils/mongodb-model)
[![codecov](https://codecov.io/gh/webergency-utils/mongodb-model/graph/badge.svg)](https://codecov.io/gh/webergency-utils/mongodb-model)
[![CI](https://github.com/webergency-utils/mongodb-model/actions/workflows/ci.yml/badge.svg)](https://github.com/webergency-utils/mongodb-model/actions/workflows/ci.yml)
[![CodeQL](https://github.com/webergency-utils/mongodb-model/actions/workflows/codeql.yml/badge.svg)](https://github.com/webergency-utils/mongodb-model/actions/workflows/codeql.yml)

## TL;DR

```ts
import { AbstractModels, AbstractModel, ObjectId } from '@webergency-utils/mongodb-model';

type JobDBE = { _id: ObjectId, title: string, status: string };
type JobDTO = { id: string, title: string, status: string };

class Models extends AbstractModels
{
    jobs: JobModel;

    constructor( uri: string )
    {
        super( uri );
        this.jobs = new JobModel( this, this.client.db( 'app' ).collection( 'jobs' ));
    }
}

class JobModel extends AbstractModel<JobDBE, JobDTO, {
    converters: { dto: { converter: ( dbe: JobDBE ) => JobDTO }, dbe: { converter: ( dbe: JobDBE ) => JobDBE } }
}>
{
    constructor( models: Models, collection: any )
    {
        super( models, collection,
        {
            converters:
            {
                dto : { converter: ( dbe ) => ({ id: String( dbe._id ), title: dbe.title, status: dbe.status }) },
                dbe : { converter: ( dbe ) => dbe }
            },
            access:
            {
                filters:
                {
                    'guest-read'    : async() => ({ status: 'published' }),
                    'admin'         : async() => ({})
                },
                defaults: ({ operation }) => operation === 'read' ? 'guest-read' : undefined
            }
        });
    }
}

const models = new Models( process.env.MONGODB_URI! );
await models.scope.execute( async() =>
{
    const page = await models.jobs.list({ limit: 20, sort: { title: 1 } });
    console.log( page.items, page.cursors );
}, { auth: { role: 'guest' } });
```

## Installation & Setup

```bash
npm install @webergency-utils/mongodb-model
```

`mongodb` is a normal dependency of this package (not a peer dependency). Prefer a single `mongodb` install in your dependency tree so app and library share one `ObjectId` class. If two copies are present, the library still rewrites foreign ObjectId-like values to its own `ObjectId` on query and write paths.

Auth for named access policies is read from Flow scope. Pass it with `models.scope.execute(fn, { auth })` (or equivalent Flow start); `scope.assign` alone is not enough outside an active flow.

See `example/` for a full domain (organizations → jobs → embedded applications) with converters, smart filters, computed properties, employer/recruiter access, cursors, and streams.

## Architecture & Internals

- **Registry:** `AbstractModels` owns the shared `MongoClient`, Flow `scope`, transactions, collection-wide cache invalidation, and `shutdown()`.
- **Shared Base Model:** `AbstractBaseModel` is the shared superclass of `AbstractModel` and `AbstractPropertyModel`, owning collaborator state, lifecycle tracking, `ModelCache`, observability emitters (`on` / `off`), `Aggregator` batching, and read methods (`get`, `getMany`, `find`, `aggregate`, `count`, `exists`).
- **Root models:** `AbstractModel` / `defineModel` / `Model` — document CRUD (`create`, `createFrom`, `createMany`, `update`, `updateOne`, `updateMany`, `upsert`, `findOneAndUpdate`, `findOneAndDelete`, `delete`, `deleteMany`, `restore`, `restoreMany`, `hardDelete`, `hardDeleteMany`, `bulkWrite`), `list`/`stream`/`find`/`aggregate`/`count`/`exists`/`distinct`/`explain`/`watch`, `syncIndexes`, converter recipes, smart filters, computed properties, relations (`populate`), named access, timestamps, soft delete, optimistic concurrency (`versioning`), and lifecycle hooks.
- **Property models:** `AbstractPropertyModel` / `definePropertyModel` / `PropertyModel` — embedded array/object paths (e.g. `applications[]`) with the same read/write surface (`create(parentID, ...)`, `createFrom(parentID, ...)`, `createMany(parentID, ...)`, `update`, `updateOne`, `updateMany`, `upsert`, `findOneAndUpdate`, `findOneAndDelete`, `delete`, `deleteMany`, `restore`, `restoreMany`, `hardDelete`, `hardDeleteMany`, `bulkWrite`, `distinct`, `explain`, `watch`, `syncIndexes`).
- **Access:** Named policies in `access.filters`; `defaults` picks a policy from operation + Flow auth. Subdocument ID mutations verify subdocument predicates via pipeline before mutating.
- **Caching:** Built-in `ModelCache` (`cache: true | ModelCacheOptions | ModelCacheInstance`) caches `get` / `getMany` results per conversion and access scope with optional distributed L2 store (`store: ModelExternalCacheStore`), automatically invalidating on ID mutations, clearing on filter mutations, and invalidating sibling models registered on the same collection.
- **Observability:** Hierarchical `observability` configuration (`AbstractModels` -> `AbstractModel` -> `AbstractPropertyModel`) with O(1) fast-path operation filtering (`operations`), three-tier synchronous `context` resolution (`options.context` > `models.scope` `context` > `observability.context`), rich caller `query` / `mutation` metadata, and `internal: true` pre-query attribution.
- **Pagination:** Opaque cursors from `list` (`next:` / `prev:`); `stream` yields one converted document at a time.
- **Dual ObjectId installs:** BSON resolve / update / access / cursor paths coerce foreign ObjectId-like values.

Runtime dependencies: `mongodb`, `@liqd-js/flow`, `@webergency-utils/aggregator`, `@webergency-utils/object-hash`, `@webergency-utils/mongodb-query-optimizer`, `snappy`.

## Glossary

- **DBE / DTO** — database entity vs API shape; converters map between them.
- **Smart filter** — named filter/pipeline methods passed as `smartFilter: { byStatus: 'new' }`.
- **Computed property** — `$addFields` / `$lookup` stages attached via converters or aggregate options.
- **Named access policy** — string key under `access.filters` resolved by `defaults` or per-call `access`.
- **Property model** — model bound to an embedded path on a root collection.
- **Cursor** — opaque pagination token from `list` (`cursors.next` / `cursors.prev`).

## API Reference

### `AbstractModels`

Registry for models sharing one Mongo client.

- **constructor(`connectionString`, `options?`)** — creates or reuses a pooled `MongoClient`.
- **`scope`** — `{ start, assign, set, get, execute }` Flow helpers; use `execute(fn, scope)` for request auth.
- **`transaction(fn)`** — `withTransaction` wrapper.
- **`shutdown({ timeout? })`** — wait for in-flight ops (optional timeout), then close the client.
- **`assertOpen()` / `trackOperation()`** — used by models during queries.

### `AbstractBaseModel`

Shared superclass extended by both `AbstractModel` and `AbstractPropertyModel`. Exported so consumers can write helpers that accept either a root model or a subdocument property model.

- **Reads:** `get(idOrIds, options?)`, `getMany(ids, options?)`, `find(options, conversion?, sort?)`, `aggregate(pipeline, options?)`, `count(pipelineOrOptions?, options?)`, `exists(idOrFilter?, options?)`
- **IDs:** `dbeID(id)`, `dtoID(id)`
- **Events:** `on(event, handler)`, `off(event, handler)` for `'query' | 'mutation' | 'slowQuery' | 'cache' | 'error'`
- **Resolvers:** `resolveSmartFilter(smartFilter)`, `resolveComputedProperties(properties)`

### `AbstractModel` / `defineModel` / `Model`

Root collection model (extends `AbstractBaseModel`).

- **Reads:** `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`, `exists`
- **Writes:** `create`, `createFrom`, `createMany`, `update`, `updateOne`, `updateMany`, `delete`, `deleteMany`
- **Extensions:** `converters`, `smartFilters`, `computedProperties`, `access`, `cache`, `optimizer`, `observability`
- **IDs:** override `dbeID` / `dtoID` when ids are not raw ObjectIds
- **Events:** `on('query' | 'mutation' | 'slowQuery' | 'cache' | 'error', handler)` / `off`

`list` returns `{ items, total?, cursors: { next?, prev? } }`. Pass `cursor: \`next:${token}\`` (same `sort`) for the next page.

### `AbstractPropertyModel` / `definePropertyModel` / `PropertyModel`

Embedded-document model (`path` like `applications[]`, extends `AbstractBaseModel`).

- **Reads:** `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`, `exists`
- **Writes:** `create(parentID, dbe, id?, options?)`, `createFrom(parentID, data, fromKeyOrId?, idOrOptions?, options?)`, `createMany(parentID, items, idsOrOptions?, options?)`, `update(id, update, options?)`, `updateOne(match, update, options?)`, `updateMany(idsOrFilter, update, options?)`, `delete(id, options?)`, `deleteMany(idsOrFilter, options?)`
- Access filters may use `_root` to constrain the parent document, and subdocument-level access filters are verified before ID updates/deletes.

### `ModelCache`

In-memory TTL/LRU cache (`cache: true | ModelCacheOptions | ModelCacheInstance`):

- **Options:** `{ ttl?: number, maxTTL?: number, sliding?: boolean, maxSize?: number, clone?: boolean }`
- Automatically caches `get` / `getMany` responses by conversion and access filter hash.
- Automatically invalidates affected IDs on `update`, `updateOne`, `updateMany`, `delete`, and `deleteMany`, clears on non-ID filter mutations, and invalidates sibling models registered on the same collection in `AbstractModels`.

### Observability & Query Context

Configure `observability` on `AbstractModels`, `AbstractModel`, or `AbstractPropertyModel` (`boolean | ObservabilityOptions`) and/or subscribe via `models.on(event, handler)` and `model.on(event, handler)`:

- **Selective Operation Filtering (`operations`):** Pass an array of categories/operations (e.g. `['mutation']`, `['find', 'aggregate', 'update', 'delete']`) or a boolean override map (e.g. `{ mutation: true, delete: false }`, `{ internal: false }`). Supported category tokens: `'query'`, `'mutation'`, `'create'`, `'update'`, `'delete'`, `'cache'`, `'error'`, `'slowQuery'`, `'internal'`, plus exact operations (`'get'`, `'getMany'`, `'find'`, `'list'`, `'stream'`, `'aggregate'`, `'count'`, `'exists'`, `'create'`, `'createFrom'`, `'createMany'`, `'update'`, `'updateOne'`, `'updateMany'`, `'delete'`, `'deleteMany'`).
- **Zero-Overhead Fast Path:** Disabled read queries skip payload construction and `@liqd-js/flow` lookups in O(1) unless `slowQueryMs` is exceeded (`slowQuery` event) or an `error` occurs (`error` event).
- **Three-Tier Context Resolution (`context` & `traceID`):** Merged synchronously when an event is observed in priority order:
  1. Per-call `options.context` (and `options.traceID`) on any read or mutation call
  2. Scoped `context` object in `models.scope.execute(fn, { context: { route: 'POST /jobs' }, traceID: 'req-1' })`
  3. `observability.context` configured as an array of `@liqd-js/flow` scope keys (e.g. `['userID', 'tenant']`) or a synchronous resolver `() => Record<string, unknown> | undefined`
- **Rich Caller Metadata & Internal Pre-Queries:**
  - `ModelQueryEvent`, `ModelSlowQueryEvent`, and `ModelErrorEvent` include `query?: ModelQueryContext` (`filter`, `smartFilter`, `computedProperties`, `sort`, `limit`, `skip`, `cursor`, `access`, `ids`).
  - `ModelMutationEvent` includes `ids`, `parentID` (for `PropertyModel` creates), `filter`, and `smartFilter`.
  - Internal pre-queries (pipeline smartFilter resolution, `documentBefore` + `documentAfter` snapshots, `duplicateIgnore` fallback, and `PropertyModel` subdocument ID resolution) emit `query` events with `internal: true` and `parentOperation`.

### Converters

- **`createDefaultConverters({ dtoID })`** — default `dto` / `dbe`
- **`compileConverters(recipes, { dtoID })`** — `pick` / `omit` / `rename` / `custom` / `extends` / `computedProperties` / `projection`

### Access

- **`AccessControl`** — named filters + defaults; deny-fast on `false`
- Per-call `access: 'policy-name' | false` overrides defaults

### Transactions, Validation & Cursor Pagination

- **Transactions (`models.transaction(fn)` & `options.session`)**: `await models.transaction(async (session) => { ... })` automatically propagates the active `ClientSession` through `@liqd-js/flow` to every read (`get`, `getMany`, `find`, `list`, `stream`, `count`, `exists`, `aggregate`, `distinct`) and write (`create`, `createFrom`, `createMany`, `update`, `updateOne`, `updateMany`, `upsert`, `delete`, `deleteMany`, `restore`, `restoreMany`, `hardDelete`, `hardDeleteMany`, `bulkWrite`) inside the callback. You can also pass `{ session }` per call. Active transactions bypass reading/populating `ModelCache` and replay cache invalidations after commit.
- **Runtime Validation (`validate`)**: Pass a function `(data, ctx) => ...`, a Standard Schema v1 (`~standard.validate`), a Zod/Valibot-compatible schema (`safeParse` / `safeParseAsync` / `parse`), or `{ create?, update? }` in `defineModel` / `definePropertyModel` (or override `protected validate(data, ctx)` on subclasses). Failures throw `ModelValidationError` (`MODEL_VALIDATION_ERROR`, with `issues`) and emit `error` observability events.
- **Keyset Cursor Pagination (`after` / `before` / `nextCursor` / `prevCursor`)**: `list()` results include ready-to-pass `page.nextCursor` (`next:<token>`) and `page.prevCursor` (`prev:<token>`) alongside `page.cursors`. `list()`, `stream()`, `find()`, and `aggregate()` accept `{ after }` and `{ before }` (either raw base64url tokens or prefixed tokens) in addition to `{ cursor }`.

### Timestamps, Soft Delete, Upsert, Distinct, Hooks, Indexes & Bulk Operations

- **Lifecycle Timestamps (`timestamps`)**: Configure `timestamps: true` or `{ createdAt?: string | false, updatedAt?: string | false }` on `defineModel` / `definePropertyModel` (or constructor extensions) to automatically manage `createdAt` and `updatedAt` across `create`, `createMany`, `update`, `updateOne`, `updateMany`, `upsert`, and `bulkWrite`.
- **Soft Delete (`softDelete`)**: Configure `softDelete: true` or `{ field?: string, deletedAtField?: string | false }`. Read operations (`get`, `getMany`, `find`, `list`, `stream`, `count`, `exists`, `distinct`) automatically exclude soft-deleted documents unless `{ includeDeleted: true }` is passed. `delete` / `deleteMany` perform soft deletes by default; use `restore(id)` / `restoreMany(idsOrFilter)` to restore soft-deleted records, and `hardDelete(id)` / `hardDeleteMany(idsOrFilter)` (or `{ hard: true }`) for physical removal.
- **Atomic Upsert (`upsert`) & `distinct()`**:
  - `await model.upsert(filter, update, options?)` (and `await propModel.upsert(parentID, filter, update, options?)`) atomically updates a matching document/subdocument or inserts a new one with a generated ID, timestamps, validation, hooks, and cache invalidation.
  - `await model.distinct(field, filterOrOptions?, options?)` returns unique values for `field` while respecting access policies, smart filters, and soft-delete filters.
- **Lifecycle Hooks (`hooks`)**: Configure `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, and `afterDelete` (or define methods on model subclasses). `beforeCreate` / `beforeUpdate` may return a transformed payload, and any hook can register `ctx.afterCommit(fn)` callbacks that run only after an active `models.transaction()` commits (or immediately when outside a transaction).
- **Declarative Index Management (`indexes` & `syncIndexes`)**: Declare `indexes` on root and property models (property model index keys are automatically prefixed with the embedded path). Call `await model.syncIndexes({ dryRun?, dropObsolete?, background? })` or `await models.syncIndexes(...)` to inspect and synchronize collection indexes.
- **Bulk Operations (`bulkWrite`)**: `await model.bulkWrite(operations, options?)` executes mixed batch mutations (`create`, `insertOne`, `update`, `updateOne`, `updateMany`, `upsert`, `delete`, `deleteOne`, `deleteMany`) with full access control, timestamps, soft-delete translation, validation, hooks, observability, and cache invalidation.

### Atomic `findOneAndUpdate` & `findOneAndDelete`, Optimistic Concurrency, Relations, Explain, Change Streams & L2 Cache

- **Atomic `findOneAndUpdate` & `findOneAndDelete`:**
  - `await model.findOneAndUpdate(idOrFilter, update, options?)` and `await model.findOneAndDelete(idOrFilter, options?)` (available on both `AbstractModel` and `AbstractPropertyModel`) atomically mutate and return the converted DTO (default `'dto'`, or any converter via `{ as: 'summary' }` or shorthand `'summary'`).
  - Supports `{ returnDocument: 'before' | 'after', sort, upsert, expectedVersion, populate, hard }`.
- **Optimistic Concurrency Control (`versioning` & `ModelVersionConflictError`):**
  - Configure `versioning: true | 'versionField' | { field?: string, initialVersion?: number }` on models.
  - Automatically initializes the version field on `create` / `createMany` / `upsert` and increments it via `$inc` on updates.
  - Pass `{ expectedVersion: number }` to `update`, `updateOne`, `updateMany`, `findOneAndUpdate`, or `bulkWrite` operations; if a concurrent write modified the document first, throws `ModelVersionConflictError` (`MODEL_VERSION_CONFLICT`).
- **Application-Level Relation Hydration (`relations` & `populate`):**
  - Declare `relations` on `defineModel` / `definePropertyModel` (`{ author: { model: () => users, localField: 'authorId', type: 'one' }, comments: { model: 'comments', foreignField: 'postId', type: 'many' } }`).
  - Pass `populate: 'author' | ['author', 'comments'] | [{ path: 'author', as: 'summary', populate: 'organization' }]` (or dot-notation `'author.organization'`) to `get`, `getMany`, `find`, `list`, `findOneAndUpdate`, and `findOneAndDelete`. Hydrates related records in batched `getMany` / `list` calls (DataLoader-style) without `$lookup` pipeline bloat.
- **Query Plan Inspection & Diagnostics (`explain`, `ping`, `healthCheck`, `cacheStats`):**
  - `await model.explain(listOptionsOrPipeline?, verbosity?)` returns a structured `ModelExplainResult` (`collection`, `pipeline`, `winningPlan`, `indexUsed`, `isCollectionScan`, `totalDocsExamined`, `totalKeysExamined`, `executionTimeMillis`, `nReturned`, `raw`).
  - `await models.ping()` and `await models.healthCheck()` report connectivity, latency, registered model/collection counts, in-flight operation count, and shutdown status.
  - `model.cacheStats()` returns `{ hits, misses, sets, invalidations, clears, size, hitRate }`.
- **Change Streams & Cross-Instance Cache Invalidation (`watch`):**
  - `const stream = model.watch({ operations, filter, fullDocument, as, invalidateCache, onChange, onError })` (and `models.watch(...)`) wraps MongoDB Change Streams with automatic local/sibling cache invalidation, DTO conversion, event emitter (`stream.on('change' | 'error', ...)`), and `AsyncIterable` (`for await (const ev of stream)`) support.
- **Async / Distributed L2 Cache Adapter (`ModelExternalCacheStore`, `invalidateCache`, `primeCache`):**
  - Pass `store: ModelExternalCacheStore` (`get`, `getMany`, `set`, `setMany`, `delete`, `clear`) in `cache` options for a two-tier L1 (in-memory) + L2 (Redis / Valkey / custom) cache with automatic L1 backfill on L2 hits.
  - `model.invalidateCache(idOrIds?)` and `model.primeCache(id, value, options?)` provide public cache invalidation and warming hooks.
- **Safe Cryptographic ID Generation & Collision Protection (`id`, `generateRandomId`, `estimateIdCollisionRisk`, `ModelIdCollisionError`):**
  - Default `id()` uses Node's `node:crypto` (`randomBytes`) to generate a 24-hex ObjectId-compatible string (4-byte Unix epoch timestamp + 8-byte per-call CSPRNG entropy), eliminating static process-random/counter collisions across serverless workers.
  - Configure `id` in `defineModel` / `definePropertyModel` (or constructor extensions) using built-in strategies (`'objectId' | 'cryptoHex' | 'uuid' | 'ulid' | 'nanoid' | 'base62'`), custom `{ strategy, length, alphabet, prefix, maxRetries, verifyUniqueness, expectedCount, minEntropyBits, maxCollisionRisk }`, or a custom generator function `(ctx) => ...`.
  - Automatic collision retry: `create`, `createMany`, and `bulkWrite` guarantee intra-batch uniqueness, check existing parent subdocuments on `PropertyModel`, and automatically regenerate and retry auto-generated IDs on `E11000` `_id` / `id` collisions up to `maxRetries` (default `5`), throwing `ModelIdCollisionError` (`MODEL_ID_COLLISION`) if exhausted.
  - Birthday-paradox collision risk calculator: `estimateIdCollisionRisk(options)` and `model.idCollisionRisk(expectedCountOrOptions?)` return `{ entropyBits, alphabetSize, length, expectedCount, collisionProbability, maxCountForOneInBillion, maxCountForOneInMillion, maxCountForOneInThousand, riskLevel }`.
- **Batch `createManyFrom` (`model.createManyFrom` & `propModel.createManyFrom`):**
  - Converts an array of external payloads through `converters.from` (`default` or any named converter key) in parallel and inserts them in a single batched `createMany` call: `await model.createManyFrom(items, fromKey?, ids?, options?)` or `await model.createManyFrom(fromKey, items, ids?, options?)`.
- **Configurable `collation`, `maxTimeMS`, `hint`, & `readPreference` (`queryDefaults`):**
  - Configure `queryDefaults: { collation, maxTimeMS, hint, readPreference }` (or top-level `collation` / `maxTimeMS`) on `AbstractModels`, `defineModel`, or `definePropertyModel`, and override per call on `get`, `getMany`, `list`, `find`, `aggregate`, `exists`, `distinct`, and `explain`.
  - Pass `collation: false` to disable the default `{ locale: 'en' }` collation (for binary index comparisons), a locale string shorthand like `collation: 'cs'`, or a full `CollationOptions` object.
- **Transient Error & `WriteConflict` Retry with Exponential Backoff (`retry`, `withRetry`, `models.transaction`):**
  - Configure `retry: true | maxAttempts | { maxAttempts?, baseDelayMs?, maxDelayMs?, jitter?, shouldRetry?, onRetry? }` on `AbstractModels` or individual models.
  - Use `await model.withRetry(fn, options?)`, `await models.withRetry(fn, options?)`, or `await models.transaction(fn, { retry: true })` to automatically retry `WriteConflict` (`112`), `TransientTransactionError`, `UnknownTransactionCommitResult`, `PrimarySteppedDown`, and network reset errors with exponential backoff and jitter.
- **Observability PII / Secret Redaction (`redactFields` & `redactReplacement`):**
  - Configure `observability: { redactFields: true | ['password', 'ssn', 'apiKey'], redactReplacement: '[REDACTED]' }` to recursively mask sensitive keys across `pipeline`, `filter`, `smartFilter`, `update`, `query`, `context`, `documentBefore`, and `documentAfter` in `query`, `mutation`, `slowQuery`, and `error` events.
- **Cursor-Paginated Batch Processor & Backfill Helper (`forEachBatch` & `backfill`):**
  - `await model.forEachBatch(options?, async (batch, meta) => { ... })` iterates through large collections or subdocument arrays in cursor-paginated batches (`batchSize`, `maxBatches`, `maxItems`; return `false` to stop early) without holding a long-lived server cursor open.
  - `await model.backfill(async (doc, meta) => patchOrNull, { batchSize?, dryRun?, onProgress? })` scans documents in batches and applies chunked `bulkWrite` updates, returning `{ batches, scanned, matched, modified, skipped, dryRun }`.
- **Declarative Audit Trail (`audit`):**
  - Configure `audit: true | 'audit_logs' | onAuditFn | { collection?, onAudit?, actions?, captureBefore?, captureAfter?, computeDiff?, redactFields?, redactReplacement? }` on `AbstractModels` or individual models.
  - Automatically captures `before` and `after` snapshots on updates, computes field-level `changes` (`{ [field]: { before, after } }`) via `computeAuditDiff`, redacts sensitive fields, and dispatches `ModelAuditEntry` records to `onAudit` and/or a MongoDB audit collection.

### Helpers (selected)

Re-exported object helpers include `objectHash`, `objectFlatten`, `deleteNullishProperties`, `i18n`, `generateRandomId`, `createIdGenerator`, `estimateIdCollisionRisk`, and related utilities. Pipeline/access internals (`PipelineBuilder`, `AccessControl`) are available for advanced composition.

### Errors

- `ModelError`, `ModelQueryError`, `ModelConverterError`, `ModelAccessDeniedError`, `ModelAccessConfigError`, `ModelValidationError`, `ModelVersionConflictError`, `ModelIdCollisionError`, `ConverterRecipeError`

## Troubleshooting

### Access always looks like guest / deny

Cause: auth was set with `scope.assign` outside Flow.  
Fix: wrap work in `models.scope.execute(async () => { ... }, { auth })`.

### ObjectId filters miss documents

Cause: app and library resolved different `mongodb` copies (`instanceof` fails).  
Fix: dedupe `mongodb` in the lockfile. The library also coerces foreign ObjectId-like values on model paths.

### Property `list({ count: true, cursor: 'prev:…' })` threw sort mismatch

Fixed: count pipelines omit the pagination cursor and reuse the normalized list sort. Upgrade to a build that includes that fix.

## Maintenance

This package is actively maintained.

Bug reports and pull requests are welcome. Security issues and critical
regressions are prioritized. New features are considered when they align
with the package's existing scope.
