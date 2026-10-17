import { describe, expect, test } from 'vitest';
import { getCursor } from '../helpers/mongo.js';
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

    test( 'buildCountPipeline inserts countLimit before $count', () =>
    {
        const builder = new PipelineBuilder();
        const count = builder.buildCountPipeline([{ $match: { a: 1 } }], 10 );

        expect( count ).toEqual(
        [
            { $match: { a: 1 } },
            { $limit: 11 },
            { $count: 'count' }
        ]);
    });

    test( 'count builds pipeline without cursor/computed and applies countLimit', async() =>
    {
        const builder = new PipelineBuilder();
        const count = await builder.count(
        {
            filter              : { status: 'active' },
            sort                : { _id: 1 },
            limit               : 5,
            cursor              : 'next:abc',
            computedProperties  : { fields: { x: 1 }, pipeline: [{ $addFields: { x: 1 } }] },
            countLimit          : 20
        });

        expect( count[0] ).toEqual({ $match: { status: 'active' } });
        expect( count ).not.toContainEqual( expect.objectContaining({ $sort: expect.anything() }));
        expect( count ).not.toContainEqual( expect.objectContaining({ $limit: 5 }));
        expect( count ).toContainEqual({ $limit: 21 });
        expect( count[count.length - 1] ).toEqual({ $count: 'count' });
    });

    test( 'pipeline includes smartFilter, sample, skip, and prev cursor reverse sort', async() =>
    {
        const builder = new PipelineBuilder();
        const cursor = 'prev:' + getCursor({ _id: 'abc' }, { _id: 1 });
        const pipeline = await builder.pipeline(
        {
            filter      : { a: 1 },
            smartFilter : {
                filter  : { b: 2 },
                pipeline: [{ $addFields: { tmp: 1 } }]
            },
            skip        : 2,
            sample      : 3,
            sort        : { _id: 1 },
            cursor
        });

        expect( pipeline.some( s => s.$addFields?.tmp === 1 )).toBe( true );
        expect( pipeline ).toContainEqual({ $unset: [ 'tmp' ] });
        expect( pipeline ).toContainEqual({ $skip: 2 });
        expect( pipeline ).toContainEqual({ $sample: { size: 3 } });
        expect( pipeline ).toContainEqual({ $sort: { _id: -1 } });
    });

    test( 'pipeline allows arbitrary stages in options.pipeline and preserves caller $addFields', async() =>
    {
        const builder = new PipelineBuilder();
        const pipeline = await builder.pipeline(
        {
            filter  : { status: 'active' },
            pipeline:
            [
                { $addFields: { callerField: '$score' } },
                { $sort: { callerField: -1 } },
                { $limit: 5 }
            ]
        });

        expect( pipeline ).toContainEqual({ $addFields: { callerField: '$score' } });
        expect( pipeline ).toContainEqual({ $sort: { callerField: -1 } });
        expect( pipeline ).toContainEqual({ $limit: 5 });
        expect( pipeline ).not.toContainEqual({ $unset: [ 'callerField' ] });
    });
});
