import { describe, expect, test, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import
{
    ModelCache,
    buildCacheKey,
    cloneCachedValue,
    extractTargetIdsFromFilter
}
from '../cache.js';

describe( 'ModelCache & cache utilities', () =>
{
    test( 'cloneCachedValue deep-clones primitives, ObjectId, foreign ObjectId, Date, RegExp, arrays, and plain objects', () =>
    {
        const nativeId = new ObjectId( '507f1f77bcf86cd799439011' );
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            toString    : () => '507f1f77bcf86cd799439012'
        };
        const date = new Date( '2025-01-01T00:00:00.000Z' );
        const regex = /abc/gi;

        const original =
        {
            id      : nativeId,
            foreign : foreignId,
            date,
            regex,
            tags    : [ 'a', 'b' ],
            nested  : { count: 1, flag: true, nil: null, undef: undefined }
        };

        const cloned = cloneCachedValue( original );

        expect( cloned ).not.toBe( original );
        expect( cloned.id ).toBeInstanceOf( ObjectId );
        expect( cloned.id ).not.toBe( nativeId );
        expect( cloned.id.toHexString() ).toBe( '507f1f77bcf86cd799439011' );
        expect( cloned.foreign ).toBeInstanceOf( ObjectId );
        expect( ( cloned.foreign as unknown as ObjectId ).toHexString() ).toBe( '507f1f77bcf86cd799439012' );
        expect( cloned.date ).toBeInstanceOf( Date );
        expect( cloned.date ).not.toBe( date );
        expect( cloned.date.getTime() ).toBe( date.getTime() );
        expect( cloned.regex ).toBeInstanceOf( RegExp );
        expect( cloned.regex ).not.toBe( regex );
        expect( cloned.regex.source ).toBe( 'abc' );
        expect( cloned.regex.flags ).toBe( 'gi' );

        cloned.tags.push( 'mutated' );
        cloned.nested.count = 99;

        expect( original.tags ).toEqual([ 'a', 'b' ]);
        expect( original.nested.count ).toBe( 1 );
    });

    test( 'buildCacheKey formats conversion, id, and optional scopeKey', () =>
    {
        expect( buildCacheKey( 'dto', '123' ) ).toBe( 'dto:123' );
        expect( buildCacheKey( 'dbe', '123', 'org1' ) ).toBe( 'dbe:123:org1' );
    });

    test( 'ModelCache stores, clones on get/set, and invalidates all variants by ID', () =>
    {
        const cache = new ModelCache( true );
        const dto = { id: 'u1', name: 'Alice', roles: [ 'admin' ] };
        const dbe = { _id: new ObjectId( '507f1f77bcf86cd799439011' ), name: 'Alice' };

        cache.set( 'dto:u1', dto, [ 'u1' ] );
        cache.set( 'dbe:u1', dbe, [ 'u1' ] );
        cache.set( 'dto:u2', { id: 'u2', name: 'Bob' }, [ 'u2' ] );

        const firstRead = cache.get<{ id: string, name: string, roles: string[] }>( 'dto:u1' )!;
        expect( firstRead ).toEqual( dto );
        firstRead.roles.push( 'hacked' );

        const secondRead = cache.get<{ id: string, name: string, roles: string[] }>( 'dto:u1' )!;
        expect( secondRead.roles ).toEqual([ 'admin' ]);

        const evictedKeys = cache.invalidateIds([ 'u1' ]);
        expect( evictedKeys.sort() ).toEqual([ 'dbe:u1', 'dto:u1' ]);
        expect( cache.get( 'dto:u1' ) ).toBeUndefined();
        expect( cache.get( 'dbe:u1' ) ).toBeUndefined();
        expect( cache.get( 'dto:u2' ) ).toEqual({ id: 'u2', name: 'Bob' });
    });

    test( 'ModelCache respects ttl, sliding expiration, and maxTTL ceiling', () =>
    {
        vi.useFakeTimers();

        try
        {
            const cache = new ModelCache({ ttl: 100, sliding: true, maxTTL: 250 });

            cache.set( 'dto:1', { id: '1' }, [ '1' ] );

            vi.advanceTimersByTime( 80 );
            expect( cache.get( 'dto:1' ) ).toEqual({ id: '1' });

            vi.advanceTimersByTime( 80 );
            expect( cache.get( 'dto:1' ) ).toEqual({ id: '1' });

            vi.advanceTimersByTime( 100 );
            expect( cache.get( 'dto:1' ) ).toBeUndefined();
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    test( 'ModelCache enforces maxSize with LRU eviction and supports clear() and clone: false', () =>
    {
        const cache = new ModelCache({ maxSize: 2, clone: false });
        const a = { id: 'a' };
        const b = { id: 'b' };
        const c = { id: 'c' };

        cache.set( 'dto:a', a, [ 'a' ] );
        cache.set( 'dto:b', b, [ 'b' ] );

        // Touch 'a' so 'b' becomes least-recently-used
        expect( cache.get( 'dto:a' ) ).toBe( a );

        cache.set( 'dto:c', c, [ 'c' ] );

        expect( cache.get( 'dto:a' ) ).toBe( a );
        expect( cache.get( 'dto:b' ) ).toBeUndefined();
        expect( cache.get( 'dto:c' ) ).toBe( c );

        // Overwriting existing key does not evict
        cache.set( 'dto:a', { id: 'a2' }, [ 'a' ] );
        expect( cache.get( 'dto:c' ) ).toBe( c );

        cache.clear();
        expect( cache.get( 'dto:a' ) ).toBeUndefined();
        expect( cache.get( 'dto:c' ) ).toBeUndefined();
    });

    test( 'ModelCache delegates to custom ModelCacheInstance', () =>
    {
        const store = new Map<string, unknown>();
        const customInstance =
        {
            get             : vi.fn(( key: string ) => store.get( key )),
            set             : vi.fn(( key: string, val: unknown ) => { store.set( key, val ) }),
            invalidateIds   : vi.fn(( _ids: string[] ) =>
            {
                const keys = Array.from( store.keys() );
                store.clear();

                return keys;
            }),
            clear           : vi.fn(() => { store.clear() })
        };

        const cache = new ModelCache( customInstance );
        cache.set( 'dto:1', { id: '1' }, [ '1' ] );

        expect( customInstance.set ).toHaveBeenCalledOnce();
        expect( cache.get( 'dto:1' ) ).toEqual({ id: '1' });

        const evicted = cache.invalidateIds([ '1' ]);
        expect( evicted ).toEqual([ 'dto:1' ]);
        expect( customInstance.invalidateIds ).toHaveBeenCalledWith([ '1' ]);

        cache.clear();
        expect( customInstance.clear ).toHaveBeenCalledOnce();
    });

    test( 'extractTargetIdsFromFilter extracts IDs from direct, $eq, $in, $and, all-ID $or, and filter wrapper, ignoring non-ID filters', () =>
    {
        const norm = ( id: any ) => String( id );
        const oid = new ObjectId( '507f1f77bcf86cd799439011' );

        expect( extractTargetIdsFromFilter({ _id: oid }, '_id', norm ) ).toEqual([ '507f1f77bcf86cd799439011' ]);
        expect( extractTargetIdsFromFilter({ _id: { $eq: 'u1' } }, '_id', norm ) ).toEqual([ 'u1' ]);
        expect( extractTargetIdsFromFilter({ _id: { $in: [ 'u1', 'u2' ] } }, '_id', norm ) ).toEqual([ 'u1', 'u2' ]);
        expect( extractTargetIdsFromFilter({ filter: { id: 'p1' } }, 'id', norm ) ).toEqual([ 'p1' ]);
        expect( extractTargetIdsFromFilter({ $and: [{ _id: 'u1' }, { status: 'active' }] }, '_id', norm ) ).toEqual([ 'u1' ]);
        expect( extractTargetIdsFromFilter({ $or: [{ _id: 'u1' }, { _id: { $in: [ 'u2', 'u3' ] } }] }, '_id', norm ) ).toEqual([ 'u1', 'u2', 'u3' ]);

        // Non-ID filters return empty array
        expect( extractTargetIdsFromFilter({ status: 'active' }, '_id', norm ) ).toEqual([]);
        expect( extractTargetIdsFromFilter({ _id: { $ne: 'u1' } }, '_id', norm ) ).toEqual([]);
        expect( extractTargetIdsFromFilter({ $or: [{ _id: 'u1' }, { status: 'active' }] }, '_id', norm ) ).toEqual([]);
        expect( extractTargetIdsFromFilter( null, '_id', norm ) ).toEqual([]);
    });
});
