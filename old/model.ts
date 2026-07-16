import { Collection, Document, FindOptions, Filter, WithId, ObjectId, OptionalUnlessRequiredId, UpdateFilter } from 'mongodb';
import { flowGet, DUMP, Arr, isSet, convert, REGISTER_MODEL, hasPublicMethod, collectAddedFields, mergeComputedProperties, toUpdateOperations, Benchmark, formatter, LOG_FILE } from './helpers';
import { getCursor, resolveBSONObject, ModelError, QueryBuilder } from './helpers';
import { ModelAggregateOptions, ModelCreateOptions, ModelListOptions, MongoRootDocument, WithTotal, ModelUpdateResponse, AbstractModelSmartFilters, PublicMethodNames, SmartFilterMethod, ModelExtensions, ModelFindOptions, ModelUpdateOptions, AbstractModelProperties, ComputedPropertyMethod, AbstractConverterOptions, ComputedPropertiesParam, SyncComputedPropertyMethod, ExtractSmartFilters, ExtractComputedProperties } from './types';
import { AbstractModels } from "./index";
import Cache from "@liqd-js/cache";
import objectHash from "@liqd-js/fast-object-hash";
import QueryOptimizer from "@liqd-js/mongodb-query-optimizer";
export const Aggregator = require('@liqd-js/aggregator');

/**
 * Abstract model class
 * @template DBE - Database entity
 * @template DTO - Data transfer object
 * @template Extensions - Model parameters
 * @class
 */
export abstract class AbstractModel<
    DBE extends MongoRootDocument,
    DTO extends Document,
    Extensions extends ModelExtensions<DBE, AbstractModelSmartFilters<ExtractSmartFilters<Extensions>>, AbstractModelProperties<ExtractComputedProperties<Extensions>>>
>
{
    private abstractFindAggregator;
    public converters: Extensions['converters'];
    public smartFilters?: ExtractSmartFilters<Extensions>;
    private readonly computedProperties: ExtractComputedProperties<Extensions>;
    readonly #models: AbstractModels;
    private readonly cache?: Cache<any>;

    protected constructor( models: AbstractModels, public collection: Collection<DBE>, params: Extensions )
    {
        this.converters = params.converters ?? { dbe: { converter: ( dbe: DBE ) => dbe } };
        this.smartFilters = params.smartFilters;
        this.computedProperties = params.computedProperties;

        params.cache && ( this.cache = new Cache( params.cache ));

        this.#models = models;

        models[REGISTER_MODEL]( this, collection.collectionName );
        this.abstractFindAggregator = new Aggregator( async( ids: Array<DTO['id']>, conversion: keyof Extensions['converters'], accessControl: Filter<WithId<DBE>> | void ) =>
        {
            try
            {
                //const filter = accessControl ? { $and: [ { _id: { $in: ids.map( id => this.dbeID( id ))}}, accessControl ]} : { _id: { $in: ids.map( id => this.dbeID( id ))}};
                //const documents = await this.collection.find( filter, { projection: this.converters[conversion].projection, collation: { locale: 'en' } }).toArray();
                // const documents = accessControl
                //     ? await this.collection.aggregate([{ $match: { $and: [ { _id: { $in: ids.map( id => this.dbeID( id ))}}, accessControl ]}}]).toArray()
                //     : await this.collection.find( { _id: { $in: ids.map( id => this.dbeID( id ))}}, { projection: this.converters[conversion].projection, collation: { locale: 'en' } }).toArray();

                const cacheKeys = ids.map( id => [id, this.cacheKey( id, 'dbe', accessControl )]);
                let documents: Document[] = [];
                const missingIDs = cacheKeys.filter( ([_, key]) => !this.cache?.get( key ) ).map( ([id, _]) => id );
                const cachedIDs = ids.filter( id => !missingIDs.includes( id ));

                if ( cachedIDs.length )
                {
                    LOG_FILE( `FROM CACHE - Collection: ${this.collection.collectionName}` );
                    LOG_FILE( `Count: ${ids.length}, IDs: ${ids}`, true );
                }

                flowGet( 'benchmark' ) && this.cache && console.log( `${formatter.format( new Date() )} ${this.constructor.name}::aggregator - cached(${ids.length - missingIDs.length}), fetched(${missingIDs.length})`);

                if ( missingIDs.length !== ids.length )
                {
                    // TODO: cache - vracat clone nie referenciu
                    documents.push(...ids
                        .filter( id => !missingIDs.includes(id))
                        .map( id => this.cache?.get( this.cacheKey( id, 'dbe', accessControl ) ) )
                    );
                }

                if ( missingIDs.length )
                {
                    const pipeline = await this.pipeline({
                        filter: {
                            $and: [
                                { _id: { $in: missingIDs.map( id => this.dbeID( id ))} },
                                accessControl || {}
                            ]
                        },
                        projection: this.converters[conversion].projection
                    }, conversion );

                    flowGet( 'log' ) && DUMP( pipeline );

                    const start = Date.now();

                    documents.push(...await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray());

                    LOG_FILE( `Collection: ${this.collection.collectionName}` );
                    LOG_FILE( `TIME: ${Date.now() - start} ms` );
                    LOG_FILE( pipeline, true );

                    if ( this.cache )
                    {
                        for ( const doc of documents )
                        {
                            this.cache.set( this.cacheKey( doc._id, 'dbe', accessControl ), doc );
                        }
                    }
                }

                const index = documents.reduce(( i: any, dbe: any ) => ( i.set( this.dtoID( dbe._id ?? dbe.id ), dbe ), i ), new Map());

                return ids.map( id => index.get( this.dtoID(id) ) ?? null );
            }
            catch( e: any )
            {
                if( e instanceof ModelError )
                {
                    throw e;
                }

                throw new ModelError( this, e?.toString() );
            }
        });
    }

    protected id(): DTO['id'] | Promise<DTO['id']>{ return new ObjectId().toString() as DTO['id']; }
    public dbeID( id: DTO['id'] | DBE['_id'] ): DBE['_id']{ return id as DBE['_id']; }
    public dtoID( dbeID: DBE['_id'] | DTO['id'] ): DTO['id']{ return dbeID as DTO['id']; }

    protected async pipeline<K extends keyof Extensions['converters']>( options: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>, conversion?: K ): Promise<Document[]>
    {
        const { computedProperties: converterComputedProperties } = this.converters[conversion ?? 'dto'];

        const { filter, sort, projection, computedProperties: optionsComputedProperties, smartFilter } = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>;

        const converterProperties = { '': await this.resolveComputedProperties( converterComputedProperties )};
        const optionsProperties = { '': await this.resolveComputedProperties( optionsComputedProperties )};
        const computedProperties = mergeComputedProperties( converterProperties, optionsProperties )[''];

        const params = {
            filter, projection, computedProperties, sort,
            smartFilter: smartFilter && await this.resolveSmartFilter( smartFilter ) || undefined,
            accessFilter: await this.accessFilter() || undefined,
        };
        const queryBuilder = new QueryBuilder<DBE>();
        return await queryBuilder.pipeline( params );
    }

    public async create( dbe: Omit<DBE, '_id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        /*if( options?.converter )
        {
            dbe = await options.converter( dbe as T );
        }*/

        const _id: DTO['id'] = id ?? await this.id();

        try
        {
            await this.collection.insertOne({ ...dbe, _id: this.dbeID( _id ) } as OptionalUnlessRequiredId<DBE>/*, { collation: { locale: 'en' } }*/ );
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

    public async createFrom( data: any, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        throw new Error('Method not implemented.');
    }

    public async update( id: DTO['id'] | DBE['_id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<ModelUpdateResponse<DBE>>
    {
        let matchedCount: number | undefined = 0, modifiedCount: number | undefined = 0, documentBefore: DBE | undefined, documentAfter: DBE | undefined;

        // TODO: do properly
        const canUpdate = await this.get( id, 'dbe' );
        if ( !canUpdate )
        {
            return {
                matchedCount: 0,
                modifiedCount: 0,
            }
        }

        if( options?.documentAfter )
        {
            await this.#models.transaction( async() =>
            {
                documentBefore = options?.documentBefore ? (await this.collection.findOne({ _id: this.dbeID( id ) as WithId<DBE>['_id'] }, {collation: { locale: 'en' }})) as DBE || undefined : undefined;
                // TODO remove documentAfter = (await this.collection.findOneAndUpdate({ _id: ( this.dbeID ? this.dbeID( id ) : id ) as WithId<DBE>['_id'] }, isUpdateOperator( update ) ? update : { $set: update } as UpdateFilter<DBE>/*, { collation: { locale: 'en' } }*/ )) as DBE || undefined;
                documentAfter = (await this.collection.findOneAndUpdate({ _id: ( this.dbeID ? this.dbeID( id ) : id ) as WithId<DBE>['_id'] }, toUpdateOperations( update ))) as DBE || undefined;

                matchedCount = documentAfter ? 1 : 0;
                modifiedCount = documentAfter ? 1 : 0;
            });
        }
        else
        {
            documentBefore = options?.documentBefore ? (await this.collection.findOne({ _id: this.dbeID( id ) as WithId<DBE>['_id'] }, {collation: { locale: 'en' }})) as DBE || undefined : undefined;
            // TODO remove const res = await this.collection.updateOne({ _id: ( this.dbeID ? this.dbeID( id ) : id ) as WithId<DBE>['_id'] }, isUpdateOperator( update ) ? update : { $set: update } as UpdateFilter<DBE>/*, { collation: { locale: 'en' } }*/ );
            const res = await this.collection.updateOne({ _id: ( this.dbeID ? this.dbeID( id ) : id ) as WithId<DBE>['_id'] }, toUpdateOperations( update ));

            matchedCount = res.matchedCount;
            modifiedCount = res.modifiedCount;
        }

        return { matchedCount, modifiedCount, documentBefore, documentAfter };
    }

    public async updateMany( id: DTO['id'][] | DBE['_id'][], update: Partial<DBE> | UpdateFilter<DBE> ): Promise<ModelUpdateResponse<DBE>>
    {
        // TODO: do properly
        const canUpdate = await this.get( id, 'dbe' );
        if ( !canUpdate || canUpdate.length !== id.length )
        {
            return {
                matchedCount: 0,
                modifiedCount: 0,
            }
        }

        //const res = await this.collection.updateMany({ _id: { $in: id.map( id => this.dbeID( id ))}}, isUpdateOperator( update ) ? update : { $set: update } as UpdateFilter<DBE> );
        const res = await this.collection.updateMany({ _id: { $in: id.map( id => this.dbeID( id ))}}, toUpdateOperations( update ));

        return {
            matchedCount: res.matchedCount,
            modifiedCount: res.modifiedCount
        }
    }

    public async updateOne( match: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>, update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<ModelUpdateResponse<DBE>>
    {
        throw new Error('Method not implemented.');

        return { matchedCount: 1, modifiedCount: 1 };
    }

    public async get( id: DTO['id'] | DBE['_id'] ): Promise<Awaited<ReturnType<Extensions['converters']['dto']['converter']>> | null>;
    public async get<K extends keyof Extensions['converters']>( id: DTO['id'] | DBE['_id'], conversion: K ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    public async get( id: Array<DTO['id'] | DBE['_id']> ): Promise<Array<Awaited<ReturnType<Extensions['converters']['dto']['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters']>( id: Array<DTO['id'] | DBE['_id']>, conversion: K ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters']>( id: Array<DTO['id'] | DBE['_id']>, conversion: K, filtered: true ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public async get<K extends keyof Extensions['converters']>( id: Array<DTO['id'] | DBE['_id']>, conversion: K, filtered: false ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public async get<K extends keyof Extensions['converters']>( id: DTO['id'] | DBE['_id'] | Array<DTO['id'] | DBE['_id']>, conversion: K = 'dto' as K, filtered: boolean = false )
    {
        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':get(' + ( conversion as string ) + ')' ) : undefined;

        const documents = await this.abstractFindAggregator.call( Arr( id ), conversion, await this.accessFilter() ) as Array<DBE|null>;

        benchmark?.step('QUERY');

        let entries = await Promise.all( documents.map( dbe => dbe ? convert( this, this.converters[conversion].converter, dbe, conversion ) : null )) as Array<Awaited<ReturnType<Extensions['converters']['dto']['converter']>> | null>;

        benchmark?.step('CONVERTER');

        if( filtered ){ entries = entries.filter( Boolean )}

        return Array.isArray( id ) ? entries : entries[0] ?? null as any;
    }

    public async find<K extends keyof Extensions['converters']>( options: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>, conversion: K = 'dto' as K, sort?: FindOptions['sort'] ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        const { converter } = this.converters[conversion];

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':find(' + ( conversion as string ) + ')' ) : undefined;

        const dbe = await this.aggregate<DBE>( [{$limit: 1}], { ...options, sort } ).then( r => r[0]);

        benchmark?.step('QUERY');

        const data = dbe ? await convert( this, converter, dbe, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> : null;

        benchmark?.step('CONVERTER');

        return data;
    }

    public async list<K extends keyof Extensions['converters']>( options: ModelListOptions<DBE, ExtractSmartFilters<Extensions>>, conversion: K = 'dto' as K ): Promise<WithTotal<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string }>>>
    {
        const { converter, computedProperties: compProps, cache } = this.converters[conversion];
        let { filter = {}, sort = { _id: 1 }, cursor, limit, smartFilter: sFilter, countLimit, ...rest } = resolveBSONObject(options);
        const prev = cursor?.startsWith('prev:');
        if ( !sort._id )
        {
            sort = { ...sort, _id: 1 };
        }

        const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + ( conversion as string ) + ')' ) : undefined;

        const accessFilter = await this.accessFilter() || undefined;

        const smartFilter = options.smartFilter && await this.resolveSmartFilter( options.smartFilter );
        const computedProperties = compProps && await this.resolveComputedProperties( Array.isArray( compProps ) ? compProps : compProps() ) || undefined;

        const params = {
            filter, sort, smartFilter, cursor, limit, countLimit, ...rest,
            accessFilter,
            pipeline: options.pipeline,
            computedProperties
        };
        const queryBuilder = new QueryBuilder<DBE>();
        let [pipeline, countPipeline] = await Promise.all ([
            queryBuilder.pipeline( params ),
            options.count ? queryBuilder.count( params ) : undefined
        ]);

        flowGet( 'log' ) && DUMP( pipeline );
        flowGet( 'log' ) && countPipeline && DUMP( countPipeline );

        if ( (flowGet( 'experimentalFlags' ) as any)?.['query-optimizer'] )
        {
            let optimizer = new QueryOptimizer();
            pipeline = optimizer.optimizePipeline( pipeline );
            countPipeline && (countPipeline = optimizer.optimizePipeline( countPipeline ));
        }

        const start = Date.now();
        let [ entries, total ] = await Promise.all(
        [
            this.collection.aggregate( pipeline, { collation: { locale: 'en' } } ).toArray().then( r => {
                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${Date.now() - start} ms` );
                LOG_FILE( pipeline, true );
                return r;
            }),
            options.count ? this.collection.aggregate( countPipeline, { collation: { locale: 'en' } } ).toArray().then( r => {
                LOG_FILE( `Collection: ${this.collection.collectionName}` );
                LOG_FILE( `TIME: ${Date.now() - start} ms` );
                LOG_FILE( countPipeline, true );
                return r[0]?.count ?? 0
            } ) : undefined
        ]);

        benchmark?.step('QUERY');

        const result = await Promise.all( entries.map( async( dbe, i ) =>
        {
            const dto = await convert( this, converter, dbe as DBE, conversion ) as ReturnType<Extensions['converters'][K]['converter']> & { $cursor?: string };
            if ( this.cache && !options.projection )
            {
                this.cache.set( this.cacheKey( dbe._id, 'dbe', await this.accessFilter() as Filter<WithId<DBE>> | void ), dbe );
            }
            dto.$cursor = getCursor( dbe, sort ); // TODO pozor valka klonu
            return dto;
        }));

        benchmark?.step('CONVERTER');

        if ( options.count )
        {
            Object.defineProperty(result, 'total', { value: total ?? 0, writable: false });
        }

        return prev ? result.reverse() : result;
    }

    public async aggregate<T>( pipeline: Document[], options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']> ): Promise<T[]>
    {
        let aggregationPipeline = isSet( options ) ? [ ...await this.pipeline( options!, 'dbe' ), ...( resolveBSONObject( pipeline ) as Document[] ) ] : resolveBSONObject( pipeline ) as Document[];

        flowGet( 'log' ) && DUMP( aggregationPipeline );

        if ( (flowGet( 'experimentalFlags' ) as any)?.['query-optimizer'] )
        {
            aggregationPipeline = new QueryOptimizer().optimizePipeline( aggregationPipeline );
        }

        const start = Date.now();

        const res = await this.collection.aggregate( aggregationPipeline, { collation: { locale: 'en' } } ).toArray() as T[];

        LOG_FILE( `Collection: ${this.collection.collectionName}` );
        LOG_FILE( `TIME: ${Date.now() - start} ms` );
        LOG_FILE( aggregationPipeline, true );

        return res;
    }

    public async count( pipeline: Document[], options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']> ): Promise<number>
    {
        let countPipeline = [ ...pipeline, { $count: 'count' }];

        if ( (flowGet( 'experimentalFlags' ) as any)?.['query-optimizer'] )
        {
            countPipeline = new QueryOptimizer().optimizePipeline( countPipeline );
        }

        return this.aggregate<{ count: number }>(countPipeline, options ).then( r => r[0]?.count ?? 0 );
    }

    // TODO pridat podporu ze ked vrati false tak nerobi ani query ale throwne error
    protected async accessFilter(): Promise<Filter<DBE> | void> {}

    public async resolveSmartFilter( smartFilter: {[key in PublicMethodNames<ExtractSmartFilters<Extensions>>]?: any} ): Promise<{ filter?: Filter<DBE>, pipeline?: Document[] }>
    {
        const pipeline: any[] = [];
        let filter: any = {};
        const extraFilters: any = {};

        for ( const [key, value] of Object.entries( smartFilter ) )
        {
            if ( hasPublicMethod( this.smartFilters, key ) )
            {
                const result = await (( this.smartFilters as any )[key] as SmartFilterMethod)( value );
                result.pipeline && pipeline.push( ...result.pipeline );
                result.filter && ( filter = { $and: [{ ...filter }, result.filter ].filter(f => Object.keys(f).length > 0) });
            }
            else
            {
                extraFilters[key] = value;
            }
        }

        if ( Object.keys( extraFilters ).length > 0 )
        {
            throw new Error( `Custom filter contains unsupported filters - ${JSON.stringify(extraFilters, null, 2)}` );
        }

        return { filter, pipeline };
    }

    public async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>
    {
        const result: ReturnType<ComputedPropertyMethod> = { fields: {}, pipeline: [] };

        if ( Array.isArray( properties ) )
        {
            properties = properties.reduce(
                (acc, val) => {acc[val] = null; return acc;},
                {} as any
            );
        }

        for ( const property in (properties as object) )
        {
            if ( hasPublicMethod( this.computedProperties, property ) )
            {
                const resolvedProperties: Awaited<ReturnType<ComputedPropertyMethod>> = await ( this.computedProperties as any )[property]( (properties as any)[property] );
                result.fields = { ...result.fields, ...resolvedProperties.fields };
                result.pipeline?.push( ...(resolvedProperties.pipeline || []) );
            }
        }

        return {
            fields: result.fields && Object.keys( result.fields ).length ? result.fields : null,
            pipeline: result.pipeline?.length ? result.pipeline : null
        }
    }

    public async delete( id: DTO['id'] | DBE['_id'] ): Promise<Boolean>
    {
        // TODO: do properly
        const canUpdate = await this.get( id, 'dbe' );
        if ( !canUpdate )
        {
            return false;
        }

        return ( await this.collection.deleteOne({ _id: this.dbeID( id ) as WithId<DBE>['_id'] }/*, { collation: { locale: 'en' } }*/)).deletedCount === 1;
    }

    private cacheKey( id: DTO['id'] | DBE['_id'], conversion: keyof Extensions['converters'], accessControl: Filter<WithId<DBE>> | void ): string
    {
        return objectHash({ id: this.dtoID( id ), accessControl, projection: this.converters[conversion].projection });
    }
}