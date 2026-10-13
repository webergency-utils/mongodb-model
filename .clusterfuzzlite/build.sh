#!/bin/bash -eu

npm install
npm install --save-dev @jazzer.js/core
npm run build

compile_javascript_fuzzer mongodb-model fuzz_index.cjs
