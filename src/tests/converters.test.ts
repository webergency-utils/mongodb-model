import { describe, expect, test } from 'vitest';
import { ModelConverterError } from '../errors.js';
import { ConverterManager } from '../converters.js';

class SampleModel {}

describe( 'ConverterManager', () =>
{
    test( 'exposes converters and options', () =>
    {
        const converters =
        {
            dto : { converter: async( dbe: any ) => ({ id: dbe._id }), projection: { name: 1 } },
            dbe : { converter: async( dbe: any ) => dbe }
        };
        const manager = new ConverterManager( new SampleModel(), converters );

        expect( manager.converters ).toBe( converters );
        expect( manager.options( 'dto' )).toEqual( converters.dto );
    });

    test( 'convert and convertMany map documents', async() =>
    {
        const manager = new ConverterManager( new SampleModel(), {
            dto: { converter: async( dbe: any ) => ({ id: dbe._id, name: dbe.name }) }
        });

        const one = await manager.convert({ _id: '1', name: 'Ada' } as any, 'dto' );
        const many = await manager.convertMany(
        [
            { _id: '1', name: 'Ada' } as any,
            null,
            { _id: '2', name: 'Bob' } as any
        ],
        'dto' );

        expect( one ).toEqual({ id: '1', name: 'Ada' });
        expect( many ).toEqual(
        [
            { id: '1', name: 'Ada' },
            null,
            { id: '2', name: 'Bob' }
        ]);
    });

    test( 'convert wraps converter failures as ModelConverterError', async() =>
    {
        const manager = new ConverterManager( new SampleModel(), {
            dto: { converter: async() => { throw new Error( 'boom' ) } }
        });

        await expect( manager.convert({ _id: 'x' } as any, 'dto' )).rejects.toBeInstanceOf( ModelConverterError );
    });
});
