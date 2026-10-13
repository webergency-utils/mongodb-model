# Testing notes

## Rules

- Unit tests live under `src/tests/**/*.test.ts` and must not require a network MongoDB.
- Real-DB coverage lives under `src/tests/integration/**` and runs via `npm run test:integration`.
- Full coverage (unit + integration) runs via `npm run coverage` (`vitest.coverage.config.ts`, 95% thresholds).
- Integration URI/DB come from gitignored `.env.test` (`MONGODB_URI`, `MONGODB_DB`). Use `.env.test.example` as the template. Process env wins over the file.
- Access defaults that read `models.scope.get('auth')` only work inside `models.scope.execute(fn, { auth })` (Flow). `scope.assign` alone is not enough outside an active flow.

## Anti-Patterns

- Do not spread `...rest` after a resolved `smartFilter` in `list`/`stream` params — unresolved `smartFilter` from `resolveBSONObject(options)` overwrites the resolved value (fixed in `src/model.ts`).
- Property-model `list` count path must omit `cursor` and reuse the same normalized `sort` as the data pipeline (fixed in `src/property-model.ts`). Count is total matches, not the current page window.

## Mocking Conventions

- Unit tests mock `collection.aggregate` / `updateOne` / etc. Integration tests use the example models against the CI sandbox URI (from `.env.test`).
- Ported helper suite: `src/tests/helpers.mongo.port.test.ts` (from legacy `test/helpers/mongo.ts`).
- Integration files: `example-models*.integration.test.ts` (smoke, root CRUD/query, property, access). Each suite uses an isolated DB suffix via helpers so suites do not collide.
