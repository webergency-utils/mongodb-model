import { MongoClient, WithTransactionCallback } from 'mongodb';
import { ModelError } from './errors.js';
import
{
    ModelEventEmitter,
    ModelEventHandler,
    ModelEventName,
    ModelEventsMap,
    ObservabilityOptions,
    resolveObservabilityOptions
}
from './events.js';
import
{
    flowExecute,
    flowGet,
    flowSet,
    flowStart,
    TRANSACTION_POST_COMMIT_KEY,
    TRANSACTION_SESSION_KEY
}
from './flow.js';
import
{
    CLEAR_LOCAL_CACHE,
    EMIT_OBSERVABILITY_EVENT,
    GET_OBSERVABILITY_OPTIONS,
    GET_OPTIMIZER_OPTIONS,
    GET_PARENT,
    HAS_OBSERVABILITY_LISTENERS,
    INVALIDATE_COLLECTION_CACHE,
    REGISTER_MODEL
}
from './symbols.js';
import type { AbstractBaseModel } from './base-model.js';
import type { ModelSyncIndexesOptions, ModelSyncIndexesResult, ModelsOptions, OptimizerConfig, OptimizerOptions } from './types/external.js';

const Clients = new Map<string, MongoClient>();
const ClosedClients = new WeakSet<MongoClient>();

type InflightState =
{
    count   : number
    waiters : Array<() => void>
};

const Inflight = new WeakMap<MongoClient, InflightState>();

function inflightState( client: MongoClient ): InflightState
{
    let state = Inflight.get( client );

    if( !state )
    {
        state = { count: 0, waiters: [] };
        Inflight.set( client, state );
    }

    return state;
}

export type ModelsShutdownOptions =
{
    timeout?: number
};

type ModelInstance = AbstractBaseModel<any, any, any, any>;

export class AbstractModels
{
    protected client: MongoClient;
    #connectionString: string;
    #closed = false;
    #shutdownPromise?: Promise<void>;
    #models = new Map<string, ModelInstance>();
    #collectionModels = new Map<string, Set<ModelInstance>>();
    #optimizer: OptimizerConfig = true;
    #resolvedObservability?: ObservabilityOptions;
    #events = new ModelEventEmitter();

    public readonly scope = Object.freeze(
    {
        start   : flowStart,
        assign  : ( scope: object ) => { Object.entries( scope ).forEach(([ key, value ]) => flowSet( key, value )) },
        set     : flowSet,
        get     : flowGet,
        execute : flowExecute
    });

    protected constructor( connectionString: string, options: ModelsOptions = {})
    {
        const { optimizer = true, observability, ...mongoOptions } = options;

        this.#connectionString = connectionString;
        this.#optimizer = optimizer;
        this.#resolvedObservability = resolveObservabilityOptions( observability );

        if( Clients.has( connectionString ) )
        {
            this.client = Clients.get( connectionString )!;
        }
        else
        {
            this.client = new MongoClient( connectionString,
            {
                minPoolSize     : 0,
                maxPoolSize     : 100,
                maxIdleTimeMS   : 15000,
                compressors     : [ 'snappy' ],
                ...mongoOptions
            });

            Clients.set( connectionString, this.client );
        }
    }

    public on<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): () => void
    {
        return this.#events.on( event, handler );
    }

    public off<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): void
    {
        this.#events.off( event, handler );
    }

    public assertOpen(): void
    {
        if( this.#closed || ClosedClients.has( this.client ) )
        {
            this.#closed = true;

            throw new ModelError( 'MODEL_SHUTDOWN', this, 'Models have been shut down' );
        }
    }

    public trackOperation(): () => void
    {
        this.assertOpen();

        const state = inflightState( this.client );

        state.count++;

        let released = false;

        return () =>
        {
            if( released ){ return }

            released = true;
            state.count--;

            if( state.count === 0 )
            {
                const waiters = state.waiters.splice( 0 );

                for( const resolve of waiters )
                {
                    resolve();
                }
            }
        };
    }

    public async shutdown( options: ModelsShutdownOptions = {} ): Promise<void>
    {
        if( this.#shutdownPromise ){ return this.#shutdownPromise }

        this.#shutdownPromise = this.#shutdown( options );

        return this.#shutdownPromise;
    }

    async #shutdown( options: ModelsShutdownOptions ): Promise<void>
    {
        this.#closed = true;
        ClosedClients.add( this.client );

        if( Clients.get( this.#connectionString ) === this.client )
        {
            Clients.delete( this.#connectionString );
        }

        await this.#waitForIdle( options.timeout ?? 0 );
        await this.client.close();
    }

    async #waitForIdle( timeout: number ): Promise<void>
    {
        const state = inflightState( this.client );

        if( state.count === 0 || timeout <= 0 ){ return }

        await Promise.race(
        [
            new Promise<void>( resolve =>
            {
                if( state.count === 0 )
                {
                    resolve();

                    return;
                }

                state.waiters.push( resolve );
            }),
            new Promise<void>( resolve => setTimeout( resolve, timeout ))
        ]);
    }

    public getCollectionModels( collection: string ): Set<ModelInstance> | undefined
    {
        return this.#collectionModels.get( collection );
    }

    public async syncIndexes( options?: ModelSyncIndexesOptions ): Promise<ModelSyncIndexesResult[]>
    {
        const results: ModelSyncIndexesResult[] = [];

        for( const models of this.#collectionModels.values() )
        {
            const firstModel = models.values().next().value;

            if( firstModel )
            {
                results.push( await firstModel.syncIndexes({ ...options, includeSiblingModels: true } as any ));
            }
        }

        return results;
    }

    [REGISTER_MODEL]( instance: ModelInstance, collection: string, path?: string )
    {
        this.#models.set( collection + ( path ? '.' + path : '' ), instance );

        let set = this.#collectionModels.get( collection );

        if( !set )
        {
            set = new Set();
            this.#collectionModels.set( collection, set );
        }

        set.add( instance );
    }

    [INVALIDATE_COLLECTION_CACHE]( source: ModelInstance, collection: string ): void
    {
        const set = this.#collectionModels.get( collection );

        if( !set ){ return }

        for( const instance of set )
        {
            if( instance === source )
            {
                continue;
            }

            instance[CLEAR_LOCAL_CACHE]?.();
        }
    }

    [GET_PARENT]( collection: string, path: string ): ModelInstance | undefined
    {
        let parent = collection + ( path && path !== '' ? '.' + path : '' );

        while( parent.includes( '.' ) )
        {
            parent = parent.replace( /\.[^.]+$/, '' );

            if( this.#models.has( parent ) )
            {
                return this.#models.get( parent );
            }
        }

        return undefined;
    }

    [GET_OPTIMIZER_OPTIONS](): OptimizerOptions | undefined
    {
        if( this.#optimizer === false ){ return undefined }

        if( this.#optimizer === true ){ return {} }

        return this.#optimizer;
    }

    [GET_OBSERVABILITY_OPTIONS](): ObservabilityOptions | undefined
    {
        return this.#resolvedObservability;
    }

    [HAS_OBSERVABILITY_LISTENERS]( event?: ModelEventName ): boolean
    {
        return this.#events.hasListeners( event );
    }

    [EMIT_OBSERVABILITY_EVENT]<E extends ModelEventName>( event: E, payload: ModelEventsMap[E] ): void
    {
        this.#events.emit( event, payload );
    }

    public async transaction<T = void>( fn: WithTransactionCallback<T> ): Promise<T>
    {
        const release = this.trackOperation();

        try
        {
            const session = this.client.startSession();
            const postCommitCallbacks = new Set<() => void | Promise<void>>();

            try
            {
                const result = await session.withTransaction( async( txSession ) =>
                {
                    const activeSession = txSession ?? session;

                    postCommitCallbacks.clear();

                    return await flowExecute(
                        () => fn( activeSession ),
                        {
                            [TRANSACTION_SESSION_KEY]       : activeSession,
                            [TRANSACTION_POST_COMMIT_KEY]   : postCommitCallbacks
                        },
                        false
                    );
                });

                for( const callback of postCommitCallbacks )
                {
                    await callback();
                }

                return result as T;
            }
            finally
            {
                await session.endSession();
            }
        }
        finally
        {
            release();
        }
    }
}
