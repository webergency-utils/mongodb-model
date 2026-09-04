import { describe, expect, test, vi } from 'vitest';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument & { _id: string, name: string };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor( client: any )
    {
        super( 'mongodb://localhost/test' );
        ( this as any ).client = client;
    }
}

class SharedClientModels extends AbstractModels
{
    constructor( connectionString: string )
    {
        super( connectionString );
    }

    getClient()
    {
        return this.client;
    }
}

class UserModel extends AbstractModel<UserDBE, UserDTO,
{
    converters:
    {
        dto : { converter: ( dbe: UserDBE ) => UserDTO }
        dbe : { converter: ( dbe: UserDBE ) => UserDBE }
    }
}>
{
    constructor( models: AbstractModels, collection: any )
    {
        super( models, collection,
        {
            converters:
            {
                dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name }) },
                dbe : { converter: ( dbe ) => dbe }
            }
        });
    }
}

describe( 'AbstractModels.transaction', () =>
{
    test( 'ends session in finally', async() =>
    {
        const endSession = vi.fn( async() => undefined );
        const withTransaction = vi.fn( async( fn: any ) => fn());
        const startSession = vi.fn(() => ({ withTransaction, endSession }));
        const models = new TestModels({ startSession, close: vi.fn( async() => undefined ) });

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
        const models = new TestModels({ startSession, close: vi.fn( async() => undefined ) });

        await expect( models.transaction( async() => undefined )).rejects.toThrow( 'boom' );
        expect( endSession ).toHaveBeenCalledOnce();
    });
});

describe( 'AbstractModels.shutdown', () =>
{
    test( 'closes client once and is idempotent', async() =>
    {
        const close = vi.fn( async() => undefined );
        const models = new TestModels({ close });

        await models.shutdown();
        await models.shutdown();

        expect( close ).toHaveBeenCalledOnce();
    });

    test( 'rejects transactions after shutdown', async() =>
    {
        const close = vi.fn( async() => undefined );
        const startSession = vi.fn();
        const models = new TestModels({ close, startSession });

        await models.shutdown();

        await expect( models.transaction( async() => 'ok' )).rejects.toMatchObject({ code: 'MODEL_SHUTDOWN' });
        expect( startSession ).not.toHaveBeenCalled();
    });

    test( 'rejects model queries after shutdown', async() =>
    {
        const uri = 'mongodb://localhost/shutdown-reject-' + Date.now();
        const models = new SharedClientModels( uri );
        const model = new UserModel( models,
        {
            collectionName  : 'users',
            aggregate       : vi.fn()
        });

        await models.shutdown();

        await expect( model.get( '1' )).rejects.toMatchObject({ code: 'MODEL_SHUTDOWN' });
    });

    test( 'waits for in-flight queries up to timeout before close', async() =>
    {
        let releaseGate!: () => void;
        const gate = new Promise<void>( resolve => { releaseGate = resolve });

        const close = vi.fn( async() => undefined );
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            {
                await gate;

                return [{ _id: '1', name: 'Ada' }];
            }
        }));

        const models = new TestModels({ close });
        const model = new UserModel( models, { collectionName: 'users', aggregate });

        const pending = model.get( '1' );
        let closed = false;

        const shuttingDown = models.shutdown({ timeout: 5000 }).then(() => { closed = true });

        await Promise.resolve();
        expect( closed ).toBe( false );
        expect( close ).not.toHaveBeenCalled();

        releaseGate();
        await expect( pending ).resolves.toEqual({ id: '1', name: 'Ada' });
        await shuttingDown;

        expect( close ).toHaveBeenCalledOnce();
    });

    test( 'timeout expires even if queries are still running', async() =>
    {
        const close = vi.fn( async() => undefined );
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            {
                await new Promise( resolve => setTimeout( resolve, 200 ));

                return [{ _id: '1', name: 'Ada' }];
            }
        }));

        const models = new TestModels({ close });
        const model = new UserModel( models, { collectionName: 'users', aggregate });

        const pending = model.get( '1' );

        await models.shutdown({ timeout: 20 });

        expect( close ).toHaveBeenCalledOnce();
        await expect( pending ).resolves.toEqual({ id: '1', name: 'Ada' });
    });

    test( 'evicts shared client so a later instance gets a fresh client', async() =>
    {
        const uri = 'mongodb://localhost/shutdown-evict-' + Date.now();
        const first = new SharedClientModels( uri );
        const shared = new SharedClientModels( uri );

        expect( shared.getClient()).toBe( first.getClient());

        const closedClient = first.getClient();

        await first.shutdown();

        const next = new SharedClientModels( uri );

        expect( next.getClient()).not.toBe( closedClient );

        await next.shutdown();
        await shared.shutdown();
    });
});
