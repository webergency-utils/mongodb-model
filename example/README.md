# Example models

Self-contained sample domain (organizations → jobs → embedded applications) showing how to wire **@webergency-utils/mongodb-model** with:

- Converter recipes (`pick` / `rename` / `custom` + `computedProperties`)
- Smart filters (filter + pipeline forms)
- Computed properties (`$addFields` / `$lookup`)
- Named access policies (`access.filters` + `defaults`)
- Property models (`applications[]` on jobs)
- Cursor pagination (`list` → `cursors.next` / `cursors.prev`)
- Streaming (`stream` async generator; root + property models)
- `AbstractModels` registry + `scope` auth + `shutdown`

## Layout

```
example/
  index.ts                 # ExampleModels registry
  types.ts                 # DBE / DTO / auth types
  demo.ts                  # runnable walkthrough
  models/
    organization/          # root model
    job/                   # root model (full feature set)
    application/           # property model on jobs.applications[]
```

## Run the demo

Requires a local MongoDB:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 npx tsx --tsconfig example/tsconfig.json example/demo.ts
```

## Snippets

**List with smart filter + converter:**

```ts
// listItemDTO recipe already requests applicationCount computed property
await models.jobs.list(
{
    smartFilter : { byOrganization: orgId, hasApplications: true },
    count       : false
}, 'listItemDTO' );
```

**Auth via Flow scope** (drives access defaults — employer vs recruiter):

```ts
await models.scope.execute( async() =>
{
    await models.jobs.get( jobId ); // employer-read: org jobs incl. drafts
}, { auth: { role: 'employer', orgId }});

await models.scope.execute( async() =>
{
    await models.jobs.list({}); // recruiter-read: org published/closed only
}, { auth: { role: 'recruiter', orgId }});
```

## Integration tests

Against the CI sandbox DB (credentials in gitignored `.env.test`; copy from `.env.test.example`):

```bash
cp .env.test.example .env.test   # then set MONGODB_URI
npm run test:integration
```

**Property model:**

```ts
await models.applications.list({ smartFilter: { byStatus: 'new' } }, 'basicDTO' );
```

**Cursor pagination** (no model code — `list` returns opaque sort keys):

```ts
const page1 = await models.jobs.list({ sort: { title: 1 }, limit: 20 }, 'basicDTO' );
const page2 = await models.jobs.list(
{
    sort    : { title: 1 },
    limit   : 20,
    cursor  : `next:${page1.cursors.next}`
}, 'basicDTO' );
```

**Stream** (same options/converters/access as list, minus count):

```ts
for await( const job of models.jobs.stream({ smartFilter: { byOrganization: orgId } }, 'basicDTO' ) )
{
    // process one converted job at a time
}
```

Import paths use the package name `@webergency-utils/mongodb-model` (mapped to `../src` via `example/tsconfig.json`) so the example matches consumer imports. Run typecheck with:

```bash
npx tsc -p example/tsconfig.json
```
