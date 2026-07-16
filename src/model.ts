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
import { REGISTER_MODEL } from './symbols.js';
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
    ModelExtensions,
    ModelFindOptions,
    ModelListOptions,
    ModelStreamOptions,
    ModelUpdateOptions,
    ModelUpdateResponse,
    MongoRootDocument
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
    #findAggregator: Aggregator<DTO['id'], Array<DBE | null>>;
    #converters: ConverterManager<DBE>;
    #access: AccessControl<DBE>;
    #smartFilters: SmartFilterResolver;
    #computedProperties: ComputedPropertyResolver;
    #pipelineBuilder = new PipelineBuilder<DBE>();
    #events = new ModelEventEmitter();

    public converters: Extensions['converters'];
    public smartFilters?: ExtractSmartFilters<Extensions>;

    protected constructor( models: AbstractModels, public collection: Collection<DBE>, params: Extensions )
    {
        this.converters = ( params.converters ?? { dto: { converter: ( dbe: DBE ) => dbe }, dbe: { converter: ( dbe: DBE ) => dbe } }) as unknown as Extensions['converters'];
        this.smartFilters = params.smartFilters;
        this.#converters = new ConverterManager( this, this.converters );
        this.#access = new AccessControl( this, () => this.accessFilter() );
        this.#smartFilters = new SmartFilterResolver( this, this.smartFilters );
        this.#computedProperties = new ComputedPropertyResolver( this, params.computedProperties );

        models[REGISTER_MODEL]( this, collection.collectionName );

        this.#findAggregator = new Aggregator( async( ids: Array<DTO['id']>, conversion: keyof Extensions['converters'], accessControl: Filter<DBE> | void ) =>
        {
            try
            {
                const pipeline = await this.pipeline(
                {
                    filter:
                    {
                        $and:
                        [
                            { _id: { $in: ids.map( id => this.dbeID( id )) } },
                            accessControl || {}
                        ]
                    } as Filter<DBE>,
                    projection: this.converters[conversion].projection
                }, conversion );

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

    protected async pipeline<K extends keyof Extensions['converters']>(
        options: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
        conversion?: K
    ): Promise<Document[]>
    {
        const { computedProperties: converterComputedProperties } = this.converters[conversion ?? 'dto'];
        const { filter, sort, projection, computedProperties: optionsComputedProperties, smartFilter } = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>;

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
            accessFilter: await this.#access.resolve()
        });
    }

    public async create( dbe: Omit<DBE, '_id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        const _id: DTO['id'] = id ?? await this.id();

        try
        {
            await this.collection.insertOne({ ...dbe, _id: this.dbeID( _id ) } as OptionalUnlessRequiredId<DBE> );
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
        const match = await this.#access.match({ _id: this.dbeID( id ) } as Filter<DBE> );

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

    public async updateMany( ids: DTO['id'][] | DBE['_id'][], update: Partial<DBE> | UpdateFilter<DBE> ): Promise<ModelUpdateResponse<DBE>>
    {
        const match = await this.#access.match({ _id: { $in: ids.map( id => this.dbeID( id )) } } as Filter<DBE> );

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
        const conversion = ( options?.as ?? 'dto' ) as K;
        const access = await this.#access.resolveOrDeny();

        if( access.denied ){ return null }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + String( conversion ) + ')' ) : undefined;
        const documents = await this.#findAggregator.call( Arr( id ), conversion, access.filter ) as Array<DBE | null>;

        benchmark?.step( 'QUERY' );

        const entries = await convertDocuments( this.#converters, documents, conversion );

        benchmark?.step( 'CONVERTER' );

        return ( entries[0] ?? null ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null;
    }

    public async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        options?: GetManyOptions<K>
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>
    {
        const conversion = ( options?.as ?? 'dto' ) as K;
        const access = await this.#access.resolveOrDeny();

        if( access.denied )
        {
            return options?.filter ? [] : ids.map(() => null );
        }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':getMany(' + String( conversion ) + ')' ) : undefined;
        const documents = await this.#findAggregator.call( ids as DTO['id'][], conversion, access.filter ) as Array<DBE | null>;

        benchmark?.step( 'QUERY' );

        const entries = await convertDocuments( this.#converters, documents, conversion, options?.filter === true );

        benchmark?.step( 'CONVERTER' );

        return entries as Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
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
        const { computedProperties: compProps } = this.converters[conversion];
        let { filter = {}, sort = { _id: 1 }, cursor, limit, countLimit, ...rest } = resolveBSONObject( options );
        const prev = cursor?.startsWith( 'prev:' );

        if( !sort._id )
        {
            sort = { ...sort, _id: 1 };
        }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + String( conversion ) + ')' ) : undefined;

        let accessFilter: Filter<DBE> | undefined;

        try
        {
            accessFilter = await this.#access.resolve();
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
            filter, sort, smartFilter, cursor, limit, countLimit, ...rest,
            accessFilter,
            pipeline: options.pipeline,
            computedProperties
        };

        let [ pipeline, countPipeline ] = await Promise.all(
        [
            this.#pipelineBuilder.pipeline( params ),
            options.count ? this.#pipelineBuilder.count( params ) : undefined
        ]);

        flowGet( 'log' ) && DUMP( pipeline );
        flowGet( 'log' ) && countPipeline && DUMP( countPipeline );

        if(( flowGet( 'experimentalFlags' ) as any )?.['query-optimizer'] )
        {
            pipeline = optimizePipeline( pipeline );
            countPipeline && ( countPipeline = optimizePipeline( countPipeline ));
        }

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

    public async *stream<K extends keyof Extensions['converters']>(
        options: ModelStreamOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K
    ): AsyncGenerator<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>
    {
        const { computedProperties: compProps } = this.converters[conversion];
        let { filter = {}, sort = { _id: 1 }, cursor, limit, ...rest } = resolveBSONObject( options );
        const prev = cursor?.startsWith( 'prev:' );

        if( !sort._id )
        {
            sort = { ...sort, _id: 1 };
        }

        let accessFilter: Filter<DBE> | undefined;

        try
        {
            accessFilter = await this.#access.resolve();
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
            filter, sort, smartFilter, cursor, limit, ...rest,
            accessFilter,
            pipeline: options.pipeline,
            computedProperties
        });

        flowGet( 'log' ) && DUMP( pipeline );

        if(( flowGet( 'experimentalFlags' ) as any )?.['query-optimizer'] )
        {
            pipeline = optimizePipeline( pipeline );
        }

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

    public async aggregate<T>(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<T[]>
    {
        let aggregationPipeline = isSet( options )
            ? [ ...await this.pipeline( options!, 'dbe' ), ...( resolveBSONObject( pipeline ) as Document[] ) ]
            : resolveBSONObject( pipeline ) as Document[];

        flowGet( 'log' ) && DUMP( aggregationPipeline );

        if(( flowGet( 'experimentalFlags' ) as any )?.['query-optimizer'] )
        {
            aggregationPipeline = optimizePipeline( aggregationPipeline );
        }

        const start = Date.now();
        const res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } }).toArray() as T[];
        const duration = Date.now() - start;

        LOG_FILE( `Collection: ${this.collection.collectionName}` );
        LOG_FILE( `TIME: ${duration} ms` );
        LOG_FILE( aggregationPipeline, true );
        this.#emitQuery( 'aggregate', aggregationPipeline, duration );

        return res;
    }

    public async count(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>
    {
        let countPipeline = [ ...pipeline, { $count: 'count' }];

        if(( flowGet( 'experimentalFlags' ) as any )?.['query-optimizer'] )
        {
            countPipeline = optimizePipeline( countPipeline );
        }

        return this.aggregate<{ count: number }>( countPipeline, options ).then( r => r[0]?.count ?? 0 );
    }

    protected async accessFilter(): Promise<AccessFilterResult<DBE>> {}

    public async resolveSmartFilter( smartFilter: Record<string, any> )
    {
        return this.#smartFilters.resolve( smartFilter ) as Promise<{ filter?: Filter<DBE>, pipeline?: Document[] }>;
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>
    {
        return this.#computedProperties.resolve( properties ) as Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>;
    }

    public async delete( id: DTO['id'] | DBE['_id'] ): Promise<boolean>
    {
        const match = await this.#access.match({ _id: this.dbeID( id ) } as Filter<DBE> );

        if( !match ){ return false }

        return ( await this.collection.deleteOne( match )).deletedCount === 1;
    }
}
