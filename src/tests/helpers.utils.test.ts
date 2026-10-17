import { afterEach, describe, expect, test, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { flowExecute } from '../flow.js';
import { Log } from '../helpers/log.js';
import { DUMP, LOG, LOG_FILE, hasPublicMethod, map } from '../helpers/utils.js';

describe( 'helpers/utils', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    test( 'hasPublicMethod detects public functions', () =>
    {
        const obj = { run: () => 1, value: 2 };

        expect( hasPublicMethod( obj, 'run' )).toBe( true );
        expect( hasPublicMethod( obj, 'value' )).toBe( false );
        expect( hasPublicMethod( null, 'run' )).toBeFalsy();
        expect( hasPublicMethod( obj, 'missing' )).toBe( false );
    });

    test( 'map indexes by id including native and foreign ObjectId', () =>
    {
        const id = new ObjectId( '507f1f77bcf86cd799439011' );
        const foreignLookupId =
        {
            _bsontype   : 'ObjectId',
            toString    : () => '507f1f77bcf86cd799439011'
        };
        const entries = [{ id, name: 'a' }, { id: '2', name: 'b' }];

        expect( map([ foreignLookupId as any, '2', 'missing' ], entries, e => e.id )).toEqual(
        [
            entries[0],
            entries[1],
            null
        ]);
    });

    test( 'LOG stringifies non-string args via inspect', () =>
    {
        const spy = vi.spyOn( console, 'log' ).mockImplementation(() => undefined );

        LOG( 'plain', { a: 1 });

        expect( spy ).toHaveBeenCalledOnce();
        expect( spy.mock.calls[0][0] ).toBe( 'plain' );
        expect( String( spy.mock.calls[0][1] )).toContain( 'a:' );
    });

    test( 'DUMP covers stringify branches including foreign ObjectId', () =>
    {
        const spy = vi.spyOn( console, 'log' ).mockImplementation(() => undefined );
        const id = new ObjectId( '507f1f77bcf86cd799439011' );
        const foreignId =
        {
            _bsontype   : 'ObjectId',
            toString    : () => '507f1f77bcf86cd799439012'
        };
        const date = new Date( '2020-01-01T00:00:00.000Z' );

        DUMP(
        {
            undef   : undefined,
            nil     : null,
            num     : 1,
            bool    : true,
            str     : 'x',
            arr     : [ 1, 'y' ],
            date,
            re      : /abc/i,
            id,
            foreignId,
            nested  : { k: 2 }
        });

        const out = String( spy.mock.calls[0][0] );

        expect( out ).toContain( 'undefined' );
        expect( out ).toContain( 'null' );
        expect( out ).toContain( 'ISODate("2020-01-01T00:00:00.000Z")' );
        expect( out ).toContain( '/abc/i' );
        expect( out ).toContain( 'ObjectId("507f1f77bcf86cd799439011")' );
        expect( out ).toContain( 'ObjectId("507f1f77bcf86cd799439012")' );
        expect( out ).toContain( '"k": 2' );
    });

    test( 'LOG_FILE noops without path or traceID', async() =>
    {
        const append = vi.spyOn( Log, 'append' ).mockResolvedValue( undefined );

        await flowExecute( async() =>
        {
            LOG_FILE({ a: 1 });
        }, {});

        await flowExecute( async() =>
        {
            LOG_FILE({ a: 1 });
        }, { experimentalFlags: { logQueries: '/tmp/logs' } });

        expect( append ).not.toHaveBeenCalled();
    });

    test( 'LOG_FILE appends with and without separator', async() =>
    {
        const append = vi.spyOn( Log, 'append' ).mockResolvedValue( undefined );

        await flowExecute( async() =>
        {
            LOG_FILE({ q: 1 });
            LOG_FILE({ q: 2 }, true );
        },
        {
            experimentalFlags   : { logQueries: '/tmp/logs' },
            traceID             : 'trace-1'
        });

        expect( append ).toHaveBeenCalledTimes( 2 );
        expect( append.mock.calls[0][0] ).toBe( '/tmp/logs/trace-1.txt' );
        expect( append.mock.calls[0][1] ).toContain( '"q": 1' );
        expect( append.mock.calls[0][1].endsWith( '\n' )).toBe( true );
        expect( append.mock.calls[1][1] ).toContain( '===============================' );
    });
});
