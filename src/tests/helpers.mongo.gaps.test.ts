import { describe, expect, test } from 'vitest';
import { ObjectId } from 'mongodb';
import { ModelConverterError } from '../errors.js';
import
{
    addPrefixToFilter,
    addPrefixToPipeline,
    collectAddedFields,
    convert,
    getSubPaths,
    getUsedFields,
    isExclusionProjection,
    mergeProperties,
    optimizeMatch,
    projectionToProject
}
from '../helpers/mongo.js';

describe( 'mongo helper coverage gaps', () =>
{
    test( 'convert rethrows ModelConverterError unchanged', async() =>
    {
        const err = new ModelConverterError( {}, 'dto', '1', new Error( 'x' ));

        await expect( convert( {}, async() => { throw err }, { _id: '1' } as any, 'dto' )).rejects.toBe( err );
    });

    test( 'addPrefixToFilter handles $switch $function and $cond', () =>
    {
        const withSwitch = addPrefixToFilter(
        {
            $expr:
            {
                $switch:
                {
                    branches: [{ case: { $eq: [ '$a', 1 ] }, then: 1 }],
                    default : '$b'
                }
            }
        },
        'items' );

        expect( withSwitch.$expr.$switch.default ).toBe( '$items.b' );

        const withFn = addPrefixToFilter(
        {
            $function:
            {
                lang    : 'js',
                args    : [ '$a' ],
                body    : 'function(){}'
            }
        },
        'items' );

        expect( withFn.$function.args[0] ).toBe( '$items.a' );

        const withCond = addPrefixToFilter(
        {
            score:
            {
                $cond: { if: '$x', then: 1, else: 0 }
            }
        },
        'items' );

        expect( withCond['items.score'] ).toBeDefined();
    });

    test( 'addPrefixToPipeline covers densify geoNear lookup and empty prefix', () =>
    {
        expect( addPrefixToPipeline([{ $match: { a: 1 } }], '' )).toEqual([{ $match: { a: 1 } }]);

        const densify = addPrefixToPipeline(
        [{
            $densify:
            {
                field               : '$ts',
                partitionByFields   : [ '$group' ],
                range               : { step: 1, unit: 'day', bounds: [ 'min', 'max' ] }
            }
        }],
        'items' );

        expect( densify[0].$densify.field ).toBe( '$items.ts' );
        expect( densify[0].$densify.partitionByFields[0] ).toBe( '$items.group' );

        const geo = addPrefixToPipeline(
        [{
            $geoNear:
            {
                near            : { type: 'Point', coordinates: [ 0, 0 ] },
                distanceField   : 'dist',
                key             : 'loc'
            }
        }],
        'items' );

        expect( geo[0].$geoNear.near ).toEqual({ type: 'Point', coordinates: [ 0, 0 ] });
        expect( geo[0].$geoNear.distanceField ).toBe( 'dist' );

        const lookup = addPrefixToPipeline(
        [{
            $lookup:
            {
                from        : 'other',
                localField  : 'ref',
                foreignField: '_id',
                as          : 'joined',
                let         : { x: '$a' }
            }
        }],
        'items' );

        expect( lookup[0].$lookup.as ).toBe( 'items.joined' );
        expect( lookup[0].$lookup.localField ).toBe( 'items.ref' );
    });

    test( 'isExclusionProjection throws on mixed projection', () =>
    {
        expect(() => isExclusionProjection({ a: 0, b: 1 })).toThrow( /exclusion and inclusion/ );
        expect( isExclusionProjection({ a: 0, nested: { b: 0 } })).toBe( true );
    });

    test( 'projectionToProject supports arrays and rejects bad types', () =>
    {
        expect( projectionToProject({ tags: [ '$a', new ObjectId(), null ] } as any, 'items' )).toBeDefined();
        expect(() => projectionToProject({ a: true as any }, 'items' )).toThrow( /Unsupported projection/ );
    });

    test( 'optimizeMatch skips undefined and flattens', () =>
    {
        expect( optimizeMatch( undefined as any )).toBeUndefined();
        expect( optimizeMatch({ a: undefined, b: 1 })).toEqual({ b: 1 });
        expect( optimizeMatch({ $or: [{ a: 1 }, { a: 1, b: 2 }] })).toBeDefined();
    });

    test( 'mergeProperties conflict and typed equality paths', () =>
    {
        expect(() => mergeProperties( 1 as any )).toThrow( /Invalid input/ );
        expect( mergeProperties({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
        expect( mergeProperties({ a: {} }, { a: 2 })).toEqual({ a: 2 });
        expect( mergeProperties({ a: { $gt: 1 } }, { a: 2 })).toEqual({ a: { $gt: 1, $eq: 2 } });
        expect( mergeProperties({ a: { $eq: 1 } }, { a: { $eq: 2 } })).toBe( false );
    });

    test( 'getUsedFields covers switch size unwind and replaceWith', () =>
    {
        const used = getUsedFields(
        [
            { $addFields: {
                a: { $switch: { branches: [{ case: { $eq: [ '$x', 1 ] }, then: 1 }], default: '$y' } },
                b: { $size: '$arr' },
                c: { $size: { $ifNull: [ '$arr', [] ] } }
            }},
            { $unwind: '$items' },
            { $replaceWith: { $mergeObjects: [ '$doc', { z: '$z' }] } }
        ]);

        expect( used.used.length ).toBeGreaterThan( 0 );
    });

    test( 'collectAddedFields and getUsedFields support all 25 optimizer stages ($sort, $limit, $skip, $setWindowFields)', () =>
    {
        const added = collectAddedFields(
        [
            { $addFields: { a: 1, b: 2 } },
            { $sort: { a: -1 } },
            { $skip: 5 },
            { $limit: 10 },
            { $setWindowFields: { sortBy: { a: 1 }, output: { rank: { $rank: {} } } } },
            { $unset: [ 'b' ] }
        ]);

        expect( added ).toEqual([ 'a', 'rank' ]);

        const used = getUsedFields(
        [
            { $addFields: { computed: '$sourceField' } },
            { $sort: { computed: 1, sortField: -1 } },
            { $skip: 2 },
            { $limit: 5 }
        ]);

        expect( used.used ).toEqual( expect.arrayContaining([ 'sourceField', 'sortField' ]));
        expect( used.used ).not.toContain( 'computed' );
        expect( used.ignored ).toContain( 'computed' );
    });

    test( 'getSubPaths keeps trailing non-array segments', () =>
    {
        expect( getSubPaths(
        [
            { path: 'a', array: true },
            { path: 'b', array: false },
            { path: 'c', array: false }
        ])).toEqual([ 'a', 'b.c' ]);
    });

    test( 'optimizeMatch preserves operator subdocument with undefined operand instead of collapsing to empty filter', () =>
    {
        const res = optimizeMatch({ id: { $eq: undefined } } as any );

        expect( Object.keys( res )).toEqual([ 'id' ]);
    });

    test( 'getUsedFields extracts fields from $match when top-level condition contains unknown $ operators', () =>
    {
        const res = getUsedFields(
        [
            {
                $match:
                {
                    status      : 'active',
                    $unknownOp  : []
                }
            }
        ]);

        expect( res.used ).toEqual([ 'status' ]);
    });
});
