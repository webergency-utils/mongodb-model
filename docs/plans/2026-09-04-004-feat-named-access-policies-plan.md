---
title: Named Access Policies - Plan
type: feat
date: 2026-09-04
topic: named-access-policies
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
origin: docs/plans/2026-09-04-004-feat-named-access-policies-plan.md
---

# Named Access Policies - Plan

## Goal Capsule

- **Objective:** Replace the single unscoped `accessFilter()` with named access policies so every public DB-touching method applies the correct policy for its CRUD operation (and optional method-level choice), without leaking data through aggregate/count/stream or other side paths.
- **Product authority:** This plan owns access-name resolution and enforcement on Model and PropertyModel public DB paths. Validation/typechecker, app-level permission helpers (`Can.*`), and soft-delete as a first-class library feature are surrounding context, not active scope.
- **Stop conditions:** Stop when acceptance examples for name resolution, deny/throw rules, create deny-fast, and full method coverage pass; do not invent a library bypass or bake Ramp permission vocabulary into the package.
- **Open blockers:** None.

---

## Product Contract

**Product Contract preservation:** unchanged — planning resolved deferred HOW questions in Key Technical Decisions without altering R1–R12 meaning.

### Summary

Access becomes named policies selected per call. Models declare filters by name and defaults by CRUD operation (or a resolver function). Call sites may override the name. When ACL is active, missing names deny and unknown names throw; when no ACL hook exists, behavior stays unrestricted.

### Problem Frame

Today one `accessFilter()` feeds every read and write path. Consumer apps already distinguish read/create/update/delete abilities, but the library always applies a read-shaped filter. Side paths that skip access can leak documents. There is no first-class way to register multiple policies or override which policy a call uses.

### Key Decisions

- **Named policies + op/method resolution** — `accessFilter(name)` is the single hook; callers and defaults choose the name. (session-settled: user-directed — chosen over separate read/write/delete methods and method-only maps: one hook, reusable names, CRUD defaults with method context) Governs R1–R5.
- **Deny when ACL is on and name is missing; unrestricted when ACL is absent** — presence of the access hook turns the model into deny-by-default for unresolved names. (session-settled: user-directed — chosen over always-deny or always-allow) Governs R6.
- **Unknown name throws** — misconfigured defaults/filters fail loud. (session-settled: user-directed — chosen over silent deny or unrestricted) Governs R7.
- **Create is deny-fast only** — create resolves a name and honors `false`; document filters are not applied to the insert body. (session-settled: user-directed — chosen over parent-scope matching or skipping create) Governs R8.
- **No library bypass** — apps implement system/unrestricted policies and their own preconditions inside filters. (session-settled: user-directed — chosen over `skipAccess` / scope bypass flags: stay unopinionated) Governs R9.
- **Full public DB coverage** — every public method that can leak or mutate data goes through access. (session-settled: user-directed) Governs R10.

### Requirements

**Policy surface**

- R1. Models expose a single access hook `accessFilter(name: string)` that returns a filter, `false` (deny), or void/undefined (no extra filter constraints).
- R2. `defineModel` (and PropertyModel equivalents) accept `access: { filters, defaults }` where `filters` maps policy names to filter functions and `defaults` is either a map from CRUD operation to name or a function `({ operation, method }) => name | undefined`.
- R3. Class-based models support the same `access.filters` / `access.defaults` shape (constructor or equivalent) and may implement `accessFilter(name)` as a class method instead of or in addition to the filters map.
- R4. Name resolution receives both `operation` (`create` | `read` | `update` | `delete`) and `method` (concrete public method, e.g. `get`, `getMany`, `list`, `find`, `create`, `update`, `delete`, `aggregate`, …). Defaults may key only on `operation`; the function may branch on either.
- R5. Every participating public method accepts an optional per-call `access` override (policy name) that wins over defaults for that call.

**Enforcement rules**

- R6. If the model has an access hook (filters map and/or `accessFilter` method), and no policy name is resolved for the call, the call is denied.
- R7. If a policy name is resolved but is unknown (missing from `filters` when that map is the source of truth, or otherwise undeclared), the library throws a configuration/access error — it does not silently deny or allow.
- R8. For `create` (and create-like insert entry points), the library resolves the policy and denies on `false`; it does not merge document filters into the inserted document.
- R9. The library does not provide a skip/bypass flag; unrestricted or system behavior is an application-defined named policy.
- R10. Every public Model and PropertyModel method that reads or mutates MongoDB data must resolve and apply access per R4–R9 (including at least get, getMany, list, find, create, update, updateMany, delete, count, aggregate, stream, and any other public DB entry points planning enumerates).

**Compatibility posture**

- R11. Models with no access hook and no `access` config keep today’s unrestricted behavior (no access filter applied).
- R12. Soft-delete and tenant scoping are not separate library features in this work; they live inside named policies if the app wants them.

### Key Flows

- F1. List with default read policy
  - **Trigger:** Caller invokes `list` with no `access` option on a model that defines `defaults.read` → `'recruiter-read'` and a matching filter.
  - **Steps:** Resolve `operation=read`, `method=list` → name `'recruiter-read'` → run filter → merge into match → return only allowed docs.
  - **Outcome:** List results are scoped to the named read policy.
  - **Covers:** R1, R2, R4, R10.

- F2. Update with stricter policy than read
  - **Trigger:** Caller invokes `update` on a model where `defaults.update` differs from `defaults.read`.
  - **Steps:** Resolve update name → apply that filter to the update match → mutate only docs allowed for update.
  - **Outcome:** Documents visible for read but not for update are not mutated.
  - **Covers:** R4, R5, R10.

- F3. Per-call override
  - **Trigger:** Caller passes `access: 'employer-read'` on `get` while defaults map read to another name.
  - **Steps:** Override wins → that filter applies for this call only.
  - **Outcome:** Same method can use different policies without changing model defaults.
  - **Covers:** R5.

- F4. ACL on, missing name
  - **Trigger:** Model has `accessFilter` / filters configured; defaults return `undefined` for the operation; no per-call override.
  - **Steps:** Name unresolved → deny.
  - **Outcome:** No data returned / mutation refused.
  - **Covers:** R6.

- F5. Unknown policy name
  - **Trigger:** Defaults or override resolve to a name absent from `filters`.
  - **Steps:** Library throws configuration/access error.
  - **Outcome:** Fail loud; no silent empty result that looks like “not found”.
  - **Covers:** R7.

- F6. Create deny-fast
  - **Trigger:** `create` resolves a policy that returns `false`.
  - **Steps:** Deny before insert; document filter content is ignored even if present.
  - **Outcome:** No insert; ability-style deny without matching on a non-existent doc.
  - **Covers:** R8.

- F7. Aggregate / count cannot bypass
  - **Trigger:** Caller uses `aggregate` or `count` on an ACL-enabled model.
  - **Steps:** Same resolution path as other reads → access filter applied (or deny/throw per R6–R7).
  - **Outcome:** No leak via “helper” APIs.
  - **Covers:** R10.

- F8. No ACL configured
  - **Trigger:** Model has neither filters map nor `accessFilter` override.
  - **Steps:** No access resolution required; query proceeds unrestricted.
  - **Outcome:** Migration-safe default for models that opt out.
  - **Covers:** R11.

### Scope Boundaries

**In scope**

- Named access policies, defaults/resolver, per-call override
- Enforcement on all public Model and PropertyModel DB methods
- defineModel and class-based registration of the same shape
- Clear deny / throw / unrestricted rules

**Out of scope**

- Validation / `@webergency-utils/typechecker` integration
- Built-in permission vocabulary (`readOwn`, `Can.update`, etc.)
- Library-provided bypass / `skipAccess` / scope flags for access
- Soft-delete as a first-class library feature
- Reworking converters, projection, or list cursor APIs beyond wiring access into them

### Acceptance Examples

- AE1. Read default applies to list
  - **Covers:** R2, R4, R10
  - **Given:** Model with `filters['org-read']` and `defaults: { read: 'org-read' }`
  - **When:** `list` is called without `access`
  - **Then:** Results only include documents matching `org-read`

- AE2. Update uses update default, not read
  - **Covers:** R4, R10
  - **Given:** Distinct `read` and `update` default names with different filters
  - **When:** `update` targets a doc allowed by read but not update
  - **Then:** Update does not modify that document

- AE3. Per-call override wins
  - **Covers:** R5
  - **Given:** Default read name A; call passes `access: B`
  - **When:** `get` runs
  - **Then:** Filter B is applied

- AE4. Missing name denies when ACL on
  - **Covers:** R6
  - **Given:** ACL-configured model; defaults function returns `undefined` for `delete`
  - **When:** `delete` is called without override
  - **Then:** Access is denied

- AE5. Unknown name throws
  - **Covers:** R7
  - **Given:** `defaults.read = 'missing-policy'` and no such filter
  - **When:** Any read method runs
  - **Then:** Library throws; does not return empty success

- AE6. Create honors false only
  - **Covers:** R8
  - **Given:** Create policy returns `false`
  - **When:** `create` is called
  - **Then:** Insert is refused; a policy returning a document filter does not rewrite/reject the payload by matching that filter as a query

- AE7. Aggregate is covered
  - **Covers:** R10
  - **Given:** ACL-enabled model
  - **When:** `aggregate` runs without a valid resolved policy
  - **Then:** Deny or throw per R6/R7 — never unrestricted

- AE8. No ACL stays open
  - **Covers:** R11
  - **Given:** Model with no access config/hook
  - **When:** `list` / `aggregate` run
  - **Then:** Behavior matches today’s unrestricted access

### Outstanding Questions

**Resolve before planning**

- None.

**Deferred to implementation**

- Whether `createFrom` should resolve create access before or after the from-converter (behavior equivalent either way for deny-fast; implementer picks the earlier fail).

### How This Work Fits Together

<!-- ce-section: work-relationships -->

This is the access-control redesign for `@webergency-utils/mongodb-model`. It sits beside already-shipped definition DX, ObjectId normalization, and shutdown work. Validation via typechecker remains a later, separate brainstorm. Consumer Ramp abstracts will adopt named policies after this library surface exists; that migration is not part of this Product Contract.

---

## Planning Contract

### Summary

Extend `AccessControl` to resolve a policy name from per-call override + defaults (map or function), invoke named filters / `accessFilter(name)`, and wire that into every public Model and PropertyModel DB method. Add `access` to defineModel config and option bags. Close today’s skip paths (`create`, bare `aggregate`/`count`). Preserve zero-arg subclass overrides via a legacy default-name path when no `access` config is present.

### Key Technical Decisions

- **KTD1. Context-aware AccessControl** — replace the zero-arg resolver with `resolve(ctx)` / `resolveOrDeny(ctx)` / `match(base, ctx)` where `ctx = { operation, method, access?: string }`. AccessControl owns name resolution, ACL-active detection, deny/throw, and filter invocation. Governs R1, R4–R7. Rationale: one place for rules; models only pass context.
- **KTD2. Access config shape** — store on the model instance: `access?: { filters?: Record<string, AccessFilterFn>, defaults?: AccessDefaultsMap | AccessDefaultsFn }` from defineModel `access` and/or constructor extensions (`ModelExtensions.access`). Class `accessFilter(name)` remains the override hook; when `filters[name]` exists it is preferred, else `accessFilter(name)` runs. Governs R2, R3. Rationale: matches brainstorm API; class and defineModel share one runtime shape.
- **KTD3. ACL-active + legacy default name** — ACL is active when `access.filters` has keys, `access.defaults` is set, or `accessFilter` is overridden vs the abstract base. If active and name unresolved: **deny**, except legacy mode — overridden `accessFilter` with **no** `access.filters` and **no** `access.defaults` resolves missing names to `'default'` and calls `accessFilter('default')` (zero-arg overrides ignore the arg). Once any `access` config is set, missing name denies (R6). Governs R6, R11. Rationale: confirmed compat path for today’s Ramp-style overrides without requiring an immediate defaults map.
- **KTD4. Unknown name throws only for filters map** — if `access.filters` is defined and the resolved name is not a key, throw `ModelAccessConfigError` (`MODEL_ACCESS_CONFIG`). If only a class `accessFilter` override exists (no filters map), always invoke the method — the class owns unknown-name handling. Governs R7.
- **KTD5. Per-call `access?: string` on option bags** — add to `ModelCreateOptions`, `ModelUpdateOptions`, `GetOptions`, `GetManyOptions`, `ModelListOptions`, `ModelStreamOptions`, `ModelFindOptions`, `ModelAggregateOptions`, and PropertyModel equivalents. Methods without an options bag today (`delete`, PropertyModel `create`) gain an optional trailing `options?: { access?: string }` (or extend create options). Governs R5.
- **KTD6. Operation ↔ method map** — fixed mapping used by every call site:

  | method | operation |
  |---|---|
  | `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`, `pipeline` | `read` |
  | `create`, `createFrom` | `create` |
  | `update`, `updateMany`, `updateOne` | `update` |
  | `delete` | `delete` |

  Governs R4, R10.
- **KTD7. Create deny-fast** — before insert, `resolveOrDeny({ operation: 'create', method: 'create'|'createFrom', access })`; on deny throw `ModelAccessDeniedError`; never `$and` the filter into the document. PropertyModel `create` resolves create access on the property model before writing. Governs R8.
- **KTD8. Always apply access on aggregate/count** — even when `options` is unset, still resolve read access and prepend a `$match` (or deny) before the consumer pipeline. Today bare aggregate skips access; this closes the leak. Governs R10, AE7.
- **KTD9. `updateOne` stub** — remains `MODEL_NOT_IMPLEMENTED` but signature accepts `access` in options for future parity; no behavior change beyond types. PropertyModel nested updates already use access via `#access` / `#filterStages` — pass method context through.

### High-Level Technical Design

```mermaid
flowchart TD
    call[Public DB method]
    ctx["ctx: operation + method + access?"]
    resolve[AccessControl.resolveName]
    active{ACL active?}
    name{name resolved?}
    legacy{legacy override only?}
    deny[Deny]
    lookup{filters map has name?}
    throw[ModelAccessConfigError]
    filterFn[filters name or accessFilter name]
    mode{create?}
    denyFast[Honor false only]
    merge[Merge filter into match / pipeline]
    done[Proceed]

    call --> ctx --> resolve --> active
    active -->|no| done
    active -->|yes| name
    name -->|no| legacy
    legacy -->|yes| filterFn
    legacy -->|no| deny
    name -->|yes| lookup
    lookup -->|missing key| throw
    lookup -->|hit or no map| filterFn
    filterFn --> mode
    mode -->|yes| denyFast --> done
    mode -->|no| merge --> done
```

**Public DB method coverage (R10):**

| Surface | Methods |
|---|---|
| `AbstractModel` | `pipeline`, `create`, `createFrom`, `update`, `updateMany`, `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count`, `delete` (`updateOne` types only) |
| `AbstractPropertyModel` | `pipeline` / `#filterStages`, `create`, `update`, `updateMany`, `get`, `getMany`, `find`, `list`, `stream`, `aggregate`, `count` |

### Assumptions

- Zero-arg subclass `accessFilter()` overrides remain callable when the library passes `'default'` (extra argument ignored in JS).
- Consumers that adopt `access.filters` / `access.defaults` accept R6 deny-on-missing-name and must set defaults for every operation they use.
- `PipelineBuilder` continues to receive an already-resolved `Filter` via `accessFilter` param — name resolution stays outside the builder.

### Open Questions

- **Deferred to implementation:** Exact `create` / `createFrom` interaction with `duplicateIgnore` when access denies (prefer throw `ModelAccessDeniedError` before insert).
- **Deferred to follow-up:** README migration guide for Ramp abstracts (map readOwn filters into named policies).

---

## Implementation Units

### U1. Access types, errors, and AccessControl core

- **Goal:** Introduce named-policy types and make `AccessControl` resolve by context.
- **Requirements:** R1, R4, R6, R7, R11; Covers AE4, AE5, AE8 (unit level).
- **Dependencies:** None.
- **Files:** `src/types/external.ts`, `src/access-control.ts`, `src/errors.ts`, `src/tests/access-control.test.ts`, `src/index.ts` (exports if new public types/errors)
- **Approach:**
  1. Add types: `AccessOperation`, `AccessMethod`, `AccessResolveContext`, `AccessFilterFn<T>`, `AccessDefaultsMap`, `AccessDefaultsFn`, `ModelAccessConfig<T>`.
  2. Add `ModelAccessConfigError` with code `MODEL_ACCESS_CONFIG`.
  3. Rewrite `AccessControl` to accept model + config + `invokeFilter(name) => AccessFilterResult` (bound to `accessFilter` / filters).
  4. Implement resolveName: override `ctx.access` → defaults map/fn → legacy `'default'` → undefined.
  5. Implement resolve/resolveOrDeny/match with ACL-active, deny, throw, filter invoke rules (KTD3–KTD4).
- **Patterns to follow:** Existing `ModelAccessDeniedError`; Allman / padded-parens style in `src/access-control.ts`.
- **Test scenarios:**
  - No config + base accessFilter → resolve returns undefined (unrestricted).
  - Legacy override only + no name → invokes filter with `'default'`.
  - Configured defaults + missing name → denied.
  - `filters` missing key → throws `ModelAccessConfigError`.
  - Per-call `access` wins over defaults map.
  - Defaults function receives `{ operation, method }`.
  - `false` from filter → deny; filter object → returned; void → no filter.
- **Verification:** `npm test -- src/tests/access-control.test.ts`

### U2. Wire access config into defineModel and model constructors

- **Goal:** Accept `access: { filters, defaults }` on definitions and constructor extensions; bind `accessFilter(name)`.
- **Requirements:** R2, R3.
- **Dependencies:** U1.
- **Files:** `src/types/definition.ts`, `src/types/external.ts` (`ModelExtensions` / `PropertyModelExtensions`), `src/define-model.ts`, `src/define-property-model.ts`, `src/model.ts`, `src/property-model.ts`, `src/tests/define-model.test.ts`, `src/tests/define-property-model.test.ts`
- **Approach:**
  1. Add `access?` to `RootModelDefinition` / `PropertyModelDefinition` and to `ModelExtensions` / `PropertyModelExtensions`.
  2. `buildExtensions` forwards `access`.
  3. Model constructors store access config and construct `AccessControl` with invoke that prefers `filters[name]` then `this.accessFilter(name)`.
  4. Change protected hook to `accessFilter( name: string )`.
- **Patterns to follow:** Existing `buildExtensions` forwarding of smartFilters/computedProperties.
- **Test scenarios:**
  - defineModel with `access.filters` + `defaults` builds a model that lists with the named filter (mock collection).
  - Class override of `accessFilter(name)` works without filters map (legacy path).
- **Verification:** `npm test -- src/tests/define-model.test.ts src/tests/define-property-model.test.ts`

### U3. Option bags + AbstractModel method coverage

- **Goal:** Add `access?: string` to options; pass context into AccessControl from every AbstractModel DB method; close create and bare aggregate/count gaps.
- **Requirements:** R5, R8, R10; Covers AE1–AE3, AE6, AE7.
- **Dependencies:** U1, U2.
- **Files:** `src/types/external.ts`, `src/model.ts`, `src/tests/model.get.test.ts`, new `src/tests/model.access.test.ts` (or extend existing)
- **Approach:**
  1. Extend option types (KTD5).
  2. Replace every `#access.resolve()` / `match()` with context including method name and `options?.access`.
  3. `create` / `createFrom`: deny-fast before insert (KTD7).
  4. `aggregate` / `count`: always resolve read access; if filter present, prepend `$match`; if denied, return empty for reads matching current list/get patterns.
  5. `delete` / `update` / `updateMany`: optional access on options; delete gains `options?: { access?: string }`.
  6. `pipeline` internal helper: accept access context from callers (do not leave a public pipeline path without access when ACL active).
- **Patterns to follow:** Existing list catch of `ModelAccessDeniedError` → empty result; get `resolveOrDeny` → undefined.
- **Test scenarios:**
  - Covers AE1–AE3, AE6, AE7 with mock collection.
  - Bare `aggregate(pipeline)` on ACL model applies read filter or denies.
  - Create with policy `false` throws / refuses insert; collection.insertOne not called.
  - Update with update-policy filter excludes read-only docs.
- **Verification:** `npm test -- src/tests/model.access.test.ts src/tests/model.get.test.ts`

### U4. AbstractPropertyModel method coverage

- **Goal:** Same access context wiring for PropertyModel; create deny-fast; `#filterStages` uses named resolution.
- **Requirements:** R3, R8, R10.
- **Dependencies:** U1, U2, U3 (shared types).
- **Files:** `src/property-model.ts`, `src/tests/property-model.access.test.ts` (new)
- **Approach:**
  1. Pass `{ operation, method, access }` into `#access` from every public method.
  2. `#filterStages` / pipeline paths use resolved filter (keep deny → impossible match pattern or empty results as today).
  3. `create(parentID, dbe, id?, options?)` deny-fast on create operation.
  4. Aggregate/count always apply access.
- **Patterns to follow:** Existing `#filterStages` access merge; AbstractModel U3 behaviors.
- **Test scenarios:**
  - Property list respects named read filter.
  - Property create denied when policy returns false.
  - Property aggregate without options still applies access when ACL on.
- **Verification:** `npm test -- src/tests/property-model.access.test.ts`

### U5. Export surface and regression pass

- **Goal:** Export new types/errors; full suite + build green; update access tests that assume zero-arg resolver.
- **Requirements:** R1–R12 completeness check.
- **Dependencies:** U1–U4.
- **Files:** `src/index.ts`, any broken call sites in `src/tests/**`
- **Approach:**
  1. Export `ModelAccessConfig`, related types, `ModelAccessConfigError` as needed for consumers.
  2. Fix `model.get.test.ts` accessFilter override to accept `name`.
  3. Run full test + build.
- **Test scenarios:** Full suite regression; no remaining zero-arg `#access` construction.
- **Verification:** `npm test` and `npm run build`

---

## Verification Contract

- **Unit:** `npm test -- src/tests/access-control.test.ts`
- **Model access:** `npm test -- src/tests/model.access.test.ts src/tests/model.get.test.ts`
- **Property access:** `npm test -- src/tests/property-model.access.test.ts`
- **Define helpers:** `npm test -- src/tests/define-model.test.ts src/tests/define-property-model.test.ts`
- **Full suite:** `npm test`
- **Build:** `npm run build`
- **Manual grep gate:** no `this.#access.resolve()` / `match(` without context args; no bare `aggregate` path that skips access when ACL active.

---

## Definition of Done

- R1–R12 satisfied for Model and PropertyModel public DB methods listed in Planning Contract.
- AE1–AE8 covered by automated tests (U1–U4).
- Legacy zero-arg `accessFilter()` subclasses still work without `access` config (KTD3).
- No library bypass API; no typechecker / soft-delete feature creep.
- `npm test` and `npm run build` pass.
