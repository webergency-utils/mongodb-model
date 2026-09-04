import { MongoClient, MongoClientOptions, WithTransactionCallback } from 'mongodb';
import { ModelError } from './errors.js';
import { flowExecute, flowGet, flowSet, flowStart } from './flow.js';
import { GET_PARENT, REGISTER_MODEL } from './symbols.js';
import type { AbstractModel } from './model.js';
import type { AbstractPropertyModel } from './property-model.js';

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

type ModelInstance = AbstractModel<any, any, any> | AbstractPropertyModel<any, any, any, any>;

export class AbstractModels
{
    protected client: MongoClient;
    #connectionString: string;
    #closed = false;
    #shutdownPromise?: Promise<void>;
    #models = new Map<string, ModelInstance>();

    public readonly scope = Object.freeze(
    {
        start   : flowStart,
        assign  : ( scope: object ) => { Object.entries( scope ).forEach(([ key, value ]) => flowSet( key, value )) },
        set     : flowSet,
        get     : flowGet,
        execute : flowExecute
    });

    protected constructor( connectionString: string, options: MongoClientOptions = {})
    {
        this.#connectionString = connectionString;

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
                ...options
            });

            Clients.set( connectionString, this.client );
        }
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

    [REGISTER_MODEL]( instance: ModelInstance, collection: string, path?: string )
    {
        this.#models.set( collection + ( path ? '.' + path : '' ), instance );
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

    public async transaction<T = void>( fn: WithTransactionCallback<T> ): Promise<T>
    {
        const release = this.trackOperation();

        try
        {
            const session = this.client.startSession();

            try
            {
                return await session.withTransaction( fn );
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
