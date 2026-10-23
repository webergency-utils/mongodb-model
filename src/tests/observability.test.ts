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

describe( 'Observability query context, selective operations & internal pre-queries', () =>
{
    test( 'AE1: mutation-only logging skips disabled read queries with zero context overhead and merges 3-tier context on mutations', async() =>
    {
        const queryLogs: ModelQueryEvent[] = [];
        const mutationLogs: ModelMutationEvent[] = [];
        const contextSpy = vi.fn();

        const models = new TestModels(
        {
            observability:
            {
                operations  : [ 'mutation' ],
                context     : [ 'userID', 'tenant' ],
                onQuery     : ( e ) => queryLogs.push( e ),
                onMutation  : ( e ) => mutationLogs.push( e )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada' }]
        }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const collection = { collectionName: 'users', aggregate, updateOne };
        const users = new UserModel( models, collection );

        await models.scope.execute( async() =>
        {
            await users.find({ filter: { name: 'Ada' } });
            await users.updateOne(
                { name: 'Ada' },
                { $set: { name: 'Ada Lovelace' } },
                { context: { reason: 'promote' } }
            );
        }, { userID: 'u1', tenant: 't1', context: { route: 'POST /users' } });

        expect( queryLogs ).toHaveLength( 0 );
        expect( mutationLogs ).toHaveLength( 1 );
        expect( mutationLogs[0] ).toMatchObject(
        {
            operation   : 'updateOne',
            filter      : { name: 'Ada' },
            context     :
            {
                userID  : 'u1',
                tenant  : 't1',
                route   : 'POST /users',
                reason  : 'promote'
            }
        });

        // Verify fast-path zero overhead: context resolver function is never invoked for disabled read queries
        const fnModels = new TestModels(
        {
            observability:
            {
                operations  : [ 'mutation' ],
                context     : () =>
                {
                    contextSpy();

                    return { env: 'prod' };
                },
                onQuery     : ( e ) => queryLogs.push( e ),
                onMutation  : ( e ) => mutationLogs.push( e )
            }
        });
        const fnUsers = new UserModel( fnModels, collection );

        await fnUsers.find({ filter: { name: 'Ada' } });
        await fnUsers.list({ filter: { name: 'Ada' } });
        expect( contextSpy ).not.toHaveBeenCalled();

        await fnUsers.updateOne({ name: 'Ada' }, { $set: { name: 'Updated' } });
        expect( contextSpy ).toHaveBeenCalledOnce();

        await models.shutdown();
        await fnModels.shutdown();
    });

    test( 'AE2: slow read query still fires slowQuery with context and query metadata when only mutations are enabled', async() =>
    {
        const onQuery = vi.fn();
        const slowQueries: ModelSlowQueryEvent[] = [];

        const models = new TestModels(
        {
            observability:
            {
                operations  : [ 'mutation' ],
                slowQueryMs : 20,
                context     : [ 'requestID' ],
                onQuery,
                onSlowQuery : ( e ) => slowQueries.push( e )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            {
                await new Promise( r => setTimeout( r, 35 ));

                return [{ _id: 'u1', name: 'Ada' }];
            }
        }));
        const collection = { collectionName: 'users', aggregate };
        const users = new UserModel( models, collection );

        await models.scope.execute( async() =>
        {
            await users.list(
            {
                filter  : { name: 'Ada' },
                sort    : { name: 1 },
                limit   : 10,
                context : { page: 'directory' }
            });
        }, { requestID: 'req-slow-1' });

        expect( onQuery ).not.toHaveBeenCalled();
        expect( slowQueries ).toHaveLength( 1 );
        expect( slowQueries[0] ).toMatchObject(
        {
            operation   : 'list',
            thresholdMs : 20,
            context     : { requestID: 'req-slow-1', page: 'directory' },
            query       :
            {
                filter  : { name: 'Ada' },
                sort    : { name: 1, _id: 1 },
                limit   : 10
            }
        });
        expect( slowQueries[0].duration ).toBeGreaterThanOrEqual( 20 );

        await models.shutdown();
    });

    test( 'AE3: PropertyModel mutation emits internal pre-query with parentOperation and suppresses it when internal: false', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ id: 'i1' }]
        }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const collection = { collectionName: 'users', aggregate, updateMany };

        const events1: Array<{ type: string, payload: any }> = [];
        const models1 = new TestModels(
        {
            observability:
            {
                operations  : [ 'update' ],
                onQuery     : ( e ) => events1.push({ type: 'query', payload: e }),
                onMutation  : ( e ) => events1.push({ type: 'mutation', payload: e })
            }
        });
        new UserModel( models1, collection );
        const items1 = new ItemModel( models1, collection );

        await items1.updateMany(
            { label: 'pending' },
            { $set: { label: 'done' } },
            { context: { jobID: 'j1' }, traceID: 'tr-1' }
        );

        expect( events1 ).toHaveLength( 2 );
        expect( events1[0] ).toMatchObject(
        {
            type    : 'query',
            payload :
            {
                collection      : 'users.items',
                operation       : 'aggregate',
                internal        : true,
                parentOperation : 'updateMany',
                context         : { jobID: 'j1' },
                traceID         : 'tr-1',
                query           : { filter: { label: 'pending' } }
            }
        });
        expect( events1[1] ).toMatchObject(
        {
            type    : 'mutation',
            payload :
            {
                collection  : 'users.items',
                operation   : 'updateMany',
                filter      : { label: 'pending' },
                context     : { jobID: 'j1' },
                traceID     : 'tr-1'
            }
        });

        const events2: Array<{ type: string, payload: any }> = [];
        const models2 = new TestModels(
        {
            observability:
            {
                operations  : { update: true, internal: false },
                onQuery     : ( e ) => events2.push({ type: 'query', payload: e }),
                onMutation  : ( e ) => events2.push({ type: 'mutation', payload: e })
            }
        });
        new UserModel( models2, collection );
        const items2 = new ItemModel( models2, collection );

        await items2.updateMany(
            { label: 'pending' },
            { $set: { label: 'done' } },
            { context: { jobID: 'j2' } }
        );

        expect( events2 ).toHaveLength( 1 );
        expect( events2[0].type ).toBe( 'mutation' );
        expect( events2[0].payload.operation ).toBe( 'updateMany' );
        expect( events2[0].payload.context ).toEqual({ jobID: 'j2' });

        await models1.shutdown();
        await models2.shutdown();
    });

    test( 'AE4: fine-grained operation selection and boolean map overrides', async() =>
    {
        const observedOps: string[] = [];
        const models = new TestModels(
        {
            observability:
            {
                operations  : [ 'find', 'aggregate', 'update', 'delete' ],
                onQuery     : ( e ) => observedOps.push( `query:${e.operation}` ),
                onMutation  : ( e ) => observedOps.push( `mutation:${e.operation}` )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada', count: 1 }]
        }));
        const insertOne = vi.fn( async() => ({ insertedId: 'u1' }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const deleteMany = vi.fn( async() => ({ deletedCount: 1 }));
        const collection = { collectionName: 'users', aggregate, insertOne, updateOne, deleteMany };
        const users = new UserModel( models, collection );

        await users.get( 'u1' );
        await users.getMany([ 'u1', 'u2' ]);
        await users.count({ filter: { name: 'Ada' } });
        await users.exists( 'u1' );
        await users.create({ name: 'Ada' }, 'u1' );
        await users.find({ filter: { name: 'Ada' } });
        await users.aggregate([{ $match: { name: 'Ada' } }], { context: { step: 'agg' } });
        await users.updateOne({ name: 'Ada' }, { $set: { name: 'Grace' } });
        await users.deleteMany({ name: 'Grace' });

        expect( observedOps ).toEqual(
        [
            'query:find',
            'query:aggregate',
            'mutation:updateOne',
            'mutation:deleteMany'
        ]);

        // Boolean map override: { mutation: true, delete: false }
        const mapOps: string[] = [];
        const mapModels = new TestModels(
        {
            observability:
            {
                operations  : { mutation: true, delete: false },
                onMutation  : ( e ) => mapOps.push( e.operation )
            }
        });
        const mapUsers = new UserModel( mapModels, collection );

        await mapUsers.create({ name: 'Ada' }, 'u1' );
        await mapUsers.updateOne({ name: 'Ada' }, { $set: { name: 'Grace' } });
        await mapUsers.deleteMany({ name: 'Grace' });

        expect( mapOps ).toEqual([ 'create', 'updateOne' ]);

        await models.shutdown();
        await mapModels.shutdown();
    });

    test( 'three-tier context priority, safe error handling in context resolver, and batched get/getMany context & ids', async() =>
    {
        const queries: ModelQueryEvent[] = [];
        let shouldThrowInContext = false;
        const consoleSpy = vi.spyOn( console, 'error' ).mockImplementation(() => undefined );

        const models = new TestModels(
        {
            observability:
            {
                context : () =>
                {
                    if( shouldThrowInContext )
                    {
                        throw new Error( 'context-resolver-boom' );
                    }

                    return { tier1: 'base', shared: 'from-tier1' };
                },
                onQuery : ( e ) => queries.push( e )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada' }, { _id: 'u2', name: 'Bob' }, { _id: 'u3', name: 'Cara' }]
        }));
        const collection = { collectionName: 'users', aggregate };
        const users = new UserModel( models, collection );

        await models.scope.execute( async() =>
        {
            // Same-tick get + getMany batching with per-call context
            await Promise.all(
            [
                users.get( 'u1', { context: { fromGet: 1, shared: 'from-get' } }),
                users.getMany([ 'u2', 'u3' ], { context: { fromGetMany: 2, shared: 'from-getMany' }, traceID: 'explicit-trace' })
            ]);
        }, { traceID: 'ambient-trace', context: { tier2: 'scope', shared: 'from-tier2' } });

        expect( aggregate ).toHaveBeenCalledOnce();
        expect( queries ).toHaveLength( 1 );
        expect( queries[0] ).toMatchObject(
        {
            operation   : 'get',
            traceID     : 'explicit-trace',
            query       : { ids: [ 'u1', 'u2', 'u3' ] },
            context     :
            {
                tier1       : 'base',
                tier2       : 'scope',
                fromGet     : 1,
                fromGetMany : 2,
                shared      : 'from-getMany'
            }
        });

        // Standalone getMany emits 'getMany' and throwing context resolver does not break query
        shouldThrowInContext = true;
        await users.getMany([ 'u2', 'u3' ]);
        expect( queries ).toHaveLength( 2 );
        expect( queries[1].operation ).toBe( 'getMany' );
        expect( queries[1].context ).toBeUndefined();
        expect( consoleSpy ).toHaveBeenCalled();

        consoleSpy.mockRestore();
        await models.shutdown();
    });

    test( 'all 4 internal pre-query sites emit internal: true with parentOperation and aggregate/list strip context from pipeline', async() =>
    {
        const queries: ModelQueryEvent[] = [];
        const mutations: ModelMutationEvent[] = [];

        const models = new TestModels(
        {
            observability:
            {
                onQuery     : ( e ) => queries.push( e ),
                onMutation  : ( e ) => mutations.push( e )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', id: 'i1', name: 'Ada' }]
        }));
        const findOne = vi.fn( async() => ({ _id: 'u1', name: 'Ada-before' }));
        const findOneAndUpdate = vi.fn( async() => ({ _id: 'u1', name: 'Ada-after' }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const insertOne = vi.fn( async() =>
        {
            const err: any = new Error( 'dup' );
            err.code = 11000;
            err.keyValue = { name: 'Ada' };
            throw err;
        });

        const collection =
        {
            collectionName: 'users',
            aggregate,
            findOne,
            findOneAndUpdate,
            updateOne,
            insertOne
        };

        class SmartUserModel extends AbstractModel<UserDBE, UserDTO,
        {
            converters:
            {
                dto : { converter: ( dbe: UserDBE ) => UserDTO, computedProperties: [ 'fullTitle' ] }
                dbe : { converter: ( dbe: UserDBE ) => UserDBE }
            }
            smartFilters:
            {
                byLookup: ( v: string ) => { pipeline: Document[] }
            }
            computedProperties:
            {
                fullTitle: () => { fields: Record<string, any> }
            }
        }>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name }), computedProperties: [ 'fullTitle' ] },
                        dbe : { converter: ( dbe ) => dbe }
                    },
                    smartFilters:
                    {
                        byLookup: ( v: string ) => ({ pipeline: [{ $lookup: { from: 'roles', as: v, localField: '_id', foreignField: 'userID' } }] })
                    },
                    computedProperties:
                    {
                        fullTitle: () => ({ fields: { fullTitle: '$name' } })
                    }
                });
            }
        }

        const smartUsers = new SmartUserModel();
        const items = new ItemModel( models, collection );

        // 1. #resolveFilterMatch with smartFilter.pipeline + 2. #findOneAndUpdateWithSnapshots with documentBefore & documentAfter
        await smartUsers.updateOne(
            { filter: { name: 'Ada' }, smartFilter: { byLookup: 'admin' } },
            { $set: { name: 'Ada-after' } },
            { documentBefore: true, documentAfter: true, context: { op: 'smart-snap' } }
        );

        expect( queries[0] ).toMatchObject(
        {
            operation       : 'aggregate',
            internal        : true,
            parentOperation : 'updateOne',
            context         : { op: 'smart-snap' },
            query           : { filter: { name: 'Ada' }, smartFilter: { byLookup: 'admin' } }
        });
        expect( queries[1] ).toMatchObject(
        {
            operation       : 'get',
            internal        : true,
            parentOperation : 'updateOne',
            context         : { op: 'smart-snap' }
        });
        expect( mutations[0] ).toMatchObject(
        {
            operation   : 'updateOne',
            smartFilter : { byLookup: 'admin' },
            context     : { op: 'smart-snap' }
        });

        // 3. create with duplicateIgnore: true on 11000
        queries.length = 0;
        mutations.length = 0;
        await smartUsers.create({ name: 'Ada' }, 'u1', { duplicateIgnore: true, context: { op: 'dup-ignore' } });

        expect( queries[0] ).toMatchObject(
        {
            operation       : 'get',
            internal        : true,
            parentOperation : 'create',
            context         : { op: 'dup-ignore' },
            query           : { filter: { name: 'Ada' } }
        });
        expect( mutations[0] ).toMatchObject(
        {
            operation       : 'create',
            insertedCount   : 0,
            ids             : [ 'u1' ],
            context         : { op: 'dup-ignore' }
        });

        // 4. PropertyModel.create includes parentID
        mutations.length = 0;
        await items.create( 'u1', { label: 'Child' }, 'i1', { context: { op: 'child-create' } });
        expect( mutations[0] ).toMatchObject(
        {
            operation   : 'create',
            parentID    : 'u1',
            ids         : [ 'i1' ],
            context     : { op: 'child-create' }
        });

        // 5. aggregate(pipeline, { context, traceID }) on model with computedProperties does not inject computedProperties
        queries.length = 0;
        aggregate.mockClear();
        await smartUsers.aggregate([{ $match: { name: 'Ada' } }], { context: { onlyCtx: true }, traceID: 'tr-agg' });
        expect( aggregate ).toHaveBeenCalledWith([{ $match: { name: 'Ada' } }], { collation: { locale: 'en' } });
        expect( queries[0] ).toMatchObject(
        {
            operation   : 'aggregate',
            context     : { onlyCtx: true },
            traceID     : 'tr-agg'
        });

        // 6. PropertyModel.update with documentBefore & documentAfter emits internal: true pre-queries with parentOperation: 'update'
        queries.length = 0;
        mutations.length = 0;
        await items.update( 'i1', { label: 'SnapChild' }, { documentBefore: true, documentAfter: true, context: { op: 'prop-snap' } });
        expect( queries.filter( q => q.internal ) ).toHaveLength( 2 );
        expect( queries[0] ).toMatchObject(
        {
            operation       : 'get',
            internal        : true,
            parentOperation : 'update',
            context         : { op: 'prop-snap' },
            query           : { ids: [ 'i1' ] }
        });
        expect( queries[1] ).toMatchObject(
        {
            operation       : 'get',
            internal        : true,
            parentOperation : 'update',
            context         : { op: 'prop-snap' },
            query           : { ids: [ 'i1' ] }
        });

        await models.shutdown();
    });

    test( 'supports exclusion-only operations maps, model-level observability: false suppression, raw traceID/context document filters, error metadata, and stream converter deduplication', async() =>
    {
        // 1. Exclusion-only object map: { internal: false, delete: false } keeps normal queries and non-delete mutations active
        const queries: ModelQueryEvent[] = [];
        const mutations: ModelMutationEvent[] = [];
        const errors: ModelErrorEvent[] = [];

        const models = new TestModels(
        {
            observability:
            {
                operations  : { internal: false, delete: false },
                onQuery     : ( e ) => queries.push( e ),
                onMutation  : ( e ) => mutations.push( e ),
                onError     : ( e ) => errors.push( e )
            }
        });

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: 'u1', name: 'Ada', items: [{ id: 'i1', label: 'A' }] }]
        }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const deleteMany = vi.fn( async() => ({ deletedCount: 1 }));
        const deleteOne = vi.fn( async() => ({ deletedCount: 1 }));

        const collection =
        {
            collectionName: 'users',
            aggregate,
            updateOne,
            deleteMany,
            deleteOne
        };

        const users = new UserModel( models, collection );
        const items = new ItemModel( models, collection );

        await users.find({ filter: { name: 'Ada' } });
        expect( queries ).toHaveLength( 1 );

        // Internal pre-queries during items.update with documentBefore are suppressed by { internal: false }
        queries.length = 0;
        await items.update( 'i1', { label: 'B' }, { documentBefore: true });
        expect( queries ).toHaveLength( 0 );
        expect( mutations ).toHaveLength( 1 );
        expect( mutations[0].operation ).toBe( 'update' );

        // Delete mutations are suppressed by { delete: false }
        mutations.length = 0;
        await users.delete( 'u1' );
        expect( mutations ).toHaveLength( 0 );

        // 2. Model with observability: false does not forward events to container models.on() listeners
        const disabledCollection = { ...collection, collectionName: 'disabled_users' };
        const disabledUsers = new UserModel( models, disabledCollection, { observability: false });
        const containerQueries: ModelQueryEvent[] = [];
        models.on( 'query', e => containerQueries.push( e ) );
        await disabledUsers.find({ filter: { name: 'Ada' } });
        expect( containerQueries ).toHaveLength( 0 );

        // 3. Raw document filter on { traceID: 'doc-trace' } in deleteMany is preserved as a filter, not wiped to {}
        await users.deleteMany({ traceID: 'doc-trace' } as any );
        expect( deleteMany ).toHaveBeenCalledWith({ traceID: 'doc-trace' });

        // 4. Error-path ModelErrorEvent carries query, filter, context, and traceID
        aggregate.mockImplementationOnce(() =>
        ({
            toArray: async() => { throw new Error( 'find-boom' ) }
        }));
        await expect( users.find({ filter: { name: 'Ada' }, context: { step: 'err-find' }, traceID: 'tr-err' }) ).rejects.toThrow( 'find-boom' );
        expect( errors ).toHaveLength( 1 );
        expect( errors[0] ).toMatchObject(
        {
            operation   : 'find',
            filter      : { name: 'Ada' },
            query       : { filter: { name: 'Ada' } },
            context     : { step: 'err-find' },
            traceID     : 'tr-err'
        });

        // 5. Converter failure inside stream() emits exactly one error event (not duplicated by stream catch block)
        errors.length = 0;

        class FailingStreamModel extends AbstractModel<UserDBE, UserDTO, { converters: { dto: { converter: ( dbe: UserDBE ) => UserDTO }, broken: { converter: ( dbe: UserDBE ) => UserDTO } } }>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    idField     : '_id',
                    converters  :
                    {
                        dto     : { converter: ( dbe: UserDBE ) => ({ id: dbe._id, name: dbe.name }) },
                        broken  : { converter: () => { throw new Error( 'conv-stream-fail' ) } }
                    }
                });
            }
        }

        const failingStreamModel = new FailingStreamModel();
        const streamColl = collection as any;
        streamColl.aggregate = vi.fn(() =>
        ({
            async *[Symbol.asyncIterator]()
            {
                yield { _id: 'u1', name: 'Ada' };
            }
        }));

        await expect( ( async() =>
        {
            for await( const _ of failingStreamModel.stream({ filter: { name: 'Ada' } }, 'broken' ) )
            {
                // consume
            }
        })() ).rejects.toThrow( 'MODEL_CONVERTER_ERROR' );

        expect( errors ).toHaveLength( 1 );
        expect( errors[0].operation ).toBe( 'convert:broken' );

        await models.shutdown();
    });
});
