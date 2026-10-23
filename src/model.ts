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
    LOG_FILE,
    mergeComputedProperties,
    resolveBSONObject,
    toUpdateOperations
}
from './helpers/index.js';
import { getCursor } from './helpers/mongo.js';
import { AbstractModels } from './models.js';
import
{
    attachCursorToItem,
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
            this.resolveComputedProperties( converterComputedProperties ),
            this.resolveComputedProperties( optionsComputedProperties ),
            preResolvedAccess ?? this._access.resolveOrDeny({ operation: 'read', method, access }),
            smartFilter ? this.resolveSmartFilter( smartFilter ) : undefined
        ]);
        const computedProperties = mergeComputedProperties({ '': convProps }, { '': optProps })[''];
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
        const release = this.trackOperation();

        try
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
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                            filter : e.keyValue,
                            ...( options?.context !== undefined ? { context: options.context } : {} ),
                            ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                    }), { internal: true, parentOperation: 'create' });

                    const existingId = this.dtoID( existingDoc?._id );

                    this._emitMutation( 'create', Date.now() - start,
                    {
                        insertedCount   : 0,
                        ids             : [ existingId ],
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                    });

                    return existingId;
                }

                this._emitError( e, 'create', Date.now() - start,
                {
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                });

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
                dbe = await this._converters.convertFrom( data, fromKey );
            }
            catch( e )
            {
                this._emitError( e, 'createFrom', Date.now() - start,
                {
                    ...( resolvedOptions?.context !== undefined ? { context: resolvedOptions.context } : {} ),
                    ...( resolvedOptions?.traceID !== undefined ? { traceID: resolvedOptions.traceID } : {} )
                });

                throw e;
            }

            const resolvedId = explicitId ?? ( dbe._id !== undefined ? this.dtoID( dbe._id ) as DTO['id'] : undefined );
            const createdId = await this.create( dbe, resolvedId, resolvedOptions );

            this._emitMutation( 'createFrom', Date.now() - start,
            {
                insertedCount   : 1,
                ids             : [ createdId ],
                ...( resolvedOptions?.context !== undefined ? { context: resolvedOptions.context } : {} ),
                ...( resolvedOptions?.traceID !== undefined ? { traceID: resolvedOptions.traceID } : {} )
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
                    ...( resolvedOptions?.context !== undefined ? { context: resolvedOptions.context } : {} ),
                    ...( resolvedOptions?.traceID !== undefined ? { traceID: resolvedOptions.traceID } : {} )
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
                    ...( resolvedOptions?.context !== undefined ? { context: resolvedOptions.context } : {} ),
                    ...( resolvedOptions?.traceID !== undefined ? { traceID: resolvedOptions.traceID } : {} )
                });

                return ids;
            }
            catch( e: any )
            {
                this._emitError( e, 'createMany', Date.now() - start,
                {
                    ...( resolvedOptions?.context !== undefined ? { context: resolvedOptions.context } : {} ),
                    ...( resolvedOptions?.traceID !== undefined ? { traceID: resolvedOptions.traceID } : {} )
                });

                throw e;
            }
        });
    }

    public async update( id: DTO['id'] | DBE['_id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<ModelUpdateResponse<DBE>>
    {
        const release = this.trackOperation();

        try
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
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                    filter : match,
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                });

                throw e;
            }
        }
        finally
        {
            release();
        }
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
                ...( options.context !== undefined ? { context: options.context } : {} ),
                ...( options.traceID !== undefined ? { traceID: options.traceID } : {} )
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
        targetIds   : string[] | null
        empty?      : boolean
        rawFilter   : Filter<DBE>
        smartFilter?: Record<string, unknown>
        context?    : Record<string, unknown>
        traceID?    : string
    }>
    {
        const { filter: rawFilter, smartFilter, access, context, traceID } = normalizeFindMatch<Filter<DBE>, any>( matchInput, options );
        const targetIds = extractTargetIdsFromFilter( matchInput, '_id', id => String( this.dtoID( id )));
        const resolvedSmart = smartFilter ? await this.resolveSmartFilter( smartFilter ) : undefined;

        if( resolvedSmart?.pipeline?.length )
        {
            const accessResult = await this._access.resolveOrDeny({ operation, method, access });

            if( accessResult.denied )
            {
                return { finalMatch: null, targetIds, rawFilter, smartFilter, context, traceID };
            }

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
                    filter : rawFilter,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    query  :
                    {
                        filter : rawFilter,
                        ...( smartFilter !== undefined ? { smartFilter } : {} ),
                        ...( limit !== undefined ? { limit } : {} ),
                        ...( access !== undefined ? { access } : {} )
                    },
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                });

                throw e;
            }

            const preDuration = Date.now() - preStart;

            this._emitQuery( 'aggregate', pipeline, preDuration, () => (
            {
                resultCount     : docs.length,
                internal        : true,
                parentOperation : method,
                query           :
                {
                    filter : rawFilter,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    ...( limit !== undefined ? { limit } : {} ),
                    ...( access !== undefined ? { access } : {} )
                },
                ...( context !== undefined ? { context } : {} ),
                ...( traceID !== undefined ? { traceID } : {} )
            }), { internal: true, parentOperation: method });

            const matchedDbeIds = docs.map( d => d._id ).filter( id => id !== undefined );
            const matchedDtoIds = matchedDbeIds.map( id => String( this.dtoID( id )));

            if( matchedDbeIds.length === 0 )
            {
                return { finalMatch: null, targetIds: targetIds ?? matchedDtoIds, empty: true, rawFilter, smartFilter, context, traceID };
            }

            const finalMatch = ( limit === 1
                ? { _id: matchedDbeIds[0] }
                : { _id: { $in: matchedDbeIds } } ) as Filter<DBE>;

            return { finalMatch, targetIds: matchedDtoIds, rawFilter, smartFilter, context, traceID };
        }

        const combinedFilter = resolvedSmart?.filter
            ? ( Object.keys( rawFilter ).length > 0 ? { $and: [ rawFilter, resolvedSmart.filter ] } : resolvedSmart.filter )
            : rawFilter;

        const finalMatch = await this._access.match(
            resolveBSONObject( combinedFilter ) as Filter<DBE>,
            { operation, method, access }
        );

        return { finalMatch, targetIds, rawFilter, smartFilter, context, traceID };
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
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                        filter : match,
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                    if( targetIds && targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'updateMany', 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        ids             : targetIds ?? undefined,
                        filter          : rawFilter,
                        ...( smartFilter !== undefined ? { smartFilter } : {} ),
                        ...( context !== undefined ? { context } : {} ),
                        ...( traceID !== undefined ? { traceID } : {} )
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
                    filter : finalMatch,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                });

                throw e;
            }

            if( targetIds && targetIds.length > 0 )
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
                ids             : targetIds ?? undefined,
                filter          : finalMatch,
                ...( smartFilter !== undefined ? { smartFilter } : {} ),
                ...( context !== undefined ? { context } : {} ),
                ...( traceID !== undefined ? { traceID } : {} )
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
                    if( targetIds && targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'updateOne', 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        ids             : targetIds ?? undefined,
                        filter          : rawFilter,
                        ...( smartFilter !== undefined ? { smartFilter } : {} ),
                        ...( context !== undefined ? { context } : {} ),
                        ...( traceID !== undefined ? { traceID } : {} )
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
                    const idsToEvict = targetIds && targetIds.length > 0
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
                        ...( smartFilter !== undefined ? { smartFilter } : {} ),
                        ...( context !== undefined ? { context } : {} ),
                        ...( traceID !== undefined ? { traceID } : {} )
                    });

                    return {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter
                    };
                }

                const res = await this.collection.updateOne( finalMatch, toUpdateOperations( update ));

                if( targetIds && targetIds.length > 0 )
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
                    ids             : targetIds ?? undefined,
                    filter          : finalMatch,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
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
                    filter : finalMatch,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
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
        const release = this.trackOperation();

        try
        {
            const { context, traceID } = options;
            const bsonInput = ( context !== undefined || traceID !== undefined )
                ? (({ context: _c, traceID: _t, ...restOpts }) => restOpts )( options )
                : options;
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, countLimit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( bsonInput );
            const prev = cursor?.startsWith( 'prev:' );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            const benchmark = flowGet( 'benchmark' ) ? new Benchmark( this.constructor.name + ':list(' + String( conversion ) + ')' ) : undefined;

            let accessFilter: Filter<DBE> | undefined;

            try
            {
                accessFilter = await this._access.resolve({ operation: 'read', method: 'list', access: options.access });
            }
            catch( e )
            {
                if( e instanceof ModelAccessDeniedError )
                {
                    return attachListMetadata([], options.count ? 0 : undefined, {});
                }

                throw e;
            }

            const [ smartFilter, convProps, optProps ] = await Promise.all(
            [
                options.smartFilter ? this.resolveSmartFilter( options.smartFilter ) : undefined,
                this.resolveComputedProperties( compProps ),
                this.resolveComputedProperties( optionsCompProps )
            ]);
            const computedProperties = mergeComputedProperties({ '': convProps }, { '': optProps })[''];

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
                this._pipelineBuilder.pipeline( params ),
                options.count ? this._pipelineBuilder.count( params ) : undefined
            ]);

            pipeline = this._optimizePipeline( pipeline );
            countPipeline && ( countPipeline = this._optimizePipeline( countPipeline ));

            flowGet( 'log' ) && DUMP( pipeline );
            flowGet( 'log' ) && countPipeline && DUMP( countPipeline );

            const start = Date.now();
            let queryDuration = 0;
            let entries: Document[];
            let total: number | undefined;

            try
            {
                [ entries, total ] = await Promise.all(
                [
                    this.collection.aggregate( pipeline, { collation: { locale: 'en' } }).toArray().then( r =>
                    {
                        queryDuration = Date.now() - start;

                        LOG_FILE( `Collection: ${this._collectionLabel}` );
                        LOG_FILE( `TIME: ${queryDuration} ms` );
                        LOG_FILE( pipeline, true );

                        return r;
                    }),
                    options.count ? this.collection.aggregate( countPipeline, { collation: { locale: 'en' } }).toArray().then( r =>
                    {
                        const duration = Date.now() - start;

                        LOG_FILE( `Collection: ${this._collectionLabel}` );
                        LOG_FILE( `TIME: ${duration} ms` );
                        LOG_FILE( countPipeline, true );
                        this._emitQuery( 'count', countPipeline!, duration, () => (
                        {
                            resultCount : r[0]?.count ?? 0,
                            query       : this._buildListQueryContext( options, sort ),
                            ...( context !== undefined ? { context } : {} ),
                            ...( traceID !== undefined ? { traceID } : {} )
                        }));

                        return r[0]?.count ?? 0;
                    }) : undefined
                ]);
            }
            catch( e )
            {
                this._emitError( e, 'list', Date.now() - start,
                {
                    ...( options.filter !== undefined ? { filter: options.filter } : {} ),
                    ...( options.smartFilter !== undefined ? { smartFilter: options.smartFilter as Record<string, unknown> } : {} ),
                    query : this._buildListQueryContext( options, sort ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                });

                throw e;
            }

            benchmark?.step( 'QUERY' );

            let orderedEntries = prev ? [ ...entries ].reverse() : entries;

            const convStart = Date.now();
            const items = await Promise.all( orderedEntries.map( async( dbe ) =>
            {
                const dto = await this._converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>> & { $cursor?: string };

                return attachCursorToItem( dto, dbe, sort );
            }));
            const converterDuration = Date.now() - convStart;

            this._emitQuery( 'list', pipeline, queryDuration, () => (
            {
                converterDuration,
                resultCount : items.length,
                conversion  : String( conversion ),
                query       : this._buildListQueryContext( options, sort ),
                ...( context !== undefined ? { context } : {} ),
                ...( traceID !== undefined ? { traceID } : {} )
            }));

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
            const { context, traceID } = options;
            const bsonInput = ( context !== undefined || traceID !== undefined )
                ? (({ context: _c, traceID: _t, ...restOpts }) => restOpts )( options )
                : options;
            const { projection: convProjection, computedProperties: compProps } = this.converters[conversion];
            let { filter = {}, sort = { _id: 1 }, cursor, limit, projection = convProjection, computedProperties: optionsCompProps, smartFilter: _rawSmartFilter, ...rest } = resolveBSONObject( bsonInput );
            const prev = cursor?.startsWith( 'prev:' );

            if( !sort._id )
            {
                sort = { ...sort, _id: 1 };
            }

            let accessFilter: Filter<DBE> | undefined;

            try
            {
                accessFilter = await this._access.resolve({ operation: 'read', method: 'stream', access: options.access });
            }
            catch( e )
            {
                if( e instanceof ModelAccessDeniedError )
                {
                    return;
                }

                throw e;
            }

            const [ smartFilter, convProps, optProps ] = await Promise.all(
            [
                options.smartFilter ? this.resolveSmartFilter( options.smartFilter ) : undefined,
                this.resolveComputedProperties( compProps ),
                this.resolveComputedProperties( optionsCompProps )
            ]);
            const computedProperties = mergeComputedProperties({ '': convProps }, { '': optProps })[''];

            let pipeline = await this._pipelineBuilder.pipeline(
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

            pipeline = this._optimizePipeline( pipeline );

            flowGet( 'log' ) && DUMP( pipeline );

            const start = Date.now();
            const emitStreamQuery = ( duration: number ) =>
            {
                this._emitQuery( 'stream', pipeline, duration, () => (
                {
                    conversion  : String( conversion ),
                    query       : this._buildListQueryContext( options, sort ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                }));
            };

            try
            {
                const cursorDocs = this.collection.aggregate( pipeline, { collation: { locale: 'en' } });

                if( prev )
                {
                    const entries = await cursorDocs.toArray();
                    const duration = Date.now() - start;

                    LOG_FILE( `Collection: ${this._collectionLabel}` );
                    LOG_FILE( `TIME: ${duration} ms` );
                    LOG_FILE( pipeline, true );
                    emitStreamQuery( duration );

                    for( const dbe of entries.reverse() )
                    {
                        yield await this._converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
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

                        LOG_FILE( `Collection: ${this._collectionLabel}` );
                        LOG_FILE( `TIME: ${duration} ms` );
                        LOG_FILE( pipeline, true );
                        emitStreamQuery( duration );
                    }

                    yield await this._converters.convert( dbe as DBE, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>;
                }

                if( !emitted )
                {
                    emitStreamQuery( Date.now() - start );
                }
            }
            catch( e )
            {
                this._emitError( e, 'stream', Date.now() - start,
                {
                    ...( options.filter !== undefined ? { filter: options.filter } : {} ),
                    ...( options.smartFilter !== undefined ? { smartFilter: options.smartFilter as Record<string, unknown> } : {} ),
                    query : this._buildListQueryContext( options, sort ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                });

                throw e;
            }
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
                    filter : match,
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                });

                throw e;
            }

            this._invalidateCache([ id ], res.deletedCount > 0 );
            this._emitMutation( 'delete', Date.now() - start,
            {
                deletedCount    : res.deletedCount,
                ids             : [ id ],
                filter          : match,
                ...( options?.context !== undefined ? { context: options.context } : {} ),
                ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                        filter : match,
                        ...( options?.context !== undefined ? { context: options.context } : {} ),
                        ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
                    });

                    throw e;
                }

                this._invalidateCache( idsOrFilter, res.deletedCount > 0 );
                this._emitMutation( 'deleteMany', Date.now() - start,
                {
                    deletedCount    : res.deletedCount,
                    ids             : idsOrFilter,
                    filter          : match,
                    ...( options?.context !== undefined ? { context: options.context } : {} ),
                    ...( options?.traceID !== undefined ? { traceID: options.traceID } : {} )
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
                    if( targetIds && targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( 'deleteMany', 0,
                    {
                        deletedCount    : 0,
                        ids             : targetIds ?? undefined,
                        filter          : rawFilter,
                        ...( smartFilter !== undefined ? { smartFilter } : {} ),
                        ...( context !== undefined ? { context } : {} ),
                        ...( traceID !== undefined ? { traceID } : {} )
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
                    filter : finalMatch,
                    ...( smartFilter !== undefined ? { smartFilter } : {} ),
                    ...( context !== undefined ? { context } : {} ),
                    ...( traceID !== undefined ? { traceID } : {} )
                });

                throw e;
            }

            if( targetIds && targetIds.length > 0 )
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
                ids             : targetIds ?? undefined,
                filter          : finalMatch,
                ...( smartFilter !== undefined ? { smartFilter } : {} ),
                ...( context !== undefined ? { context } : {} ),
                ...( traceID !== undefined ? { traceID } : {} )
            });

            return res.deletedCount;
        });
    }
}
