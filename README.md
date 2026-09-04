# @webergency-utils/mongodb-model

Type-safe MongoDB model abstraction for Node.js.

## Install

```bash
npm install @webergency-utils/mongodb-model
```

`mongodb` is a normal dependency of this package (not a peer dependency). Prefer a single `mongodb` install in your dependency tree so app and library share one `ObjectId` class. If two copies are present, the library still rewrites foreign ObjectId-like values to its own `ObjectId` on query and write paths.
