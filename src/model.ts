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
import { ConverterManager } from './converters.js';
import { ModelAccessDeniedError, ModelError } from './errors.js';
import { ModelEventEmitter, ModelEventHandler, ModelEventName } from './events.js';
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
    resolveBSONObject,
    toUpdateOperations
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import { convertDocuments } from './operations.js';
import { PipelineBuilder } from './pipeline-builder.js';
import { ComputedPropertyResolver, SmartFilterResolver } from './resolvers.js';
import { GET_OPTIMIZER_OPTIONS, REGISTER_MODEL } from './symbols.js';
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
    ListResult,
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
    OptimizerOptions
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
    #optimizer?: OptimizerConfig;

    public converters: Extensions['converters'];
    public smartFilters?: ExtractSmartFilters<Extensions>;

    protected constructor( models: AbstractModels, public collection: Collection<DBE>, params: Extensions & { optimizer?: OptimizerConfig } )
    {
        this.#models = models;
        this.#optimizer = params.optimizer;
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this.smartFilters = params.smartFilters;
        this.#converters = new ConverterManager( this, this.converters );
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

        this.#findAggregator = new Aggregator( async( ids: Array<DTO['id']>, conversion: keyof Extensions['converters'], accessCtx?: { method: string, access?: string } ) =>
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

                this.#emitQuery( 'get', pipeline, duration );

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

    #emitQuery( operation: 'get' | 'list' | 'stream' | 'aggregate' | 'count' | 'find', pipeline: Document[], duration: number )
    {
        this.#events.emit( 'query',
        {
            collection  : this.collection.collectionName,
            pipeline,
            duration,
            operation
        });
    }

    #emitError( error: unknown, operation?: string )
    {
        this.#events.emit( 'error',
        {
            collection  : this.collection.collectionName,
            error       : error instanceof Error ? error : new Error( String( error )),
            operation
        });
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
        const { filter, sort, projection, computedProperties: optionsComputedProperties, smartFilter, access } = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>;

        const converterProperties = { '': await this.resolveComputedProperties( converterComputedProperties ) };
        const optionsProperties = { '': await this.resolveComputedProperties( optionsComputedProperties ) };
        const computedProperties = mergeComputedProperties( converterProperties, optionsProperties )[''];

        return this.#pipelineBuilder.pipeline(
        {
            filter,
            projection,
            computedProperties,
            sort,
            smartFilter : smartFilter && await this.resolveSmartFilter( smartFilter ) || undefined,
            accessFilter: await this.#access.resolve({ operation: 'read', method, access })
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

            try
            {
                await this.collection.insertOne( resolveBSONObject({ ...dbe, _id: this.dbeID( _id ) }) as OptionalUnlessRequiredId<DBE> );
            }
            catch( e: any )
            {
                if( options?.duplicateIgnore === true && e.code === 11000 )
                {
                    return this.dtoID( await this.collection.findOne( e.keyValue, { projection: { _id: 1 }, collation: { locale: 'en' } }).then( r => r?._id ));
                }

                throw e;
            }

            return _id;
        }
        finally
        {
            release();
        }
    }

    /**
     * Virtual hook — convert inbound API data to DBE and create.
     * Subclasses must override; default throws.
     */
    public async createFrom( _data: unknown, _id?: DTO['id'], _options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        throw new ModelError( 'MODEL_NOT_IMPLEMENTED', this, 'createFrom() is not implemented' );
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

                return {
                    matchedCount    : document ? 1 : 0,
                    modifiedCount   : document ? 1 : 0,
                    documentBefore  : options.documentBefore && !options.documentAfter ? document : undefined,
                    documentAfter   : options.documentAfter ? document : undefined
                };
            }

            const res = await this.collection.updateOne( match, toUpdateOperations( update ));

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

    public async updateMany(
        ids: DTO['id'][] | DBE['_id'][],
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
        {
            const match = await this.#access.match(
                resolveBSONObject({ _id: { $in: ids.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                { operation: 'update', method: 'updateMany', access: options?.access }
            );

            if( !match )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const res = await this.collection.updateMany( match, toUpdateOperations( update ));

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

    /**
     * Virtual hook — update a single document by find options / match.
     * Subclasses must override; default throws.
     */
    public async updateOne(
        _match: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        _update: Partial<DBE> | UpdateFilter<DBE>,
        _options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        throw new ModelError( 'MODEL_NOT_IMPLEMENTED', this, 'updateOne() is not implemented' );
    }

    public async get<K extends keyof Extensions['converters'] = 'dto'>(
        id: DTO['id'] | DBE['_id'],
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
            const documents = await this.#findAggregator.execute( Arr( id ), conversion, { method: 'get', access: options?.access } ) as Array<DBE | null>;

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
        ids: Array<DTO['id'] | DBE['_id']>,
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
        options: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':find(' + String( conversion ) + ')' ) : undefined;

        const dbe = await this.aggregate<DBE>( [{ $limit: 1 }], { ...options, sort }).then( r => r[0] );

        benchmark?.step( 'QUERY' );

        const data = dbe ? await this.#converters.convert( dbe, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;

        benchmark?.step( 'CONVERTER' );

        return data;
    }

    public async list<K extends keyof Extensions['converters']>(
        options: ModelListOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K
    ): Promise<ListResult<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>
    {
        const release = this.trackOperation();

        try
        {
        const { computedProperties: compProps } = this.converters[conversion];
        let { filter = {}, sort = { _id: 1 }, cursor, limit, countLimit, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( options );
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
                return { items: [], total: options.count ? 0 : undefined, cursors: {} };
            }

            throw e;
        }

        const smartFilter = options.smartFilter && await this.resolveSmartFilter( options.smartFilter );
        const computedProperties = compProps && await this.resolveComputedProperties( Array.isArray( compProps ) ? compProps : typeof compProps === 'function' ? compProps() : compProps ) || undefined;

        const params =
        {
            ...rest,
            filter, sort, smartFilter, cursor, limit, countLimit,
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
        const [ entries, total ] = await Promise.all(
        [
            this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray().then( r =>
            {
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( pipeline, true );
                this.#emitQuery( 'list', pipeline, duration );

                return r;
            }),
            options.count ? this.collection.aggregate( countPipeline, { collation: { locale: 'en' } }).toArray().then( r =>
            {
                const duration = Date.now() - start;

                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${duration} ms` );
                LOG_FILE( countPipeline, true );
                this.#emitQuery( 'count', countPipeline!, duration );

                return r[0]?.count ?? 0;
            }) : undefined
        ]);

        benchmark?.step( 'QUERY' );

        let orderedEntries = prev ? [ ...entries ].reverse() : entries;

        const items = await Promise.all( orderedEntries.map( async( dbe ) =>
        {
            return await this.#converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
        }));

        benchmark?.step( 'CONVERTER' );

        const first = orderedEntries[0];
        const last = orderedEntries[orderedEntries.length - 1];

        return {
            items,
            total   : options.count ? total : undefined,
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
        options: ModelStreamOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K
    ): AsyncGenerator<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>
    {
        const release = this.trackOperation();

        try
        {
        const { computedProperties: compProps } = this.converters[conversion];
        let { filter = {}, sort = { _id: 1 }, cursor, limit, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( options );
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
        const computedProperties = compProps && await this.resolveComputedProperties( Array.isArray( compProps ) ? compProps : typeof compProps === 'function' ? compProps() : compProps ) || undefined;

        let pipeline = await this.#pipelineBuilder.pipeline(
        {
            ...rest,
            filter, sort, smartFilter, cursor, limit,
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

                LOG_FILE( `Collection: ${this.collection.collectionName}` );
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
            this.#emitQuery( 'aggregate', aggregationPipeline, duration );

            return res;
        });
    }

    public async count(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>
    {
        const countPipeline = [ ...pipeline, { $count: 'count' }];

        return this.aggregate<{ count: number }>( countPipeline, options ).then( r => r[0]?.count ?? 0 );
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

            return ( await this.collection.deleteOne( match )).deletedCount === 1;
        });
    }
}
