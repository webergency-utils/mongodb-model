import { Document } from 'mongodb';

export type ModelQueryEvent =
{
    collection  : string
    pipeline    : Document[]
    duration    : number
    operation   : 'get' | 'list' | 'stream' | 'aggregate' | 'count' | 'find'
}

export type ModelErrorEvent =
{
    collection  : string
    error       : Error
    operation?  : string
}

export type ModelEventsMap =
{
    query   : ModelQueryEvent
    error   : ModelErrorEvent
}

export type ModelEventName = keyof ModelEventsMap;
export type ModelEventHandler<E extends ModelEventName> = ( payload: ModelEventsMap[E] ) => void;

export class ModelEventEmitter
{
    #listeners = new Map<ModelEventName, Set<ModelEventHandler<any>>>();

    on<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): () => void
    {
        let set = this.#listeners.get( event );

        if( !set )
        {
            set = new Set();
            this.#listeners.set( event, set );
        }

        set.add( handler );

        return () => this.off( event, handler );
    }

    off<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): void
    {
        this.#listeners.get( event )?.delete( handler );
    }

    emit<E extends ModelEventName>( event: E, payload: ModelEventsMap[E] ): void
    {
        const set = this.#listeners.get( event );

        if( !set ){ return }

        for( const handler of set )
        {
            try
            {
                handler( payload );
            }
            catch( err )
            {
                console.error( `Model event handler for "${event}" failed:`, err );
            }
        }
    }
}
