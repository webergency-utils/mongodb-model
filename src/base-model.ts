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
    ModelEventEmitter,
    ModelEventHandler,
    ModelEventName,
    ModelMutationEvent,
    ModelMutationOperation,
    ModelQueryEvent,
    ModelQueryOperation,
    ObservabilityConfig,
    ObservabilityOptions,
    dispatchObservabilityEvent,
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
    OptimizerConfig,
    OptimizerOptions
}
from './types/external.js';
import { ComputedPropertiesParam } from './types/internal.js';

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
    CollectionDoc extends Document = DBE
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
            try
            {
                const normalizedIds = this._idField === 'id' ? ids.map( id => this.dtoID( id )) : ids;
                const dbeIds = normalizedIds.map( id => this.dbeID( id ));

                let pipeline = await this.pipeline(
                {
                    filter              : { [this._idField]: { $in: dbeIds } } as any,
                    projection          : this.converters[conversion].projection,
                    access              : accessCtx?.access,
                    [RESOLVED_ACCESS]   : accessCtx?.[RESOLVED_ACCESS]
                } as any, conversion, 'get' );

                pipeline = this._optimizePipeline( pipeline );

                if( this._idField === '_id' )
                {
                    flowGet( 'log' ) && DUMP( pipeline );
                }

                const start = Date.now();
                const documents = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() as DBE[];
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this._collectionLabel}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );

                this._emitQuery( 'get', pipeline, duration,
                {
                    resultCount : documents.length,
                    conversion  : String( conversion )
                });

                return map(
                    normalizedIds.map( id => this.dtoID( id )),
                    documents,
                    ( dbe: DBE ) => this.dtoID(( dbe as any )[this._idField] )
                );
            }
            catch( e: any )
            {
                this._emitError( e, 'get' );

                if( e instanceof ModelError )
                {
                    throw e;
                }

                throw new ModelError( 'MODEL_GET_ERROR', this, e?.toString?.() ?? String( e ), e );
            }
        });

        models[REGISTER_MODEL]( this as any, collection.collectionName, this._prefix );
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
        if( this._prefix )
        {
            const parent = this._models[GET_PARENT]( this.collection.collectionName, this._prefix );
            const parentOptions = typeof parent?.[GET_OBSERVABILITY_OPTIONS] === 'function'
                ? parent[GET_OBSERVABILITY_OPTIONS]()
                : this._models[GET_OBSERVABILITY_OPTIONS]();

            return resolveObservabilityOptions( this._observability, parentOptions );
        }

        return resolveObservabilityOptions( this._observability, this._models[GET_OBSERVABILITY_OPTIONS]() );
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
    ): void
    {
        dispatchObservabilityEvent(
            'query',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                pipeline,
                duration,
                operation,
                ...extra
            },
            this._events,
            this._models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    protected _emitMutation(
        operation: ModelMutationOperation,
        duration: number,
        extra?: Partial<Omit<ModelMutationEvent, 'collection' | 'operation' | 'duration'>>
    ): void
    {
        dispatchObservabilityEvent(
            'mutation',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                operation,
                duration,
                ...extra
            },
            this._events,
            this._models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    protected _emitCache(
        operation: ModelCacheEvent['operation'],
        extra?: Partial<Omit<ModelCacheEvent, 'collection' | 'operation'>>
    ): void
    {
        dispatchObservabilityEvent(
            'cache',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                operation,
                ...extra
            },
            this._events,
            this._models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    protected _emitError( error: unknown, operation?: string, duration?: number ): void
    {
        dispatchObservabilityEvent(
            'error',
            {
                collection  : this._collectionLabel,
                model       : this.constructor.name,
                error       : error instanceof Error ? error : new Error( String( error )),
                operation,
                duration
            },
            this._events,
            this._models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    [CLEAR_LOCAL_CACHE](): void
    {
        if( !this._cache ){ return }

        this._cache.clear();
        this._emitCache( 'invalidate' );
    }

    protected _invalidateCache( ids: Array<any>, notifySiblings: boolean = true ): void
    {
        if( notifySiblings && typeof ( this._models as any )[INVALIDATE_COLLECTION_CACHE] === 'function' )
        {
            ( this._models as any )[INVALIDATE_COLLECTION_CACHE]( this, this.collection.collectionName );
        }

        if( !this._cache || !ids.length ){ return }

        const normalizedIds = ids.map( id => String( this.dtoID( id )));
        const evicted = this._cache.invalidateIds( normalizedIds );

        if( evicted.length > 0 )
        {
            this._emitCache( 'invalidate', { ids: normalizedIds });
        }
    }

    protected _clearCache( notifySiblings: boolean = true ): void
    {
        if( notifySiblings && typeof ( this._models as any )[INVALIDATE_COLLECTION_CACHE] === 'function' )
        {
            ( this._models as any )[INVALIDATE_COLLECTION_CACHE]( this, this.collection.collectionName );
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
                    this._emitCache( 'hit', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });

                    return cached;
                }

                this._emitCache( 'miss', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + String( conversion ) + ')' ) : undefined;
            const documents = await this.#findAggregator.execute(
                Arr( idOrIds ),
                conversion,
                { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
            ) as Array<DBE | null>;

            benchmark?.step( 'QUERY' );

            const entries = await convertDocuments( this._converters, documents, conversion );

            benchmark?.step( 'CONVERTER' );

            const result = ( entries[0] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;

            if( this._cache && cacheKey && result !== null )
            {
                this._cache.set( cacheKey, result, [ dtoId ]);
                this._emitCache( 'set', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
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

                for( let i = 0; i < ids.length; i++ )
                {
                    const id = ids[i];
                    const dtoId = String( this.dtoID( id ));
                    const cacheKey = buildCacheKey( String( conversion ), dtoId, scopeKey );
                    const cached = this._cache.get<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>( cacheKey );

                    if( cached !== undefined )
                    {
                        results[i] = cached;
                        this._emitCache( 'hit', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
                    }
                    else
                    {
                        this._emitCache( 'miss', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
                        missing.push({ index: i, id, dtoId, cacheKey });
                    }
                }

                if( missing.length > 0 )
                {
                    const documents = await this.#findAggregator.execute(
                        missing.map( m => m.id ),
                        conversion,
                        { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
                    ) as Array<DBE | null>;

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
                            this._emitCache( 'set', { key: target.cacheKey, ids: [ target.dtoId ], conversion: String( conversion ) });
                        }
                    }
                }

                return options.filter ? results.filter( Boolean ) : results;
            }

            const documents = await this.#findAggregator.execute(
                ids,
                conversion,
                { access: options.access, scopeKey, [RESOLVED_ACCESS]: access }
            ) as Array<DBE | null>;

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

    public async find<K extends keyof Extensions['converters']>(
        options: any,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async() =>
        {
            if( this._idField === '_id' )
            {
                const access = await this._access.resolveOrDeny({ operation: 'read', method: 'find', access: options.access });

                if( access.denied ){ return null }
            }

            const { projection } = this.converters[conversion];
            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':find(' + String( conversion ) + ')' ) : undefined;

            let pipeline = await this.pipeline(
            {
                filter      : options.filter,
                smartFilter : options.smartFilter,
                projection,
                sort,
                limit       : 1,
                access      : options.access
            }, conversion, 'find' );

            pipeline = this._optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            const dbe = ( await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() )[0] as DBE | undefined;
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this._collectionLabel}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( pipeline, true );

            benchmark?.step( 'QUERY' );

            const convStart = Date.now();
            const data = dbe ? await this._converters.convert( dbe, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;
            const converterDuration = Date.now() - convStart;

            this._emitQuery( 'find', pipeline, duration,
            {
                converterDuration,
                resultCount : data ? 1 : 0,
                conversion  : String( conversion )
            });

            benchmark?.step( 'CONVERTER' );

            return data;
        }) as Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    }

    public async aggregate<T>(
        pipeline: Document[],
        options?: any
    ): Promise<T[]>
    {
        return this.runOperation( async() =>
        {
            let aggregationPipeline: Document[];

            if( isSet( options ))
            {
                aggregationPipeline = [ ...await this.pipeline( options!, 'dbe' as any, 'aggregate' ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
            }
            else
            {
                const access = await this._access.resolveOrDeny({ operation: 'read', method: 'aggregate' });

                if( access.denied ){ return [] }

                if( this._idField === '_id' )
                {
                    aggregationPipeline = access.filter
                        ? [{ $match: access.filter }, ...( resolveBSONObject( pipeline ) as Document[] )]
                        : resolveBSONObject( pipeline ) as Document[];
                }
                else
                {
                    aggregationPipeline = [ ...await this.pipeline({ [RESOLVED_ACCESS]: access }, 'dbe' as any, 'aggregate' ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
                }
            }

            aggregationPipeline = this._optimizePipeline( aggregationPipeline );

            flowGet( 'log' ) && DUMP( aggregationPipeline );

            const start = Date.now();
            const res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } }).toArray() as T[];
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this._collectionLabel}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( aggregationPipeline, true );
            this._emitQuery( 'aggregate', aggregationPipeline, duration, this._idField === '_id' ? { resultCount: res.length } : undefined );

            return res;
        });
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

            return this.aggregate<{ count: number }>( countPipeline, options ).then( r => r[0]?.count ?? 0 );
        }

        return this.aggregate<{ count: number }>([{ $count: 'count' }], pipelineOrOptions ).then( r => r[0]?.count ?? 0 );
    }

    public async exists(
        idOrFilter?: any,
        options?: { access?: string }
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const findOptions = normalizeExistsOptions<any, any>(
                idOrFilter,
                this._idField,
                id => this.dbeID( id ),
                options?.access
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
            const res = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray();
            const duration = Date.now() - start;

            this._emitQuery( 'exists', pipeline, duration, { resultCount: res.length });

            return res.length > 0;
        });
    }

    protected async accessFilter( _name: string ): Promise<AccessFilterResult<any>> {}

    public async resolveSmartFilter( smartFilter: Record<string, any> ): Promise<any>
    {
        return this._smartFilters.resolve( smartFilter );
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<any>
    {
        return this._computedProperties.resolve( properties );
    }
}
