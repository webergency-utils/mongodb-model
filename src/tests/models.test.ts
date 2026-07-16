import { describe, expect, test, vi } from 'vitest';
import { AbstractModels } from '../models.js';

class TestModels extends AbstractModels
{
    constructor( client: any )
    {
        super( 'mongodb://localhost/test' );
        ( this as any ).client = client;
    }
}

describe( 'AbstractModels.transaction', () =>
{
    test( 'ends session in finally', async() =>
    {
        const endSession = vi.fn( async() => undefined );
        const withTransaction = vi.fn( async( fn: any ) => fn());
        const startSession = vi.fn(() => ({ withTransaction, endSession }));
        const models = new TestModels({ startSession });

        const result = await models.transaction( async() => 'ok' );

        expect( result ).toBe( 'ok' );
        expect( startSession ).toHaveBeenCalledOnce();
        expect( withTransaction ).toHaveBeenCalledOnce();
        expect( endSession ).toHaveBeenCalledOnce();
    });

    test( 'ends session even when transaction throws', async() =>
    {
        const endSession = vi.fn( async() => undefined );
        const withTransaction = vi.fn( async() => { throw new Error( 'boom' ) });
        const startSession = vi.fn(() => ({ withTransaction, endSession }));
        const models = new TestModels({ startSession });

        await expect( models.transaction( async() => undefined )).rejects.toThrow( 'boom' );
        expect( endSession ).toHaveBeenCalledOnce();
    });
});
