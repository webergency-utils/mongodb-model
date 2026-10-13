import { describe, expect, test, vi } from 'vitest';
import
{
    ModelAccessConfigError,
    ModelAccessDeniedError,
    ModelConverterError,
    ModelError,
    ModelQueryError
}
from '../errors.js';
import { ConverterManager } from '../converters.js';
import { buildListResult, convertDocuments } from '../operations.js';
import { Benchmark } from '../helpers/benchmark.js';
import { DUMP, hasPublicMethod, LOG, LOG_FILE } from '../helpers/utils.js';
import { flowExecute, flowGet, flowSet, flowStart } from '../flow.js';
import { ObjectId } from 'mongodb';

describe( 'errors', () =>
{
    class Sample {}

    test( 'constructs typed model errors', () =>
    {
        const model = new Sample();
        const cause = new Error( 'root' );

        expect( new ModelError( 'X', model, 'm', cause ).code ).toBe( 'X' );
        expect( new ModelQueryError( model, 'q', cause ).code ).toBe( 'MODEL_QUERY_ERROR' );
        expect( new ModelConverterError( model, 'dto', '1', cause ).message ).toContain( 'dto converter failed' );
        expect( new ModelAccessDeniedError( model ).code ).toBe( 'MODEL_ACCESS_DENIED' );
        expect( new ModelAccessConfigError( model, 'bad' ).code ).toBe( 'MODEL_ACCESS_CONFIG' );
    });
});

describe( 'operations', () =>
{
    test( 'buildListResult orders and emits cursors', () =>
    {
        const items = [{ _id: 'a' }, { _id: 'b' }];
        const result = buildListResult( items, { _id: 1 }, { total: 2, reversed: true });

        expect( result.items.map( i => i._id ) ).toEqual([ 'b', 'a' ]);
        expect( result.total ).toBe( 2 );
        expect( result.cursors.prev ).toBeTypeOf( 'string' );
        expect( result.cursors.next ).toBeTypeOf( 'string' );
    });

    test( 'buildListResult empty has no cursors', () =>
    {
        expect( buildListResult( [], { _id: 1 }).cursors ).toEqual({});
    });

    test( 'convertDocuments maps and optionally filters nulls', async() =>
    {
        const converters = new ConverterManager({},
        {
            dto: { converter: async( dbe: any ) => ({ id: dbe._id }) }
        } as any );

        const docs = [{ _id: '1' }, null, { _id: '2' }] as any;

        expect( await convertDocuments( converters, docs, 'dto' ) ).toEqual(
        [
            { id: '1' },
            null,
            { id: '2' }
        ]);
        expect( await convertDocuments( converters, docs, 'dto', true ) ).toEqual(
        [
            { id: '1' },
            { id: '2' }
        ]);
    });
});

describe( 'ConverterManager', () =>
{
    test( 'options and convertMany', async() =>
    {
        const converters = new ConverterManager({},
        {
            dto: { converter: async( dbe: any ) => ({ id: dbe._id }), projection: { _id: 1 } }
        } as any );

        expect( converters.options( 'dto' ).projection ).toEqual({ _id: 1 });
        expect( converters.converters ).toBeTruthy();
        expect( await converters.convertMany([ { _id: '1' }, null ] as any, 'dto' ) ).toEqual(
        [
            { id: '1' },
            null
        ]);
    });
});

describe( 'Benchmark', () =>
{
    test( 'tracks steps and end', () =>
    {
        const log = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
        const bm = new Benchmark( 'x' );

        expect( bm.elapsed() ).toBeGreaterThanOrEqual( 0 );
        expect( typeof bm.startTime ).toBe( 'string' );
        expect( typeof bm.time ).toBe( 'string' );
        bm.step( 'A' );
        bm.end();
        expect( log ).toHaveBeenCalled();
        log.mockRestore();
    });
});

describe( 'utils', () =>
{
    test( 'hasPublicMethod', () =>
    {
        class A { foo(){ return 1 } }

        expect( hasPublicMethod( new A(), 'foo' ) ).toBe( true );
        expect( hasPublicMethod( new A(), 'bar' ) ).toBe( false );
        expect( hasPublicMethod( null, 'foo' ) ).toBeFalsy();
    });

    test( 'DUMP and LOG stringify specials', () =>
    {
        const log = vi.spyOn( console, 'log' ).mockImplementation( () => {} );

        DUMP({ id: new ObjectId( '507f1f77bcf86cd799439011' ), at: new Date( '2020-01-01' ), re: /a/i, arr: [ 1 ] });
        LOG( 'x', { y: 1 });
        expect( log ).toHaveBeenCalled();
        log.mockRestore();
    });

    test( 'LOG_FILE no-ops without flags', () =>
    {
        expect( () => LOG_FILE({ a: 1 }, true ) ).not.toThrow();
    });
});

describe( 'flow', () =>
{
    test( 'flowExecute sets and gets values', async() =>
    {
        await flowExecute( async() =>
        {
            flowSet( 'k', 1 );
            expect( flowGet( 'k' ) ).toBe( 1 );
        }, {});
    });

    test( 'flowStart runs callback', async() =>
    {
        let seen = false;

        await new Promise<void>( resolve =>
        {
            flowStart( () =>
            {
                seen = true;
                resolve();
            }, {});
        });

        expect( seen ).toBe( true );
    });
});
