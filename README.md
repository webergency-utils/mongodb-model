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
- **Root models:** `AbstractModel` / `defineModel` / `Model` — document CRUD (`create`, `createFrom`, `createMany`, `update`, `updateOne`, `updateMany`, `delete`, `deleteMany`), `list`/`stream`/`find`/`aggregate`/`count`/`exists`, converter recipes, smart filters, computed properties, named access.
- **Property models:** `AbstractPropertyModel` / `definePropertyModel` / `PropertyModel` — embedded array/object paths (e.g. `applications[]`) with the same read/write surface (`create(parentID, ...)`, `createFrom(parentID, ...)`, `createMany(parentID, ...)`, `update`, `updateOne`, `updateMany`, `delete`, `deleteMany`).
- **Access:** Named policies in `access.filters`; `defaults` picks a policy from operation + Flow auth. Subdocument ID mutations verify subdocument predicates via pipeline before mutating.
- **Caching:** Built-in `ModelCache` (`cache: true | ModelCacheOptions | ModelCacheInstance`) caches `get` / `getMany` results per conversion and access scope, automatically invalidating on ID mutations, clearing on filter mutations, and invalidating sibling models registered on the same collection.
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

- **Transactions (`models.transaction(fn)` & `options.session`)**: `await models.transaction(async (session) => { ... })` automatically propagates the active `ClientSession` through `@liqd-js/flow` to every read (`get`, `getMany`, `find`, `list`, `stream`, `count`, `exists`, `aggregate`) and write (`create`, `createFrom`, `createMany`, `update`, `updateOne`, `updateMany`, `delete`, `deleteMany`) inside the callback. You can also pass `{ session }` per call. Active transactions bypass reading/populating `ModelCache` and replay cache invalidations after commit.
- **Runtime Validation (`validate`)**: Pass a function `(data, ctx) => ...`, a Standard Schema v1 (`~standard.validate`), a Zod/Valibot-compatible schema (`safeParse` / `safeParseAsync` / `parse`), or `{ create?, update? }` in `defineModel` / `definePropertyModel` (or override `protected validate(data, ctx)` on subclasses). Failures throw `ModelValidationError` (`MODEL_VALIDATION_ERROR`, with `issues`) and emit `error` observability events.
- **Keyset Cursor Pagination (`after` / `before` / `nextCursor` / `prevCursor`)**: `list()` results include ready-to-pass `page.nextCursor` (`next:<token>`) and `page.prevCursor` (`prev:<token>`) alongside `page.cursors`. `list()`, `stream()`, `find()`, and `aggregate()` accept `{ after }` and `{ before }` (either raw base64url tokens or prefixed tokens) in addition to `{ cursor }`.

### Helpers (selected)

Re-exported object helpers include `objectHash`, `objectFlatten`, `deleteNullishProperties`, `i18n`, and related utilities. Pipeline/access internals (`PipelineBuilder`, `AccessControl`) are available for advanced composition.

### Errors

- `ModelError`, `ModelQueryError`, `ModelConverterError`, `ModelAccessDeniedError`, `ModelAccessConfigError`, `ModelValidationError`, `ConverterRecipeError`

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
