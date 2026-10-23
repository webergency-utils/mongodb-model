import { Document } from 'mongodb';
import { flowGet } from './flow.js';
import { isSet } from './helpers/mongo.js';
import { EMIT_OBSERVABILITY_EVENT, GET_OBSERVABILITY_OPTIONS, RESOLVED_OPERATION_FILTER } from './symbols.js';

export type ModelQueryOperation = 'get' | 'getMany' | 'list' | 'stream' | 'aggregate' | 'count' | 'find' | 'exists' | 'distinct';

export type ModelMutationOperation =
    | 'create'
    | 'createFrom'
    | 'createMany'
    | 'update'
    | 'updateOne'
    | 'updateMany'
    | 'upsert'
    | 'delete'
    | 'deleteMany'
    | 'restore'
    | 'restoreMany'
    | 'hardDelete'
    | 'hardDeleteMany'
    | 'bulkWrite';

export type ObservabilityOperationCategory = 'query' | 'mutation' | 'create' | 'update' | 'delete' | 'cache' | 'error' | 'slowQuery' | 'internal';

export type ObservabilityOperationFilter = ObservabilityOperationCategory | ModelQueryOperation | ModelMutationOperation;

export type ObservabilityContextResolver = string[] | ( () => Record<string, unknown> | undefined );

export type ModelQueryContext =
{
    ids?                : unknown[]
    parentID?           : unknown
    filter?             : Document
    smartFilter?        : Record<string, unknown>
    computedProperties? : string[]
    sort?               : Record<string, 1 | -1>
    limit?              : number
    skip?               : number
    cursor?             : string
    access?             : string | boolean | Document
};

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
    internal?           : boolean
    parentOperation?    : ModelMutationOperation
    query?              : ModelQueryContext
    context?            : Record<string, unknown>
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
    upsertedCount?      : number
    ids?                : unknown[]
    parentID?           : unknown
    filter?             : Document
    smartFilter?        : Record<string, unknown>
    update?             : Document
    context?            : Record<string, unknown>
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
    context?    : Record<string, unknown>
    traceID?    : string
};

export type ModelErrorEvent =
{
    collection      : string
    model?          : string
    error           : Error
    operation?      : string
    duration?       : number
    query?          : ModelQueryContext
    filter?         : Document
    smartFilter?    : Record<string, unknown>
    parentID?       : unknown
    context?        : Record<string, unknown>
    traceID?        : string
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
    | {
        debug?  : ( message: string, meta?: Record<string, unknown> ) => void
        info?   : ( message: string, meta?: Record<string, unknown> ) => void
        warn?   : ( message: string, meta?: Record<string, unknown> ) => void
        error?  : ( message: string, meta?: Record<string, unknown> ) => void
    }
    | (( event: ModelEventsMap[ModelEventName] & { type: ModelEventName }) => void );

export type ResolvedOperationFilter =
{
    queryOps    : Set<ModelQueryOperation>
    mutationOps : Set<ModelMutationOperation>
    cache       : boolean
    error       : boolean
    slowQuery   : boolean
    internal    : boolean | 'inherit'
};

export type ObservabilityOptions =
{
    enabled?                        : boolean
    slowQueryMs?                    : number
    operations?                     : ObservabilityOperationFilter[] | Partial<Record<ObservabilityOperationFilter, boolean>>
    context?                        : ObservabilityContextResolver
    logger?                         : ObservabilityLogger
    onQuery?                        : ( event: ModelQueryEvent ) => void
    onMutation?                     : ( event: ModelMutationEvent ) => void
    onSlowQuery?                    : ( event: ModelSlowQueryEvent ) => void
    onCache?                        : ( event: ModelCacheEvent ) => void
    onError?                        : ( event: ModelErrorEvent ) => void
    [RESOLVED_OPERATION_FILTER]?    : ResolvedOperationFilter
};

export type ObservabilityConfig = boolean | ObservabilityOptions;

const ALL_QUERY_OPS: ModelQueryOperation[] = [ 'get', 'getMany', 'list', 'stream', 'aggregate', 'count', 'find', 'exists', 'distinct' ];
const ALL_MUTATION_OPS: ModelMutationOperation[] =
[
    'create',
    'createFrom',
    'createMany',
    'update',
    'updateOne',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
    'restore',
    'restoreMany',
    'hardDelete',
    'hardDeleteMany',
    'bulkWrite'
];
const CREATE_OPS: ModelMutationOperation[] = [ 'create', 'createFrom', 'createMany', 'upsert', 'bulkWrite' ];
const UPDATE_OPS: ModelMutationOperation[] = [ 'update', 'updateOne', 'updateMany', 'upsert', 'restore', 'restoreMany', 'bulkWrite' ];
const DELETE_OPS: ModelMutationOperation[] = [ 'delete', 'deleteMany', 'hardDelete', 'hardDeleteMany', 'bulkWrite' ];
const QUERY_OP_SET = new Set<string>( ALL_QUERY_OPS );
const MUTATION_OP_SET = new Set<string>( ALL_MUTATION_OPS );

function applyFilterToken(
    state: ResolvedOperationFilter,
    token: string,
    enable: boolean
): void
{
    const mutateSet = <T>( set: Set<T>, items: T[] ) =>
    {
        for( const item of items )
        {
            if( enable ){ set.add( item ) }
            else { set.delete( item ) }
        }
    };

    if( token === 'query' )
    {
        mutateSet( state.queryOps, ALL_QUERY_OPS );
    }
    else if( token === 'mutation' )
    {
        mutateSet( state.mutationOps, ALL_MUTATION_OPS );
    }
    else if( token === 'create' )
    {
        mutateSet( state.mutationOps, CREATE_OPS );
    }
    else if( token === 'update' )
    {
        mutateSet( state.mutationOps, UPDATE_OPS );
    }
    else if( token === 'delete' )
    {
        mutateSet( state.mutationOps, DELETE_OPS );
    }
    else if( token === 'cache' )
    {
        state.cache = enable;
    }
    else if( token === 'error' )
    {
        state.error = enable;
    }
    else if( token === 'slowQuery' )
    {
        state.slowQuery = enable;
    }
    else if( token === 'internal' )
    {
        state.internal = enable;
    }
    else if( QUERY_OP_SET.has( token ) )
    {
        mutateSet( state.queryOps, [ token as ModelQueryOperation ] );
    }
    else if( MUTATION_OP_SET.has( token ) )
    {
        mutateSet( state.mutationOps, [ token as ModelMutationOperation ] );
    }
}

export function compileOperationFilter(
    operations?: ObservabilityOperationFilter[] | Partial<Record<ObservabilityOperationFilter, boolean>>
): ResolvedOperationFilter | undefined
{
    if( operations === undefined )
    {
        return undefined;
    }

    const state: ResolvedOperationFilter =
    {
        queryOps    : new Set<ModelQueryOperation>(),
        mutationOps : new Set<ModelMutationOperation>(),
        cache       : false,
        error       : true,
        slowQuery   : true,
        internal    : 'inherit'
    };

    if( Array.isArray( operations ) )
    {
        for( const token of operations )
        {
            applyFilterToken( state, token, true );
        }

        return state;
    }

    const entries = Object.entries( operations );
    let hasPositiveQueryOrMutation = false;

    for( const [ token, enabled ] of entries )
    {
        if( enabled === true && ( token === 'query' || token === 'mutation' || token === 'create' || token === 'update' || token === 'delete' || QUERY_OP_SET.has( token ) || MUTATION_OP_SET.has( token ) ) )
        {
            hasPositiveQueryOrMutation = true;
            break;
        }
    }

    if( !hasPositiveQueryOrMutation )
    {
        for( const op of ALL_QUERY_OPS ){ state.queryOps.add( op ) }
        for( const op of ALL_MUTATION_OPS ){ state.mutationOps.add( op ) }
    }

    for( const [ token, enabled ] of entries )
    {
        if( enabled === true )
        {
            applyFilterToken( state, token, true );
        }
    }

    for( const [ token, enabled ] of entries )
    {
        if( enabled === false )
        {
            applyFilterToken( state, token, false );
        }
    }

    return state;
}

function attachCompiledFilter( target: ObservabilityOptions, filter: ResolvedOperationFilter | undefined ): ObservabilityOptions
{
    if( filter )
    {
        Object.defineProperty( target, RESOLVED_OPERATION_FILTER,
        {
            value        : filter,
            enumerable   : false,
            writable     : false,
            configurable : true
        });
    }

    return target;
}

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
        const filter = parentOptions?.[RESOLVED_OPERATION_FILTER] ?? compileOperationFilter( parentOptions?.operations );

        return attachCompiledFilter({ ...parentOptions, enabled: true }, filter );
    }

    if( config.enabled === false )
    {
        return undefined;
    }

    const merged: ObservabilityOptions = { ...parentOptions, ...config, enabled: config.enabled ?? true };
    const filter = config.operations !== undefined
        ? compileOperationFilter( config.operations )
        : ( parentOptions?.[RESOLVED_OPERATION_FILTER] ?? compileOperationFilter( merged.operations ) );

    return attachCompiledFilter( merged, filter );
}

export function isOperationObserved(
    options: ObservabilityOptions | undefined,
    event: ModelEventName,
    operation?: string,
    extra?: { internal?: boolean, parentOperation?: ModelMutationOperation }
): boolean
{
    const filter = options?.[RESOLVED_OPERATION_FILTER];

    if( !filter )
    {
        return true;
    }

    if( event === 'query' )
    {
        if( extra?.internal )
        {
            if( filter.internal === false ){ return false }
            if( filter.internal === true ){ return true }

            return extra.parentOperation
                ? filter.mutationOps.has( extra.parentOperation )
                : ( operation ? filter.queryOps.has( operation as ModelQueryOperation ) : true );
        }

        return operation ? filter.queryOps.has( operation as ModelQueryOperation ) : filter.queryOps.size > 0;
    }

    if( event === 'mutation' )
    {
        return operation ? filter.mutationOps.has( operation as ModelMutationOperation ) : filter.mutationOps.size > 0;
    }

    if( event === 'cache' )
    {
        return filter.cache;
    }

    if( event === 'error' )
    {
        return filter.error;
    }

    if( event === 'slowQuery' )
    {
        return filter.slowQuery;
    }

    return true;
}

export function isSlowQueryObserved( options: ObservabilityOptions | undefined, duration?: number ): boolean
{
    if( !options || options.enabled === false || options.slowQueryMs === undefined || duration === undefined )
    {
        return false;
    }

    if( duration < options.slowQueryMs )
    {
        return false;
    }

    const filter = options[RESOLVED_OPERATION_FILTER];

    return filter ? filter.slowQuery : true;
}

function isPlainRecord( value: unknown ): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray( value );
}

export function resolveObservabilityContext(
    optionsContext?: ObservabilityContextResolver,
    payloadContext?: Record<string, unknown>
): Record<string, unknown> | undefined
{
    let merged: Record<string, unknown> | undefined;

    if( Array.isArray( optionsContext ) )
    {
        for( const key of optionsContext )
        {
            const val = flowGet( key );

            if( val !== undefined )
            {
                merged ??= {};
                merged[key] = val;
            }
        }
    }
    else if( typeof optionsContext === 'function' )
    {
        try
        {
            const resolved = optionsContext();

            if( isPlainRecord( resolved ) )
            {
                merged = Object.assign( merged ?? {}, resolved );
            }
        }
        catch( err )
        {
            console.error( 'Observability hook failed:', err );
        }
    }

    const scopedContext = flowGet( 'context' );

    if( isPlainRecord( scopedContext ) )
    {
        merged = Object.assign( merged ?? {}, scopedContext );
    }

    if( isPlainRecord( payloadContext ) )
    {
        merged = Object.assign( merged ?? {}, payloadContext );
    }

    return isSet( merged ) ? merged : undefined;
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

    hasListeners( event?: ModelEventName ): boolean
    {
        if( event !== undefined )
        {
            return ( this.#listeners.get( event )?.size ?? 0 ) > 0;
        }

        for( const set of this.#listeners.values() )
        {
            if( set.size > 0 ){ return true }
        }

        return false;
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
    const operation = ( payload as { operation?: string } ).operation;
    const extra = event === 'query'
        ? { internal: ( payload as ModelQueryEvent ).internal, parentOperation: ( payload as ModelQueryEvent ).parentOperation }
        : undefined;
    const duration = ( payload as { duration?: number } ).duration;
    const isEnabled = options?.enabled !== false;
    const activeOptions = isEnabled ? options : undefined;
    const modelsOptions = models[GET_OBSERVABILITY_OPTIONS]?.();
    const filterOptions = activeOptions ?? modelsOptions;
    const primaryObserved = isOperationObserved( filterOptions, event, operation, extra );
    const slowOptions = ( activeOptions && activeOptions.slowQueryMs !== undefined ) ? activeOptions : modelsOptions;
    const slowObserved = ( event === 'query' || event === 'mutation' ) && isSlowQueryObserved( slowOptions, duration );

    if( !primaryObserved && !slowObserved )
    {
        return;
    }

    const traceID = payload.traceID ?? ( flowGet( 'traceID' ) as string | undefined );
    const context = resolveObservabilityContext( filterOptions?.context, payload.context );

    let enriched = payload;

    if( traceID !== undefined || context !== undefined )
    {
        enriched =
        {
            ...payload,
            ...( traceID !== undefined ? { traceID } : {} ),
            ...( context !== undefined ? { context } : {} )
        };
    }

    const fnLogger = activeOptions && typeof activeOptions.logger === 'function' ? activeOptions.logger : undefined;
    const objLogger = activeOptions && typeof activeOptions.logger === 'object' && activeOptions.logger !== null ? activeOptions.logger : undefined;

    if( primaryObserved )
    {
        localEmitter.emit( event, enriched );

        if( isEnabled && modelsOptions?.enabled !== false )
        {
            models[EMIT_OBSERVABILITY_EVENT]?.( event, enriched );
        }

        if( activeOptions )
        {
            if( fnLogger )
            {
                safeCall( fnLogger, { ...enriched, type: event } as ModelEventsMap[ModelEventName] & { type: ModelEventName } );
            }

            if( event === 'query' )
            {
                const queryEvent = enriched as ModelQueryEvent;

                safeCall( activeOptions.onQuery, queryEvent );
                objLogger?.info?.( `MongoDB query ${queryEvent.collection}.${queryEvent.operation} (${queryEvent.duration}ms)`, queryEvent as unknown as Record<string, unknown> );
            }
            else if( event === 'mutation' )
            {
                const mutationEvent = enriched as ModelMutationEvent;

                safeCall( activeOptions.onMutation, mutationEvent );
                objLogger?.info?.( `MongoDB mutation ${mutationEvent.collection}.${mutationEvent.operation} (${mutationEvent.duration}ms)`, mutationEvent as unknown as Record<string, unknown> );
            }
            else if( event === 'cache' )
            {
                const cacheEvent = enriched as ModelCacheEvent;

                safeCall( activeOptions.onCache, cacheEvent );
                objLogger?.debug?.( `MongoDB cache ${cacheEvent.collection}.${cacheEvent.operation}`, cacheEvent as unknown as Record<string, unknown> );
            }
            else if( event === 'error' )
            {
                const errorEvent = enriched as ModelErrorEvent;

                safeCall( activeOptions.onError, errorEvent );
                objLogger?.error?.( `MongoDB error in ${errorEvent.collection}${errorEvent.operation ? '.' + errorEvent.operation : ''}: ${errorEvent.error.message}`, errorEvent as unknown as Record<string, unknown> );
            }
        }
    }

    if( slowObserved && slowOptions && slowOptions.enabled !== false && slowOptions.slowQueryMs !== undefined )
    {
        const timed = enriched as ModelQueryEvent | ModelMutationEvent;
        const slowPayload: ModelSlowQueryEvent =
        {
            ...timed,
            thresholdMs : slowOptions.slowQueryMs
        };

        localEmitter.emit( 'slowQuery', slowPayload );

        if( isEnabled && modelsOptions?.enabled !== false )
        {
            models[EMIT_OBSERVABILITY_EVENT]?.( 'slowQuery', slowPayload );
        }

        if( activeOptions )
        {
            safeCall( activeOptions.onSlowQuery, slowPayload );

            if( fnLogger )
            {
                safeCall( fnLogger, { ...slowPayload, type: 'slowQuery' } as ModelEventsMap[ModelEventName] & { type: ModelEventName } );
            }

            objLogger?.warn?.( `Slow MongoDB ${event} ${timed.collection}.${timed.operation} (${timed.duration}ms >= ${slowOptions.slowQueryMs}ms)`, slowPayload as unknown as Record<string, unknown> );
        }
    }
}


