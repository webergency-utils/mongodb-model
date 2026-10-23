import
{
    Collection,
    Document,
    Filter,
    FindOptions,
    ObjectId
}
from 'mongodb';
import Aggregator from '@webergency-utils/aggregator';
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';
import { AccessControl } from './access-control.js';
import { ModelCache, ModelCacheConfig, buildCacheKey } from './cache.js';
import { ConverterManager } from './converters.js';
import { ModelError } from './errors.js';
import
{
    ModelCacheEvent,
    ModelErrorEvent,
    ModelEventEmitter,
    ModelEventHandler,
    ModelEventName,
    ModelMutationEvent,
    ModelMutationOperation,
    ModelQueryContext,
    ModelQueryEvent,
    ModelQueryOperation,
    ObservabilityConfig,
    ObservabilityOptions,
    dispatchObservabilityEvent,
    isOperationObserved,
    isSlowQueryObserved,
    resolveObservabilityOptions
}
from './events.js';
import { flowGet } from './flow.js';
import { Benchmark } from './helpers/benchmark.js';
import
{
    Arr,
    DUMP,
    LOG_FILE,
    isSet,
    map,
    objectHash,
    resolveBSONObject
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import
{
    convertDocuments,
    normalizeExistsOptions,
    normalizeGetManyOptions,
    normalizeGetOptions
}
from './operations.js';
import { PipelineBuilder } from './pipeline-builder.js';
import { ComputedPropertyResolver, SmartFilterResolver, SmartFilterResolverOptions, ComputedPropertyResolverOptions } from './resolvers.js';
import
{
    CLEAR_LOCAL_CACHE,
    GET_OBSERVABILITY_OPTIONS,
    GET_OPTIMIZER_OPTIONS,
    GET_PARENT,
    HAS_OBSERVABILITY_LISTENERS,
    INVALIDATE_COLLECTION_CACHE,
    REGISTER_MODEL,
    RESOLVED_ACCESS
}
from './symbols.js';
import
{
    AbstractModelConverters,
    AccessFilterResult,
    GetManyOptions,
    GetOptions,
    ModelAccessConfig,
    ModelExistsOptions,
    MongoRootDocument,
    OptimizerConfig,
    OptimizerOptions
}
from './types/external.js';
import { ComputedPropertiesParam } from './types/internal.js';

type ObservabilityBatchEntry =
{
    ids         : Set<string>
    operation   : 'get' | 'getMany'
    access?     : string
    context?    : Record<string, unknown>
    traceID?    : string
};

export type BaseModelParams<DBE extends Document> =
{
    cache?                  : ModelCacheConfig
    converters?             : AbstractModelConverters<DBE>
    smartFilters?           : any
    computedProperties?     : any
    access?                 : ModelAccessConfig<DBE>
    optimizer?              : OptimizerConfig
    observability?          : ObservabilityConfig
    idField                 : '_id' | 'id'
    prefix?                 : string
    smartFilterOptions?     : SmartFilterResolverOptions
    computedPropertyOptions?: ComputedPropertyResolverOptions
};

/**
 * Shared abstract base class for root-level (`AbstractModel`) and subdocument (`AbstractPropertyModel`) models.
 */
export abstract class AbstractBaseModel
<
    DBE extends Document,
    DTO extends Document,
    Extensions extends { converters: AbstractModelConverters<DBE>, smartFilters?: any, computedProperties?: any },
    CollectionDoc extends MongoRootDocument = DBE & MongoRootDocument,
    AccessFilterDoc = DBE
>
{
    protected _models: AbstractModels;
    protected _converters: ConverterManager<DBE>;
    protected _access: AccessControl<DBE>;
    protected _smartFilters: SmartFilterResolver;
    protected _computedProperties: ComputedPropertyResolver;
    protected _pipelineBuilder: PipelineBuilder<CollectionDoc>;
    protected _events = new ModelEventEmitter();
    protected _cache?: ModelCache;
    protected _optimizer?: OptimizerConfig;
    protected _observability?: ObservabilityConfig;
    protected _idField: '_id' | 'id';
    protected _prefix?: string;

    #findAggregator: Aggregator<any, DBE | null>;
    #pendingBatchMeta = new Map<string, ObservabilityBatchEntry[]>();
    #resolvedObservability: ObservabilityOptions | undefined | null = null;
    #observabilityDisabled = false;

    public converters: Extensions['converters'];

    protected constructor(
        models: AbstractModels,
        public collection: Collection<CollectionDoc>,
        params: BaseModelParams<DBE>
    )
    {
        this._models = models;
        this._idField = params.idField;
        this._prefix = params.prefix;
        this._cache = params.cache ? new ModelCache( params.cache ) : undefined;
        this._optimizer = params.optimizer;
        this._observability = params.observability;
        this._pipelineBuilder = new PipelineBuilder<CollectionDoc>();
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this._converters = new ConverterManager( this, this.converters, ( err, op ) => this._emitError( err, op ));
        this._access = new AccessControl(
        {
            model            : this,
            config           : params.access,
            filterOverridden : this.accessFilter !== AbstractBaseModel.prototype.accessFilter,
            invokeFilter     : ( name ) => this.accessFilter( name ) as any
        });
        this._smartFilters = new SmartFilterResolver( this, params.smartFilters, params.smartFilterOptions );
        this._computedProperties = new ComputedPropertyResolver( this, params.computedProperties, params.computedPropertyOptions );

        this.#findAggregator = new Aggregator( async( ids: Array<any>, conversion: keyof Extensions['converters'], accessCtx?: { access?: string, scopeKey?: string, [RESOLVED_ACCESS]?: { denied: boolean, filter?: Filter<DBE> } } ) =>
        {
            const metaKey = this.#batchMetaKey( conversion, accessCtx?.access, accessCtx?.scopeKey );
            const queue = this.#pendingBatchMeta.get( metaKey );
            const batchEntries: ObservabilityBatchEntry[] = [];

            if( queue && queue.length > 0 )
            {
                const requestedIdSet = new Set( ids.map( id => String( this.dtoID( id ))));

                for( let i = 0; i < queue.length; i++ )
                {
                    const entry = queue[i];
                    let matched = false;

                    for( const reqId of requestedIdSet )
                    {
                        if( entry.ids.delete( reqId ) )
                        {
                            matched = true;
                        }
                    }

                    if( matched )
                    {
                        batchEntries.push( entry );
                    }

                    if( entry.ids.size === 0 )
                    {
                        queue.splice( i, 1 );
                        i--;
                    }
                }

                if( queue.length === 0 )
                {
                    this.#pendingBatchMeta.delete( metaKey );
                }
            }

            const hasGet = batchEntries.some( e => e.operation === 'get' );
            const hasGetMany = batchEntries.some( e => e.operation === 'getMany' );
            const obsOptions = this[GET_OBSERVABILITY_OPTIONS]() ?? this._models[GET_OBSERVABILITY_OPTIONS]?.();
            let batchOperation: 'get' | 'getMany' = hasGetMany && !hasGet ? 'getMany' : 'get';

            if( hasGet && hasGetMany && !isOperationObserved( obsOptions, 'query', 'get' ) && isOperationObserved( obsOptions, 'query', 'getMany' ) )
            {
                batchOperation = 'getMany';
            }

            const resolveBatchMeta = () =>
            {
                let batchContext: Record<string, unknown> | undefined;
                let batchTraceID: string | undefined;

                for( const entry of batchEntries )
                {
                    if( entry.context )
                    {
                        batchContext = Object.assign( batchContext ?? {}, entry.context );
                    }

                    if( entry.traceID !== undefined )
                    {
                        batchTraceID = entry.traceID;
                    }
                }

                return {
                    ...( batchContext !== undefined ? { context: batchContext } : {} ),
                    ...( batchTraceID !== undefined ? { traceID: batchTraceID } : {} )
                };
            };

            let start = Date.now();
            let dtoIds: Array<DTO['id']> | undefined;

            try
            {
                dtoIds = ids.map( id => this.dtoID( id ));
                const dbeIds = ids.map( id => this.dbeID( id ));

                let pipeline = await this.pipeline(
                {
                    filter              : { [this._idField]: { $in: dbeIds } } as any,
                    projection          : this.converters[conversion].projection,
                    access              : accessCtx?.access,
                    [RESOLVED_ACCESS]   : accessCtx?.[RESOLVED_ACCESS]
                } as any, conversion, batchOperation );

                pipeline = this._optimizePipeline( pipeline );

                flowGet( 'log' ) && DUMP( pipeline );

                start = Date.now();
                const documents = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() as DBE[];
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this._collectionLabel}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );

                this._emitQuery( batchOperation, pipeline, duration, () => (
                {
                    resultCount : documents.length,
                    conversion  : String( conversion ),
                    query       :
                    {
                        ids : dtoIds!,
                        ...( accessCtx?.access !== undefined ? { access: accessCtx.access } : {} )
                    },
                    ...resolveBatchMeta()
                }));

                return map(
                    dtoIds,
                    documents,
                    ( dbe: DBE ) => this.dtoID(( dbe as any )[this._idField] )
                );
            }
            catch( e: any )
            {
                this._emitError( e, batchOperation, Date.now() - start, () => (
                {
                    query :
                    {
                        ids : dtoIds ?? ids.map( id => this.dtoID( id )),
                        ...( accessCtx?.access !== undefined ? { access: accessCtx.access } : {} )
                    },
                    ...resolveBatchMeta()
                }));

                if( e instanceof ModelError )
                {
                    throw e;
                }

                throw new ModelError( 'MODEL_GET_ERROR', this, e?.toString?.() ?? String( e ), e );
            }
        }, { normalizeID: ( id: any ) => String( this.dtoID( id )) });

        models[REGISTER_MODEL]( this as any, collection.collectionName, this._prefix );
    }

    #batchMetaKey( conversion: string | number | symbol, access?: string, scopeKey?: string ): string
    {
        return `${String( conversion )}:${scopeKey ?? ''}:${access ?? ''}`;
    }

    #hasAnyObservabilityActive(): boolean
    {
        return Boolean(
            this[GET_OBSERVABILITY_OPTIONS]()
            || this._events.hasListeners()
            || this._models[HAS_OBSERVABILITY_LISTENERS]?.()
        );
    }

    #enqueueBatchMeta(
        conversion: string | number | symbol,
        access: string | undefined,
        scopeKey: string | undefined,
        rawIds: Array<any>,
        entry: Omit<ObservabilityBatchEntry, 'ids'>
    ): ObservabilityBatchEntry | undefined
    {
        if( rawIds.length === 0 || !this.#hasAnyObservabilityActive() )
        {
            return undefined;
        }

        const key = this.#batchMetaKey( conversion, access, scopeKey );
        let list = this.#pendingBatchMeta.get( key );

        if( !list )
        {
            list = [];
            this.#pendingBatchMeta.set( key, list );
        }

        const fullEntry: ObservabilityBatchEntry =
        {
            ...entry,
            ids : new Set( rawIds.map( id => String( this.dtoID( id ))))
        };

        list.push( fullEntry );

        return fullEntry;
    }

    #cleanupBatchMetaEntry(
        conversion: string | number | symbol,
        access: string | undefined,
        scopeKey: string | undefined,
        entry: ObservabilityBatchEntry | undefined
    ): void
    {
        if( !entry ){ return }

        const key = this.#batchMetaKey( conversion, access, scopeKey );
        const list = this.#pendingBatchMeta.get( key );

        if( !list ){ return }

        const idx = list.indexOf( entry );

        if( idx !== -1 )
        {
            list.splice( idx, 1 );
        }

        if( list.length === 0 )
        {
            this.#pendingBatchMeta.delete( key );
        }
    }

    protected get _collectionLabel(): string
    {
        return this._prefix ? `${this.collection.collectionName}.${this._prefix}` : this.collection.collectionName;
    }

    [GET_OPTIMIZER_OPTIONS](): OptimizerOptions | undefined
    {
        if( this._optimizer === undefined )
        {
            if( this._prefix )
            {
                const parent = this._models[GET_PARENT]( this.collection.collectionName, this._prefix );

                return typeof parent?.[GET_OPTIMIZER_OPTIONS] === 'function'
                    ? parent[GET_OPTIMIZER_OPTIONS]()
                    : this._models[GET_OPTIMIZER_OPTIONS]();
            }

            return this._models[GET_OPTIMIZER_OPTIONS]();
        }

        if( this._optimizer === false ){ return undefined }

        if( this._optimizer === true ){ return {} }

        return this._optimizer;
    }

    [GET_OBSERVABILITY_OPTIONS](): ObservabilityOptions | undefined
    {
        if( this.#resolvedObservability !== null )
        {
            return this.#resolvedObservability;
        }

        const selfDisabled = this._observability === false
            || ( typeof this._observability === 'object' && this._observability.enabled === false );

        if( this._prefix )
        {
            const parent = this._models[GET_PARENT]( this.collection.collectionName, this._prefix ) as AbstractBaseModel<any, any, any, any, any> | undefined;
            const parentOptions = typeof parent?.[GET_OBSERVABILITY_OPTIONS] === 'function'
                ? parent[GET_OBSERVABILITY_OPTIONS]()
                : this._models[GET_OBSERVABILITY_OPTIONS]();

            this.#resolvedObservability = resolveObservabilityOptions( this._observability, parentOptions );
            this.#observabilityDisabled = selfDisabled
                || ( this._observability === undefined && Boolean( parent && #observabilityDisabled in parent && parent.#observabilityDisabled ));
        }
        else
        {
            this.#resolvedObservability = resolveObservabilityOptions( this._observability, this._models[GET_OBSERVABILITY_OPTIONS]() );
            this.#observabilityDisabled = selfDisabled;
        }

        return this.#resolvedObservability;
    }

    #dispatchOptions(): ObservabilityOptions | undefined
    {
        const options = this[GET_OBSERVABILITY_OPTIONS]();

        return options ?? ( this.#observabilityDisabled ? { enabled: false } : undefined );
    }

    #hasOptionsConsumer( options: ObservabilityOptions | undefined, event: ModelEventName ): boolean
    {
        if( !options || options.enabled === false )
        {
            return false;
        }

        if( typeof options.logger === 'function' )
        {
            return true;
        }

        const objLogger = typeof options.logger === 'object' && options.logger !== null ? options.logger : undefined;

        if( event === 'query' ){ return Boolean( options.onQuery || objLogger?.info ) }
        if( event === 'mutation' ){ return Boolean( options.onMutation || objLogger?.info ) }
        if( event === 'cache' ){ return Boolean( options.onCache || objLogger?.debug ) }
        if( event === 'error' ){ return Boolean( options.onError || objLogger?.error ) }
        if( event === 'slowQuery' ){ return Boolean( options.onSlowQuery || objLogger?.warn ) }

        return false;
    }

    protected _shouldObserve(
        event: ModelEventName,
        operation?: string,
        duration?: number,
        extra?: { internal?: boolean, parentOperation?: ModelMutationOperation }
    ): boolean
    {
        const options = this[GET_OBSERVABILITY_OPTIONS]();
        const isDisabled = this.#observabilityDisabled;
        const modelsOptions = this._models[GET_OBSERVABILITY_OPTIONS]?.();
        const filterOptions = options ?? modelsOptions;
        const hasLocalListener = this._events.hasListeners( event );
        const hasContainerListener = !isDisabled
            && Boolean( this._models[HAS_OBSERVABILITY_LISTENERS]?.( event ))
            && modelsOptions?.enabled !== false;
        const hasPrimaryListener = hasLocalListener || hasContainerListener || this.#hasOptionsConsumer( options, event );

        if( hasPrimaryListener && isOperationObserved( filterOptions, event, operation, extra ) )
        {
            return true;
        }

        const slowOptions = ( options && options.enabled !== false && options.slowQueryMs !== undefined )
            ? options
            : ( !isDisabled ? modelsOptions : undefined );

        if( ( event === 'query' || event === 'mutation' ) && isSlowQueryObserved( slowOptions, duration ) )
        {
            return this._events.hasListeners( 'slowQuery' )
                || ( !isDisabled && Boolean( this._models[HAS_OBSERVABILITY_LISTENERS]?.( 'slowQuery' )))
                || this.#hasOptionsConsumer( options, 'slowQuery' );
        }

        return false;
    }

    protected _optimizePipeline( pipeline: Document[] ): Document[]
    {
        const options = this[GET_OPTIMIZER_OPTIONS]();

        return options !== undefined ? optimizePipeline( pipeline, options ) : pipeline;
    }

    public on<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): () => void
    {
        return this._events.on( event, handler );
    }

    public off<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): void
    {
        this._events.off( event, handler );
    }

    protected _emitQuery(
        operation: ModelQueryOperation,
        pipeline: Document[],
        duration: number,
        extra?: Partial<Omit<ModelQueryEvent, 'collection' | 'operation' | 'pipeline' | 'duration'>>
            | ( () => Partial<Omit<ModelQueryEvent, 'collection' | 'operation' | 'pipeline' | 'duration'>> ),
        filterHint?: { internal?: boolean, parentOperation?: ModelMutationOperation }
    ): void
    {
        const resolvedHint = filterHint ?? ( typeof extra === 'object' && extra !== null ? { internal: extra.internal, parentOperation: extra.parentOperation } : undefined );

        if( !this._shouldObserve( 'query', operation, duration, resolvedHint ) )
        {
            return;
        }

        const resolvedExtra = typeof extra === 'function' ? extra() : extra;

        dispatchObservabilityEvent(
            'query',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                pipeline,
                duration,
                operation,
                ...resolvedExtra
            },
            this._events,
            this._models,
            this.#dispatchOptions()
        );
    }

    protected _emitMutation(
        operation: ModelMutationOperation,
        duration: number,
        extra?: Partial<Omit<ModelMutationEvent, 'collection' | 'operation' | 'duration'>>
            | ( () => Partial<Omit<ModelMutationEvent, 'collection' | 'operation' | 'duration'>> )
    ): void
    {
        if( !this._shouldObserve( 'mutation', operation, duration ) )
        {
            return;
        }

        const resolvedExtra = typeof extra === 'function' ? extra() : extra;

        dispatchObservabilityEvent(
            'mutation',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                operation,
                duration,
                ...resolvedExtra
            },
            this._events,
            this._models,
            this.#dispatchOptions()
        );
    }

    protected _emitCache(
        operation: ModelCacheEvent['operation'],
        extra?: Partial<Omit<ModelCacheEvent, 'collection' | 'operation'>>
            | ( () => Partial<Omit<ModelCacheEvent, 'collection' | 'operation'>> )
    ): void
    {
        if( !this._shouldObserve( 'cache', operation ) )
        {
            return;
        }

        const resolvedExtra = typeof extra === 'function' ? extra() : extra;

        dispatchObservabilityEvent(
            'cache',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                operation,
                ...resolvedExtra
            },
            this._events,
            this._models,
            this.#dispatchOptions()
        );
    }

    protected _emitError(
        error: unknown,
        operation?: string,
        duration?: number,
        extra?: Partial<Omit<ModelErrorEvent, 'collection' | 'model' | 'error' | 'operation' | 'duration'>>
            | ( () => Partial<Omit<ModelErrorEvent, 'collection' | 'model' | 'error' | 'operation' | 'duration'>> )
    ): void
    {
        if( !this._shouldObserve( 'error', operation, duration ) )
        {
            return;
        }

        const resolvedExtra = typeof extra === 'function' ? extra() : extra;

        dispatchObservabilityEvent(
            'error',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                error       : error instanceof Error ? error : new Error( String( error )),
                operation,
                duration,
                ...resolvedExtra
            },
            this._events,
            this._models,
            this.#dispatchOptions()
        );
    }

    [CLEAR_LOCAL_CACHE](): void
    {
        if( !this._cache ){ return }

        this._cache.clear();
        this._emitCache( 'invalidate' );
    }

    protected _notifySiblingCacheInvalidation(): void
    {
        this._models[INVALIDATE_COLLECTION_CACHE]?.( this, this.collection.collectionName );
    }

    protected _invalidateCache( ids: Array<any>, notifySiblings: boolean = true ): void
    {
        if( !ids.length ){ return }

        if( notifySiblings )
        {
            this._notifySiblingCacheInvalidation();
        }

        if( !this._cache ){ return }

        const normalizedIds = ids.map( id => String( this.dtoID( id )));
        const evicted = this._cache.invalidateIds( normalizedIds );

        if( evicted.length > 0 )
        {
            this._emitCache( 'invalidate', { ids: normalizedIds });
        }
    }

    protected _clearCache( notifySiblings: boolean = true ): void
    {
        if( notifySiblings )
        {
            this._notifySiblingCacheInvalidation();
        }

        this[CLEAR_LOCAL_CACHE]();
    }

    protected id(): DTO['id'] | Promise<DTO['id']>
    {
        return new ObjectId().toString() as DTO['id'];
    }

    public dbeID( id: any ): any
    {
        return id;
    }

    public dtoID( dbeID: any ): DTO['id']
    {
        return dbeID as DTO['id'];
    }

    protected ensureOpen(): void
    {
        this._models.assertOpen();
    }

    protected trackOperation(): () => void
    {
        return this._models.trackOperation();
    }

    protected async runOperation<T>( operation: () => Promise<T> ): Promise<T>
    {
        const release = this.trackOperation();

        try
        {
            return await operation();
        }
        finally
        {
            release();
        }
    }

    protected abstract pipeline<K extends keyof Extensions['converters']>(
        options: any,
        conversion?: K,
        method?: string
    ): Promise<Document[]>;

    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        id: any,
        options?: GetOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        idOrIds: any,
        optionsOrConversion?: GetOptions<K> | GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<
        | Awaited<ReturnType<Extensions['converters'][K]['converter']>>
        | null
        | Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    >
    {
        if( Array.isArray( idOrIds ) )
        {
            return this.getMany( idOrIds, normalizeGetManyOptions<K>( optionsOrConversion as GetManyOptions<K> | K, filtered ));
        }

        const release = this.trackOperation();

        try
        {
            const options = normalizeGetOptions<K>( optionsOrConversion as GetOptions<K> | K );
            const conversion = ( options.as ?? 'dto' ) as K;
            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'get', access: options.access });

            if( access.denied ){ return null }

            const scopeKey = access.filter ? objectHash( access.filter ) : undefined;
            const dtoId = String( this.dtoID( idOrIds ));
            const cacheKey = this._cache ? buildCacheKey( String( conversion ), dtoId, scopeKey ) : undefined;

            if( this._cache && cacheKey )
            {
                const cached = this._cache.get<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>( cacheKey );

                if( cached !== undefined )
                {
                    this._emitCache( 'hit', () => (
                    {
                        key         : cacheKey,
                        ids         : [ dtoId ],
                        conversion  : String( conversion ),
                        ...( options.context !== undefined ? { context: options.context } : {} ),
                        ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                    }));

                    return cached;
                }

                this._emitCache( 'miss', () => (
                {
                    key         : cacheKey,
                    ids         : [ dtoId ],
                    conversion  : String( conversion ),
                    ...( options.context !== undefined ? { context: options.context } : {} ),
                    ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                }));
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + String( conversion ) + ')' ) : undefined;
            const rawIds = Arr( idOrIds );
            const batchMetaEntry = this.#enqueueBatchMeta( conversion, options.access, scopeKey, rawIds,
            {
                operation   : 'get',
                access      : options.access,
                context     : options.context,
                traceID     : options.traceID
            });

            let documents: Array<DBE | null>;

            try
            {
                documents = await this.#findAggregator.execute(
                    rawIds,
                    conversion,
                    { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
                ) as unknown as Array<DBE | null>;
            }
            finally
            {
                this.#cleanupBatchMetaEntry( conversion, options.access, scopeKey, batchMetaEntry );
            }

            benchmark?.step( 'QUERY' );

            const entries = await convertDocuments( this._converters, documents, conversion );

            benchmark?.step( 'CONVERTER' );

            const result = ( entries[0] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;

            if( this._cache && cacheKey && result !== null )
            {
                this._cache.set( cacheKey, result, [ dtoId ]);
                this._emitCache( 'set', () => (
                {
                    key         : cacheKey,
                    ids         : [ dtoId ],
                    conversion  : String( conversion ),
                    ...( options.context !== undefined ? { context: options.context } : {} ),
                    ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                }));
            }

            return result;
        }
        finally
        {
            release();
        }
    }

    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<any>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>
    {
        const release = this.trackOperation();

        try
        {
            const options = normalizeGetManyOptions<K>( optionsOrConversion, filtered );
            const conversion = ( options.as ?? 'dto' ) as K;
            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'getMany', access: options.access });

            if( access.denied )
            {
                return options.filter ? [] : ids.map(() => null );
            }

            const scopeKey = access.filter ? objectHash( access.filter ) : undefined;
            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':getMany(' + String( conversion ) + ')' ) : undefined;

            if( this._cache )
            {
                const results: Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null> = new Array( ids.length ).fill( null );
                const missing: Array<{ index: number, id: any, dtoId: string, cacheKey: string }> = [];
                const observeCache = this._shouldObserve( 'cache' );

                for( let i = 0; i < ids.length; i++ )
                {
                    const id = ids[i];
                    const dtoId = String( this.dtoID( id ));
                    const cacheKey = buildCacheKey( String( conversion ), dtoId, scopeKey );
                    const cached = this._cache.get<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>( cacheKey );

                    if( cached !== undefined )
                    {
                        results[i] = cached;

                        if( observeCache )
                        {
                            this._emitCache( 'hit',
                            {
                                key         : cacheKey,
                                ids         : [ dtoId ],
                                conversion  : String( conversion ),
                                ...( options.context !== undefined ? { context: options.context } : {} ),
                                ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                            });
                        }
                    }
                    else
                    {
                        if( observeCache )
                        {
                            this._emitCache( 'miss',
                            {
                                key         : cacheKey,
                                ids         : [ dtoId ],
                                conversion  : String( conversion ),
                                ...( options.context !== undefined ? { context: options.context } : {} ),
                                ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                            });
                        }

                        missing.push({ index: i, id, dtoId, cacheKey });
                    }
                }

                if( missing.length > 0 )
                {
                    const missingIds = missing.map( m => m.id );
                    const batchMetaEntry = this.#enqueueBatchMeta( conversion, options.access, scopeKey, missingIds,
                    {
                        operation   : 'getMany',
                        access      : options.access,
                        context     : options.context,
                        traceID     : options.traceID
                    });

                    let documents: Array<DBE | null>;

                    try
                    {
                        documents = await this.#findAggregator.execute(
                            missingIds,
                            conversion,
                            { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
                        ) as unknown as Array<DBE | null>;
                    }
                    finally
                    {
                        this.#cleanupBatchMetaEntry( conversion, options.access, scopeKey, batchMetaEntry );
                    }

                    benchmark?.step( 'QUERY' );

                    const converted = await convertDocuments( this._converters, documents, conversion, false );

                    benchmark?.step( 'CONVERTER' );

                    for( let j = 0; j < missing.length; j++ )
                    {
                        const entry = ( converted[j] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;
                        const target = missing[j];

                        results[target.index] = entry;

                        if( entry !== null )
                        {
                            this._cache.set( target.cacheKey, entry, [ target.dtoId ]);

                            if( observeCache )
                            {
                                this._emitCache( 'set',
                                {
                                    key         : target.cacheKey,
                                    ids         : [ target.dtoId ],
                                    conversion  : String( conversion ),
                                    ...( options.context !== undefined ? { context: options.context } : {} ),
                                    ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                                });
                            }
                        }
                    }
                }

                return options.filter ? results.filter( Boolean ) : results;
            }

            const batchMetaEntry = this.#enqueueBatchMeta( conversion, options.access, scopeKey, ids,
            {
                operation   : 'getMany',
                access      : options.access,
                context     : options.context,
                traceID     : options.traceID
            });

            let documents: Array<DBE | null>;

            try
            {
                documents = await this.#findAggregator.execute(
                    ids,
                    conversion,
                    { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
                ) as unknown as Array<DBE | null>;
            }
            finally
            {
                this.#cleanupBatchMetaEntry( conversion, options.access, scopeKey, batchMetaEntry );
            }

            benchmark?.step( 'QUERY' );

            const entries = await convertDocuments( this._converters, documents, conversion, options.filter === true );

            benchmark?.step( 'CONVERTER' );

            return entries as Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
        }
        finally
        {
            release();
        }
    }

    protected _buildListQueryContext( options: any, sort?: Document ): ModelQueryContext
    {
        const query: ModelQueryContext = {};

        if( options?.filter !== undefined ){ query.filter = options.filter }
        if( options?.smartFilter !== undefined ){ query.smartFilter = options.smartFilter as Record<string, unknown> }
        if( Array.isArray( options?.computedProperties ) ){ query.computedProperties = options.computedProperties }
        else if( options?.computedProperties && typeof options.computedProperties === 'object' ){ query.computedProperties = Object.keys( options.computedProperties ) }
        if( sort !== undefined ){ query.sort = sort as Record<string, 1 | -1> }
        if( options?.limit !== undefined ){ query.limit = options.limit }
        if( options?.skip !== undefined ){ query.skip = options.skip }
        if( options?.cursor !== undefined ){ query.cursor = options.cursor }
        if( options?.access !== undefined ){ query.access = options.access }

        return query;
    }

    #buildFindQueryContext( options: any, sort?: FindOptions['sort'] ): ModelQueryContext | undefined
    {
        if( !options && !sort ){ return undefined }

        const query: ModelQueryContext = {};

        if( options?.filter !== undefined ){ query.filter = options.filter }
        if( options?.smartFilter !== undefined ){ query.smartFilter = options.smartFilter }
        if( sort !== undefined ){ query.sort = sort as Record<string, 1 | -1> }
        if( options?.access !== undefined ){ query.access = options.access }

        return isSet( query ) ? query : undefined;
    }

    #buildAggregateQueryContext( options: any ): ModelQueryContext | undefined
    {
        if( !options ){ return undefined }

        const query = this._buildListQueryContext( options, options.sort );

        return isSet( query ) ? query : undefined;
    }

    #buildExistsQueryContext( idOrFilter: unknown, isPrimitiveId: boolean, findOptions: any ): ModelQueryContext
    {
        return {
            ...( isPrimitiveId ? { ids: [ this.dtoID( idOrFilter ) ] } : {} ),
            filter : findOptions.filter,
            ...( findOptions.smartFilter !== undefined ? { smartFilter: findOptions.smartFilter } : {} ),
            ...( findOptions.access !== undefined ? { access: findOptions.access } : {} )
        };
    }

    public async find<K extends keyof Extensions['converters']>(
        options: any,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async() =>
        {
            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'find', access: options.access });

            if( access.denied ){ return null }

            const { projection } = this.converters[conversion];
            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':find(' + String( conversion ) + ')' ) : undefined;

            let pipeline = await this.pipeline(
            {
                filter              : options.filter,
                smartFilter         : options.smartFilter,
                projection,
                sort,
                limit               : 1,
                access              : options.access,
                [RESOLVED_ACCESS]   : access
            }, conversion, 'find' );

            pipeline = this._optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            let dbe: DBE | undefined;

            try
            {
                dbe = ( await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() )[0] as DBE | undefined;
            }
            catch( e )
            {
                this._emitError( e, 'find', Date.now() - start, () =>
                {
                    const query = this.#buildFindQueryContext( options, sort );

                    return {
                        ...( options.filter !== undefined ? { filter: options.filter } : {} ),
                        ...( options.smartFilter !== undefined ? { smartFilter: options.smartFilter } : {} ),
                        ...( query !== undefined ? { query } : {} ),
                        ...( options.context !== undefined ? { context: options.context } : {} ),
                        ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                    };
                });

                throw e;
            }

            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this._collectionLabel}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( pipeline, true );

            benchmark?.step( 'QUERY' );

            const convStart = Date.now();
            const data = dbe ? await this._converters.convert( dbe, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;
            const converterDuration = Date.now() - convStart;

            this._emitQuery( 'find', pipeline, duration, () =>
            {
                const query = this.#buildFindQueryContext( options, sort );

                return {
                    converterDuration,
                    resultCount : data ? 1 : 0,
                    conversion  : String( conversion ),
                    ...( query !== undefined ? { query } : {} ),
                    ...( options.context !== undefined ? { context: options.context } : {} ),
                    ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
                };
            });

            benchmark?.step( 'CONVERTER' );

            return data;
        }) as Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    }

    async #executeAggregate<T>(
        pipeline: Document[],
        options: any,
        operation: 'aggregate' | 'count'
    ): Promise<T[]>
    {
        return this.runOperation( async() =>
        {
            const { context, traceID, ...pipelineOptions } = ( options ?? {} ) as Record<string, any>;
            const access = await this._access.resolveOrDeny({ operation: 'read', method: operation, access: pipelineOptions.access });

            if( access.denied ){ return [] }

            let aggregationPipeline: Document[];

            if( isSet( pipelineOptions ) )
            {
                aggregationPipeline = [ ...await this.pipeline({ ...pipelineOptions, [RESOLVED_ACCESS]: access }, 'dbe' as any, operation ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
            }
            else if( this._idField === '_id' )
            {
                aggregationPipeline = access.filter
                    ? [{ $match: access.filter }, ...( resolveBSONObject( pipeline ) as Document[] )]
                    : resolveBSONObject( pipeline ) as Document[];
            }
            else
            {
                aggregationPipeline = [ ...await this.pipeline({ [RESOLVED_ACCESS]: access }, 'dbe' as any, operation ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
            }

            aggregationPipeline = this._optimizePipeline( aggregationPipeline );

            flowGet( 'log' ) && DUMP( aggregationPipeline );

            const start = Date.now();
            let res: T[];

            try
            {
                res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } }).toArray() as T[];
            }
            catch( e )
            {
                this._emitError( e, operation, Date.now() - start, () =>
                {
                    const query = this.#buildAggregateQueryContext( pipelineOptions );

                    return {
                        ...( pipelineOptions.filter !== undefined ? { filter: pipelineOptions.filter } : {} ),
                        ...( pipelineOptions.smartFilter !== undefined ? { smartFilter: pipelineOptions.smartFilter } : {} ),
                        ...( query !== undefined ? { query } : {} ),
                        ...( context !== undefined ? { context } : {} ),
                        ...( traceID !== undefined ? { traceID } : {} )
                    };
                });

                throw e;
            }

            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this._collectionLabel}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( aggregationPipeline, true );

            const resultCount = operation === 'count'
                ? (( res[0] as { count?: number } | undefined )?.count ?? 0 )
                : res.length;

            this._emitQuery( operation, aggregationPipeline, duration, () =>
            {
                const query = this.#buildAggregateQueryContext( pipelineOptions );

                return {
                    resultCount,
                    ...( query !== undefined ? { query } : {} ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                };
            });

            return res;
        });
    }

    public async aggregate<T>(
        pipeline: Document[],
        options?: any
    ): Promise<T[]>
    {
        return this.#executeAggregate<T>( pipeline, options, 'aggregate' );
    }

    public async count(
        options?: any
    ): Promise<number>;
    public async count(
        pipeline: Document[],
        options?: any
    ): Promise<number>;
    public async count(
        pipelineOrOptions?: Document[] | any,
        options?: any
    ): Promise<number>
    {
        if( Array.isArray( pipelineOrOptions ) )
        {
            const countPipeline = [ ...pipelineOrOptions, { $count: 'count' }];

            return this.#executeAggregate<{ count: number }>( countPipeline, options, 'count' ).then( r => r[0]?.count ?? 0 );
        }

        return this.#executeAggregate<{ count: number }>([{ $count: 'count' }], pipelineOrOptions, 'count' ).then( r => r[0]?.count ?? 0 );
    }

    public async exists(
        idOrFilter?: any,
        options?: ModelExistsOptions
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const findOptions = normalizeExistsOptions<any, any>(
                idOrFilter,
                this._idField,
                id => this.dbeID( id ),
                options
            );

            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'exists', access: findOptions.access });

            if( access.denied ){ return false }

            let pipeline = await this.pipeline(
            {
                filter              : findOptions.filter,
                smartFilter         : findOptions.smartFilter as any,
                projection          : { [this._idField]: 1 },
                limit               : 1,
                access              : findOptions.access,
                [RESOLVED_ACCESS]   : access
            }, 'dbe' as any, 'exists' );

            pipeline = this._optimizePipeline( pipeline );

            const start = Date.now();
            let res: Document[];

            try
            {
                res = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray();
            }
            catch( e )
            {
                this._emitError( e, 'exists', Date.now() - start, () => (
                {
                    filter : findOptions.filter,
                    ...( findOptions.smartFilter !== undefined ? { smartFilter: findOptions.smartFilter } : {} ),
                    query  : this.#buildExistsQueryContext( idOrFilter, Boolean( findOptions.isPrimitiveId ), findOptions ),
                    ...( findOptions.context !== undefined ? { context: findOptions.context } : {} ),
                    ...( findOptions.traceID !== undefined ? { traceID: findOptions.traceID } : {} )
                }));

                throw e;
            }

            const duration = Date.now() - start;

            this._emitQuery( 'exists', pipeline, duration, () => (
            {
                resultCount : res.length,
                query       : this.#buildExistsQueryContext( idOrFilter, Boolean( findOptions.isPrimitiveId ), findOptions ),
                ...( findOptions.context !== undefined ? { context: findOptions.context } : {} ),
                ...( findOptions.traceID !== undefined ? { traceID: findOptions.traceID } : {} )
            }));

            return res.length > 0;
        });
    }

    protected async accessFilter( _name: string ): Promise<AccessFilterResult<AccessFilterDoc>> {}

    public async resolveSmartFilter( smartFilter: Record<string, any> ): Promise<any>
    {
        return this._smartFilters.resolve( smartFilter );
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<any>
    {
        return this._computedProperties.resolve( properties );
    }
}
