import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname( fileURLToPath( import.meta.url ));

export default defineConfig(
{
    resolve:
    {
        alias:
        {
            '@webergency-utils/mongodb-model': path.join( root, 'src/index.ts' )
        }
    },
    test:
    {
        include         : [ 'src/tests/integration/**/*.test.ts' ],
        testTimeout     : 60_000,
        hookTimeout     : 60_000,
        fileParallelism : false,
        maxWorkers      : 1,
        sequence        :
        {
            concurrent: false
        }
    }
});
