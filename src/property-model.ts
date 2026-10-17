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
    optimizeMatch,
    projectionToReplace,
    propertyModelUpdateParams,
    resolveBSONObject,
    reverseSort,
    splitFilterToStages,
    toUpdateOperations
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import { convertDocuments } from './operations.js';
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
    ListResult,
    ModelCreateOptions,
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
    SecondType
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
    #optimizer?: OptimizerConfig;
    #observability?: ObservabilityConfig;

    public converters: Extensions['converters'];
    public smartFilters?: FirstType<ExtractSmartFilters<Extensions>>;

    protected constructor( models: AbstractModels, public collection: Collection<RootDBE>, path: string, params: ConstructorExtensions<Extensions> )
    {
        this.#models = models;
        this.#optimizer = params.optimizer;
        this.#observability = params.observability;
        this.#paths = [ ...path.matchAll( /[^\[\]]+(\[\])?/g ) ].map( m => ({ path: m[0].replace( /^\./, '' ).replace( /\[\]$/, '' ), array: m[0].endsWith( '[]' ) }));
        this.#prefix = this.#paths.map( p => p.path ).join( '.' );
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this.smartFilters = params.smartFilters;
        this.#converters = new ConverterManager( this, this.converters );
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

        this.#findAggregator = new Aggregator( async( ids: Array<DTO['id'] | DBE['id']>, conversion: keyof Extensions['converters'], accessCtx?: { method: string, access?: string } ) =>
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

            return parent ? parent[GET_OPTIMIZER_OPTIONS]() : this.#models[GET_OPTIMIZER_OPTIONS]();
        }

        if( this.#optimizer === false ){ return undefined }

        if( this.#optimizer === true ){ return {} }

        return this.#optimizer;
    }

    [GET_OBSERVABILITY_OPTIONS](): ObservabilityOptions | undefined
    {
        const parent = this.#models[GET_PARENT]( this.collection.collectionName, this.#prefix );
        const parentOptions = parent
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
        options: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>> & { computedProperties?: ComputedPropertiesParam<SecondType<ExtractComputedProperties<Extensions>>> } = {},
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
        void this.#emitCache;
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

    public async update( id: DTO['id'] | DBE['id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
        const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
        let operations: Partial<RootDBE> | UpdateFilter<RootDBE> = {};
        let updateOptions: UpdateOptions = {};

        const access = await this.#access.resolveOrDeny({ operation: 'update', method: 'update', access: options?.access });

        if( access.denied )
        {
            return { matchedRootCount: 0, modifiedRootCount: 0 };
        }

        if( this.#paths.length === 1 && !this.#paths[0].array )
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths[0].path );
        }
        else if( this.#paths[this.#paths.length - 1].array )
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths.map( p => p.path ).join( '.$[].' ) + '.$[entry]' );
            updateOptions = { ...updateOptions, arrayFilters: [{ 'entry.id': this.dbeID( id ) }]};
        }
        else
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths.slice( 0, this.#paths.length - 1 ).map( p => p.path ).join( '.$[].' ) + '.$[entry].' + this.#paths[this.#paths.length - 1].path );
            updateOptions = { ...updateOptions, arrayFilters: [{[ 'entry.' + this.#paths[this.#paths.length - 1].path + '.id' ]: this.dbeID( id ) }]};
        }

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

    async updateMany( ids: DBE['id'][] | DTO['id'][], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
        const path = this.#paths.map( p => p.path ).join( '.' ) + '.id';
        let operations: Partial<RootDBE> | UpdateFilter<RootDBE> = {};
        let updateOptions: UpdateOptions = {};

        const access = await this.#access.resolveOrDeny({ operation: 'update', method: 'updateMany', access: options?.access });

        if( access.denied )
        {
            return { matchedRootCount: 0, modifiedRootCount: 0 };
        }

        if( this.#paths.length === 1 && !this.#paths[0].array )
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths[0].path );
        }
        else if( this.#paths[this.#paths.length - 1].array )
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths.map( p => p.path ).join( '.$[].' ) + '.$[entry]' );
            updateOptions = { ...updateOptions, arrayFilters: [{ 'entry.id': { $in: ids.map( id => this.dbeID( id )) } }]};
        }
        else
        {
            operations = addPrefixToUpdate<RootDBE, DBE>( update, this.#paths.slice( 0, this.#paths.length - 1 ).map( p => p.path ).join( '.$[].' ) + '.$[entry].' + this.#paths[this.#paths.length - 1].path );
            updateOptions = { ...updateOptions, arrayFilters: [{[ 'entry.' + this.#paths[this.#paths.length - 1].path + '.id' ]: { $in: ids.map( id => this.dbeID( id )) } }]};
        }

        const match: Filter<RootDBE> = access.filter
            ? { $and: [{ [path]: { $in: ids.map( id => this.dbeID( id )) } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
            : { [path]: { $in: ids.map( id => this.dbeID( id )) } } as Filter<RootDBE>;

        flowGet( 'log' ) && LOG({ match, operations, options: updateOptions });

        const start = Date.now();
        const res = await this.collection.updateMany(
            resolveBSONObject( match ) as Filter<RootDBE>,
            toUpdateOperations( operations ),
            resolveBSONObject( updateOptions )
        );

        this.#emitMutation( 'updateMany', Date.now() - start,
        {
            matchedCount    : res.matchedCount,
            modifiedCount   : res.modifiedCount,
            ids
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
        options?: GetOptions<K>
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        const release = this.trackOperation();

        try
        {
        const conversion = ( options?.as ?? 'dto' ) as K;
        const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'get', access: options?.access });

        if( access.denied ){ return null }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + String( conversion ) + ')' ) : undefined;
        const documents = await this.#findAggregator.execute( Arr( id ) as Array<DTO['id'] | DBE['id']>, conversion, { method: 'get', access: options?.access } ) as Array<DBE | null>;

        benchmark?.step( 'QUERY' );

        const entries = await convertDocuments( this.#converters, documents, conversion );

        benchmark?.step( 'CONVERTER' );

        return ( entries[0] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;
        }
        finally
        {
            release();
        }
    }

    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['id']>,
        options?: GetManyOptions<K>
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>
    {
        const release = this.trackOperation();

        try
        {
        const conversion = ( options?.as ?? 'dto' ) as K;
        const access = await this.#access.resolveOrDeny({ operation: 'read', method: 'getMany', access: options?.access });

        if( access.denied )
        {
            return options?.filter ? [] : ids.map(() => null );
        }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':getMany(' + String( conversion ) + ')' ) : undefined;
        const documents = await this.#findAggregator.execute( ids as DTO['id'][], conversion, { method: 'getMany', access: options?.access } ) as Array<DBE | null>;

        benchmark?.step( 'QUERY' );

        const entries = await convertDocuments( this.#converters, documents, conversion, options?.filter === true );

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
        options: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K
    ): Promise<ListResult<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>
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
                return { items: [], total: options.count ? 0 : undefined, cursors: {} };
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
            return await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
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

        return {
            items,
            total   : resolvedList.count ? total : undefined,
            cursors :
            {
                prev    : first ? getCursor( first, sort ) : undefined,
                next    : last ? getCursor( last, sort ) : undefined
            }
        };
        }
        finally
        {
            release();
        }
    }

    public async *stream<K extends keyof Extensions['converters']>(
        options: PropertyModelStreamOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
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
        pipeline: Document[],
        options?: PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
    ): Promise<number>
    {
        const countPipeline = [ ...pipeline, { $count: 'count' }];

        return await this.aggregate<{ count: number }>( countPipeline, options ).then( r => r[0]?.count ?? 0 );
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

    async #filterStages( list: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>, method: string = 'list' )
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
