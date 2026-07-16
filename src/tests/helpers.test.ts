import { describe, expect, test } from 'vitest';
import
{
    addPrefixToFilter,
    generateCursorCondition,
    getCursor,
    optimizeMatch,
    toUpdateOperations
}
from '../helpers/mongo.js';

describe( 'mongo helpers', () =>
{
    test( 'optimizeMatch flattens single $and', () =>
    {
        expect( optimizeMatch({ $and: [{ a: 1 }, { b: 2 }] })).toEqual({ a: 1, b: 2 });
    });

    test( 'optimizeMatch collapses $in with one value to $eq', () =>
    {
        expect( optimizeMatch({ status: { $in: [ 'active' ] } })).toEqual({ status: { $eq: 'active' } });
    });

    test( 'addPrefixToFilter prefixes keys', () =>
    {
        expect( addPrefixToFilter({ name: 'x' }, 'items' )).toEqual({ 'items.name': 'x' });
    });

    test( 'toUpdateOperations wraps plain object as $set', () =>
    {
        expect( toUpdateOperations({ name: 'a' })).toEqual({ $set: { name: 'a' } });
    });

    test( 'cursor roundtrip generates comparison filter', () =>
    {
        const sort = { _id: 1 as const };
        const cursor = getCursor({ _id: 'abc' }, sort );
        const condition = generateCursorCondition( 'next:' + cursor, sort );

        expect( condition ).toEqual({ _id: { $gt: 'abc' } });
    });
});
