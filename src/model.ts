import
{
    Collection,
    Document,
    Filter,
    FindOptions,
    ObjectId,
    OptionalUnlessRequiredId,
    UpdateFilter
}
from 'mongodb';
import Aggregator from '@webergency-utils/aggregator';
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';
import { AccessControl } from './access-control.js';
import { ModelCache, ModelCacheConfig, buildCacheKey, extractTargetIdsFromFilter } from './cache.js';
import { ConverterManager } from './converters.js';
import { ModelAccessDeniedError, ModelError } from './errors.js';
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
    mergeComputedProperties,
    objectHash,
    resolveBSONObject,
    toUpdateOperations
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import
{
    attachCursorToItem,
    attachListMetadata,
    convertDocuments,
    normalizeExistsOptions,
    normalizeFindMatch,
    normalizeGetManyOptions,
    normalizeGetOptions,
    resolveCreateFromArgs
}
from './operations.js';
import { PipelineBuilder } from './pipeline-builder.js';
import { ComputedPropertyResolver, SmartFilterResolver } from './resolvers.js';
import { GET_OBSERVABILITY_OPTIONS, GET_OPTIMIZER_OPTIONS, REGISTER_MODEL } from './symbols.js';
import { getCursor } from './helpers/mongo.js';
import
{
    AbstractModelProperties,
    AbstractModelSmartFilters,
    AccessFilterResult,
    ExtractComputedProperties,
    ExtractSmartFilters,
    GetManyOptions,
    GetOptions,
    ModelAggregateOptions,
    ModelCreateOptions,
    ModelDeleteOptions,
    ModelExtensions,
    ModelFindOptions,
    ModelListOptions,
    ModelStreamOptions,
    ModelUpdateOptions,
    ModelUpdateResponse,
    MongoRootDocument,
    OptimizerConfig,
    OptimizerOptions,
    WithTotal
}
from './types/external.js';
import { ComputedPropertiesParam, SyncComputedPropertyMethod } from './types/internal.js';

/**
 * Abstract model for root-level MongoDB documents.
 */
export abstract class AbstractModel
<
    DBE extends MongoRootDocument,
    DTO extends Document,
    Extensions extends ModelExtensions<DBE, AbstractModelSmartFilters<ExtractSmartFilters<Extensions>>, AbstractModelProperties<ExtractComputedProperties<Extensions>>>
>
{
    #models: AbstractModels;
    #findAggregator: Aggregator<DTO['id'], DBE | null>;
    #converters: ConverterManager<DBE>;
    #access: AccessControl<DBE>;
    #smartFilters: SmartFilterResolver;
    #computedProperties: ComputedPropertyResolver;
    #pipelineBuilder = new PipelineBuilder<DBE>();
    #events = new ModelEventEmitter();
    #cache?: ModelCache;
    #optimizer?: OptimizerConfig;
    #observability?: ObservabilityConfig;

    public converters: Extensions['converters'];
    public smartFilters?: ExtractSmartFilters<Extensions>;

    protected constructor( models: AbstractModels, public collection: Collection<DBE>, params: Extensions & { cache?: ModelCacheConfig, optimizer?: OptimizerConfig, observability?: ObservabilityConfig } )
    {
        this.#models = models;
        this.#cache = params.cache ? new ModelCache( params.cache ) : undefined;
        this.#optimizer = params.optimizer;
        this.#observability = params.observability;
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this.smartFilters = params.smartFilters;
        this.#converters = new ConverterManager( this, this.converters, ( err, op ) => this.#emitError( err, op ));
        this.#access = new AccessControl(
        {
            model            : this,
            config           : params.access,
            filterOverridden : this.accessFilter !== AbstractModel.prototype.accessFilter,
            invokeFilter     : ( name ) => this.accessFilter( name )
        });
        this.#smartFilters = new SmartFilterResolver( this, this.smartFilters );
        this.#computedProperties = new ComputedPropertyResolver( this, params.computedProperties );

        models[REGISTER_MODEL]( this, collection.collectionName );

        this.#findAggregator = new Aggregator( async( ids: Array<DTO['id']>, conversion: keyof Extensions['converters'], accessCtx?: { method: string, access?: string, scopeKey?: string } ) =>
        {
            try
            {
                let pipeline = await this.pipeline(
                {
                    filter      : { _id: { $in: ids.map( id => this.dbeID( id )) } } as Filter<DBE>,
                    projection  : this.converters[conversion].projection,
                    access      : accessCtx?.access
                }, conversion, accessCtx?.method ?? 'get' );

                pipeline = this.#optimizePipeline( pipeline );

                flowGet( 'log' ) && DUMP( pipeline );

                const start = Date.now();
                const documents = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray();
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );

                this.#emitQuery( 'get', pipeline, duration,
                {
                    resultCount : documents.length,
                    conversion  : String( conversion )
                });

                return map(
                    ids.map( id => this.dtoID( id )),
                    documents as DBE[],
                    ( dbe: DBE ) => this.dtoID( dbe._id )
                );
            }
            catch( e: any )
            {
                this.#emitError( e, 'get' );

                if( e instanceof ModelError )
                {
                    throw e;
                }

                throw new ModelError( 'MODEL_GET_ERROR', this, e?.toString?.() ?? String( e ), e );
            }
        });
    }

    [GET_OPTIMIZER_OPTIONS](): OptimizerOptions | undefined
    {
        if( this.#optimizer === undefined ){ return this.#models[GET_OPTIMIZER_OPTIONS]() }

        if( this.#optimizer === false ){ return undefined }

        if( this.#optimizer === true ){ return {} }

        return this.#optimizer;
    }

    [GET_OBSERVABILITY_OPTIONS](): ObservabilityOptions | undefined
    {
        return resolveObservabilityOptions( this.#observability, this.#models[GET_OBSERVABILITY_OPTIONS]() );
    }

    #optimizePipeline( pipeline: Document[] ): Document[]
    {
        const options = this[GET_OPTIMIZER_OPTIONS]();

        return options !== undefined ? optimizePipeline( pipeline, options ) : pipeline;
    }

    public on<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): () => void
    {
        return this.#events.on( event, handler );
    }

    public off<E extends ModelEventName>( event: E, handler: ModelEventHandler<E> ): void
    {
        this.#events.off( event, handler );
    }

    #emitQuery(
        operation: ModelQueryOperation,
        pipeline: Document[],
        duration: number,
        extra?: Partial<Omit<ModelQueryEvent, 'collection' | 'operation' | 'pipeline' | 'duration'>>
    )
    {
        dispatchObservabilityEvent(
            'query',
            {
                collection  : this.collection.collectionName,
                model       : this.constructor.name,
                pipeline,
                duration,
                operation,
                ...extra
            },
            this.#events,
            this.#models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    #emitMutation(
        operation: ModelMutationOperation,
        duration: number,
        extra?: Partial<Omit<ModelMutationEvent, 'collection' | 'operation' | 'duration'>>
    )
    {
        dispatchObservabilityEvent(
            'mutation',
            {
                collection  : this.collection.collectionName,
                model       : this.constructor.name,
                operation,
                duration,
                ...extra
            },
            this.#events,
            this.#models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    #emitCache(
        operation: ModelCacheEvent['operation'],
        extra?: Partial<Omit<ModelCacheEvent, 'collection' | 'operation'>>
    )
    {
        dispatchObservabilityEvent(
            'cache',
            {
                collection  : this.collection.collectionName,
                model       : this.constructor.name,
                operation,
                ...extra
            },
            this.#events,
            this.#models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    #emitError( error: unknown, operation?: string, duration?: number )
    {
        dispatchObservabilityEvent(
            'error',
            {
                collection  : this.collection.collectionName,
                model       : this.constructor.name,
                error       : error instanceof Error ? error : new Error( String( error )),
                operation,
                duration
            },
            this.#events,
            this.#models,
            this[GET_OBSERVABILITY_OPTIONS]()
        );
    }

    #invalidateCache( ids: Array<any> ): void
    {
        if( !this.#cache || !ids.length ){ return }

        const normalizedIds = ids.map( id => String( this.dtoID( id )));
        const evicted = this.#cache.invalidateIds( normalizedIds );

        if( evicted.length > 0 )
        {
            this.#emitCache( 'invalidate', { ids: normalizedIds });
        }
    }

    protected id(): DTO['id'] | Promise<DTO['id']>
    {
        return new ObjectId().toString() as DTO['id'];
    }

    public dbeID( id: DTO['id'] | DBE['_id'] ): DBE['_id']
    {
        return id as DBE['_id'];
    }

    public dtoID( dbeID: DBE['_id'] | DTO['id'] ): DTO['id']
    {
        return dbeID as DTO['id'];
    }

    protected ensureOpen(): void
    {
        this.#models.assertOpen();
    }

    protected trackOperation(): () => void
    {
        return this.#models.trackOperation();
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

    protected async pipeline<K extends keyof Extensions['converters']>(
        options: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
        conversion?: K,
        method: string = 'pipeline'
    ): Promise<Document[]>
    {
        const { computedProperties: converterComputedProperties } = this.converters[conversion ?? 'dto'];
        const { filter, sort, limit, skip, pipeline, projection, computedProperties: optionsComputedProperties, smartFilter, access } = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>;

        const converterProperties = { '': await this.resolveComputedProperties( converterComputedProperties ) };
        const optionsProperties = { '': await this.resolveComputedProperties( optionsComputedProperties ) };
        const computedProperties = mergeComputedProperties( converterProperties, optionsProperties )[''];
        const accessResult = await this.#access.resolveOrDeny({ operation: 'read', method, access });
        const accessFilter = accessResult.denied ? ({ _id: { $exists: false } } as Filter<DBE>) : accessResult.filter;

        return this.#pipelineBuilder.pipeline(
        {
            filter,
            projection,
            computedProperties,
            sort,
            limit,
            skip,
            pipeline,
            smartFilter : smartFilter && await this.resolveSmartFilter( smartFilter ) || undefined,
            accessFilter
        });
    }

    public async create( dbe: Omit<DBE, '_id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        const release = this.trackOperation();

        try
        {
            const access = await this.#access.resolveOrDeny({ operation: 'create', method: 'create', access: options?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            const _id: DTO['id'] = id ?? await this.id();
            const start = Date.now();

            try
            {
                await this.collection.insertOne( resolveBSONObject({ ...dbe, _id: this.dbeID( _id ) }) as OptionalUnlessRequiredId<DBE> );
                this.#emitMutation( 'create', Date.now() - start, { insertedCount: 1, ids: [ _id ] });
            }
            catch( e: any )
            {
                if( options?.duplicateIgnore === true && e.code === 11000 )
                {
                    const existingId = this.dtoID( await this.collection.findOne( e.keyValue, { projection: { _id: 1 }, collation: { locale: 'en' } }).then( r => r?._id ));
                    this.#emitMutation( 'create', Date.now() - start, { insertedCount: 0, ids: [ existingId ] });

                    return existingId;
                }

                this.#emitError( e, 'create', Date.now() - start );

                throw e;
            }

            return _id;
        }
        finally
        {
            release();
        }
    }

    public async createFrom(
        data: unknown,
        fromKeyOrId?: string | DTO['id'] | ModelCreateOptions,
        idOrOptions?: DTO['id'] | ModelCreateOptions,
        options?: ModelCreateOptions
    ): Promise<DTO['id']>
    {
        return this.runOperation( async() =>
        {
            const { fromKey, explicitId, resolvedOptions } = resolveCreateFromArgs<DTO['id']>(
                this.converters.from as Record<string, unknown> | undefined,
                fromKeyOrId,
                idOrOptions,
                options
            );

            const start = Date.now();
            let dbe: Omit<DBE, '_id'> & { _id?: DBE['_id'] };

            try
            {
                dbe = await this.#converters.convertFrom( data, fromKey );
            }
            catch( e )
            {
                this.#emitError( e, 'createFrom', Date.now() - start );

                throw e;
            }

            const resolvedId = explicitId ?? ( dbe._id !== undefined ? this.dtoID( dbe._id ) as DTO['id'] : undefined );
            const createdId = await this.create( dbe, resolvedId, resolvedOptions );

            this.#emitMutation( 'createFrom', Date.now() - start, { insertedCount: 1, ids: [ createdId ] });

            return createdId;
        });
    }

    public async createMany(
        items: Array<Omit<DBE, '_id'> & { _id?: DBE['_id'] }>,
        idsOrOptions?: DTO['id'][] | ModelCreateOptions,
        options?: ModelCreateOptions
    ): Promise<DTO['id'][]>
    {
        return this.runOperation( async() =>
        {
            const explicitIds = Array.isArray( idsOrOptions ) ? idsOrOptions : undefined;
            const resolvedOptions = Array.isArray( idsOrOptions ) ? options : idsOrOptions;

            const access = await this.#access.resolveOrDeny({ operation: 'create', method: 'createMany', access: resolvedOptions?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            if( items.length === 0 )
            {
                this.#emitMutation( 'createMany', 0, { insertedCount: 0, ids: [] });

                return [];
            }

            const ids: DTO['id'][] = [];
            const docs: OptionalUnlessRequiredId<DBE>[] = [];

            for( let i = 0; i < items.length; i++ )
            {
                const item = items[i];
                const rawId = explicitIds?.[i] ?? ( item._id !== undefined ? this.dtoID( item._id ) : await this.id());
                const dtoId = this.dtoID( rawId ) as DTO['id'];

                ids.push( dtoId );
                docs.push( resolveBSONObject({ ...item, _id: this.dbeID( dtoId ) }) as OptionalUnlessRequiredId<DBE> );
            }

            const start = Date.now();

            try
            {
                await this.collection.insertMany( docs );
                this.#emitMutation( 'createMany', Date.now() - start, { insertedCount: docs.length, ids });

                return ids;
            }
            catch( e: any )
            {
                this.#emitError( e, 'createMany', Date.now() - start );

                throw e;
            }
        });
    }

    public async update( id: DTO['id'] | DBE['_id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<ModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
            const match = await this.#access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'update', method: 'update', access: options?.access }
            );

            if( !match )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();

            if( options?.documentBefore || options?.documentAfter )
            {
                const result = await this.collection.findOneAndUpdate(
                    match,
                    toUpdateOperations( update ),
                    {
                        returnDocument  : options.documentAfter ? 'after' : 'before',
                        collation       : { locale: 'en' }
                    }
                );

                const document = ( result as DBE | null ) || undefined;
                const matchedCount = document ? 1 : 0;
                const modifiedCount = document ? 1 : 0;

                this.#invalidateCache([ id ]);
                this.#emitMutation( 'update', Date.now() - start,
                {
                    matchedCount,
                    modifiedCount,
                    ids: [ id ]
                });

                return {
                    matchedCount,
                    modifiedCount,
                    documentBefore  : options.documentBefore && !options.documentAfter ? document : undefined,
                    documentAfter   : options.documentAfter ? document : undefined
                };
            }

            const res = await this.collection.updateOne( match, toUpdateOperations( update ));

            this.#invalidateCache([ id ]);
            this.#emitMutation( 'update', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : [ id ]
            });

            return {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount
            };
        }
        finally
        {
            release();
        }
    }

    async #resolveFilterMatch(
        matchInput: Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        operation: 'update' | 'delete',
        method: string,
        optionsAccess?: string
    ): Promise<{ finalMatch: Filter<DBE> | null, targetIds: string[] | null }>
    {
        const { filter: rawFilter, smartFilter, access } = normalizeFindMatch<Filter<DBE>, any>( matchInput, optionsAccess );
        const targetIds = extractTargetIdsFromFilter( matchInput, '_id', id => String( this.dtoID( id )));
        const resolvedSmart = smartFilter ? await this.resolveSmartFilter( smartFilter ) : undefined;
        const combinedFilter = resolvedSmart?.filter
            ? ( Object.keys( rawFilter ).length > 0 ? { $and: [ rawFilter, resolvedSmart.filter ] } : resolvedSmart.filter )
            : rawFilter;

        const finalMatch = await this.#access.match(
            resolveBSONObject( combinedFilter ) as Filter<DBE>,
            { operation, method, access }
        );

        return { finalMatch, targetIds };
    }

    public async updateMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
            if( Array.isArray( idsOrFilter ) )
            {
                const match = await this.#access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'update', method: 'updateMany', access: options?.access }
                );

                if( !match )
                {
                    return { matchedCount: 0, modifiedCount: 0 };
                }

                if( idsOrFilter.length === 0 )
                {
                    this.#emitMutation( 'updateMany', 0, { matchedCount: 0, modifiedCount: 0, ids: [] });

                    return { matchedCount: 0, modifiedCount: 0 };
                }

                const start = Date.now();
                const res = await this.collection.updateMany( match, toUpdateOperations( update ));

                this.#invalidateCache( idsOrFilter );
                this.#emitMutation( 'updateMany', Date.now() - start,
                {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    ids             : idsOrFilter
                });

                return {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount
                };
            }

            const { finalMatch, targetIds } = await this.#resolveFilterMatch( idsOrFilter, 'update', 'updateMany', options?.access );

            if( !finalMatch )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();
            const res = await this.collection.updateMany( finalMatch, toUpdateOperations( update ));

            if( targetIds && targetIds.length > 0 )
            {
                this.#invalidateCache( targetIds );
            }

            this.#emitMutation( 'updateMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : targetIds ?? undefined,
                filter          : finalMatch
            });

            return {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount
            };
        }
        finally
        {
            release();
        }
    }

    public async updateOne(
        match: Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            const { finalMatch, targetIds } = await this.#resolveFilterMatch( match, 'update', 'updateOne', options?.access );

            if( !finalMatch )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();

            if( options?.documentBefore || options?.documentAfter )
            {
                const result = await this.collection.findOneAndUpdate(
                    finalMatch,
                    toUpdateOperations( update ),
                    {
                        returnDocument  : options.documentAfter ? 'after' : 'before',
                        collation       : { locale: 'en' }
                    }
                );

                const document = ( result as DBE | null ) || undefined;
                const matchedCount = document ? 1 : 0;
                const modifiedCount = document ? 1 : 0;
                const idsToEvict = targetIds ?? ( document?._id !== undefined ? [ String( this.dtoID( document._id )) ] : null );

                if( idsToEvict && idsToEvict.length > 0 )
                {
                    this.#invalidateCache( idsToEvict );
                }

                this.#emitMutation( 'updateOne', Date.now() - start,
                {
                    matchedCount,
                    modifiedCount,
                    ids     : idsToEvict ?? undefined,
                    filter  : finalMatch
                });

                return {
                    matchedCount,
                    modifiedCount,
                    documentBefore  : options.documentBefore && !options.documentAfter ? document : undefined,
                    documentAfter   : options.documentAfter ? document : undefined
                };
            }

            const res = await this.collection.updateOne( finalMatch, toUpdateOperations( update ));

            if( targetIds && targetIds.length > 0 )
            {
                this.#invalidateCache( targetIds );
            }

            this.#emitMutation( 'updateOne', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : targetIds ?? undefined,
                filter          : finalMatch
            });

            return {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount
            };
        });
    }

    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        id: DTO['id'] | DBE['_id'],
        options?: GetOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        idOrIds: DTO['id'] | DBE['_id'] | Array<DTO['id'] | DBE['_id']>,
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
            const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'get', access: options.access });

            if( access.denied ){ return null }

            const scopeKey = access.filter ? objectHash( access.filter ) : undefined;
            const dtoId = String( this.dtoID( idOrIds ));
            const cacheKey = this.#cache ? buildCacheKey( String( conversion ), dtoId, scopeKey ) : undefined;

            if( this.#cache && cacheKey )
            {
                const cached = this.#cache.get<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>( cacheKey );

                if( cached !== undefined )
                {
                    this.#emitCache( 'hit', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });

                    return cached;
                }

                this.#emitCache( 'miss', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + String( conversion ) + ')' ) : undefined;
            const documents = await this.#findAggregator.execute( Arr( idOrIds ), conversion, { method: 'get', access: options.access, scopeKey } ) as Array<DBE | null>;

            benchmark?.step( 'QUERY' );

            const entries = await convertDocuments( this.#converters, documents, conversion );

            benchmark?.step( 'CONVERTER' );

            const result = ( entries[0] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;

            if( this.#cache && cacheKey && result !== null )
            {
                this.#cache.set( cacheKey, result, [ dtoId ]);
                this.#emitCache( 'set', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
            }

            return result;
        }
        finally
        {
            release();
        }
    }

    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>
    {
        const release = this.trackOperation();

        try
        {
            const options = normalizeGetManyOptions<K>( optionsOrConversion, filtered );
            const conversion = ( options.as ?? 'dto' ) as K;
            const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'getMany', access: options.access });

            if( access.denied )
            {
                return options.filter ? [] : ids.map(() => null );
            }

            const scopeKey = access.filter ? objectHash( access.filter ) : undefined;
            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':getMany(' + String( conversion ) + ')' ) : undefined;

            if( this.#cache )
            {
                const results: Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null> = new Array( ids.length ).fill( null );
                const missing: Array<{ index: number, id: DTO['id'] | DBE['_id'], dtoId: string, cacheKey: string }> = [];

                for( let i = 0; i < ids.length; i++ )
                {
                    const id = ids[i];
                    const dtoId = String( this.dtoID( id ));
                    const cacheKey = buildCacheKey( String( conversion ), dtoId, scopeKey );
                    const cached = this.#cache.get<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>( cacheKey );

                    if( cached !== undefined )
                    {
                        results[i] = cached;
                        this.#emitCache( 'hit', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
                    }
                    else
                    {
                        this.#emitCache( 'miss', { key: cacheKey, ids: [ dtoId ], conversion: String( conversion ) });
                        missing.push({ index: i, id, dtoId, cacheKey });
                    }
                }

                if( missing.length > 0 )
                {
                    const documents = await this.#findAggregator.execute(
                        missing.map( m => m.id ) as DTO['id'][],
                        conversion,
                        { method: 'getMany', access: options.access, scopeKey }
                    ) as Array<DBE | null>;

                    benchmark?.step( 'QUERY' );

                    const converted = await convertDocuments( this.#converters, documents, conversion, false );

                    benchmark?.step( 'CONVERTER' );

                    for( let j = 0; j < missing.length; j++ )
                    {
                        const entry = ( converted[j] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;
                        const target = missing[j];

                        results[target.index] = entry;

                        if( entry !== null )
                        {
                            this.#cache.set( target.cacheKey, entry, [ target.dtoId ]);
                            this.#emitCache( 'set', { key: target.cacheKey, ids: [ target.dtoId ], conversion: String( conversion ) });
                        }
                    }
                }

                return options.filter ? results.filter( Boolean ) : results;
            }

            const documents = await this.#findAggregator.execute( ids as DTO['id'][], conversion, { method: 'getMany', access: options.access, scopeKey } ) as Array<DBE | null>;

            benchmark?.step( 'QUERY' );

            const entries = await convertDocuments( this.#converters, documents, conversion, options.filter === true );

            benchmark?.step( 'CONVERTER' );

            return entries as Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
        }
        finally
        {
            release();
        }
    }

    public async find<K extends keyof Extensions['converters']>(
        options: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async() =>
        {
            const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'find', access: options.access });

            if( access.denied ){ return null }

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

            pipeline = this.#optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            const dbe = ( await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() )[0] as DBE | undefined;
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this.collection.collectionName}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( pipeline, true );

            benchmark?.step( 'QUERY' );

            const convStart = Date.now();
            const data = dbe ? await this.#converters.convert( dbe, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;
            const converterDuration = Date.now() - convStart;

            this.#emitQuery( 'find', pipeline, duration,
            {
                converterDuration,
                resultCount : data ? 1 : 0,
                conversion  : String( conversion )
            });

            benchmark?.step( 'CONVERTER' );

            return data;
        }) as Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    }

    public async list<K extends keyof Extensions['converters']>(
        options: ModelListOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): Promise<WithTotal<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string }>>>
    {
        const release = this.trackOperation();

        try
        {
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, countLimit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( options );
            const prev = cursor?.startsWith( 'prev:' );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + String( conversion ) + ')' ) : undefined;

            let accessFilter: Filter<DBE> | undefined;

            try
            {
                accessFilter = await this.#access.resolve({ operation: 'read', method: 'list', access: options.access });
            }
            catch( e )
            {
                if( e instanceof ModelAccessDeniedError )
                {
                    return attachListMetadata([], options.count ? 0 : undefined, {});
                }

                throw e;
            }

            const smartFilter = options.smartFilter && await this.resolveSmartFilter( options.smartFilter );
            const converterProperties = { '': await this.resolveComputedProperties( compProps ) };
            const optionsProperties = { '': await this.resolveComputedProperties( optionsCompProps ) };
            const computedProperties = mergeComputedProperties( converterProperties, optionsProperties )[''];

            const params =
            {
                ...rest,
                filter,
                sort,
                projection,
                smartFilter,
                cursor,
                limit,
                countLimit,
                accessFilter,
                pipeline: options.pipeline,
                computedProperties
            };

            let [ pipeline, countPipeline ] = await Promise.all(
            [
                this.#pipelineBuilder.pipeline( params ),
                options.count ? this.#pipelineBuilder.count( params ) : undefined
            ]);

            pipeline = this.#optimizePipeline( pipeline );
            countPipeline && ( countPipeline = this.#optimizePipeline( countPipeline ));

            flowGet( 'log' ) && DUMP( pipeline );
            flowGet( 'log' ) && countPipeline && DUMP( countPipeline );

            const start = Date.now();
            let queryDuration = 0;
            const [ entries, total ] = await Promise.all(
            [
                this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray().then( r =>
                {
                    queryDuration = Date.now() - start;

                    LOG_FILE( `Collection: ${this.collection.collectionName}` );
                    LOG_FILE( `TIME: ${queryDuration} ms` );
                    LOG_FILE( pipeline, true );

                    return r;
                }),
                options.count ? this.collection.aggregate( countPipeline, { collation: { locale: 'en' } }).toArray().then( r =>
                {
                    const duration = Date.now() - start;

                    LOG_FILE( `Collection: ${this.collection.collectionName}` );
                    LOG_FILE( `TIME: ${duration} ms` );
                    LOG_FILE( countPipeline, true );
                    this.#emitQuery( 'count', countPipeline!, duration, { resultCount: r[0]?.count ?? 0 });

                    return r[0]?.count ?? 0;
                }) : undefined
            ]);

            benchmark?.step( 'QUERY' );

            let orderedEntries = prev ? [ ...entries ].reverse() : entries;

            const convStart = Date.now();
            const items = await Promise.all( orderedEntries.map( async( dbe ) =>
            {
                const dto = await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string };

                return attachCursorToItem( dto, dbe, sort );
            }));
            const converterDuration = Date.now() - convStart;

            this.#emitQuery( 'list', pipeline, queryDuration,
            {
                converterDuration,
                resultCount : items.length,
                conversion  : String( conversion )
            });

            benchmark?.step( 'CONVERTER' );

            const first = orderedEntries[0];
            const last = orderedEntries[orderedEntries.length - 1];

            return attachListMetadata(
                items,
                options.count ? total : undefined,
                {
                    prev    : first ? getCursor( first, sort ) : undefined,
                    next    : last ? getCursor( last, sort ) : undefined
                }
            );
        }
        finally
        {
            release();
        }
    }

    public async *stream<K extends keyof Extensions['converters']>(
        options: ModelStreamOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): AsyncGenerator<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>
    {
        const release = this.trackOperation();

        try
        {
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( options );
            const prev = cursor?.startsWith( 'prev:' );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            let accessFilter: Filter<DBE> | undefined;

            try
            {
                accessFilter = await this.#access.resolve({ operation: 'read', method: 'stream', access: options.access });
            }
            catch( e )
            {
                if( e instanceof ModelAccessDeniedError )
                {
                    return;
                }

                throw e;
            }

            const smartFilter = options.smartFilter && await this.resolveSmartFilter( options.smartFilter );
            const converterProperties = { '': await this.resolveComputedProperties( compProps ) };
            const optionsProperties = { '': await this.resolveComputedProperties( optionsCompProps ) };
            const computedProperties = mergeComputedProperties( converterProperties, optionsProperties )[''];

            let pipeline = await this.#pipelineBuilder.pipeline(
            {
                ...rest,
                filter,
                sort,
                projection,
                smartFilter,
                cursor,
                limit,
                accessFilter,
                pipeline: options.pipeline,
                computedProperties
            });

            pipeline = this.#optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            const cursorDocs = this.collection.aggregate( pipeline, { collation: { locale: 'en' } });

            if( prev )
            {
                const entries = await cursorDocs.toArray();
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );
                this.#emitQuery( 'stream', pipeline, duration, { conversion: String( conversion ) });

                for( const dbe of entries.reverse() )
                {
                    yield await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
                }

                return;
            }

            let emitted = false;

            for await( const dbe of cursorDocs )
            {
                if( !emitted )
                {
                    emitted = true;
                    const duration = Date.now() - start;

                    LOG_FILE( `Collection: ${this.collection.collectionName}` );
                    LOG_FILE( `TIME: ${duration} ms` );
                    LOG_FILE( pipeline, true );
                    this.#emitQuery( 'stream', pipeline, duration, { conversion: String( conversion ) });
                }

                yield await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
            }

            if( !emitted )
            {
                this.#emitQuery( 'stream', pipeline, Date.now() - start, { conversion: String( conversion ) });
            }
        }
        finally
        {
            release();
        }
    }

    public async aggregate<T>(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<T[]>
    {
        return this.runOperation( async() =>
        {
            let aggregationPipeline: Document[];

            if( isSet( options ))
            {
                aggregationPipeline = [ ...await this.pipeline( options!, 'dbe', 'aggregate' ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
            }
            else
            {
                const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'aggregate' });

                if( access.denied ){ return [] }

                aggregationPipeline = access.filter
                    ? [{ $match: access.filter }, ...( resolveBSONObject( pipeline ) as Document[] )]
                    : resolveBSONObject( pipeline ) as Document[];
            }

            aggregationPipeline = this.#optimizePipeline( aggregationPipeline );

            flowGet( 'log' ) && DUMP( aggregationPipeline );

            const start = Date.now();
            const res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } }).toArray() as T[];
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this.collection.collectionName}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( aggregationPipeline, true );
            this.#emitQuery( 'aggregate', aggregationPipeline, duration, { resultCount: res.length });

            return res;
        });
    }

    public async count(
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>;
    public async count(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>;
    public async count(
        pipelineOrOptions?: Document[] | ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
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
        idOrFilter?: DTO['id'] | DBE['_id'] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: { access?: string }
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const findOptions = normalizeExistsOptions<Filter<DBE>, any>(
                idOrFilter,
                '_id',
                id => this.dbeID( id ),
                options?.access
            );

            const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'exists', access: findOptions.access });

            if( access.denied ){ return false }

            let pipeline = await this.pipeline(
            {
                filter      : findOptions.filter,
                smartFilter : findOptions.smartFilter,
                projection  : { _id: 1 },
                limit       : 1,
                access      : findOptions.access
            }, 'dbe' as any, 'exists' );

            pipeline = this.#optimizePipeline( pipeline );

            const start = Date.now();
            const res = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray();
            const duration = Date.now() - start;

            this.#emitQuery( 'exists', pipeline, duration, { resultCount: res.length });

            return res.length > 0;
        });
    }

    protected async accessFilter( _name: string ): Promise<AccessFilterResult<DBE>> {}

    public async resolveSmartFilter( smartFilter: Record<string, any> )
    {
        return this.#smartFilters.resolve( smartFilter ) as Promise<{ filter?: Filter<DBE>, pipeline?: Document[] }>;
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>
    {
        return this.#computedProperties.resolve( properties ) as Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>;
    }

    public async delete( id: DTO['id'] | DBE['_id'], options?: ModelDeleteOptions ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const match = await this.#access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'delete', method: 'delete', access: options?.access }
            );

            if( !match ){ return false }

            const start = Date.now();
            const res = await this.collection.deleteOne( match );

            this.#invalidateCache([ id ]);
            this.#emitMutation( 'delete', Date.now() - start,
            {
                deletedCount    : res.deletedCount,
                ids             : [ id ]
            });

            return res.deletedCount === 1;
        });
    }

    public async deleteMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelDeleteOptions
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            if( Array.isArray( idsOrFilter ) )
            {
                const match = await this.#access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'delete', method: 'deleteMany', access: options?.access }
                );

                if( !match ){ return 0 }

                if( idsOrFilter.length === 0 )
                {
                    this.#emitMutation( 'deleteMany', 0, { deletedCount: 0, ids: [] });

                    return 0;
                }

                const start = Date.now();
                const res = await this.collection.deleteMany( match );

                this.#invalidateCache( idsOrFilter );
                this.#emitMutation( 'deleteMany', Date.now() - start,
                {
                    deletedCount    : res.deletedCount,
                    ids             : idsOrFilter
                });

                return res.deletedCount;
            }

            const { finalMatch, targetIds } = await this.#resolveFilterMatch( idsOrFilter, 'delete', 'deleteMany', options?.access );

            if( !finalMatch ){ return 0 }

            const start = Date.now();
            const res = await this.collection.deleteMany( finalMatch );

            if( targetIds && targetIds.length > 0 )
            {
                this.#invalidateCache( targetIds );
            }

            this.#emitMutation( 'deleteMany', Date.now() - start,
            {
                deletedCount    : res.deletedCount,
                ids             : targetIds ?? undefined,
                filter          : finalMatch
            });

            return res.deletedCount;
        });
    }
}
