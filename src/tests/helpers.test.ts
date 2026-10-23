import { describe, expect, test } from 'vitest';
import { ObjectId } from 'mongodb';
import
{
    addPrefixToFilter,
    coerceToLibraryObjectId,
    generateCursorCondition,
    getCursor,
    isForeignObjectIdLike,
    optimizeMatch,
    resolveBSONObject,
    resolveBSONValue,
    toUpdateOperations
}
from '../helpers/mongo.js';

const VALID_HEX = '507f1f77bcf86cd799439011';

function foreignObjectIdByBsontype( hex: string = VALID_HEX )
{
    return {
        _bsontype   : 'ObjectId',
        toString    : () => hex
    };
}

function foreignObjectIdByConstructorName( hex: string = VALID_HEX )
{
    const obj = { toString: () => hex };

    Object.defineProperty( obj, 'constructor', { value: { name: 'ObjectId' } });

    return obj;
}

describe( 'mongo helpers', () =>
{
    test( 'optimizeMatch flattens single $and', () =>
    {
        expect( optimizeMatch({ $and: [{ a: 1 }, { b: 2 }] })).toEqual({ a: 1, b: 2 });
    });

    test( 'optimizeMatch collapses $in with one value to implicit equality', () =>
    {
        expect( optimizeMatch({ status: { $in: [ 'active' ] } })).toEqual({ status: 'active' });
    });

    test( 'addPrefixToFilter prefixes keys and preserves foreign ObjectId values', () =>
    {
        const foreign = foreignObjectIdByBsontype();

        expect( addPrefixToFilter({ name: 'x', refId: foreign }, 'items' )).toEqual({ 'items.name': 'x', 'items.refId': foreign });
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

    test( 'resolveBSONValue passes library ObjectId through unchanged', () =>
    {
        const id = new ObjectId( VALID_HEX );

        expect( resolveBSONValue( id )).toBe( id );
    });

    test( 'resolveBSONValue converts extJSON $oid', () =>
    {
        const resolved = resolveBSONValue({ $oid: VALID_HEX });

        expect( resolved ).toBeInstanceOf( ObjectId );
        expect( resolved.toString()).toBe( VALID_HEX );
    });

    test( 'resolveBSONObject coerces foreign ObjectId by _bsontype', () =>
    {
        const foreign = foreignObjectIdByBsontype();
        const resolved = resolveBSONObject({ _id: foreign });

        expect( resolved._id ).toBeInstanceOf( ObjectId );
        expect( resolved._id.toString()).toBe( VALID_HEX );
    });

    test( 'resolveBSONObject coerces foreign ObjectId by constructor name', () =>
    {
        const foreign = foreignObjectIdByConstructorName();
        const resolved = resolveBSONObject({ _id: foreign });

        expect( resolved._id ).toBeInstanceOf( ObjectId );
        expect( resolved._id.toString()).toBe( VALID_HEX );
    });

    test( 'resolveBSONObject coerces nested foreign ObjectIds', () =>
    {
        const foreign = foreignObjectIdByBsontype();
        const resolved = resolveBSONObject({ a: { b: foreign } });

        expect( resolved.a.b ).toBeInstanceOf( ObjectId );
    });

    test( 'resolveBSONObject leaves plain objects unchanged', () =>
    {
        expect( resolveBSONObject({ foo: 1 })).toEqual({ foo: 1 });
    });

    test( 'isForeignObjectIdLike rejects invalid hex', () =>
    {
        const invalid = foreignObjectIdByBsontype( 'bad' );

        expect( isForeignObjectIdLike( invalid )).toBe( false );
        expect( coerceToLibraryObjectId( invalid )).toBe( invalid );
    });

    test( 'toUpdateOperations coerces foreign ObjectId in plain partial update', () =>
    {
        const foreign = foreignObjectIdByBsontype();
        const resolved = toUpdateOperations({ ref: foreign as any });

        expect( resolved.$set.ref ).toBeInstanceOf( ObjectId );
    });

    test( 'toUpdateOperations coerces foreign ObjectId in operator update', () =>
    {
        const foreign = foreignObjectIdByBsontype();
        const resolved = toUpdateOperations({ $set: { ref: foreign as any } });

        expect( resolved.$set.ref ).toBeInstanceOf( ObjectId );
    });

    test( 'cursor encode/decode coerces foreign ObjectId sort values', () =>
    {
        const foreign = foreignObjectIdByBsontype();
        const sort = { _id: 1 as const };
        const cursor = getCursor({ _id: foreign }, sort );
        const condition = generateCursorCondition( 'next:' + cursor, sort );
        const resolved = resolveBSONObject( condition );

        expect( resolved._id.$gt ).toBeInstanceOf( ObjectId );
        expect( resolved._id.$gt.toString()).toBe( VALID_HEX );
    });

    test( 'getCursor encodes library ObjectId as $oid', () =>
    {
        const id = new ObjectId( VALID_HEX );
        const cursor = getCursor({ _id: id }, { _id: 1 });
        const decoded = JSON.parse( Buffer.from( cursor, 'base64url' ).toString( 'utf8' ));

        expect( decoded ).toEqual([{ $oid: VALID_HEX }]);
    });
});
