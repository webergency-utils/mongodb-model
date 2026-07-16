import { describe, expect, test } from 'vitest';
import { PipelineBuilder } from '../pipeline-builder.js';

describe( 'PipelineBuilder', () =>
{
    test( 'builds match + sort + limit pipeline', async() =>
    {
        const builder = new PipelineBuilder();
        const pipeline = await builder.pipeline(
        {
            filter  : { status: 'active' },
            sort    : { _id: 1 },
            limit   : 10
        });

        expect( pipeline[0] ).toEqual({ $match: { status: 'active' } });
        expect( pipeline ).toContainEqual({ $sort: { _id: 1 } });
        expect( pipeline ).toContainEqual({ $limit: 10 });
    });

    test( 'merges access filter into match', async() =>
    {
        const builder = new PipelineBuilder();
        const pipeline = await builder.pipeline(
        {
            filter          : { status: 'active' },
            accessFilter    : { orgId: '1' }
        });

        expect( pipeline[0].$match ).toMatchObject({ status: 'active', orgId: '1' });
    });

    test( 'buildCountPipeline strips trailing stages and adds $count', () =>
    {
        const builder = new PipelineBuilder();
        const count = builder.buildCountPipeline(
        [
            { $match: { a: 1 } },
            { $sort: { _id: 1 } },
            { $limit: 5 }
        ]);

        expect( count ).toEqual(
        [
            { $match: { a: 1 } },
            { $count: 'count' }
        ]);
    });
});
