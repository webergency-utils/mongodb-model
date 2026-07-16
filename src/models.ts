import { MongoClient, MongoClientOptions, WithTransactionCallback } from 'mongodb';
import { flowExecute, flowGet, flowSet, flowStart } from './flow.js';
import { GET_PARENT, REGISTER_MODEL } from './symbols.js';
import type { AbstractModel } from './model.js';
import type { AbstractPropertyModel } from './property-model.js';

const Clients = new Map<string, MongoClient>();

type ModelInstance = AbstractModel<any, any, any> | AbstractPropertyModel<any, any, any, any>;

export class AbstractModels
{
    protected client: MongoClient;
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
}
