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
        include         : [ 'src/tests/**/*.test.ts' ],
        exclude         : [ 'node_modules' ],
        testTimeout     : 60_000,
        hookTimeout     : 60_000,
        fileParallelism : false,
        coverage:
        {
            provider    : 'v8',
            include     : [ 'src/**/*.ts' ],
            exclude     :
            [
                'src/tests/**',
                'src/types/**',
                'src/index.ts',
                'src/symbols.ts'
            ],
            reporter    : [ 'text', 'text-summary', 'html', 'lcov' ],
            thresholds  :
            {
                statements  : 95,
                branches    : 85,
                functions   : 95,
                lines       : 95
            }
        }
    }
});
