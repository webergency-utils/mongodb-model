import
{
    Collection,
    Document,
    Filter,
    FindOptions,
    OptionalUnlessRequiredId,
    UpdateFilter
}
from 'mongodb';
import { AbstractBaseModel } from './base-model.js';
import { ModelCacheConfig, extractTargetIdsFromFilter } from './cache.js';
import { ModelAccessDeniedError } from './errors.js';
import { ModelMutationOperation, ObservabilityConfig } from './events.js';
import { flowGet } from './flow.js';
import { Benchmark } from './helpers/benchmark.js';
import
{
    DUMP,
    mergeComputedProperties,
    resolveBSONObject,
    toUpdateOperations
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import
{
    attachListMetadata,
    normalizeFindMatch,
    resolveCreateFromArgs
}
from './operations.js';
import { RESOLVED_ACCESS } from './symbols.js';
import
{
    ExtractComputedProperties,
    ExtractSmartFilters,
    GetManyOptions,
    GetOptions,
    ModelAggregateOptions,
    ModelCreateOptions,
    ModelDeleteOptions,
    ModelExistsOptions,
    ModelExtensions,
    ModelFindOptions,
    ModelListOptions,
    ModelStreamOptions,
    ModelUpdateOptions,
    ModelUpdateResponse,
    MongoRootDocument,
    OptimizerConfig,
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
    Extensions extends ModelExtensions<DBE, any, any> = ModelExtensions<DBE, any, any>
>
extends AbstractBaseModel<DBE, DTO, Extensions, DBE>
{
    public smartFilters?: ExtractSmartFilters<Extensions>;

    protected constructor(
        models: AbstractModels,
        collection: Collection<DBE>,
        params: Extensions & { cache?: ModelCacheConfig, optimizer?: OptimizerConfig, observability?: ObservabilityConfig }
    )
    {
        super( models, collection,
        {
            cache               : params.cache,
            converters          : params.converters,
            smartFilters        : params.smartFilters,
            computedProperties  : params.computedProperties,
            access              : params.access,
            optimizer           : params.optimizer,
            observability       : params.observability,
            idField             : '_id'
        });

        this.smartFilters = params.smartFilters;
    }

    public override dbeID( id: DTO['id'] | DBE['_id'] ): DBE['_id']
    {
        return id as DBE['_id'];
    }

    public override dtoID( dbeID: DBE['_id'] | DTO['id'] ): DTO['id']
    {
        return dbeID as DTO['id'];
    }

    protected override async pipeline<K extends keyof Extensions['converters']>(
        options: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
        conversion?: K,
        method: string = 'pipeline'
    ): Promise<Document[]>
    {
        const preResolvedAccess = ( options as any )?.[RESOLVED_ACCESS] as { denied: boolean, filter?: Filter<DBE> } | undefined;
        const { computedProperties: converterComputedProperties } = this.converters[conversion ?? 'dto'];
        const { filter, sort, limit, skip, pipeline, projection, computedProperties: optionsComputedProperties, smartFilter, access } = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>;

        const [ convProps, optProps, accessResult, resolvedSmartFilter ] = await Promise.all(
        [
            converterComputedProperties ? this.resolveComputedProperties( converterComputedProperties ) : undefined,
            optionsComputedProperties ? this.resolveComputedProperties( optionsComputedProperties ) : undefined,
            preResolvedAccess ?? this._access.resolveOrDeny({ operation: 'read', method, access }),
            smartFilter ? this.resolveSmartFilter( smartFilter ) : undefined
        ]);
        const computedProperties = ( convProps || optProps ) ? mergeComputedProperties({ '': convProps }, { '': optProps })[''] : undefined;
        const accessFilter = accessResult.denied ? ({ _id: { $exists: false } } as Filter<DBE>) : accessResult.filter;

        return this._pipelineBuilder.pipeline(
        {
            filter,
            projection,
            computedProperties,
            sort,
            limit,
            skip,
            pipeline,
            smartFilter : resolvedSmartFilter || undefined,
            accessFilter
        });
    }

    public async create( dbe: Omit<DBE, '_id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        return this.runOperation( async() =>
        {
            const access = await this._access.resolveOrDeny({ operation: 'create', method: 'create', access: options?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            const _id: DTO['id'] = id ?? await this.id();
            const start = Date.now();

            try
            {
                await this.collection.insertOne( resolveBSONObject({ ...dbe, _id: this.dbeID( _id ) }) as OptionalUnlessRequiredId<DBE> );
                this._notifySiblingCacheInvalidation();
                this._emitMutation( 'create', Date.now() - start,
                {
                    insertedCount   : 1,
                    ids             : [ _id ],
                    context         : options?.context,
                    traceID         : options?.traceID
                });
            }
            catch( e: any )
            {
                if( options?.duplicateIgnore === true && e.code === 11000 )
                {
                    const findStart = Date.now();
                    let existingDoc: Document | null;

                    try
                    {
                        existingDoc = await this.collection.findOne( e.keyValue, { projection: { _id: 1 }, collation: { locale: 'en' } });
                    }
                    catch( findErr )
                    {
                        this._emitError( findErr, 'create', Date.now() - start,
                        {
                            filter  : e.keyValue,
                            context : options.context,
                            traceID : options.traceID
                        });

                        throw findErr;
                    }

                    const findDuration = Date.now() - findStart;

                    this._emitQuery( 'get', [{ $match: e.keyValue }, { $project: { _id: 1 } }], findDuration, () => (
                    {
                        resultCount     : existingDoc ? 1 : 0,
                        internal        : true,
                        parentOperation : 'create',
                        query           : { filter: e.keyValue },
                        context         : options.context,
                        traceID         : options.traceID
                    }), { internal: true, parentOperation: 'create' });

                    const existingId = this.dtoID( existingDoc?._id );

                    this._emitMutation( 'create', Date.now() - start,
                    {
                        insertedCount   : 0,
                        ids             : [ existingId ],
                        context         : options.context,
                        traceID         : options.traceID
                    });

                    return existingId;
                }

                this._emitError( e, 'create', Date.now() - start,
                {
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }

            return _id;
        });
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
                dbe = await this._converters.convertFrom( data, fromKey );
            }
            catch( e )
            {
                this._emitError( e, 'createFrom', Date.now() - start,
                {
                    context : resolvedOptions?.context,
                    traceID : resolvedOptions?.traceID
                });

                throw e;
            }

            const resolvedId = explicitId ?? ( dbe._id !== undefined ? this.dtoID( dbe._id ) as DTO['id'] : undefined );
            const createdId = await this.create( dbe, resolvedId, resolvedOptions );

            this._emitMutation( 'createFrom', Date.now() - start,
            {
                insertedCount   : 1,
                ids             : [ createdId ],
                context         : resolvedOptions?.context,
                traceID         : resolvedOptions?.traceID
            });

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

            const access = await this._access.resolveOrDeny({ operation: 'create', method: 'createMany', access: resolvedOptions?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            if( items.length === 0 )
            {
                this._emitMutation( 'createMany', 0,
                {
                    insertedCount   : 0,
                    ids             : [],
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID
                });

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
                this._notifySiblingCacheInvalidation();
                this._emitMutation( 'createMany', Date.now() - start,
                {
                    insertedCount   : docs.length,
                    ids,
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID
                });

                return ids;
            }
            catch( e: any )
            {
                this._emitError( e, 'createMany', Date.now() - start,
                {
                    context : resolvedOptions?.context,
                    traceID : resolvedOptions?.traceID
                });

                throw e;
            }
        });
    }

    public async update( id: DTO['id'] | DBE['_id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<ModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            const match = await this._access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'update', method: 'update', access: options?.access }
            );

            if( !match )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();

            try
            {
                if( options?.documentBefore || options?.documentAfter )
                {
                    const snapshot = await this.#findOneAndUpdateWithSnapshots( match, update, options, 'update' );

                    this._invalidateCache([ id ], snapshot.matchedCount > 0 );
                    this._emitMutation( 'update', Date.now() - start,
                    {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        ids             : [ id ],
                        filter          : match,
                        context         : options.context,
                        traceID         : options.traceID
                    });

                    return {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter
                    };
                }

                const res = await this.collection.updateOne( match, toUpdateOperations( update ));

                this._invalidateCache([ id ], res.matchedCount > 0 );
                this._emitMutation( 'update', Date.now() - start,
                {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    ids             : [ id ],
                    filter          : match,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount
                };
            }
            catch( e )
            {
                this._emitError( e, 'update', Date.now() - start,
                {
                    filter  : match,
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }
        });
    }

    async #findOneAndUpdateWithSnapshots(
        match: Filter<DBE>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options: ModelUpdateOptions,
        parentOperation: 'update' | 'updateOne'
    ): Promise<{ document?: DBE, documentBefore?: DBE, documentAfter?: DBE, matchedCount: number, modifiedCount: number }>
    {
        let beforeDoc: DBE | undefined;
        let effectiveMatch = match;

        if( options.documentBefore && options.documentAfter )
        {
            const preStart = Date.now();

            beforeDoc = ( await this.collection.findOne( match, { collation: { locale: 'en' } }) as DBE | null ) || undefined;

            const preDuration = Date.now() - preStart;

            this._emitQuery( 'get', [{ $match: match }], preDuration, () => (
            {
                resultCount     : beforeDoc ? 1 : 0,
                internal        : true,
                parentOperation,
                query           : { filter: match },
                context         : options.context,
                traceID         : options.traceID
            }), { internal: true, parentOperation });

            if( !beforeDoc )
            {
                return {
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    documentBefore  : undefined,
                    documentAfter   : undefined
                };
            }

            effectiveMatch = beforeDoc._id !== undefined
                ? ({ $and: [ match, { _id: beforeDoc._id } ] } as Filter<DBE>)
                : match;
        }

        const result = await this.collection.findOneAndUpdate(
            effectiveMatch,
            toUpdateOperations( update ),
            {
                returnDocument  : options.documentAfter ? 'after' : 'before',
                collation       : { locale: 'en' }
            }
        );

        const document = ( result as DBE | null ) || undefined;
        const matchedCount = document ? 1 : 0;
        const modifiedCount = document ? 1 : 0;

        return {
            document,
            matchedCount,
            modifiedCount,
            documentBefore  : options.documentBefore
                ? ( options.documentAfter ? ( document ? beforeDoc : undefined ) : document )
                : undefined,
            documentAfter   : options.documentAfter ? document : undefined
        };
    }

    async #resolveFilterMatch(
        matchInput: Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        operation: 'update' | 'delete',
        method: ModelMutationOperation,
        options?: { access?: string, context?: Record<string, unknown>, traceID?: string },
        limit?: number
    ): Promise<{
        finalMatch  : Filter<DBE> | null
        targetIds   : string[]
        empty?      : boolean
        rawFilter   : Filter<DBE>
        smartFilter?: Record<string, unknown>
        context?    : Record<string, unknown>
        traceID?    : string
    }>
    {
        const { filter: rawFilter, smartFilter, access, context, traceID } = normalizeFindMatch<Filter<DBE>, any>( matchInput, options );
        const [ resolvedSmart, accessResult ] = await Promise.all(
        [
            smartFilter ? this.resolveSmartFilter( smartFilter ) : undefined,
            this._access.resolveOrDeny({ operation, method, access })
        ]);

        if( accessResult.denied )
        {
            return { finalMatch: null, targetIds: [], rawFilter, smartFilter, context, traceID };
        }

        const targetIds = extractTargetIdsFromFilter( matchInput, '_id', id => String( this.dtoID( id )));

        if( resolvedSmart?.pipeline?.length )
        {
            let pipeline = await this._pipelineBuilder.pipeline(
            {
                filter          : resolveBSONObject( rawFilter ) as Filter<DBE>,
                smartFilter     : resolvedSmart,
                accessFilter    : accessResult.filter,
                projection      : { _id: 1 },
                limit
            });

            pipeline = this._optimizePipeline( pipeline );

            const preStart = Date.now();
            let docs: Array<{ _id: DBE['_id'] }>;

            try
            {
                docs = await this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray() as Array<{ _id: DBE['_id'] }>;
            }
            catch( e )
            {
                this._emitError( e, method, Date.now() - preStart,
                {
                    filter      : rawFilter,
                    smartFilter,
                    query       : { filter: rawFilter, smartFilter, limit, access },
                    context,
                    traceID
                });

                throw e;
            }

            const preDuration = Date.now() - preStart;

            this._emitQuery( 'aggregate', pipeline, preDuration, () => (
            {
                resultCount     : docs.length,
                internal        : true,
                parentOperation : method,
                query           : { filter: rawFilter, smartFilter, limit, access },
                context,
                traceID
            }), { internal: true, parentOperation: method });

            const matchedDbeIds = docs.map( d => d._id ).filter( id => id !== undefined );
            const matchedDtoIds = matchedDbeIds.map( id => String( this.dtoID( id )));

            if( matchedDbeIds.length === 0 )
            {
                return { finalMatch: null, targetIds: targetIds.length > 0 ? targetIds : matchedDtoIds, empty: true, rawFilter, smartFilter, context, traceID };
            }

            const finalMatch = ( limit === 1
                ? { _id: matchedDbeIds[0] }
                : { _id: { $in: matchedDbeIds } } ) as Filter<DBE>;

            return { finalMatch, targetIds: matchedDtoIds, rawFilter, smartFilter, context, traceID };
        }

        const combinedFilter = resolvedSmart?.filter
            ? ( Object.keys( rawFilter ).length > 0 ? { $and: [ rawFilter, resolvedSmart.filter ] } : resolvedSmart.filter )
            : rawFilter;
        const resolvedBase = resolveBSONObject( combinedFilter ) as Filter<DBE>;
        const finalMatch = accessResult.filter
            ? ({ $and: [ resolvedBase, accessResult.filter ] } as Filter<DBE>)
            : resolvedBase;

        return { finalMatch, targetIds, rawFilter, smartFilter, context, traceID };
    }

    public async updateMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            if( Array.isArray( idsOrFilter ) )
            {
                const match = await this._access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'update', method: 'updateMany', access: options?.access }
                );

                if( !match )
                {
                    return { matchedCount: 0, modifiedCount: 0 };
                }

                if( idsOrFilter.length === 0 )
                {
                    this._emitMutation( 'updateMany', 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        ids             : [],
                        context         : options?.context,
                        traceID         : options?.traceID
                    });

                    return { matchedCount: 0, modifiedCount: 0 };
                }

                const start = Date.now();
                let res: { matchedCount: number, modifiedCount: number };

                try
                {
                    res = await this.collection.updateMany( match, toUpdateOperations( update ));
                }
                catch( e )
                {
                    this._emitError( e, 'updateMany', Date.now() - start,
                    {
                        filter  : match,
                        context : options?.context,
                        traceID : options?.traceID
                    });

                    throw e;
                }

                this._invalidateCache( idsOrFilter, res.matchedCount > 0 );
                this._emitMutation( 'updateMany', Date.now() - start,
                {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    ids             : idsOrFilter,
                    filter          : match,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount
                };
            }

            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID } = await this.#resolveFilterMatch(
                idsOrFilter,
                'update',
                'updateMany',
                options
            );

            if( !finalMatch )
            {
                if( empty )
                {
                    if( targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'updateMany', 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        ids             : targetIds.length > 0 ? targetIds : undefined,
                        filter          : rawFilter,
                        smartFilter,
                        context,
                        traceID
                    });
                }

                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();
            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateMany( finalMatch, toUpdateOperations( update ));
            }
            catch( e )
            {
                this._emitError( e, 'updateMany', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw e;
            }

            if( targetIds.length > 0 )
            {
                this._invalidateCache( targetIds, res.matchedCount > 0 );
            }
            else if( res.matchedCount > 0 || res.modifiedCount > 0 )
            {
                this._clearCache();
            }

            this._emitMutation( 'updateMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : targetIds.length > 0 ? targetIds : undefined,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount
            };
        });
    }

    public async updateOne(
        match: Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<ModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID } = await this.#resolveFilterMatch(
                match,
                'update',
                'updateOne',
                options,
                1
            );

            if( !finalMatch )
            {
                if( empty )
                {
                    if( targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'updateOne', 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        ids             : targetIds.length > 0 ? targetIds : undefined,
                        filter          : rawFilter,
                        smartFilter,
                        context,
                        traceID
                    });
                }

                return { matchedCount: 0, modifiedCount: 0 };
            }

            const start = Date.now();

            try
            {
                if( options?.documentBefore || options?.documentAfter )
                {
                    const snapshot = await this.#findOneAndUpdateWithSnapshots(
                        finalMatch,
                        update,
                        { ...options, context, traceID },
                        'updateOne'
                    );
                    const idsToEvict = targetIds.length > 0
                        ? targetIds
                        : ( snapshot.document?._id !== undefined ? [ String( this.dtoID( snapshot.document._id )) ] : null );

                    if( idsToEvict && idsToEvict.length > 0 )
                    {
                        this._invalidateCache( idsToEvict, snapshot.matchedCount > 0 );
                    }
                    else if( snapshot.matchedCount > 0 || snapshot.modifiedCount > 0 )
                    {
                        this._clearCache();
                    }

                    this._emitMutation( 'updateOne', Date.now() - start,
                    {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        ids             : idsToEvict ?? undefined,
                        filter          : finalMatch,
                        smartFilter,
                        context,
                        traceID
                    });

                    return {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter
                    };
                }

                const res = await this.collection.updateOne( finalMatch, toUpdateOperations( update ));

                if( targetIds.length > 0 )
                {
                    this._invalidateCache( targetIds, res.matchedCount > 0 );
                }
                else if( res.matchedCount > 0 || res.modifiedCount > 0 )
                {
                    this._clearCache();
                }

                this._emitMutation( 'updateOne', Date.now() - start,
                {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    ids             : targetIds.length > 0 ? targetIds : undefined,
                    filter          : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                return {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount
                };
            }
            catch( e )
            {
                this._emitError( e, 'updateOne', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw e;
            }
        });
    }

    public override async get<K extends keyof Extensions['converters'] = 'dto'>(
        id: DTO['id'] | DBE['_id'],
        options?: GetOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>;
    public override async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public override async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public override async get<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public override async get<K extends keyof Extensions['converters'] = 'dto'>(
        idOrIds: DTO['id'] | DBE['_id'] | Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetOptions<K> | GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<
        | Awaited<ReturnType<Extensions['converters'][K]['converter']>>
        | null
        | Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    >
    {
        return super.get( idOrIds, optionsOrConversion as any, filtered );
    }

    public override async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        options: GetManyOptions<K> & { filter: true }
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public override async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        conversion: K,
        filtered: true
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>>;
    public override async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>;
    public override async getMany<K extends keyof Extensions['converters'] = 'dto'>(
        ids: Array<DTO['id'] | DBE['_id']>,
        optionsOrConversion?: GetManyOptions<K> | K,
        filtered?: boolean
    ): Promise<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>>
    {
        return super.getMany( ids, optionsOrConversion as any, filtered );
    }

    public override async find<K extends keyof Extensions['converters']>(
        options: ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        conversion: K = 'dto' as K,
        sort?: FindOptions['sort']
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return super.find( options, conversion, sort );
    }

    public async list<K extends keyof Extensions['converters']>(
        options: ModelListOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): Promise<WithTotal<Array<Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string }>>>
    {
        return this.runOperation( async() =>
        {
            const bsonInput = this._stripObservabilityOptions( options );
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, countLimit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( bsonInput );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + String( conversion ) + ')' ) : undefined;
            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'list', access: options.access });

            if( access.denied )
            {
                return attachListMetadata([], options.count ? 0 : undefined, {});
            }

            const [ smartFilter, convProps, optProps ] = await Promise.all(
            [
                options.smartFilter ? this.resolveSmartFilter( options.smartFilter ) : undefined,
                compProps ? this.resolveComputedProperties( compProps ) : undefined,
                optionsCompProps ? this.resolveComputedProperties( optionsCompProps ) : undefined
            ]);
            const computedProperties = ( convProps || optProps ) ? mergeComputedProperties({ '': convProps }, { '': optProps })[''] : undefined;

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
                accessFilter : access.filter,
                pipeline     : options.pipeline,
                computedProperties
            };

            let [ pipeline, countPipeline ] = await Promise.all(
            [
                this._pipelineBuilder.pipeline( params ),
                options.count ? this._pipelineBuilder.count( params ) : undefined
            ]);

            pipeline = this._optimizePipeline( pipeline );
            countPipeline && ( countPipeline = this._optimizePipeline( countPipeline ));

            flowGet( 'log' ) && DUMP( pipeline );
            flowGet( 'log' ) && countPipeline && DUMP( countPipeline );

            return this._executeList( pipeline, countPipeline, options, sort, conversion, benchmark );
        });
    }

    public async *stream<K extends keyof Extensions['converters']>(
        options: ModelStreamOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        conversion: K = 'dto' as K
    ): AsyncGenerator<Awaited<ReturnType<Extensions['converters'][K]['converter']>>>
    {
        const release = this.trackOperation();

        try
        {
            const bsonInput = this._stripObservabilityOptions( options );
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( bsonInput );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            const access = await this._access.resolveOrDeny({ operation: 'read', method: 'stream', access: options.access });

            if( access.denied )
            {
                return;
            }

            const [ smartFilter, convProps, optProps ] = await Promise.all(
            [
                options.smartFilter ? this.resolveSmartFilter( options.smartFilter ) : undefined,
                compProps ? this.resolveComputedProperties( compProps ) : undefined,
                optionsCompProps ? this.resolveComputedProperties( optionsCompProps ) : undefined
            ]);
            const computedProperties = ( convProps || optProps ) ? mergeComputedProperties({ '': convProps }, { '': optProps })[''] : undefined;

            let pipeline = await this._pipelineBuilder.pipeline(
            {
                ...rest,
                filter,
                sort,
                projection,
                smartFilter,
                cursor,
                limit,
                accessFilter : access.filter,
                pipeline     : options.pipeline,
                computedProperties
            });

            pipeline = this._optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            yield* this._executeStream( pipeline, options, sort, conversion );
        }
        finally
        {
            release();
        }
    }

    public override async aggregate<T>(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<T[]>
    {
        return super.aggregate<T>( pipeline, options );
    }

    public override async count(
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>;
    public override async count(
        pipeline: Document[],
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>;
    public override async count(
        pipelineOrOptions?: Document[] | ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
        options?: ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>
    ): Promise<number>
    {
        return super.count( pipelineOrOptions as any, options );
    }

    public override async exists(
        idOrFilter?: DTO['id'] | DBE['_id'] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelExistsOptions
    ): Promise<boolean>
    {
        return super.exists( idOrFilter, options );
    }

    public override async resolveSmartFilter( smartFilter: Record<string, any> )
    {
        return super.resolveSmartFilter( smartFilter ) as Promise<{ filter?: Filter<DBE>, pipeline?: Document[] }>;
    }

    public override async resolveComputedProperties( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>
    {
        return super.resolveComputedProperties( properties ) as Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>;
    }

    public async delete( id: DTO['id'] | DBE['_id'], options?: ModelDeleteOptions ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const match = await this._access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'delete', method: 'delete', access: options?.access }
            );

            if( !match ){ return false }

            const start = Date.now();
            let res: { deletedCount: number };

            try
            {
                res = await this.collection.deleteOne( match );
            }
            catch( e )
            {
                this._emitError( e, 'delete', Date.now() - start,
                {
                    filter  : match,
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }

            this._invalidateCache([ id ], res.deletedCount > 0 );
            this._emitMutation( 'delete', Date.now() - start,
            {
                deletedCount    : res.deletedCount,
                ids             : [ id ],
                filter          : match,
                context         : options?.context,
                traceID         : options?.traceID
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
                const match = await this._access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'delete', method: 'deleteMany', access: options?.access }
                );

                if( !match ){ return 0 }

                if( idsOrFilter.length === 0 )
                {
                    this._emitMutation( 'deleteMany', 0,
                    {
                        deletedCount    : 0,
                        ids             : [],
                        context         : options?.context,
                        traceID         : options?.traceID
                    });

                    return 0;
                }

                const start = Date.now();
                let res: { deletedCount: number };

                try
                {
                    res = await this.collection.deleteMany( match );
                }
                catch( e )
                {
                    this._emitError( e, 'deleteMany', Date.now() - start,
                    {
                        filter  : match,
                        context : options?.context,
                        traceID : options?.traceID
                    });

                    throw e;
                }

                this._invalidateCache( idsOrFilter, res.deletedCount > 0 );
                this._emitMutation( 'deleteMany', Date.now() - start,
                {
                    deletedCount    : res.deletedCount,
                    ids             : idsOrFilter,
                    filter          : match,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return res.deletedCount;
            }

            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID } = await this.#resolveFilterMatch(
                idsOrFilter,
                'delete',
                'deleteMany',
                options
            );

            if( !finalMatch )
            {
                if( empty )
                {
                    if( targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'deleteMany', 0,
                    {
                        deletedCount    : 0,
                        ids             : targetIds.length > 0 ? targetIds : undefined,
                        filter          : rawFilter,
                        smartFilter,
                        context,
                        traceID
                    });
                }

                return 0;
            }

            const start = Date.now();
            let res: { deletedCount: number };

            try
            {
                res = await this.collection.deleteMany( finalMatch );
            }
            catch( e )
            {
                this._emitError( e, 'deleteMany', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw e;
            }

            if( targetIds.length > 0 )
            {
                this._invalidateCache( targetIds, res.deletedCount > 0 );
            }
            else if( res.deletedCount > 0 )
            {
                this._clearCache();
            }

            this._emitMutation( 'deleteMany', Date.now() - start,
            {
                deletedCount    : res.deletedCount,
                ids             : targetIds.length > 0 ? targetIds : undefined,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return res.deletedCount;
        });
    }
}
