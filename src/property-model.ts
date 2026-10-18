import
{
    Collection,
    Document,
    Filter,
    Filter as MongoFilter,
    FindOptions,
    ObjectId,
    UpdateFilter,
    UpdateOptions
}
from 'mongodb';
import Aggregator from '@webergency-utils/aggregator';
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';
import { AccessControl } from './access-control.js';
import { ModelCache, buildCacheKey, extractTargetIdsFromFilter } from './cache.js';
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
    LOG,
    LOG_FILE,
    addPrefixToFilter,
    addPrefixToUpdate,
    collectAddedFields,
    generateCursorCondition,
    getCursor,
    getSubPaths,
    getUsedFields,
    isExclusionProjection,
    isSet,
    map,
    mergeComputedProperties,
    objectHash,
    optimizeMatch,
    projectionToReplace,
    propertyModelUpdateParams,
    resolveBSONObject,
    reverseSort,
    splitFilterToStages,
    toUpdateOperations
}
from './helpers/index.js';
import { propertyModelTargetUpdateParams } from './helpers/mongo.js';
import { AbstractModels } from './models.js';
import
{
    attachCursorToItem,
    attachListMetadata,
    attachPropertyUpdateMetadata,
    buildPropertyDeleteOperation,
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
import { GET_OBSERVABILITY_OPTIONS, GET_OPTIMIZER_OPTIONS, GET_PARENT, REGISTER_MODEL } from './symbols.js';
import
{
    AbstractPropertyModelComputedProperties,
    AbstractPropertyModelSmartFilters,
    AccessFilterResult,
    ConstructorExtensions,
    ExtractComputedProperties,
    ExtractSmartFilters,
    FirstType,
    GetManyOptions,
    GetOptions,
    ModelCreateOptions,
    ModelDeleteOptions,
    ModelUpdateOptions,
    MongoPropertyDocument,
    MongoRootDocument,
    OptimizerConfig,
    OptimizerOptions,
    PropertyModelAggregateOptions,
    PropertyModelExtensions,
    PropertyModelFilter,
    PropertyModelFindOptions,
    PropertyModelListOptions,
    PropertyModelStreamOptions,
    PropertyModelUpdateResponse,
    WithTotal
}
from './types/external.js';
import { ComputedPropertiesParam, SyncComputedPropertyMethod } from './types/internal.js';

/**
 * Abstract model for embedded / nested sub-documents.
 */
export abstract class AbstractPropertyModel
<
    RootDBE extends MongoRootDocument,
    DBE extends MongoPropertyDocument,
    DTO extends Document,
    Extensions extends PropertyModelExtensions<DBE, AbstractPropertyModelSmartFilters<any, any>, AbstractPropertyModelComputedProperties<any, any>>
>
{
    #findAggregator: Aggregator<DTO['id'] | DBE['id'], DBE | null>;
    #paths: { path: string, array: boolean }[];
    #prefix: string;
    #converters: ConverterManager<DBE>;
    #access: AccessControl<DBE>;
    #smartFilters: SmartFilterResolver;
    #computedProperties: ComputedPropertyResolver;
    #pipelineBuilder = new PipelineBuilder<RootDBE>();
    #models: AbstractModels;
    #events = new ModelEventEmitter();
    #cache?: ModelCache;
    #optimizer?: OptimizerConfig;
    #observability?: ObservabilityConfig;

    public converters: Extensions['converters'];
    public smartFilters?: FirstType<ExtractSmartFilters<Extensions>>;

    protected constructor( models: AbstractModels, public collection: Collection<RootDBE>, path: string, params: ConstructorExtensions<Extensions> )
    {
        this.#models = models;
        this.#cache = params.cache ? new ModelCache( params.cache ) : undefined;
        this.#optimizer = params.optimizer;
        this.#observability = params.observability;
        this.#paths = [ ...path.matchAll( /[^\[\]]+(\[\])?/g ) ].map( m => ({ path: m[0].replace( /^\./, '' ).replace( /\[\]$/, '' ), array: m[0].endsWith( '[]' ) }));
        this.#prefix = this.#paths.map( p => p.path ).join( '.' );
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this.smartFilters = params.smartFilters;
        this.#converters = new ConverterManager( this, this.converters, ( err, op ) => this.#emitError( err, op ));
        this.#access = new AccessControl(
        {
            model            : this,
            config           : params.access,
            filterOverridden : this.accessFilter !== AbstractPropertyModel.prototype.accessFilter,
            invokeFilter     : ( name ) => this.accessFilter( name ) as any
        });
        this.#smartFilters = new SmartFilterResolver( this, this.smartFilters,
        {
            prefix          : this.#prefix,
            parentResolve   : ( smartFilter ) =>
            {
                const parent = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );

                return parent ? parent.resolveSmartFilter( smartFilter ) : Promise.resolve({});
            }
        });
        this.#computedProperties = new ComputedPropertyResolver( this, params.computedProperties,
        {
            prefix          : this.#prefix,
            parentResolve   : ( properties ) =>
            {
                const parent = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );

                return parent ? parent.resolveComputedProperties( properties ) : Promise.resolve({});
            }
        });

        this.#findAggregator = new Aggregator( async( ids: Array<DTO['id'] | DBE['id']>, conversion: keyof Extensions['converters'], accessCtx?: { method: string, access?: string, scopeKey?: string } ) =>
        {
            try
            {
                ids = ids.map( id => this.dtoID( id ));

                let pipeline = await this.pipeline(
                {
                    filter      : { id: { $in: ids.map( id => this.dbeID( id )) } },
                    projection  : this.converters[conversion].projection,
                    access      : accessCtx?.access
                }, conversion, accessCtx?.method ?? 'get' );

                pipeline = this.#optimizePipeline( pipeline );

                const start = Date.now();
                const documents = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() as DBE[];
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );
                this.#emitQuery( 'get', pipeline, duration,
                {
                    resultCount : documents.length,
                    conversion  : String( conversion )
                });

                return map(
                    ids.map( id => this.dtoID( id )),
                    documents,
                    ( dbe: DBE ) => this.dtoID( dbe.id )
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

        models[REGISTER_MODEL]( this, collection.collectionName, this.#prefix );
    }

    [GET_OPTIMIZER_OPTIONS](): OptimizerOptions | undefined
    {
        if( this.#optimizer === undefined )
        {
            const parent = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );

            return typeof parent?.[GET_OPTIMIZER_OPTIONS] === 'function'
                ? parent[GET_OPTIMIZER_OPTIONS]()
                : this.#models[GET_OPTIMIZER_OPTIONS]();
        }

        if( this.#optimizer === false ){ return undefined }

        if( this.#optimizer === true ){ return {} }

        return this.#optimizer;
    }

    [GET_OBSERVABILITY_OPTIONS](): ObservabilityOptions | undefined
    {
        const parent = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );
        const parentOptions = typeof parent?.[GET_OBSERVABILITY_OPTIONS] === 'function'
            ? parent[GET_OBSERVABILITY_OPTIONS]()
            : this.#models[GET_OBSERVABILITY_OPTIONS]();

        return resolveObservabilityOptions( this.#observability, parentOptions );
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
                collection  : `${this.collection.collectionName}.${this.#prefix}`,
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
                collection  : `${this.collection.collectionName}.${this.#prefix}`,
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
                collection  : `${this.collection.collectionName}.${this.#prefix}`,
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
                collection  : `${this.collection.collectionName}.${this.#prefix}`,
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

    public dbeID( id: DTO['id'] | DBE['id'] ): DBE['id']
    {
        return id as DBE['id'];
    }

    public dtoID( dbeID: DBE['id'] | DTO['id'] ): DTO['id']
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
        options: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>> = {},
        conversion?: K,
        method: string = 'list'
    ): Promise<Document[]>
    {
        const { computedProperties } = this.converters[conversion ?? 'dto'];
        let { filter = {} as PropertyModelFilter<RootDBE, DBE>, sort = { id: -1 }, ...rest } = resolveBSONObject( options );

        void filter;

        let pipeline: Document[] = [], prefix = '$';

        const smartFilter = options.smartFilter ? await this.resolveSmartFilter( options.smartFilter as any ) as { [prefix: string]: { filter?: Filter<any>, pipeline?: Document[] } } : undefined;
        const converterProperties = await this.resolveComputedProperties( computedProperties );
        const optionsProperties = await this.resolveComputedProperties( options.computedProperties );
        const computed = mergeComputedProperties( converterProperties as any, optionsProperties as any );

        const gatheredFields = Object.values( computed || { fields: null, pipeline: null })
            .reduce(( acc, val ) =>
            {
                const fields = { ...acc?.fields, ...val?.fields };
                const stages = [ ...acc?.pipeline!, ...( val?.pipeline || [] ) ];

                return { fields, pipeline: stages };
            }, { fields: {}, pipeline: [] as Document[] });

        let computedAddedFields = Object.fromEntries(([
            ...collectAddedFields( [{ $addFields: gatheredFields?.fields || {} }] ),
            ...collectAddedFields( gatheredFields?.pipeline || [] )
        ]).map( f =>
        {
            if( f.startsWith( this.#prefix + '.' ) )
            {
                return [ f.replace( new RegExp( '^' + this.#prefix + '.' ), '' ), 1 ];
            }

            return [ f.split( '.' ).reverse()[0], '$_root.' + f ];
        }));
        computedAddedFields = projectionToReplace( computedAddedFields, this.#prefix ) as {[p: string]: any};

        const gatheredFilters = Object.values( smartFilter || {})
            .reduce(( acc, val ) =>
            {
                const nextFilter = { ...acc?.filter, ...val?.filter } as Filter<DBE>;
                const stages = [ ...acc?.pipeline!, ...( val?.pipeline || [] ) ] as Document[];

                return { filter: nextFilter, pipeline: stages };
            }, { filter: {} as Filter<DBE>, pipeline: [] as Document[] });
        const needRoot = getUsedFields( gatheredFilters?.pipeline ?? [] ).used.some( el => el.startsWith( '_root.' ));

        const stages = await this.#filterStages( options, method );
        const subPaths = getSubPaths( this.#paths );

        for( let i = 0; i <= subPaths.length; i++ )
        {
            const last = i === subPaths.length;

            if( i !== 0 && ( !last || this.#paths[this.#paths.length - 1].array ) )
            {
                pipeline.push({ $unwind: prefix = ( prefix === '$' ? prefix : prefix + '.' ) + subPaths[i - 1] });
            }

            const tmpPrefix = prefix.replace( /^\$/, '' );

            needRoot && last && pipeline.push({ $addFields: { _root: '$$ROOT' }});
            pipeline.push( ...await this.#pipelineBuilder.pipeline(
            {
                filter              : stages[i],
                smartFilter         : smartFilter?.[tmpPrefix] ? smartFilter?.[tmpPrefix] as { filter?: Filter<RootDBE>, pipeline: Document[] } : undefined,
                computedProperties  : computed?.[tmpPrefix] ? computed[tmpPrefix] : undefined
            }));
            needRoot && last && pipeline.push({ $unset: '_root' });
        }

        let $project: string | Record<string, unknown> = '$' + this.#prefix, $rootProject;

        const { rootProjection, propertyProjection } = this.#splitProjection( rest.projection ?? {});

        const unsetFieldsRoot = isExclusionProjection( rootProjection ) && getUsedFields( [{ $match: rootProjection }] ).used.map( el => ( '_root.' + el )) || [];
        const unsetFieldsProperty = isExclusionProjection( propertyProjection ) && getUsedFields( [{ $match: propertyProjection }] ).used || [];

        if( isSet( propertyProjection ) )
        {
            $project = projectionToReplace({ id: 1, ...propertyProjection }, this.#prefix );
        }

        if( isSet( rootProjection ) )
        {
            $rootProject = typeof rootProjection === 'object' && unsetFieldsRoot.length === 0 ? projectionToReplace( rootProjection ) : '$$ROOT';
        }

        if( $rootProject )
        {
            pipeline.push({ $replaceWith: { $mergeObjects: [ $project, { '_root': $rootProject, ...computedAddedFields }]}});
        }
        else
        {
            pipeline.push({ $replaceWith: { $mergeObjects: [ $project, computedAddedFields ] } });
        }

        const unsetFields = [ ...unsetFieldsProperty, ...unsetFieldsRoot ];

        if( unsetFields.length )
        {
            pipeline.push({ $unset: unsetFields });
        }

        const prev = options.cursor?.startsWith( 'prev:' );

        pipeline.push( ...await this.#pipelineBuilder.pipeline(
        {
            sort        : prev ? reverseSort( sort ) : sort,
            skip        : rest.skip,
            limit       : rest.limit,
            pipeline    : rest.pipeline
        }));

        return pipeline;
    }

    public async create( parentID: any, dbe: Omit<DBE, 'id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
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
            const parentModel = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );
            const parent = parentModel ? await parentModel.get( parentID ) : null;

            if( !parent || !parentModel )
            {
                throw new ModelError( 'MODEL_PARENT_NOT_FOUND', this, `Parent document not found: ${parentID}` );
            }

            const { parentIDPath, updatePath, arrayFilters } = propertyModelUpdateParams( this.#paths, parentModel.dbeID( parentID ));
            const operation = this.#paths[this.#paths.length - 1].array ? '$push' : '$set';
            const start = Date.now();

            await this.collection.updateOne(
                resolveBSONObject({ [parentIDPath]: parentModel.dbeID( parentID ) }) as any,
                resolveBSONObject({ [operation]: { [updatePath]: { id: this.dbeID( _id ), ...dbe } } }),
                resolveBSONObject({ arrayFilters })
            );

            this.#emitMutation( 'create', Date.now() - start, { insertedCount: 1, ids: [ _id ] });

            return _id;
        }
        finally
        {
            release();
        }
    }

    public async createFrom(
        parentID: any,
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
            let dbe: Omit<DBE, 'id'> & { id?: DBE['id'] };

            try
            {
                dbe = await this.#converters.convertFrom( data, fromKey ) as unknown as Omit<DBE, 'id'> & { id?: DBE['id'] };
            }
            catch( e )
            {
                this.#emitError( e, 'createFrom', Date.now() - start );

                throw e;
            }

            const resolvedId = explicitId ?? ( dbe.id !== undefined ? this.dtoID( dbe.id ) as DTO['id'] : undefined );
            const createdId = await this.create( parentID, dbe, resolvedId, resolvedOptions );

            this.#emitMutation( 'createFrom', Date.now() - start, { insertedCount: 1, ids: [ createdId ] });

            return createdId;
        });
    }

    public async createMany(
        parentID: any,
        items: Array<Omit<DBE, 'id'> & { id?: DBE['id'] }>,
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

            const parentModel = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );
            const parent = parentModel ? await parentModel.get( parentID ) : null;

            if( !parent || !parentModel )
            {
                throw new ModelError( 'MODEL_PARENT_NOT_FOUND', this, `Parent document not found: ${parentID}` );
            }

            if( items.length === 0 )
            {
                this.#emitMutation( 'createMany', 0, { insertedCount: 0, ids: [] });

                return [];
            }

            const ids: DTO['id'][] = [];
            const docs: Document[] = [];

            for( let i = 0; i < items.length; i++ )
            {
                const item = items[i];
                const rawId = explicitIds?.[i] ?? ( item.id !== undefined ? this.dtoID( item.id ) : await this.id());
                const dtoId = this.dtoID( rawId ) as DTO['id'];

                ids.push( dtoId );
                docs.push( resolveBSONObject({ ...item, id: this.dbeID( dtoId ) }));
            }

            const { parentIDPath, updatePath, arrayFilters } = propertyModelUpdateParams( this.#paths, parentModel.dbeID( parentID ));
            const isLeafArray = this.#paths[this.#paths.length - 1].array;
            const updatePayload = isLeafArray
                ? { $push: { [updatePath]: { $each: docs } } }
                : { $set: { [updatePath]: docs[docs.length - 1] } };
            const start = Date.now();

            try
            {
                await this.collection.updateOne(
                    resolveBSONObject({ [parentIDPath]: parentModel.dbeID( parentID ) }) as any,
                    resolveBSONObject( updatePayload ),
                    resolveBSONObject({ arrayFilters })
                );

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

    public async update( id: DTO['id'] | DBE['id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
            const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
            const access = await this.#access.resolveOrDeny({ operation: 'update', method: 'update', access: options?.access });

            if( access.denied )
            {
                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, this.dbeID( id ));
            const operations = addPrefixToUpdate<RootDBE, DBE>( update, updatePrefix );
            const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: this.dbeID( id ) }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: this.dbeID( id ) } as Filter<RootDBE>;

            flowGet( 'log' ) && LOG({ match, operations, options: updateOptions });

            const documentBefore = options?.documentBefore ? ( await this.get( id, { as: 'dbe' as any }) as DBE ) || undefined : undefined;
            const start = Date.now();
            const res = await this.collection.updateOne(
                resolveBSONObject( match ) as Filter<RootDBE>,
                toUpdateOperations( operations ),
                resolveBSONObject( updateOptions )
            );
            const duration = Date.now() - start;

            this.#invalidateCache([ id ]);

            const documentAfter = options?.documentAfter ? ( await this.get( id, { as: 'dbe' as any }) as DBE ) || undefined : undefined;

            this.#emitMutation( 'update', duration,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : [ id ]
            });

            flowGet( 'log' ) && LOG({ res });

            return { matchedRootCount: res.matchedCount, modifiedRootCount: res.modifiedCount, documentBefore, documentAfter };
        }
        finally
        {
            release();
        }
    }

    async #findMatchingSubdocIds(
        findOptions: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        accessFilter?: Filter<any>,
        limit?: number
    ): Promise<Array<DBE['id']>>
    {
        const combinedFilter: PropertyModelFilter<RootDBE, DBE> = accessFilter
            ? ( Object.keys( findOptions.filter ?? {} ).length > 0
                ? { $and: [ findOptions.filter, accessFilter ] } as any
                : accessFilter )
            : ( findOptions.filter ?? {} as PropertyModelFilter<RootDBE, DBE> );

        let pipeline = await this.pipeline(
        {
            filter      : combinedFilter,
            smartFilter : findOptions.smartFilter as any,
            projection  : { id: 1 },
            limit,
            access      : findOptions.access
        }, 'dbe' as any, 'find' );

        pipeline = this.#optimizePipeline( pipeline );

        const docs = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() as Array<{ id: DBE['id'] }>;

        return docs.map( d => d.id ).filter( id => id !== undefined );
    }

    async #resolveBatchTargetIds(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        findOptions: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>> | undefined,
        accessFilter?: Filter<any>
    ): Promise<{ targetIds: Array<DBE['id'] | DTO['id']>, cacheIdsToInvalidate: Array<DBE['id'] | DTO['id']> | null }>
    {
        if( Array.isArray( idsOrFilter ) )
        {
            return { targetIds: idsOrFilter, cacheIdsToInvalidate: idsOrFilter };
        }

        const extracted = extractTargetIdsFromFilter( idsOrFilter, 'id', id => String( this.dtoID( id )));
        const filterKeys = Object.keys( findOptions!.filter ?? {});
        const isOnlyIdFilter = Boolean( extracted && !findOptions!.smartFilter && filterKeys.every( k => k === 'id' ));

        return {
            cacheIdsToInvalidate    : extracted,
            targetIds               : isOnlyIdFilter
                ? extracted!
                : await this.#findMatchingSubdocIds( findOptions!, accessFilter )
        };
    }

    public async updateOne(
        match: PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<PropertyModelUpdateResponse<DBE> & { matchedCount: number, modifiedCount: number }>
    {
        return this.runOperation( async() =>
        {
            const findOptions = normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( match, options?.access );
            const access = await this.#access.resolveOrDeny({ operation: 'update', method: 'updateOne', access: findOptions.access });

            if( access.denied )
            {
                return attachPropertyUpdateMetadata<DBE>({ matchedCount: 0, modifiedCount: 0 });
            }

            const targetIds = extractTargetIdsFromFilter( match, 'id', id => String( this.dtoID( id )));
            const filterKeys = Object.keys( findOptions.filter ?? {});
            const isDirectSingleId = Boolean(
                targetIds
                && targetIds.length === 1
                && !findOptions.smartFilter
                && filterKeys.length === 1
                && filterKeys[0] === 'id'
            );

            let targetId: DTO['id'] | DBE['id'] | undefined = isDirectSingleId ? targetIds![0] : undefined;

            if( targetId === undefined )
            {
                const matchedIds = await this.#findMatchingSubdocIds( findOptions, access.filter, 1 );
                targetId = matchedIds[0];
            }

            if( targetId === undefined )
            {
                if( targetIds && targetIds.length > 0 )
                {
                    this.#invalidateCache( targetIds );
                }

                this.#emitMutation( 'updateOne', 0, { matchedCount: 0, modifiedCount: 0, ids: targetIds ?? undefined });

                return attachPropertyUpdateMetadata<DBE>({ matchedCount: 0, modifiedCount: 0 });
            }

            const res = await this.update( targetId, update, { ...options, access: findOptions.access });

            if( targetIds && targetIds.length > 0 )
            {
                this.#invalidateCache( targetIds );
            }

            return attachPropertyUpdateMetadata<DBE>(
            {
                matchedCount    : res.matchedRootCount,
                modifiedCount   : res.modifiedRootCount,
                documentBefore  : res.documentBefore,
                documentAfter   : res.documentAfter
            });
        });
    }

    async updateMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
            const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
            const isIdArray = Array.isArray( idsOrFilter );
            const findOptions = !isIdArray ? normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( idsOrFilter, options?.access ) : undefined;
            const effectiveAccess = isIdArray ? options?.access : findOptions?.access;

            const access = await this.#access.resolveOrDeny({ operation: 'update', method: 'updateMany', access: effectiveAccess });

            if( access.denied )
            {
                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            const { targetIds: targetIdsToUpdate, cacheIdsToInvalidate } = await this.#resolveBatchTargetIds( idsOrFilter, findOptions, access.filter );

            if( targetIdsToUpdate.length === 0 )
            {
                if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
                {
                    this.#invalidateCache( cacheIdsToInvalidate );
                }

                this.#emitMutation( 'updateMany', 0, { matchedCount: 0, modifiedCount: 0, ids: cacheIdsToInvalidate ?? undefined });

                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            const dbeIds = targetIdsToUpdate.map( id => this.dbeID( id ));
            const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, { $in: dbeIds });
            const operations = addPrefixToUpdate<RootDBE, DBE>( update, updatePrefix );
            const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: { $in: dbeIds } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: { $in: dbeIds } } as Filter<RootDBE>;

            flowGet( 'log' ) && LOG({ match, operations, options: updateOptions });

            const start = Date.now();
            const res = await this.collection.updateMany(
                resolveBSONObject( match ) as Filter<RootDBE>,
                toUpdateOperations( operations ),
                resolveBSONObject( updateOptions )
            );

            if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
            {
                this.#invalidateCache( cacheIdsToInvalidate );
            }

            this.#emitMutation( 'updateMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : cacheIdsToInvalidate ?? undefined
            });

            flowGet( 'log' ) && LOG({ res });

            return { matchedRootCount: res.matchedCount, modifiedRootCount: res.modifiedCount };
        }
        finally
        {
            release();
        }
    }

    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        id: DTO['id'] | DBE['id'],
        options?: GetOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        idOrIds: DTO['id'] | DBE['id'] | Array<DTO['id'] | DBE['id']>,
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
            const documents = await this.#findAggregator.execute( Arr( idOrIds ) as Array<DTO['id'] | DBE['id']>, conversion, { method: 'get', access: options.access, scopeKey } ) as Array<DBE | null>;

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
        ids: Array<DTO['id'] | DBE['id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
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
                const missing: Array<{ index: number, id: DTO['id'] | DBE['id'], dtoId: string, cacheKey: string }> = [];

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
        options: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async() =>
        {
            const { projection } = this.converters[conversion];
            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':find(' + String( conversion ) + ')' ) : undefined;

            let pipeline = await this.pipeline({ filter: options.filter, smartFilter: options.smartFilter, projection, sort, limit: 1, access: options.access }, conversion, 'find' );

            pipeline = this.#optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            const dbe = ( await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray())[0];
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( pipeline, true );

            benchmark?.step( 'QUERY' );

            const convStart = Date.now();
            const data = dbe ? await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;
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
        options: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): Promise<WithTotal<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string }>>>
    {
        const release = this.trackOperation();

        try
        {
        const { projection } = this.converters[conversion];
        const prev = options.cursor?.startsWith( 'prev:' );
        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + String( conversion ) + ')' ) : undefined;

        try
        {
            await this.#access.resolve({ operation: 'read', method: 'list', access: options.access });
        }
        catch( e )
        {
            if( e instanceof ModelAccessDeniedError )
            {
                return attachListMetadata([], options.count ? 0 : undefined, {});
            }

            throw e;
        }

        const resolvedList = resolveBSONObject( options );
        // Strip cursor/count from the count path — count is not page-scoped, and must not
        // re-apply cursor against a different default sort than the list pipeline.
        let { sort = { id: 1 }, countLimit, cursor: _cursor, count: _count, ...countRest } = resolvedList;

        if( !sort.id )
        {
            sort = { ...sort, id: 1 };
        }

        let pipeline = await this.pipeline({ ...resolvedList, sort, projection }, conversion, 'list' );
        let countPipeline = resolvedList.count
            ? this.#pipelineBuilder.buildCountPipeline(
                await this.pipeline({ ...countRest, sort, projection }, undefined, 'list' ),
                countLimit
            )
            : undefined;

        pipeline = this.#optimizePipeline( pipeline );
        countPipeline && ( countPipeline = this.#optimizePipeline( countPipeline ));

        const start = Date.now();
        let queryDuration = 0;
        const [ entries, total ] = await Promise.all(
        [
            this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray().then( r =>
            {
                queryDuration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
                LOG_FILE( `TIME: ${queryDuration} ms` );
                LOG_FILE( pipeline, true );

                return r;
            }),
            countPipeline
                ? this.collection.aggregate( countPipeline, { collation: { locale: 'en' } }).toArray().then( r =>
                {
                    const duration = Date.now() - start;

                    LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
                    LOG_FILE( `TIME: ${duration} ms` );
                    LOG_FILE( countPipeline, true );
                    this.#emitQuery( 'count', countPipeline!, duration, { resultCount: r[0]?.count ?? 0 });

                    return r[0]?.count ?? 0;
                })
                : undefined
        ]);

        benchmark?.step( 'QUERY' );

        const orderedEntries = prev ? [ ...entries ].reverse() : entries;
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
            resolvedList.count ? total : undefined,
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
        options: PropertyModelStreamOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): AsyncGenerator<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>
    {
        const release = this.trackOperation();

        try
        {
        const { projection } = this.converters[conversion];
        const prev = options.cursor?.startsWith( 'prev:' );

        try
        {
            await this.#access.resolve({ operation: 'read', method: 'stream', access: options.access });
        }
        catch( e )
        {
            if( e instanceof ModelAccessDeniedError )
            {
                return;
            }

            throw e;
        }

        const resolvedList = resolveBSONObject( options );
        let { sort = { id: 1 } } = resolvedList;

        if( !sort.id )
        {
            sort = { ...sort, id: 1 };
        }

        let pipeline = await this.pipeline({ ...resolvedList, sort, projection }, conversion, 'stream' );

        pipeline = this.#optimizePipeline( pipeline );

        const start = Date.now();
        const cursorDocs = this.collection.aggregate( pipeline, { collation: { locale: 'en' } });

        if( prev )
        {
            const entries = await cursorDocs.toArray();
            const duration = Date.now() - start;

            LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
            LOG_FILE( `TIME: ${duration} ms` );
            LOG_FILE( pipeline, true );
            this.#emitQuery( 'stream', pipeline, duration );

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

                LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );
                this.#emitQuery( 'stream', pipeline, duration );
            }

            yield await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
        }

        if( !emitted )
        {
            this.#emitQuery( 'stream', pipeline, Date.now() - start );
        }
        }
        finally
        {
            release();
        }
    }

    public async aggregate<T>(
        pipeline: Document[],
        options?: PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
    ): Promise<T[]>
    {
        const release = this.trackOperation();

        try
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

            aggregationPipeline = [ ...await this.pipeline({}, 'dbe', 'aggregate' ), ...( resolveBSONObject( pipeline ) as Document[] ) ];
        }

        aggregationPipeline = this.#optimizePipeline( aggregationPipeline );

        flowGet( 'log' ) && DUMP( aggregationPipeline );

        const start = Date.now();
        const res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } }).toArray() as T[];
        const duration = Date.now() - start;

        LOG_FILE( `Collection: ${this.collection.collectionName}.${this.#paths.map( el => el.path ).join( '.' )}` );
        LOG_FILE( `TIME: ${duration} ms` );
        LOG_FILE( aggregationPipeline, true );
        this.#emitQuery( 'aggregate', aggregationPipeline, duration );

        return res;
        }
        finally
        {
            release();
        }
    }

    public async count(
        options?: PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
    ): Promise<number>;
    public async count(
        pipeline: Document[],
        options?: PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
    ): Promise<number>;
    public async count(
        pipelineOrOptions?: Document[] | PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        options?: PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
    ): Promise<number>
    {
        if( Array.isArray( pipelineOrOptions ) )
        {
            const countPipeline = [ ...pipelineOrOptions, { $count: 'count' }];

            return await this.aggregate<{ count: number }>( countPipeline, options ).then( r => r[0]?.count ?? 0 );
        }

        return await this.aggregate<{ count: number }>([{ $count: 'count' }], pipelineOrOptions ).then( r => r[0]?.count ?? 0 );
    }

    public async exists(
        idOrFilter?: DTO['id'] | DBE['id'] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options?: { access?: string }
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const findOptions = normalizeExistsOptions<PropertyModelFilter<RootDBE, DBE>>(
                idOrFilter,
                'id',
                id => this.dbeID( id ),
                options?.access
            );

            const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'exists', access: findOptions.access });

            if( access.denied ){ return false }

            let pipeline = await this.pipeline(
            {
                filter      : findOptions.filter,
                smartFilter : findOptions.smartFilter as any,
                projection  : { id: 1 },
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

    protected async accessFilter( _name: string ): Promise<AccessFilterResult<PropertyModelFilter<RootDBE, DBE>>> {}

    public async resolveSmartFilter( smartFilter: Record<string, any> )
    {
        return this.#smartFilters.resolve( smartFilter );
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<{ [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> }>
    {
        return this.#computedProperties.resolve( properties ) as Promise<{ [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> }>;
    }

    public async delete( id: DTO['id'] | DBE['id'], options?: ModelDeleteOptions ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const access = await this.#access.resolveOrDeny({ operation: 'delete', method: 'delete', access: options?.access });

            if( access.denied )
            {
                return false;
            }

            const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
            const dbeId = this.dbeID( id );
            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: dbeId }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: dbeId } as Filter<RootDBE>;

            const { operations, updateOptions } = buildPropertyDeleteOperation<RootDBE>( this.#paths, dbeId );

            const start = Date.now();
            const res = await this.collection.updateOne(
                resolveBSONObject( match ) as Filter<RootDBE>,
                resolveBSONObject( operations ) as UpdateFilter<RootDBE>,
                resolveBSONObject( updateOptions )
            );

            this.#invalidateCache([ id ]);
            this.#emitMutation( 'delete', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                deletedCount    : res.modifiedCount,
                ids             : [ id ]
            });

            return res.modifiedCount > 0;
        });
    }

    public async deleteMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelDeleteOptions
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            const isIdArray = Array.isArray( idsOrFilter );
            const findOptions = !isIdArray ? normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( idsOrFilter, options?.access ) : undefined;
            const effectiveAccess = isIdArray ? options?.access : findOptions?.access;

            const access = await this.#access.resolveOrDeny({ operation: 'delete', method: 'deleteMany', access: effectiveAccess });

            if( access.denied )
            {
                return 0;
            }

            const { targetIds: targetIdsToDelete, cacheIdsToInvalidate } = await this.#resolveBatchTargetIds( idsOrFilter, findOptions, access.filter );

            if( targetIdsToDelete.length === 0 )
            {
                if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
                {
                    this.#invalidateCache( cacheIdsToInvalidate );
                }

                this.#emitMutation( 'deleteMany', 0, { deletedCount: 0, ids: cacheIdsToInvalidate ?? undefined });

                return 0;
            }

            const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
            const dbeIds = targetIdsToDelete.map( id => this.dbeID( id ));
            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: { $in: dbeIds } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: { $in: dbeIds } } as Filter<RootDBE>;

            const { operations, updateOptions } = buildPropertyDeleteOperation<RootDBE>( this.#paths, { $in: dbeIds });

            const start = Date.now();
            const res = await this.collection.updateMany(
                resolveBSONObject( match ) as Filter<RootDBE>,
                resolveBSONObject( operations ) as UpdateFilter<RootDBE>,
                resolveBSONObject( updateOptions )
            );

            if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
            {
                this.#invalidateCache( cacheIdsToInvalidate );
            }

            this.#emitMutation( 'deleteMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                deletedCount    : res.modifiedCount,
                ids             : cacheIdsToInvalidate ?? undefined
            });

            return res.modifiedCount;
        });
    }

    async #filterStages( list: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>, method: string = 'list' )
    {
        const sort = list.sort ?? { id: -1 };
        const access = await this.#access.resolveOrDeny({ operation: 'read', method, access: list.access });
        const accessFilter = access.denied ? { '_root._id': { $exists: false }, id: { $exists: false } } : access.filter;
        const cursorFilter = list.cursor ? generateCursorCondition( list.cursor, sort ) : undefined;
        const stageFilter = optimizeMatch( resolveBSONObject(
        {
            $and: [ addPrefixToFilter({ $and: [ list.filter, accessFilter, cursorFilter ] }, this.#prefix ) ]
        }) as MongoFilter<DBE> );

        return splitFilterToStages( stageFilter as MongoFilter<DBE>, this.#paths ) as Filter<RootDBE>[];
    }

    #splitProjection( projection: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>['projection'] ): { rootProjection?: any, propertyProjection?: any }
    {
        if( !projection ){ return {} }

        let { _root: rootProjection, ...propertyProjection } = projection;

        for( const key in propertyProjection )
        {
            if( key.startsWith( '_root.' ) )
            {
                if( !rootProjection )
                {
                    rootProjection = {};
                }

                rootProjection[key.replace( '_root.', '' )] = propertyProjection[key];
                delete propertyProjection[key];
            }
        }

        return { rootProjection, propertyProjection };
    }
}
