import { MongoClient, MongoClientOptions, WithTransactionCallback } from 'mongodb';
import { flowStart, flowGet, flowSet, GET_PARENT, REGISTER_MODEL, flowExecute } from './helpers';
import { AbstractPropertyModel } from "./property-model";
import { AbstractModel } from "./model";

export * from 'mongodb';
export * from './types/external';
export * from './helpers/external';
export * from './model';
export * from './property-model';

const Clients = new Map<string, MongoClient>();
type ModelInstance = AbstractModel<any, any, any> | AbstractPropertyModel<any, any, any, any>;

export class AbstractModels
{
    protected client: MongoClient;
    private models = new Map<string, ModelInstance>();
    public readonly scope = Object.freeze(
    {
        start   : flowStart,
        assign  : ( scope: object ) => { Object.entries( scope ).forEach(([ key, value ]) => flowSet( key, value ))},
        set     : flowSet, 
        get     : flowGet,
        execute : flowExecute
    });

    protected constructor( connectionString: string, options: MongoClientOptions = {} )
    {
        if( Clients.has( connectionString ))
        {
            this.client = Clients.get( connectionString )!;
        }
        else
        {
            this.client = new MongoClient( connectionString, { minPoolSize: 0, maxPoolSize: 100, maxIdleTimeMS: 15000, compressors: [ 'snappy' ], ...options });
            this.client.connect();

            Clients.set( connectionString, this.client );
        }
    }

    [REGISTER_MODEL]( instance: ModelInstance, collection: string, path?: string )
    {
        this.models.set( collection + (path ? '.' + path : ''), instance );
    }

    [GET_PARENT]( collection: string, path: string ): ModelInstance | undefined
    {
        let parent = collection + (path && path !== '' ? '.' + path : '');

        while ( parent.includes('.') )
        {
            parent = parent.replace( /\.[^.]+$/, '' );

            if( this.models.has( parent ) )
            {
                return this.models.get( parent );
            }
        }
    }

    public async transaction<T = void>( transaction: WithTransactionCallback<T> ): Promise<T>
    {
        return await this.client.startSession().withTransaction( transaction );
    }
}