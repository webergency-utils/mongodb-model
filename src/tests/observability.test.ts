import { describe, expect, test, vi } from 'vitest';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import { GET_OBSERVABILITY_OPTIONS } from '../symbols.js';
import type
{
    ModelCacheEvent,
    ModelErrorEvent,
    ModelMutationEvent,
    ModelQueryEvent,
    ModelSlowQueryEvent
}
from '../events.js';
import type { ModelsOptions, MongoPropertyDocument, MongoRootDocument, ObservabilityConfig } from '../types/external.js';

type ItemDBE = MongoPropertyDocument & { id: string, label: string };
type ItemDTO = { id: string, label: string };
type UserDBE = MongoRootDocument & { _id: string, name: string, items?: ItemDBE[] };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor( options: ModelsOptions = {} )
    {
        super( 'mongodb://localhost/test-observability-' + Math.random().toString( 36 ).slice( 2 ), options );
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
        dto : { converter: ( dbe: UserDBE ) => Promise<UserDTO> | UserDTO }
        dbe : { converter: ( dbe: UserDBE ) => UserDBE }
    }
}>
{
    constructor( models: AbstractModels, collection: any, extra: { observability?: ObservabilityConfig, cache?: boolean } = {} )
    {
        super( models, collection,
        {
            ...extra,
            converters:
            {
                dto : { converter: async( dbe ) => ({ id: dbe._id, name: dbe.name }) },
                dbe : { converter: ( dbe ) => dbe }
            }
        });
    }
}

class ItemModel extends AbstractPropertyModel<UserDBE, ItemDBE, ItemDTO,
{
    converters:
    {
        dto : { converter: ( dbe: ItemDBE ) => ItemDTO }
        dbe : { converter: ( dbe: ItemDBE ) => ItemDBE }
    }
}>
{
    constructor( models: AbstractModels, collection: any, extra: { observability?: ObservabilityConfig } = {} )
    {
        super( models, collection, 'items[]',
        {
            ...extra,
            converters:
            {
                dto : { converter: ( dbe ) => ({ id: dbe.id, label: dbe.label }) },
                dbe : { converter: ( dbe ) => dbe }
            }
        });
    }
}

describe( 'Observability hierarchy & events', () =>
{
    test( 'inherits observability options from AbstractModels -> AbstractModel -> AbstractPropertyModel and strips from MongoClient options', async() =>
    {
        const onQuery = vi.fn();
        const models = new TestModels(
        {
            observability   : { slowQueryMs: 50, onQuery },
            maxPoolSize     : 33
        });

        const collection = { collectionName: 'users', aggregate: vi.fn() };
        const users = new UserModel( models, collection, { observability: { slowQueryMs: 25 } });
        const items = new ItemModel( models, collection );
        const disabledItems = new ItemModel( models, collection, { observability: false });

        expect( 'observability' in ( models.getClient() as any ).options ).toBe( false );
        expect( ( models as any )[GET_OBSERVABILITY_OPTIONS]() ).toMatchObject({ slowQueryMs: 50, onQuery });
        expect( ( users as any )[GET_OBSERVABILITY_OPTIONS]() ).toMatchObject({ slowQueryMs: 25, onQuery });
        expect( ( items as any )[GET_OBSERVABILITY_OPTIONS]() ).toMatchObject({ slowQueryMs: 25, onQuery });
        expect( ( disabledItems as any )[GET_OBSERVABILITY_OPTIONS]() ).toBeUndefined();

        await models.shutdown();
    });

    test( 'emits query, slowQuery, mutation, and error events with traceID and converterDuration to both model and models listeners', async() =>
    {
        const onQueryHook = vi.fn();
        const onMutationHook = vi.fn();
        const onSlowQueryHook = vi.fn();
        const onErrorHook = vi.fn();
        const logger =
        {
            info    : vi.fn(),
            warn    : vi.fn(),
            error   : vi.fn()
        };

        const models = new TestModels(
        {
            observability:
            {
                slowQueryMs : 0,
                onQuery     : onQueryHook,
                onMutation  : onMutationHook,
                onSlowQuery : onSlowQueryHook,
                onError     : onErrorHook,
                logger
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada' }]
        }));
        const insertOne = vi.fn( async() => ({ insertedId: 'u2' }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const deleteOne = vi.fn( async() => ({ deletedCount: 1 }));

        const collection =
        {
            collectionName: 'users',
            aggregate,
            insertOne,
            updateOne,
            deleteOne
        };

        const users = new UserModel( models, collection );

        const containerQueries: ModelQueryEvent[] = [];
        const containerMutations: ModelMutationEvent[] = [];
        const containerSlow: ModelSlowQueryEvent[] = [];
        const containerErrors: ModelErrorEvent[] = [];

        const offQuery = models.on( 'query', e => containerQueries.push( e ) );
        models.on( 'mutation', e => containerMutations.push( e ) );
        models.on( 'slowQuery', e => containerSlow.push( e ) );
        models.on( 'error', e => containerErrors.push( e ) );

        await models.scope.execute( async() =>
        {
            await users.list({});
            await users.create({ name: 'Bob' }, 'u2' );
            await users.update( 'u2', { name: 'Bobby' } );
            await users.delete( 'u2' );
        }, { traceID: 'trace-obs-1' });

        expect( containerQueries ).toHaveLength( 1 );
        expect( containerQueries[0] ).toMatchObject(
        {
            collection  : 'users',
            model       : 'UserModel',
            operation   : 'list',
            resultCount : 1,
            conversion  : 'dto',
            traceID     : 'trace-obs-1'
        });
        expect( typeof containerQueries[0].converterDuration ).toBe( 'number' );

        expect( containerMutations ).toHaveLength( 3 );
        expect( containerMutations.map( m => m.operation ) ).toEqual([ 'create', 'update', 'delete' ]);
        expect( containerMutations[0].traceID ).toBe( 'trace-obs-1' );
        expect( containerMutations[1].matchedCount ).toBe( 1 );
        expect( containerMutations[2].deletedCount ).toBe( 1 );

        // Because slowQueryMs: 0, all 4 operations trigger slowQuery
        expect( containerSlow.length ).toBeGreaterThanOrEqual( 4 );
        expect( containerSlow[0].thresholdMs ).toBe( 0 );
        expect( onQueryHook ).toHaveBeenCalledOnce();
        expect( onMutationHook ).toHaveBeenCalledTimes( 3 );
        expect( onSlowQueryHook ).toHaveBeenCalled();
        expect( logger.warn ).toHaveBeenCalled();

        // Test unsubscribe on AbstractModels
        offQuery();
        await users.list({});
        expect( containerQueries ).toHaveLength( 1 );

        // Test error emission
        aggregate.mockImplementationOnce(() =>
        ({
            toArray: async() => { throw new Error( 'db-crash' ) }
        }));

        await expect( users.get( 'u99' ) ).rejects.toThrow( 'db-crash' );
        expect( containerErrors ).toHaveLength( 1 );
        expect( containerErrors[0].operation ).toBe( 'get' );
        expect( onErrorHook ).toHaveBeenCalledOnce();
        expect( logger.error ).toHaveBeenCalledOnce();

        await models.shutdown();
    });

    test( 'PropertyModel emits mutation and query events to container and hooks', async() =>
    {
        const models = new TestModels({ observability: { slowQueryMs: 10_000 } });
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada', items: [{ id: 'i1', label: 'A' }] }]
        }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        const collection =
        {
            collectionName: 'users',
            aggregate,
            updateOne,
            updateMany
        };

        new UserModel( models, collection );
        const items = new ItemModel( models, collection );

        const mutations: ModelMutationEvent[] = [];
        const queries: ModelQueryEvent[] = [];
        const caches: ModelCacheEvent[] = [];

        models.on( 'mutation', e => mutations.push( e ) );
        models.on( 'query', e => queries.push( e ) );
        models.on( 'cache', e => caches.push( e ) );

        await items.create( 'u1', { label: 'New' }, 'i2' );
        await items.update( 'i2', { label: 'Updated' } );
        await items.updateMany([ 'i2' ], { label: 'Batch' } );
        await items.find({ filter: { label: 'Batch' } });

        expect( mutations.map( m => m.operation ) ).toEqual([ 'create', 'update', 'updateMany' ]);
        expect( mutations[0].collection ).toBe( 'users.items' );
        expect( queries.some( q => q.operation === 'find' && q.collection === 'users.items' ) ).toBe( true );

        await models.shutdown();
    });
});
