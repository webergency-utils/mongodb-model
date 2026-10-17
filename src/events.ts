import { Document } from 'mongodb';
import { flowGet } from './flow.js';
import { EMIT_OBSERVABILITY_EVENT, GET_OBSERVABILITY_OPTIONS } from './symbols.js';

export type ModelQueryOperation = 'get' | 'getMany' | 'list' | 'stream' | 'aggregate' | 'count' | 'find' | 'exists';

export type ModelMutationOperation = 'create' | 'createFrom' | 'createMany' | 'update' | 'updateOne' | 'updateMany' | 'delete' | 'deleteMany';

export type ModelQueryEvent =
{
    collection          : string
    model?              : string
    pipeline            : Document[]
    duration            : number
    converterDuration?  : number
    resultCount?        : number
    conversion?         : string
    operation           : ModelQueryOperation
    traceID?            : string
};

export type ModelMutationEvent =
{
    collection          : string
    model?              : string
    operation           : ModelMutationOperation
    duration            : number
    converterDuration?  : number
    matchedCount?       : number
    modifiedCount?      : number
    deletedCount?       : number
    insertedCount?      : number
    ids?                : unknown[]
    filter?             : Document
    update?             : Document
    traceID?            : string
};

export type ModelSlowQueryEvent = ( ModelQueryEvent | ModelMutationEvent ) &
{
    thresholdMs : number
};

export type ModelCacheEvent =
{
    collection  : string
    model?      : string
    operation   : 'hit' | 'miss' | 'set' | 'invalidate'
    key?        : string
    keys?       : string[]
    ids?        : unknown[]
    conversion? : string
    traceID?    : string
};

export type ModelErrorEvent =
{
    collection  : string
    model?      : string
    error       : Error
    operation?  : string
    duration?   : number
    traceID?    : string
};

export type ModelEventsMap =
{
    query       : ModelQueryEvent
    mutation    : ModelMutationEvent
    slowQuery   : ModelSlowQueryEvent
    cache       : ModelCacheEvent
    error       : ModelErrorEvent
};

export type ModelEventName = keyof ModelEventsMap;
export type ModelEventHandler<E extends ModelEventName> = ( payload: ModelEventsMap[E] ) => void;

export type ObservabilityLogger =
{
    debug?  : ( message: string, meta?: Record<string, unknown> ) => void
    info?   : ( message: string, meta?: Record<string, unknown> ) => void
    warn?   : ( message: string, meta?: Record<string, unknown> ) => void
    error?  : ( message: string, meta?: Record<string, unknown> ) => void
};

export type ObservabilityOptions =
{
    enabled?        : boolean
    slowQueryMs?    : number
    logger?         : ObservabilityLogger
    onQuery?        : ( event: ModelQueryEvent ) => void
    onMutation?     : ( event: ModelMutationEvent ) => void
    onSlowQuery?    : ( event: ModelSlowQueryEvent ) => void
    onCache?        : ( event: ModelCacheEvent ) => void
    onError?        : ( event: ModelErrorEvent ) => void
};

export type ObservabilityConfig = boolean | ObservabilityOptions;

export function resolveObservabilityOptions( config?: ObservabilityConfig, parentOptions?: ObservabilityOptions ): ObservabilityOptions | undefined
{
    if( config === false )
    {
        return undefined;
    }

    if( config === undefined )
    {
        return parentOptions;
    }

    if( config === true )
    {
        return { ...parentOptions, enabled: true };
    }

    if( config.enabled === false )
    {
        return undefined;
    }

    return { ...parentOptions, ...config, enabled: config.enabled ?? true };
}

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

function safeCall<T>( fn: (( arg: T ) => void ) | undefined, arg: T ): void
{
    if( !fn ){ return }

    try
    {
        fn( arg );
    }
    catch( err )
    {
        console.error( 'Observability hook failed:', err );
    }
}

export function dispatchObservabilityEvent<E extends ModelEventName>(
    event: E,
    payload: ModelEventsMap[E],
    localEmitter: ModelEventEmitter,
    models: {
        [GET_OBSERVABILITY_OPTIONS]?: () => ObservabilityOptions | undefined
        [EMIT_OBSERVABILITY_EVENT]?: <K extends ModelEventName>( ev: K, p: ModelEventsMap[K] ) => void
    },
    options?: ObservabilityOptions
): void
{
    const traceID = payload.traceID ?? ( flowGet( 'traceID' ) as string | undefined );
    const enriched = ( traceID !== undefined ? { ...payload, traceID } : payload ) as ModelEventsMap[E];

    localEmitter.emit( event, enriched );
    models[EMIT_OBSERVABILITY_EVENT]?.( event, enriched );

    if( !options || options.enabled === false )
    {
        return;
    }

    if( event === 'query' )
    {
        const queryEvent = enriched as ModelQueryEvent;

        safeCall( options.onQuery, queryEvent );
        options.logger?.info?.( `MongoDB query ${queryEvent.collection}.${queryEvent.operation} (${queryEvent.duration}ms)`, queryEvent as unknown as Record<string, unknown> );
    }
    else if( event === 'mutation' )
    {
        const mutationEvent = enriched as ModelMutationEvent;

        safeCall( options.onMutation, mutationEvent );
        options.logger?.info?.( `MongoDB mutation ${mutationEvent.collection}.${mutationEvent.operation} (${mutationEvent.duration}ms)`, mutationEvent as unknown as Record<string, unknown> );
    }
    else if( event === 'cache' )
    {
        const cacheEvent = enriched as ModelCacheEvent;

        safeCall( options.onCache, cacheEvent );
        options.logger?.debug?.( `MongoDB cache ${cacheEvent.collection}.${cacheEvent.operation}`, cacheEvent as unknown as Record<string, unknown> );
    }
    else if( event === 'error' )
    {
        const errorEvent = enriched as ModelErrorEvent;

        safeCall( options.onError, errorEvent );
        options.logger?.error?.( `MongoDB error in ${errorEvent.collection}${errorEvent.operation ? '.' + errorEvent.operation : ''}: ${errorEvent.error.message}`, errorEvent as unknown as Record<string, unknown> );
    }

    if( ( event === 'query' || event === 'mutation' ) && options.slowQueryMs !== undefined )
    {
        const timed = enriched as ModelQueryEvent | ModelMutationEvent;

        if( timed.duration >= options.slowQueryMs )
        {
            const slowPayload: ModelSlowQueryEvent =
            {
                ...timed,
                thresholdMs: options.slowQueryMs
            };

            localEmitter.emit( 'slowQuery', slowPayload );
            models[EMIT_OBSERVABILITY_EVENT]?.( 'slowQuery', slowPayload );
            safeCall( options.onSlowQuery, slowPayload );
            options.logger?.warn?.( `Slow MongoDB ${event} ${timed.collection}.${timed.operation} (${timed.duration}ms >= ${options.slowQueryMs}ms)`, slowPayload as unknown as Record<string, unknown> );
        }
    }
}

