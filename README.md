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

- **Registry:** `AbstractModels` owns the shared `MongoClient`, Flow `scope`, transactions, and `shutdown()`.
- **Root models:** `AbstractModel` / `defineModel` / `Model` — document CRUD, `list`/`stream`/`find`/`aggregate`/`count`, converter recipes, smart filters, computed properties, named access.
- **Property models:** `AbstractPropertyModel` / `definePropertyModel` / `PropertyModel` — embedded array/object paths (e.g. `applications[]`) with the same read/write surface.
- **Access:** Named policies in `access.filters`; `defaults` picks a policy from operation + Flow auth.
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

### `AbstractModel` / `defineModel` / `Model`

Root collection model.

- **Reads:** `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`
- **Writes:** `create`, `update`, `updateMany`, `delete` (`createFrom` / `updateOne` are hooks subclasses may override)
- **Extensions:** `converters`, `smartFilters`, `computedProperties`, `access`
- **IDs:** override `dbeID` / `dtoID` when ids are not raw ObjectIds
- **Events:** `on('query' | 'error', handler)` / `off`

`list` returns `{ items, total?, cursors: { next?, prev? } }`. Pass `cursor: \`next:${token}\`` (same `sort`) for the next page.

### `AbstractPropertyModel` / `definePropertyModel` / `PropertyModel`

Embedded-document model (`path` like `applications[]`).

- Same read surface as root models; `create(parentID, dbe)` / `update` / `updateMany` target the embedded path.
- Access filters may use `_root` to constrain the parent document.

### Converters

- **`createDefaultConverters({ dtoID })`** — default `dto` / `dbe`
- **`compileConverters(recipes, { dtoID })`** — `pick` / `omit` / `rename` / `custom` / `extends` / `computedProperties` / `projection`

### Access

- **`AccessControl`** — named filters + defaults; deny-fast on `false`
- Per-call `access: 'policy-name' | false` overrides defaults

### Helpers (selected)

Re-exported object helpers include `objectHash`, `objectFlatten`, `deleteNullishProperties`, `i18n`, and related utilities. Pipeline/access internals (`PipelineBuilder`, `AccessControl`) are available for advanced composition.

### Errors

- `ModelError`, `ModelQueryError`, `ModelConverterError`, `ModelAccessDeniedError`, `ModelAccessConfigError`, `ConverterRecipeError`

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
