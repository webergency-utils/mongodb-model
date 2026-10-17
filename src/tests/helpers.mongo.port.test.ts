import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { objectStringify } from '@webergency-utils/object-hash';
import { describe, it } from 'vitest';
import
{
    addPrefixToFilter,
    addPrefixToPipeline,
    addPrefixToUpdate,
    bsonValue,
    collectAddedFields,
    generateCursorCondition,
    getCursor,
    getUsedFields,
    isExclusionProjection,
    isUpdateOperator,
    LOG,
    mergeProperties,
    objectFlatten,
    objectGet,
    objectHash,
    objectHashID,
    objectSet,
    optimizeMatch,
    projectionToProject,
    propertyModelTargetUpdateParams,
    propertyModelUpdateParams,
    resolveBSONObject,
    resolveBSONValue,
    reverseSort,
    sortProjection,
    subfilter,
    transformToElemMatch
}
from '../helpers/index.js';

describe('objectHash', () =>
{
    it('should stringify string', () =>
    {
        const obj = 'test';
        const expected = JSON.stringify(obj);
        assert.equal( objectHash( obj, { alg: 'plain' } ), expected, 'ObjectId not correctly stringified' );
    });

    it('should stringify ObjectId', () =>
    {
        const obj = new ObjectId('5f4d6f9e6f0a4d001f9a2a4d');
        const expected = '"5f4d6f9e6f0a4d001f9a2a4d"';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'ObjectId not correctly stringified' );
    });

    it('should stringify Date', () =>
    {
        const obj = new Date('2020-08-31T14:00:00.000Z');
        const expected = '2020-08-31T14:00:00.000Z';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'Date not correctly stringified' );
    });

    it('should stringify RegExp', () =>
    {
        const obj = new RegExp('tes.*t', 'i');
        const expected = '/tes.*t/i';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'RegExp not correctly stringified' );
    });

    it('should stringify Set', () =>
    {
        const obj = new Set([3, 1, 2]);
        const expected = 'Set(1,2,3)';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'Set not correctly stringified' );
    });

    it('should stringify Map', () =>
    {
        const obj = new Map([['a', 1], ['b', 2]]);
        const expected = 'Map("a":1,"b":2)';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'Map not correctly stringified' );
    });

    it('should stringify null', () =>
    {
        const obj = null;
        const expected = 'null';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'null not correctly stringified' );
    });

    it('should stringify simple objects', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = '{"a":1,"b":2}';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'simple object not correctly stringified' );
    });

    it('should stringify arrays with sort', () =>
    {
        const arr = [3, 1, 2];
        const expected = '[1,2,3]';
        assert.equal( objectHash( arr, { sort: true, alg: 'plain' } ), expected, 'array with sort not correctly stringified' );
    });

    it('should stringify arrays without sort', () =>
    {
        const arr = [3, 1, 2];
        const expected = '[3,1,2]';
        assert.equal( objectHash( arr, { sort: false, alg: 'plain' } ), expected, 'array without sort not correctly stringified' );
    });

    it('should stringify nested objects', () =>
    {
        const obj = { a: { b: 2, a: 1 }, b: 3 };
        const expected = '{"a":{"a":1,"b":2},"b":3}';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'nested object not correctly stringified' );
    });

    it('should stringify nested arrays with sort', () =>
    {
        const expected = '[4,[1,2,3]]';
        const arr = [[3, 1, 2], 4];
        assert.equal(objectHash(arr, { sort: true, alg: 'plain' }), expected, 'nested array with sort not correctly stringified');
    });

    it('should stringify nested arrays without sort', () =>
    {
        const expected = '[[3,1,2],4]';
        const arr = [[3, 1, 2], 4];
        assert.equal(objectHash(arr, { sort: false, alg: 'plain' }), expected, 'nested array without sort not correctly stringified');
    });

    it('should stringify nested objects combined with arrays with sort', () =>
    {
        const obj = { a: { b: [2, 1], a: 1 }, b: 3 };
        const expected = '{"a":{"a":1,"b":[1,2]},"b":3}';
        assert.equal( objectHash( obj, { sort: true, alg: 'plain' } ), expected, 'nested object with arrays with sort not correctly stringified' );
    });

    it('should stringify nested objects combined with arrays without sort', () =>
    {
        const obj = { a: { b: [2, 1], a: 1 }, b: 3 };
        const expected = '{"a":{"a":1,"b":[2,1]},"b":3}';
        assert.equal( objectHash( obj, { sort: false, alg: 'plain' } ), expected, 'nested object with arrays without sort not correctly stringified' );
    });

    it('should hash using sha1 algorithm - default params', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha1').update(JSON.stringify({ a: 1, b: 2 })).digest('hex');
        assert.equal( objectHash( obj ), expected, 'simple object not correctly hashed using SHA1' );
    });

    it('should hash using sha1 algorithm - explicit params', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha1').update(JSON.stringify({ a: 1, b: 2 })).digest('hex');
        assert.equal( objectHash( obj, { sort: true, alg: 'sha1' }), expected, 'simple object not correctly hashed using SHA1' );
    });

    it('should hash using sha256 algorithm', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha256').update(JSON.stringify({ a: 1, b: 2 })).digest('hex');
        assert.equal(objectHash(obj, { sort: true, alg: 'sha256' }), expected, 'simple object not correctly hashed using SHA256');
    });
});

describe('objectHashId', () =>
{
    it('should create correct hash ID using sha1', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha1').update('{"a":1,"b":2}').digest('hex').substring(0, 24);
        assert.equal( objectHashID( obj, { sort: true, alg: 'sha1' }).toString(), expected, 'incorrect object hash ID' );
    });

    it('should create correct hash ID using sha1 - default params', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha1').update('{"a":1,"b":2}').digest('hex').substring(0, 24);
        assert.equal( objectHashID( obj).toString(), expected, 'incorrect object hash ID' );
    });

    it('should create correct hash ID using sha256', () =>
    {
        const obj = { b: 2, a: 1 };
        const expected = createHash('sha256').update('{"a":1,"b":2}').digest('hex').substring(0, 24);
        assert.equal( objectHashID( obj, { sort: true, alg: 'sha256' }).toString(), expected, 'incorrect object hash ID' );
    });
});

describe('objectFlatten', () =>
{
    it('should flatten simple object', () => {
        const obj = { a: 1, b: 2 };
        const expected = { a: 1, b: 2 };
        assert.deepStrictEqual(objectFlatten(obj), expected, 'simple object not correctly flattened');
    });

    it('should flatten nested object', () => {
        const obj = { a: { b: 1, c: { d: 2 } } };
        const expected = { 'a.b': 1, 'a.c.d': 2 };
        assert.deepStrictEqual(objectFlatten(obj), expected, 'nested object not correctly flattened');
    });

    it('should flatten nested object with array', () => {
        const obj = { a: { b: [1, 2], c: 3 } };
        const expected = { 'a.b.0': 1, 'a.b.1': 2, 'a.c': 3 };
        assert.deepStrictEqual(objectFlatten(obj), expected, 'nested object with array not correctly flattened');
    });

    it('should flatten nested object with array of objects', () => {
        const obj = { a: { b: [{ c: 1 }, { d: { e: 2 } }], f: 3 } };
        const expected = { 'a.b.0.c': 1, 'a.b.1.d.e': 2, 'a.f': 3 };
        LOG(objectFlatten(obj));
        assert.deepStrictEqual(objectFlatten(obj), expected, 'nested object with array of objects not correctly flattened');
    })
});

describe('reverseSort', () =>
{
    it('should reverse sort direction for string values', () =>
    {
        const sort: Sort = { a: 'asc', b: 'desc' };
        const expected: Sort = { a: -1, b: 1 };
        assert.deepStrictEqual( reverseSort( sort ), expected, 'sort not correctly reversed for string values' );
    });

    it('should reverse sort direction for number values', () =>
    {
        const sort: Sort = { a: 1, b: -1 };
        const expected: Sort = { a: -1, b: 1 };
        assert.deepStrictEqual( reverseSort( sort ), expected, 'sort not correctly reversed for number values' );
    });
});

describe('sortProjection', () =>
{
    it('should add sort properties to projection', () =>
    {
        const sort: Sort = { a: 'asc', b: 'desc' };
        const id = 'c';
        const expected = { a: 1, b: 1, c: 1 };
        assert.deepStrictEqual( sortProjection( sort, id ), expected, 'sort properties not added to projection correctly' );
    });
});

describe('resolveBSONValue', () =>
{
    it('should return the same string', () =>
    {
        const value = 'test';
        assert.strictEqual(resolveBSONValue(value), value, 'string value changed');
    });

    it('should return the same number', () =>
    {
        const value = 123;
        assert.strictEqual(resolveBSONValue(value), value, 'number value changed');
    });

    it('should return null', () =>
    {
        const value = null;
        assert.strictEqual(resolveBSONValue(value), value, 'Didn\'t return null');
    });

    it('should return the same ObjectId', () =>
    {
        const value = new ObjectId();
        assert.strictEqual(resolveBSONValue(value), value, 'ObjectId changed');
    });

    it('should return the same Date', () =>
    {
        const value = new Date();
        assert.strictEqual(resolveBSONValue(value), value, 'Date changed');
    });

    it('should return the same RegExp', () =>
    {
        const value = /test/i;
        assert.strictEqual(resolveBSONValue(value), value, 'RegExp changed');
    });

    it('should convert $oid to ObjectId', () =>
    {
        const value = { $oid: '5f4d6f9e6f0a4d001f9a2a4d' };
        assert.deepStrictEqual(resolveBSONValue(value), new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'), 'ObjectId not converted correctly');
    });

    it('should convert $date to Date', () =>
    {
        const value = { $date: 1598961600000 };
        assert.deepStrictEqual(resolveBSONValue(value), new Date('2020-09-01T12:00:00.000Z'), 'Date not converted correctly');
    });

    it('should convert $function to function string', () =>
    {
        const value = { $function: { body: function() { return 'test'; } } };
        assert.deepStrictEqual(resolveBSONValue(value), { $function: { body: function() { return 'test'; }.toString() } }, 'function not converted correctly');
    });

    it('should handle $function property where body is not a function', () => {
        const value = {
            $function: {
                body: 'This is not a function'
            }
        };
        assert.deepStrictEqual(resolveBSONValue(value), value);
    });
});

describe('resolveBSONObject', () =>
{
    it('should resolve BSON values in an object', () =>
    {
        const obj = {
            a: { $oid: '5f4d6f9e6f0a4d001f9a2a4d' },
            b: { $date: 1598961600000 },
            c: 'test',
            d: [{ $function: { body: function() { return 'test'; } } }],
        };
        const expected = {
            a: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'),
            b: new Date('2020-09-01T12:00:00.000Z'),
            c: 'test',
            d: [{ $function: { body: function() { return 'test'; }.toString() } }]
        };
        assert.deepStrictEqual( resolveBSONValue( obj ), expected, 'BSON values not resolved correctly' );
    });

    it('should resolve BSON values in an array', () =>
    {
        const arr = [
            { $oid: '5f4d6f9e6f0a4d001f9a2a4d' },
            { $date: 1598961600000 },
            'test',
            [{ $function: { body: function() { return 'test'; } } }],
        ];
        const expected = [
            new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'),
            new Date('2020-09-01T12:00:00.000Z'),
            'test',
            [{ $function: { body: function() { return 'test'; }.toString() } }]
        ];
        assert.deepStrictEqual( resolveBSONValue( arr ), expected, 'BSON values not resolved correctly' );
    });
});

describe('addPrefixToFilter', () =>
{
    it('should add prefix to keys in an object', () =>
    {
        const filter = { a: 1, b: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d') };
        const prefix = 'prefix';
        const expected = { 'prefix.a': filter.a, 'prefix.b': filter.b };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to keys in object');
    });

    it('should add prefix to keys in an array', () =>
    {
        const filter = [{ a: 1 }, { b: 2 }];
        const prefix = 'prefix';
        const expected = [{ 'prefix.a': 1 }, { 'prefix.b': 2 }];
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to keys in array');
    });

    it('should not add prefix to keys starting with $', () =>
    {
        const filter = { $a: 1, b: 2 };
        const prefix = 'prefix';
        const expected = { $a: 1, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix added to keys starting with $');
    });

    it('should not add prefix to keys when prefixKeys is false', () =>
    {
        const filter = { a: 1, b: 2 };
        const prefix = 'prefix';
        const expected = { a: 1, b: 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix, false), expected, 'prefix added to keys when prefixKeys is false');
    });

    it('should handle _root key correctly as nested object', () =>
    {
        const filter = { _root: { a: { b: 1 } }, b: 2 };
        const prefix = 'prefix';
        const expected = { a: { b: 1 }, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to $root key');
    });

    it('should handle nested object', () =>
    {
        const filter = { a: { b: 1 }, b: 2 };
        const prefix = 'prefix';
        const expected = { 'prefix.a': { b: 1 }, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to $root key');
    });

    it('should handle nested object with function', () =>
    {
        const filter = { a: { b: {$dateToString: {format: '%Y-%m-%d', date: '$model.date'} }}, b: 2 };
        const prefix = 'prefix';
        const expected = { 'prefix.a': { b: {$dateToString: {format: '%Y-%m-%d', date: '$prefix.model.date'} } }, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to $root key');
    });

    it('should handle _root key correctly as concatenated string', () =>
    {
        const filter = { '_root.a.b': 1, b: 2 };
        const prefix = 'prefix';
        const expected = { 'a.b': 1, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected, 'prefix not added to $root key');
    });

    it('should prefix property inside $dateToString', () => {
        const filter = { '_root.a': {$dateToString: {format: '%Y-%m-%d', date: '$_root.model.date'}} }
        const prefix = 'prefix';
        const expected = { 'a': { $dateToString: { format: '%Y-%m-%d', date: '$model.date' } } }
        assert.deepStrictEqual(addPrefixToFilter(filter, prefix), expected);
    })
});

describe('addPrefixToPipeline', () =>
{
    it ('should add prefix to keys in $match', () => {
        const pipeline = [{ $match: { a: 1} }];
        const expected = [{ $match: { 'prefix.a': 1 } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it ('should add prefix to $project', () => {
        const pipeline = [{ $project: { a: '$b', b: 1, _root: { c: { d: '$x' } } } }];
        const expected = [{ $project: { 'prefix.a': '$prefix.b', 'prefix.b': '$prefix.b', 'prefix._root': { c: { d: '$prefix.x' }}}}];
        LOG(addPrefixToPipeline(pipeline, 'prefix'))
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $addFields', () => {
        const pipeline = [{ $addFields: { a: '$b', b: 1, _root: { c: { d: '$x' } } } }];
        const expected = [{ $addFields: { 'prefix.a': '$prefix.b', 'prefix.b': 1, c: { d: '$prefix.x' } } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $lookup', () => {
        const pipeline = [{ $lookup: { from: 'collection', localField: 'a', foreignField: 'b', as: 'c' } }];
        const expected = [{ $lookup: { from: 'collection', localField: 'prefix.a', foreignField: 'b', as: 'prefix.c' } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should not add prefix to $limit', () => {
        const pipeline = [{ $limit: 1 }];
        const expected = [{ $limit: 1 }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    })

    it('should add prefix to $group', () => {
        const pipeline = [{ $group: { _id: '$a', count: { $sum: 1 } } }];
        const expected = [{ $group: { _id: '$prefix.a', 'prefix.count': { $sum: 1 } } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $sort', () => {
        const pipeline = [{ $sort: { a: 1, '_root.b': -1 } }];
        const expected = [{ $sort: { 'prefix.a': 1, b: -1 } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $unwind', () => {
        const pipelineField = [{ $unwind: '$a' }];
        const expectedField = [{ $unwind: '$prefix.a' }];

        assert.deepStrictEqual(addPrefixToPipeline(pipelineField, 'prefix'), expectedField);
    });

    it('should add prefix to $replaceRoot', () => {
        const pipeline = [{ $replaceRoot: { newRoot: '$a' } }];
        const expected = [{ $replaceRoot: { newRoot: '$prefix.a' } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $replaceWith', () => {
        const pipeline = [{ $replaceWith: '$a' }];
        const expected = [{ $replaceWith: '$prefix.a' }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should not add prefix to $replaceWith ($$ROOT)', () => {
        const pipeline = [{ $replaceWith: '$$ROOT.a' }];
        const expected = [{ $replaceWith: '$a' }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $set', () => {
        const pipeline = [{ $set: { a: '$b', b: '$_root.c' } }];
        const expected = [{ $set: { 'prefix.a': '$prefix.b', 'prefix.b': '$c' } }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should add prefix to $count', () => {
        const pipeline = [{ $count: 'count' }];
        const expected = [{ $count: 'prefix.count' }];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    });

    it('should not add prefix to $function properties', () => {
        const func = ( args: any ) => {
            return 'test';
        }
        const pipeline = [
            {
                $addFields: {
                    tmp: {
                        $function: {
                            body: func,
                            args: ['$a', '$b'],
                            lang: 'js'
                        }
                    }
                }
            }
        ]
        const expected = [
            {
                $addFields: {
                    'prefix.tmp': {
                        $function: {
                            body: func,
                            args: ['$prefix.a', '$prefix.b'],
                            lang: 'js'
                        }
                    }
                }
            }
        ]
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    })

    it('should not add prefix to objects in $function args', () => {
        const func = ( args: any ) => {}
        const pipeline = [
            {
                $match: {
                    $expr: {
                        $function: {
                            body: func,
                            args: [
                                "$events",
                                {
                                    "from": new Date(),
                                    "to": new Date()
                                },
                                {
                                    test: '$aaa'
                                }
                            ],
                            lang: "js"
                        }
                    }
                }
            }
        ];
        const expected = [
            {
                $match: {
                    $expr: {
                        $function: {
                            body: func,
                            args: [
                                "$prefix.events",
                                {
                                    "from": new Date(),
                                    "to": new Date()
                                },
                                {
                                    test: '$prefix.aaa'
                                }
                            ],
                            lang: "js"
                        }
                    }
                }
            }
        ];
        assert.deepStrictEqual(addPrefixToPipeline(pipeline, 'prefix'), expected);
    })

    it('should throw error for unsupported stages', () => {
        // assert.throws(() => addPrefixToPipeline([{ $graphLookup: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $collStats: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $indexStats: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $merge: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $out: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $redact: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $search: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $searchMeta: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $setWindowFields: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $sortByCount: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{ $unionWith: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
        assert.throws(() => addPrefixToPipeline([{$vectorSearch: { a: 1 } }], 'prefix'), 'Unsupported pipeline stage');
    })
});

describe('addPrefixToUpdate', () =>
{
    it('should add prefix to keys in an object', () =>
    {
        const update = { a: 1, b: 2 };
        const prefix = 'prefix';
        const expected = { 'prefix.a': 1, 'prefix.b': 2 };
        assert.deepStrictEqual(addPrefixToUpdate(update, prefix), expected, 'prefix not added to keys in object');
    });

    it('should not add prefix to keys starting with $', () =>
    {
        const update = { $set: { a: 1, b: 2 } };
        const prefix = 'prefix';
        const expected = { $set: { 'prefix.a': 1, 'prefix.b': 2 } };
        assert.deepStrictEqual(addPrefixToUpdate(update, prefix), expected, 'prefix not added to keys in object');
    });

    it('should handle nested updates correctly', () =>
    {
        const update = { $set: { a: 1, b: 2 }, c: { $set: { d: 3 } } };
        const prefix = 'prefix';
        const expected = { $set: { 'prefix.a': 1, 'prefix.b': 2 }, 'prefix.c': { $set: { 'd': 3 } } };
        assert.deepStrictEqual(addPrefixToUpdate(update, prefix), expected, 'prefix not added to nested updates');
    });

    it('should handle empty update', () =>
    {
        const update = {};
        const prefix = 'prefix';
        const expected = {};
        assert.deepStrictEqual(addPrefixToUpdate(update, prefix), expected, 'empty update not handled');
    });
});

describe('objectSet', () =>
{
    it('should set value at path in object', () =>
    {
        const obj = { a: 1, b: 2 };
        const path = ['b'];
        const value = 3;
        const expected = { a: 1, b: 3 };
        assert.deepStrictEqual(objectSet(obj, path, value), expected, 'value not set at path in object');
    });

    it('should create nested objects if path does not exist', () =>
    {
        const obj = { a: 1 };
        const path = ['b', 'c', 'd'];
        const value = 2;
        const expected = { a: 1, b: { c: { d: 2 } } };
        assert.deepStrictEqual(objectSet(obj, path, value), expected, 'nested objects not created');
    });

    it('should overwrite existing value at path', () =>
    {
        const obj = { a: 1, b: { c: 2 } };
        const path = ['b', 'c'];
        const value = 3;
        const expected = { a: 1, b: { c: 3 } };
        assert.deepStrictEqual(objectSet(obj, path, value), expected, 'existing value not overwritten');
    });

    it('should handle empty path', () =>
    {
        const obj = { a: 1 };
        const path: string[] = [];
        const value = 2;
        assert.throws(() => objectSet(obj, path, value), 'empty path not handled');
    });
});

describe('objectGet', () =>
{
    it('should get value at path in object', () =>
    {
        const obj = { a: 1, b: 2 };
        const path = ['b'];
        const expected = 2;
        assert.strictEqual(objectGet(obj, path), expected);
    });

    it('should return undefined if path does not exist', () =>
    {
        const obj = { a: 1 };
        const path = ['b'];
        assert.strictEqual(objectGet(obj, path), undefined, 'value returned for non-existent path');
    });

    it('should get nested value at path', () =>
    {
        const obj = { a: 1, b: { c: 2 } };
        const path = ['b', 'c'];
        const expected = 2;
        assert.strictEqual(objectGet(obj, path), expected, 'nested value not returned');
    });

    it('should throw error for empty path', () =>
    {
        const obj = { a: 1 };
        const path: string[] = [];
        assert.throws(() => objectGet(obj, path), Error, 'Path is empty');
    });
});

describe('projectionToProject', () =>
{
    it('should handle projection with string property', () =>
    {
        const projection = { 'a.b': 'c' };
        const expected = { 'a.b': 'c' };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    });

    it('should handle projection with non-string property', () =>
    {
        const projection = { 'a.b': 1 };
        const expected = { 'a.b': '$a.b' };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    });

    it('should handle empty projection', () =>
    {
        const projection = {};
        const expected = {};
        assert.deepStrictEqual(projectionToProject(projection), expected);
    });

    it('should handle projection with nested properties', () =>
    {
        const projection = { 'a.b.c': 1, 'a.b.d': 1, 'c': 1 };
        const expected = { 'a.b.c': '$a.b.c', 'a.b.d': '$a.b.d', 'c': '$c' };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    });

    it('should handle projection with nested properties - object style', () =>
    {
        const projection = { a: { b: {c: 1, d: '$x'}, e: 1} };
        const expected = { 'y.a': { 'b': { 'c': '$y.a.b.c', d: '$y.x' }, 'e': '$y.a.e' } };
        assert.deepStrictEqual(projectionToProject(projection, 'y'), expected);
    });

    it('should handle projection with 0', () => {
        const projection = { 'a.b': 0, 'a.c': 1 };
        const expected = { 'a.b': 0, 'a.c': '$a.c' };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle $dateToString', () => {
        const projection = { date: {$dateToString: {format: '%Y-%m-%d', date: '$_root.date'}} };
        const expected = { date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle basic projection', () => {
        const projection = { a: 1, b: 1 };
        const expected = { a: '$a', b: '$b' };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle exclusion projection', () => {
        const projection = { a: 0, b: 0 };
        const expected = { a: 0, b: 0 };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle nested projection', () => {
        const projection = { a: {b: 0, c: 1} };
        const expected = { a: {b: 0, c: '$a.c'} };

        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle nested projection 2', () => {
        const projection = { a: {b: {c: 1}, d: 1} };
        const expected = { a: {b: {c: '$a.b.c'}, d: '$a.d'} };
        assert.deepStrictEqual(projectionToProject(projection), expected);
    })

    it('should handle $arrayElemAt', () => {
        const projection = {
            'a': {
                '$arrayElemAt': ['$b', 0]
            }
        }
        const expected = {
            'x.a': {
                '$arrayElemAt': ['$x.b', 0]
            }
        }
        assert.deepStrictEqual(projectionToProject(projection, 'x'), expected);
    })
});

describe('bsonValue', () =>
{
    it('should handle instances of ObjectId', () =>
    {
        const value = new ObjectId('5f4d6f9e6f0a4d001f9a2a4d');
        const expected = { $oid: '5f4d6f9e6f0a4d001f9a2a4d' };
        assert.deepStrictEqual(bsonValue(value), expected);
    });

    it('should handle instances of Date', () =>
    {
        const value = new Date('2020-08-31T14:00:00.000Z');
        const expected = { $date: value.getTime() };
        assert.deepStrictEqual(bsonValue(value), expected);
    });

    it('should return the same value for other types', () =>
    {
        const value = 'test';
        assert.strictEqual(bsonValue(value), value);
    });
});

describe('isUpdateOperator', () =>
{
    it('should return true for objects with keys starting with $', () =>
    {
        const update = { $set: { a: 1 }, $unset: { b: 1 } };
        assert.strictEqual(isUpdateOperator(update), true);
    });

    it('should return false for objects with keys not starting with $', () =>
    {
        const update = { set: { a: 1 }, unset: { b: 1 } };
        assert.strictEqual(isUpdateOperator(update), false);
    });

    it('should handle objects with some keys starting with $', () =>
    {
        const update = { $set: { a: 1 }, unset: { b: 1 } };
        assert.strictEqual(isUpdateOperator(update), false);
    });
});

describe('getCursor', () =>
{
    it('should generate cursor from data', () =>
    {
        const data = {_id: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'), a: { b: new Date('2024-01-01') } };
        const sort: Sort = {'a.b': 1, _id: -1};
        assert.equal(getCursor(data, sort), 'W3siJGRhdGUiOjE3MDQwNjcyMDAwMDB9LHsiJG9pZCI6IjVmNGQ2ZjllNmYwYTRkMDAxZjlhMmE0ZCJ9XQ')
    });

    it('should only include sort properties', () =>
    {
        const data = {_id: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'), a: { b: new Date('2024-01-01'), c: 'test' }, d: 100 };
        const sort: Sort = {'a.b': 1, _id: -1};
        const actual = getCursor(data, sort);
        const expected = getCursor({ a: { b: new Date('2024-01-01') }, _id: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d') }, sort);
        assert.equal(actual, expected);
    });

    it('should use intersection of sort and projection properties', () =>
    {
        const data = {_id: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d'), a: { c: 'test' }, d: 100 };
        const sort: Sort = {'a.b': 1, _id: -1};
        const actual = getCursor(data, sort);
        const expected = getCursor({ _id: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d') }, sort);
        assert.equal(actual, expected);
    });

    it('should handle empty empty data', () =>
    {
        const data = {};
        const sort: Sort = { a: 1, b: -1 };
        assert.strictEqual(getCursor(data, sort), 'W251bGwsbnVsbF0');
    });
});

describe('generateCursorCondition', () =>
{
    it('should generate filter for single sort key with next direction', () => {
        const cursor = 'next:W3siJGRhdGUiOjE3MDQwNjM1OTkwMDB9XQ=';
        const sort: Sort = { 'events.created': -1 };
        const expected = { 'events.created': { '$lt': { '$date': 1704063599000 } } };
        assert.deepStrictEqual(generateCursorCondition(cursor, sort), expected);
    });

    it('should generate filter for single sort key with prev direction', () => {
        const cursor = 'prev:W3siJGRhdGUiOjE3MDQwNjM1OTkwMDB9XQ=';
        const sort: Sort = { 'events.created': -1 };
        const expected = { 'events.created': { '$gt': { '$date': 1704063599000 } } };
        assert.deepStrictEqual(generateCursorCondition(cursor, sort), expected);
    });

    it('should handle multiple key sort with next direction', () => {
        const cursor = 'next:W3siJG9pZCI6IjYwZTc3ZDY3N2ZiNmNmMjYxZThiOWQwZCJ9LHsiJGRhdGUiOjE3MDQwNjM1OTkwMDB9XQ=';
        const sort: Sort = { _id: -1, 'events.created': -1 };
        const expected = {
            '$or': [
                { _id: { '$lt': { '$oid': '60e77d677fb6cf261e8b9d0d' } } },
                {
                    _id: { '$eq': { '$oid': '60e77d677fb6cf261e8b9d0d' } },
                    'events.created': { '$lt': { '$date': 1704063599000 } }
                }
            ]
        };
        assert.deepStrictEqual(generateCursorCondition(cursor, sort), expected);
    });

    it('should handle multiple key sort with prev direction', () => {
        const cursor = 'prev:W3siJG9pZCI6IjYwZTc3ZDY3N2ZiNmNmMjYxZThiOWQwZCJ9LHsiJGRhdGUiOjE3MDQwNjM1OTkwMDB9XQ=';
        const sort: Sort = { _id: -1, 'events.created': -1 };
        const expected = {
            '$or': [
                { _id: { '$gt': { '$oid': '60e77d677fb6cf261e8b9d0d' } } },
                {
                    _id: { '$eq': { '$oid': '60e77d677fb6cf261e8b9d0d' } },
                    'events.created': { '$gt': { '$date': 1704063599000 } }
                }
            ]
        };
        assert.deepStrictEqual(generateCursorCondition(cursor, sort), expected);
    });

    it('should throw error for cursor generated with different sort properties', () =>
    {
        const cursor = 'next:W3siJG9pZCI6IjYwZTc3ZDY3N2ZiNmNmMjYxZThiOWQwZCJ9LHsiJGRhdGUiOjE3MDQwNjM1OTkwMDB9XQ=';
        const sort: Sort = { 'events.created': -1 };
        assert.throws(() => generateCursorCondition(cursor, sort), 'Cursor and sort keys do not match');
    });
});

describe('collectAddedFields', () =>
{
    it('should handle $addFields', () =>
    {
        const pipeline = [{ $addFields: { a: 1, b: 2 } }];
        const expected = ['a', 'b'];
        assert.deepStrictEqual(collectAddedFields(pipeline), expected);
    });

    it('should handle $lookup', () =>
    {
        const pipeline = [{ $lookup: { as: 'c' } }];
        const expected = ['c'];
        assert.deepStrictEqual(collectAddedFields(pipeline), expected);
    });

    it('should handle $unset', () =>
    {
        const pipeline = [{ $addFields: { a: 1, b: 2 } }, { $unset: ['a'] }];
        const expected = ['b'];
        assert.deepStrictEqual(collectAddedFields(pipeline), expected);
    });

    it('should throw error for unsupported stages', () =>
    {
        const pipeline = [{ $unsupported: {} }];
        assert.throws(() => collectAddedFields(pipeline), /Unsupported pipeline stage: "\$unsupported"/);
    });
});

describe('optimizeMatch', () =>
{
    it('should keep comparison with null', () => {
        const match = { a: null };
        assert.deepStrictEqual(optimizeMatch(match), match);
    })

    it('should leave object without $and and $or intact', () =>
    {
        const match = {a: 1, b: {$gte: 1}, c: {$in: ['a', 'b']}};
        assert.deepStrictEqual(optimizeMatch(match), match);
    });

    it('should remove empty elements inside $and', () =>
    {
        const match = {$and: [undefined, {}, null, {a: 1}, {b: 2}]} as Filter<any>;
        assert.deepStrictEqual(optimizeMatch(match), {a: 1, b: 2});
    })

    it('should extract properties from $and with one element and empty $match root', () =>
    {
        const match = {$and: [{c: { $in: ['a', 'b']}}]};
        assert.deepStrictEqual(optimizeMatch(match), {c: { $in: ['a', 'b']}});
    })

    it('should extract properties from $and with one element and non-empty $match root', () =>
    {
        const match = {a: 1, $and: [{b: 'a', c: { $in: ['a', 'b']}}]};
        assert.deepStrictEqual(optimizeMatch(match), {a: 1, b: 'a', c: { $in: ['a', 'b']}});
    })

    it('should keep properties inside $and if conflicts with $match root', () =>
    {
        const match = {c: 'a', $and: [{c: { $in: ['a', 'b']}}]};
        assert.deepStrictEqual(optimizeMatch(match), match);
    })

    it('should keep all properties inside $and if any conflicts with $match root', () =>
    {
        const match = {c: 'a', $and: [{a: 1, b: 1, c: { $in: ['a', 'b']}}]};
        assert.deepStrictEqual(optimizeMatch(match), match);
    })

    it('should extract properties from nested $and/$or', () =>
    {
        const match = { $and: [{ $or: [{ $and: [{ a: 1 }] }] }] }
        assert.deepStrictEqual(optimizeMatch(match), {a: 1});
    })

    it('should merge nested $and', () => {
        const match = {
            $and: [
                {
                    $and: [
                        {
                            $and: [
                                { title: 'a' },
                                { surname: { '$in': [ 'a', 'b' ] } }
                            ]
                        },
                        {$or: []}
                    ]
                },
                {}
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { title: 'a', surname: { $in: ['a', 'b'] }} );
    })

    it('should handle $or with one element', () => {
        const match = {
            $or: [{a: 1}]
        };
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { a: 1 });
    });

    it('should handle simple $or', () => {
        const match = {
            $or: [
                {a: 1}, {b: 2}, {a: 4}, {a: {$gte: 3}}
            ]
        };
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, {$or: [ { a: 1 }, { b: 2 }, { a: 4 }, { a: { $gte: 3 } } ]}
        );
    });

    it('should merge simple nested $or', () => {
        const match = {
            $or: [
                { $or: [{ a: 1}, {b: 4}] },
                { b: 2 },
                { $or: [{ a: 2}, {b: 5}, { a: {gte: 6} }, { b: 7 }] },
                { a: 2 }
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, {
            $or: [
                { a: 1 },
                { b: 4 },
                { b: 2 },
                { a: 2 },
                { b: 5 },
                { a: { gte: 6 } },
                { b: 7 },
                { a: 2 }
            ]
        });
    })

    it('should merge nested $or combined with $and', () => {
        const match = {
            $or: [
                { $or: [{ $and: [{ a: 1}, {b: 4}] }, { b: 2 }], a: 4 },
                { $or: [{ $and: [{ a: 2}, {b: 5}] }, { a: {gte: 6} }, { b: 7 }] },
                { a: 2 }
            ]
        }

        const optimized = objectStringify( optimizeMatch(match), { sortArrays: true });
        const expected = objectStringify({
            $or: [
                { $or: [{ a: 1, b: 4}, {b: 2}], a: 4 },
                { a: 2 },
                { a: 2, b: 5 },
                { a: {gte: 6} },
                { b: 7 },
            ].sort()
        }, { sortArrays: true });
        assert.deepStrictEqual(optimized, expected);
    })

    it('should not merge combination of $and and $or', () => {
        const match = {
            $and: [
                { $or: [{ a: 1 }, { b: 2 }] },
                { $or: [{ a: {gte: 1} }, { d: 4 }] }
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should not merge combination of $or and $and', () => {
        const match = {
            $or: [
                { $and: [{ a: 1}, {b: 4}] }, { b: 2 }
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, {
            $or: [
                { a: 1, b: 4 },
                { b: 2 }
            ]
        });
    })

    it('should not merge conflicting properties', () => {
        const match = {
            $and: [
                { a: 1 },
                { a: 2 },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should merge object properties', () => {
        const match = {
            $and: [
                { $and: [{ a: 1}, {b: 4}] },
                { a: { $lt: 4} },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { a: { $lt: 4, $eq: 1 }, b: 4 });
    })

    it('should keep basic object intact', () => {
        const match = { a: 1, b: 2 };
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    });

    it('should keep simple $or intact', () => {
        const match = {
            $or: [
                { a: 1 },
                { b: 2 },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    });

    it('should keep unknown properties intact ($exists)', () => {
        const match = {
            a: { $exists: true }
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should keep unknown properties intact ($nor)', () => {
        const match = {
            $nor: [{ a: 1 }]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should keep nested $and with conflicting properties intact', () => {
        const match = {
            $and: [
                { $and: [{ a: 1}, {b: 2}] },
                { a: 4 },
                { d: 3 }
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { $and: [{ a: 1, b: 2 }, { a: 4 }, { d: 3 }] });
    })

    it('should merge $and with conflicting properties but different conditions', () => {
        const match = {
            $and: [
                { $and: [{ a: 1}, {b: 2}] },
                { a: { $gte: 4 } },
                { a: { $in: [1, 2, 3, 4] } },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { a: { $eq: 1, $gte: 4, $in: [1, 2, 3, 4] }, b: 2 });
    })

    it('should process ObjectId values', () => {
        const match = {
            $and:
            [
                {a: new ObjectId('5f4d6f9e6f0a4d001f9a2a4d')},
                {a: new ObjectId('5f4d6f9e6f0a4d001f9a2a4a')},
                {a: {$gte: new ObjectId('5f4d6f9e6f0a4d001f9a2a4b')}},
            ]
        };
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    });

    it('should not optimize $elemMatch with single condition', () => {
        const match = {
            $and: [
                { $or: [ { a: { $elemMatch: { b: 1 } } } ] },
                { $or: [ { a: { $elemMatch: { c: 2 } } } ] },
            ]
        }
        const result = {
            $and: [
                { a: { $elemMatch: { b: 1 } } },
                { a: { $elemMatch: { c: 2 } } },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, result);
    })

    it('should not optimize $elemMatch with multiple conditions', () => {
        const match = {
            $and: [
                { a: { $elemMatch: { b: 1, c: 2 } } },
                { a: { $elemMatch: { d: 3 } } },
            ]
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    });

    it('should optimize $in, $nin, $not $in with single condition', () => {
        const match = {
            a: { $in: [1] },
            b: { $nin: [3] },
            c: { $not: { $in: [5] } },
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, { a: { $eq: 1 }, b: { $ne: 3 }, c: { $ne: 5 } });
    })

    it('should not optimize $in, $nin, $not $in with single RegExp condition', () => {
        const match = {
            a: { $in: [new RegExp('test')] },
            b: { $nin: [new RegExp('test')] },
            c: { $not: { $in: [new RegExp('test')] } },
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should not optimize $in, $nin, $not $in with multiple conditions', () => {
        const match = {
            a: { $in: [1, 2] } ,
            b: { $nin: [3, 4] } ,
            c: { $not: { $in: [5, 6] } },
        }
        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, match);
    })

    it('should keep both $in and $nin and other properties within filter', () => {
        const match = {
            _id: {
                $in: [
                    new ObjectId('5422be7f4cf5e2bf05a4a784'),
                    new ObjectId('705502204ab43648d4a66126')
                ],
                $nin: [ new ObjectId('5ab8c015f7c1696f450a8dfc') ]
            }
        }

        const optimized = optimizeMatch(match);
        assert.deepStrictEqual(optimized, {
            _id: {
                $in: match['_id']['$in'],
                $ne: match['_id']['$nin'][0]
            }
        });
    });

    it('should work pls', () => {
        const match = {
            "$and": [
                {
                    "$and": [
                        {
                            "_id": {
                                "$in": [
                                    new ObjectId("63e29c4cdcc1dceb68cdeb8c")
                                ]
                            }
                        },
                        {
                            "$and": [
                                {
                                    "deleted": {
                                        "$ne": true
                                    }
                                },
                                {
                                    "$and": [
                                        {},
                                        {
                                            "_id": {
                                                "$in": [
                                                    new ObjectId("63e29c4cdcc1dceb68cdeb8c"),
                                                    new ObjectId("63eceab25a96c26fe8bf21be")
                                                ]
                                            }
                                        }
                                    ]
                                },
                            ]
                        },
                        {
                            "$and": [
                                {
                                    "deleted": {
                                        "$ne": true
                                    }
                                },
                                {
                                    "$and": [
                                        {},
                                        {
                                            "_id": {
                                                "$in": [
                                                    new ObjectId("63e29c4cdcc1dceb68cdeb8c"),
                                                    new ObjectId("63eceab25a96c26fe8bf21be")
                                                ]
                                            }
                                        }
                                    ]
                                },
                                {
                                    "organizationID": new ObjectId("5b778761fcbb2582fd21ce5d")
                                }
                            ]
                        }
                    ]
                },
                null,
                {
                    "$and": [
                        {
                            "deleted": {
                                "$ne": true
                            }
                        },
                        {
                            "$and": [
                                {},
                                {
                                    "_id": {
                                        "$in": [
                                            new ObjectId("63e29c4cdcc1dceb68cdeb8c"),
                                            new ObjectId("63eceab25a96c26fe8bf21be")
                                        ]
                                    }
                                }
                            ]
                        },
                        {
                            "organizationID": new ObjectId("5b778761fcbb2582fd21ce5d")
                        }
                    ]
                },
                null
            ]
        }

        const optimized = optimizeMatch(match as any);

        LOG(optimized);
    });
})

describe('mergeProperties', () =>
{
    it('should keep non-conflicting properties', () => {
        const merged = mergeProperties({ a: 1 }, { b: 2 });
        assert.deepStrictEqual(merged, { a: 1, b: 2 });
    });

    it('should prepend $eq to conflicting properties - different condition', () => {
        const merged = mergeProperties({ a: 5 }, { a: { $gte: 2 } });
        assert.deepStrictEqual(merged, { a: { $eq: 5, $gte: 2 } });
    });

    it('should return false for conflicting properties - same condition', () => {
        const merged = mergeProperties({ a: 5 }, { a: { $eq: 2 } });
        assert.deepStrictEqual(merged, false);
    });
})

describe('extractFields', () =>
{
    it('should extract fields from simple $match', () =>
    {
        const pipeline = [{ $match: { a: 1, b: 2 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['a', 'b'], ignored: []});
    });

    it('should extract fields from $match with nested $and and $or', () =>
    {
        const pipeline = [{ $match: { $and: [{ a: 1 }, { $or: [{ b: 2 }, { c: 3 }] }] } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['a', 'b', 'c'], ignored: []});
    });

    it('should add ignored fields created in $project', () =>
    {
        const pipeline = [{ $project: { a: '$positions', b: 1 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should exclude fields in $match created in $project before', () =>
    {
        const pipeline = [{ $project: { a: '$positions', b: 1 } }, { $match: { a: 1, b: 2 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should add ignored fields created in $addFields', () =>
    {
        const pipeline = [{ $addFields: { a: '$positions', b: 1 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should exclude fields in $match created in $addFields before', () =>
    {
        const pipeline = [{ $addFields: { a: '$positions', b: 1 } }, { $match: { a: 1, b: 2 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should add ignored fields created in $group', () =>
    {
        const pipeline = [{ $group: { a: '$positions', b: 1 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should add fields in $expr', () =>
    {
        const pipeline = [{ $match: { $expr: {$gt: ['$positions', 1] }} }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: []});
    });

    it('should exclude fields in $match created in $group before', () =>
    {
        const pipeline = [{ $group: { a: '$positions', b: 1 } }, { $match: { a: 1, b: 2 } }];
        assert.deepStrictEqual(getUsedFields(pipeline), {used: ['positions'], ignored: ['a', 'b']});
    });

    it('should combine multiple stages and operators', () =>
    {
        const pipeline = [
            {
                $match: {
                    _id: 1,
                    programmeID: {
                        $in: [new ObjectId("63e29c4cdcc1dceb68cdeb8c")]
                    },
                    "positions.events.opened": {
                        $lt: new Date("2023-07-05T00:00:00.000Z")
                    },
                    $and: [{
                        $or: [{
                            "positions.events.closed": {
                                $gte: new Date("2023-07-03T00:00:00.000Z")
                            }
                        },{
                            "positions.events.hired": {
                                $gte: new Date("2023-07-03T00:00:00.000Z")
                            }
                        }]
                    }]
                }
            },{
                $replaceWith: {
                    id: "$positions.id",
                    jobID: "$$ROOT._id",
                }
            },{
                $project: {
                    statusAt: {
                        $function: {
                            body: "...",
                            args: ["$events", new Date("2023-07-05T00:00:00.000Z"), {}],
                            lang: "js"
                        }
                    },
                    mapped: {
                        $map: {
                            input: "$mapInput",
                            as: "position",
                            in: {
                                id: "$$position.id",
                                status: "$$position.status"
                            }
                        }
                    },
                    filtered: {
                        $filter: {
                            input: "$filterInput",
                            as: "position",
                            cond: {
                                $eq: [1, 1]
                            }
                        }
                    },
                    merged: {
                        $mergeObjects: ["$merge1", {a: 'a'}]
                    },
                    elemAt: { $arrayElemAt: [ '$arrayElemAt', 0 ]},
                }
            },
            {
                $match: {
                    statusAt: {
                        $ne: null
                    }
                }
            },
            {
                $group: {
                    _id: null,
                    placedJobs: {
                        $sum: {
                            $cond: [{ $eq: ["$statusAt","hired"] }, 1, 0]
                        }
                    },
                }
            },
            {
                $lookup: {
                    from: "contracts",
                    localField: "engagements.id",
                    foreignField: "_id",
                    as: "positions"
                }
            },
            {
                $match: {
                    placedJobs: { $gt: 5 }
                }
            }
        ];
        const expected = {
            used: [
                '_id', 'programmeID', 'positions.events.opened', 'positions.events.closed', 'positions.events.hired', 'positions.id',
                '$ROOT._id', 'events', 'engagements.id', 'mapInput', 'filterInput', 'merge1', 'arrayElemAt'
            ].sort(),
            ignored: [ 'id', 'jobID', 'statusAt', '_id', 'placedJobs', 'positions', 'mapped', 'filtered', 'merged', 'elemAt' ].sort()
        }
        const {used, ignored } = getUsedFields(pipeline);
        assert.deepStrictEqual({used: used.sort(), ignored: ignored.sort()}, expected);
    });

    it('should throw error for unsupported stages', () =>
    {
        const pipeline = [{ $unsupported: {} }];
        assert.throws(() => getUsedFields(pipeline), /Unsupported pipeline stage: "\$unsupported"/);
    });

    it('should throw error for unsupported operators', () =>
    {
        const pipeline = [{ $match: { $unsupported: {} } }];
        assert.throws(() => getUsedFields(pipeline), /Unsupported operator: "\$unsupported"/);
    });
})

describe('subfilter', () =>
{
    it('should extract filters from basic filter', () => {
        const input = {
            'x': 1,
            'engagements.x': 2,
            'engagements.applications.x': 3,
        }
        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(input, '', 'engagements', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements', 'engagements.applications', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements.applications', 'engagements.applications', stages), input);
    })

    it('should extract filters from simple $and - root', () => {
        const input = {
            $and: [
                { 'x': 1 },
                { 'engagements.x': 2 },
                { 'engagements.applications.x': 3 },
            ]
        }

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(input, '', 'engagements', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements', 'engagements.applications', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements.applications', 'engagements.applications', stages), input);
    })

    it('should extract filters from nested $and - root', () => {
        const input = {
            $and: [
                { 'x': 1 },
                { $and: [
                        { 'y': 2 },
                        { 'engagements.x': 2 },
                        { 'engagements.applications.x': 3 },
                    ]},
            ]
        }

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(input, '', 'engagements', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements', 'engagements.applications', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements.applications', 'engagements.applications', stages), input);
    });

    it('should extract partial filters from basic $or - root', () => {
        const input = {
            $or: [
                {'x': 1},
                {'engagements.x': 2},
                {'engagements.applications.x': 3},
            ]
        }

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(input, '', 'engagements', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements', 'engagements.applications', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements.applications', 'engagements.applications', stages), input);
    })

    it('should extract filter from combination of $and and $or - root', () => {
        const input = {
            $and: [
                { x: 1 },
                { 'engagements.x': 2 },
                { $or: [
                    { 'engagements.x': 3 },
                    { 'engagements.y': 4 },
                ]},
            ],
            $or: [
                { 'engagements.z': 5 },
                { 'engagements.applications.z': 6 },
            ]
        }

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(input, '', 'engagements', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements', 'engagements.applications', stages), input);
        assert.deepStrictEqual(subfilter(input, 'engagements.applications', 'engagements.applications', stages), input);
    })

    it('should skip unsupported operator', () => {
        // $nor
        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        const filter = subfilter({
            $unsupported: [
                { x: 1 },
                { y: 2 }
            ]
        }, '', 'engagements', stages);

        assert.deepStrictEqual(filter, {});
    })

    it('should skip {$exists: false}', () => {
        const filter = {
            'engagements.applications.events.submitted': {$exists: false}
        };

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        assert.deepStrictEqual(subfilter(filter, '', 'engagements', stages), {});
        assert.deepStrictEqual(subfilter(filter, 'engagements.applications', 'engagements.applications', stages), filter);
    })

    it('should add unsupported operators at the last level', () => {
        const filter = {
            $unsupported: [
                { x: 1 },
                { y: 2 }
            ]
        }
        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        const sub = subfilter( filter, 'engagements', 'engagements', stages);
        assert.deepStrictEqual( sub, filter );
    })

    it('should transform $in to $elemMatch', () => {
        const filter = {
            'engagements.applications.x': { $in: [1, 2, 3]}
        }
        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        const sub = subfilter(filter, '', 'engagements', stages);
        assert.deepStrictEqual(sub, { 'engagements.applications': { $elemMatch: { x: { $in: [1, 2, 3] } } } });
    })

    it('should transform $nin to $elemMatch', () => {
        const filter = {
            'engagements.applications.x': { $nin: [1, 2, 3]}
        }
        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        const sub = subfilter(filter, '', 'engagements', stages);
        assert.deepStrictEqual(sub, { 'engagements.applications': { $elemMatch: { x: { $nin: [1, 2, 3] } } } });
    })

    it('should transform $not $in to $elemMatch', () => {
        const filter = {
            'engagements.applications.x': { $not: {$in: [1, 2, 3]}}
        }

        const stages = [
            { path: 'engagements', array: true },
            { path: 'applications', array: true },
        ]
        const sub = subfilter(filter, '', 'engagements', stages);
        assert.deepStrictEqual(sub, { 'engagements.applications': { $elemMatch: { x: { $nin: [1, 2, 3] } } } });
    })
})

describe('transformToElemMatch', () =>
{
    it('should transform $in', () =>
    {
        const elemMatch = transformToElemMatch('engagements.applications.x', [1, 2, 3], "$in", [{path: 'engagements', array: true}, {path: 'applications',  array: true}]);
        assert.deepStrictEqual(elemMatch, {key: 'engagements.applications', value: {$elemMatch: {x: {$in: [1, 2, 3]}}}});
    })

    it('should transform $nin', () =>
    {
        const elemMatch = transformToElemMatch('engagements.applications.x', [1, 2, 3], "$nin", [{path: 'engagements', array: true}, {path: 'applications',  array: true}]);
        assert.deepStrictEqual(elemMatch, {key: 'engagements.applications', value: {$elemMatch: {x: {$nin: [1, 2, 3]}}}});
    })
})

describe('isExclusionProjection', () =>
{
    it('should return true for projection with 0', () => {
        const projection = { 'a.b': 0, 'a.c': 0 };
        assert.strictEqual(isExclusionProjection(projection), true);
    })

    it('should return false for projection without 0', () => {
        const projection = { 'a.b': 1, 'a.c': 1 };
        assert.strictEqual(isExclusionProjection(projection), false);
    })

    it('should throw error for mixed projection', () => {
        const projection = { 'a.b': 0, 'a.c': 1 };
        assert.throws(() => isExclusionProjection(projection));
    })

    it('should return true for nested properties with 0', () => {
        const projection = { a: { b: {c: 0, d: {e: 0}}} };
        assert.strictEqual(isExclusionProjection(projection), true);
    })

    it('should return false for nested properties with 1', () => {
        const projection = { a: { b: {c: 1, d: {e: 1}}} };
        assert.strictEqual(isExclusionProjection(projection), false);
    })

    it('should throw error for mixed nested properties', () => {
        const projection = { a: { b: {c: 1, d: {e: 0}}} };
        assert.throws(() => isExclusionProjection(projection));
    })
})

describe('propertyModelUpdateParams', () => {

    it('should process a', () => {
        const paths = [
            { path: 'a', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: '_id',
            updatePath: 'a',
            arrayFilters: []
        })
    })

    it('should process a[]', () => {
        const paths = [
            { path: 'a', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: '_id',
            updatePath: 'a',
            arrayFilters: []
        })
    })

    it('should process a.b', () => {
        const paths = [
            { path: 'a', array: false },
            { path: 'b', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.id',
            updatePath: 'a.b',
            arrayFilters: []
        })
    })

    it('should process a[].b', () => {
        const paths = [
            { path: 'a', array: true },
            { path: 'b', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.id',
            updatePath: 'a.$[path0].b',
            arrayFilters: [{ 'path0.id': 1 }]
        })
    })

    it('should process a[].b[]', () => {
        const paths = [
            { path: 'a', array: true },
            { path: 'b', array: true },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.id',
            updatePath: 'a.$[path0].b',
            arrayFilters: [{ 'path0.id': 1 }]
        })
    })

    it('should process a.b.c', () => {
        const paths = [
            { path: 'a', array: false },
            { path: 'b', array: false },
            { path: 'c', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.b.c',
            arrayFilters: []
        })
    })

    it('should process a[].b.c', () => {
        const paths = [
            { path: 'a', array: true },
            { path: 'b', array: false },
            { path: 'c', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.$[path0].b.c',
            arrayFilters: [{ 'path0.b.id': 1 }]
        })
    })

    it('should process a.b[].c', () => {
        const paths = [
            { path: 'a', array: false },
            { path: 'b', array: true },
            { path: 'c', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.b.$[path1].c',
            arrayFilters: [{ 'path1.id': 1 }]
        })
    })

    it('should process a[].b[].c', () => {
        const paths = [
            { path: 'a', array: true },
            { path: 'b', array: true },
            { path: 'c', array: false },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.$[path0].b.$[path1].c',
            arrayFilters: [{ 'path0.b.id': 1 }, { 'path1.id': 1 }]
        })
    })

    it('should process a.b.c[]', () => {
        const paths = [
            { path: 'a', array: false },
            { path: 'b', array: false },
            { path: 'c', array: true },
        ]
        const params = propertyModelUpdateParams(paths, 1);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.b.c',
            arrayFilters: []
        })
    })

    it('should process a[].b[].c[] with explicit ancestorIds', () => {
        const paths = [
            { path: 'a', array: true },
            { path: 'b', array: true },
            { path: 'c', array: true },
        ]
        const params = propertyModelUpdateParams(paths, 'b1', ['a1', 'b1']);
        assert.deepStrictEqual(params, {
            parentIDPath: 'a.b.id',
            updatePath: 'a.$[path0].b.$[path1].c',
            arrayFilters: [{ 'path0.id': 'a1' }, { 'path1.id': 'b1' }]
        })
    })

    it('should build target update params for array, object, and mixed paths', () => {
        assert.deepStrictEqual(
            propertyModelTargetUpdateParams([{ path: 'a', array: false }, { path: 'b', array: false }], 'id1'),
            { updatePrefix: 'a.b' }
        );
        assert.deepStrictEqual(
            propertyModelTargetUpdateParams([{ path: 'a', array: false }, { path: 'b', array: true }], 'id1'),
            { updatePrefix: 'a.b.$[entry]', arrayFilters: [{ 'entry.id': 'id1' }] }
        );
        assert.deepStrictEqual(
            propertyModelTargetUpdateParams([{ path: 'a', array: true }, { path: 'b', array: true }], 'id1'),
            { updatePrefix: 'a.$[].b.$[entry]', arrayFilters: [{ 'entry.id': 'id1' }] }
        );
        assert.deepStrictEqual(
            propertyModelTargetUpdateParams([{ path: 'a', array: true }, { path: 'b', array: true }, { path: 'c', array: false }], 'id1'),
            { updatePrefix: 'a.$[].b.$[entry].c', arrayFilters: [{ 'entry.c.id': 'id1' }] }
        );
        assert.deepStrictEqual(
            propertyModelTargetUpdateParams([{ path: 'a', array: true }, { path: 'b', array: false }, { path: 'c', array: false }], 'id1'),
            { updatePrefix: 'a.$[entry].b.c', arrayFilters: [{ 'entry.b.c.id': 'id1' }] }
        );
    })
})