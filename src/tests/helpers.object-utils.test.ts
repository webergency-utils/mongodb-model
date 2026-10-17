import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { ObjectId } from 'mongodb';
import
{
    deleteNullishProperties,
    deleteUndefinedProperties,
    i18n,
    multiI18n,
    objectFlatten,
    objectGet,
    objectHash,
    objectHashID,
    objectSet
}
from '../helpers/index.js';
import { flowExecute } from '../flow.js';

describe( 'deleteNullishProperties', () =>
{
    it( 'should delete null and undefined properties from an object', () =>
    {
        const obj = { a: null, b: undefined, c: 1 };
        const res = deleteNullishProperties( obj );

        assert.deepEqual( res, { c: 1 });
    });

    it( 'should delete null and undefined elements from an array', () =>
    {
        const arr = [ null, undefined, 1 ];
        const res = deleteNullishProperties( arr );

        assert.deepEqual( res, [ 1 ]);
    });

    it( 'should recurse into nested objects', () =>
    {
        const res = deleteNullishProperties({ a: { b: null, c: 2 }, d: [ null, 3 ] });

        assert.deepEqual( res, { a: { c: 2 }, d: [ 3 ] });
    });

    it( 'preserves Date and ObjectId (including foreign realm ObjectId-like)', () =>
    {
        const date = new Date( '2020-01-01T00:00:00.000Z' );
        const id = new ObjectId( '5f4d6f9e6f0a4d001f9a2a4d' );
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            id          : Buffer.from( '5f4d6f9e6f0a4d001f9a2a4d', 'hex' ),
            toString    : () => '5f4d6f9e6f0a4d001f9a2a4d'
        };
        const res = deleteNullishProperties({ date, id, foreignId, x: null });

        assert.equal( res.date, date );
        assert.equal( res.id, id );
        assert.equal( res.foreignId, foreignId );
        assert.equal( 'x' in res, false );
    });
});

describe( 'deleteUndefinedProperties', () =>
{
    it( 'removes undefined, keeps null, and preserves foreign realm ObjectId-like', () =>
    {
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            id          : Buffer.from( '5f4d6f9e6f0a4d001f9a2a4d', 'hex' ),
            toString    : () => '5f4d6f9e6f0a4d001f9a2a4d'
        };
        const res = deleteUndefinedProperties({ a: undefined, b: null, c: 1, foreignId });

        assert.deepEqual( res, { b: null, c: 1, foreignId });
        assert.equal( res.foreignId, foreignId );
    });
});

describe( 'i18n / multiI18n', () =>
{
    it( 'returns string as-is', () =>
    {
        assert.equal( i18n( 'hello' ), 'hello' );
    });

    it( 'picks locale from flow, then en, then first key', async() =>
    {
        await flowExecute( async() =>
        {
            assert.equal( i18n({ sk: 'ahoj', en: 'hello' }), 'ahoj' );
        }, { locales: new Set([ 'sk' ]) });

        assert.equal( i18n({ de: 'hallo', en: 'hello' }), 'hello' );
        assert.equal( i18n({ de: 'hallo' }), 'hallo' );
    });

    it( 'multiI18n maps locales', async() =>
    {
        await flowExecute( async() =>
        {
            assert.deepEqual(
                multiI18n({ sk: 'ahoj', en: 'hello' }),
                { sk: 'ahoj', en: 'hello' }
            );
            assert.deepEqual( multiI18n( 'x' ), { sk: 'x', en: 'x' });
        }, { locales: new Set([ 'sk', 'en' ]) });
    });
});

describe( 'objectGet / objectSet / objectFlatten', () =>
{
    it( 'gets and sets nested paths and preserves foreign ObjectId in objectFlatten', () =>
    {
        const obj: Record<string, unknown> = {};
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            id          : Buffer.from( '5f4d6f9e6f0a4d001f9a2a4d', 'hex' ),
            toString    : () => '5f4d6f9e6f0a4d001f9a2a4d'
        };

        objectSet( obj, [ 'a', 'b' ], 1 );
        assert.equal( objectGet( obj, [ 'a', 'b' ] ), 1 );
        assert.deepEqual(
            objectFlatten({ a: { b: 1, c: [ 2 ], id: foreignId } }),
            { 'a.b': 1, 'a.c.0': 2, 'a.id': foreignId }
        );
    });

    it( 'objectHash and objectHashID match for native and foreign ObjectId', () =>
    {
        const nativeId = new ObjectId( '5f4d6f9e6f0a4d001f9a2a4d' );
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            id          : Buffer.from( '5f4d6f9e6f0a4d001f9a2a4d', 'hex' ),
            toString    : () => '5f4d6f9e6f0a4d001f9a2a4d'
        };
        const hash = objectHash({ a: 1 }, { sort: true, alg: 'sha1' });

        assert.equal( typeof hash, 'string' );
        assert.equal( objectHashID({ a: 1 }, { sort: true, alg: 'sha1' }).toString().length, 24 );
        assert.equal(
            objectHash({ id: nativeId }, { alg: 'plain' }),
            objectHash({ id: foreignId }, { alg: 'plain' })
        );
    });
});
