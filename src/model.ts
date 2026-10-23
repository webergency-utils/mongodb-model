import
{
    AnyBulkWriteOperation,
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
import { ModelAccessDeniedError, ModelIdCollisionError, ModelVersionConflictError } from './errors.js';
import { ModelMutationOperation, ObservabilityConfig } from './events.js';
import
{
    isForeignObjectIdLike,
    isLibraryObjectId,
    mergeComputedProperties,
    resolveBSONObject,
    toUpdateOperations
}
from './helpers/index.js';
import { AbstractModels } from './models.js';
import
{
    buildRestoreUpdate,
    buildSoftDeleteUpdate,
    combineMongoFilters,
    isIdDuplicateKeyError,
    normalizeCursorOption,
    normalizeFindMatch,
    resolveCreateFromArgs
}
from './operations.js';
import { INCLUDE_DELETED, RESOLVED_ACCESS } from './symbols.js';
import
{
    ExtractComputedProperties,
    ExtractSmartFilters,
    ModelAggregateOptions,
    ModelBulkWriteOperation,
    ModelBulkWriteOptions,
    ModelBulkWriteResult,
    ModelCreateOptions,
    ModelDeleteOptions,
    ModelExtensions,
    ModelFindOneAndDeleteOptions,
    ModelFindOneAndUpdateOptions,
    ModelFindOptions,
    ModelHooksConfig,
    ModelIdConfig,
    ModelIndexDefinition,
    ModelListOptions,
    ModelRelationsConfig,
    ModelSoftDeleteConfig,
    ModelStreamOptions,
    ModelTimestampsConfig,
    ModelUpdateOptions,
    ModelUpdateResponse,
    ModelUpsertOptions,
    ModelUpsertResponse,
    ModelValidatorConfig,
    ModelVersioningConfig,
    MongoRootDocument,
    OptimizerConfig
}
from './types/external.js';
import { SyncComputedPropertyMethod } from './types/internal.js';

/**
 * Abstract model for root-level MongoDB documents.
 */
export abstract class AbstractModel
<
    DBE extends MongoRootDocument,
    DTO extends Document,
    Extensions extends ModelExtensions<DBE, any, any> = ModelExtensions<DBE, any, any>
>
extends AbstractBaseModel<
    DBE,
    DTO,
    Extensions,
    DBE,
    DBE,
    DTO['id'] | DBE['_id'],
    ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
    ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']>,
    DTO['id'] | DBE['_id'] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
    Awaited<ReturnType<SyncComputedPropertyMethod>>,
    ModelListOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
    ModelStreamOptions<DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
>
{
    public smartFilters?: ExtractSmartFilters<Extensions>;

    protected constructor(
        models: AbstractModels,
        collection: Collection<DBE>,
        params: Extensions & {
            cache?          : ModelCacheConfig
            optimizer?      : OptimizerConfig
            observability?  : ObservabilityConfig
            validate?       : ModelValidatorConfig<DBE>
            indexes?        : ModelIndexDefinition<DBE>[]
            timestamps?     : ModelTimestampsConfig
            softDelete?     : ModelSoftDeleteConfig
            versioning?     : ModelVersioningConfig
            relations?      : ModelRelationsConfig<DBE>
            hooks?          : ModelHooksConfig<DBE>
            id?             : ModelIdConfig
        }
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
            validate            : params.validate,
            indexes             : params.indexes,
            timestamps          : params.timestamps,
            softDelete          : params.softDelete,
            versioning          : params.versioning,
            relations           : params.relations,
            hooks               : params.hooks,
            id                  : params.id,
            idField             : '_id'
        });

        this.smartFilters = params.smartFilters;
    }

    #versionFilter( expectedVersion?: number ): Filter<DBE> | undefined
    {
        if( expectedVersion === undefined )
        {
            return undefined;
        }

        const field = this._versioning?.field ?? 'version';

        return { [field]: expectedVersion } as Filter<DBE>;
    }

    async #assertNoVersionConflict(
        _baseMatchWithoutVersion: Filter<DBE>,
        expectedVersion: number | undefined,
        _session?: ModelUpdateOptions['session'],
        id?: unknown
    ): Promise<void>
    {
        throw new ModelVersionConflictError( this, id, expectedVersion! );
    }

    async #prepareUpsertSetOnInsert(
        updateOps: Record<string, any>,
        finalMatch: Filter<DBE>,
        targetIds: string[],
        explicitId?: DTO['id'] | DBE['_id']
    ): Promise<DTO['id']>
    {
        const generatedDtoId = ( explicitId ?? ( targetIds.length === 1 ? targetIds[0] : await this.id())) as DTO['id'];
        const setOnInsert: Record<string, any> = { ...( updateOps.$setOnInsert ?? {} ) };

        if( setOnInsert._id === undefined && updateOps.$set?._id === undefined && ( finalMatch as any )._id === undefined )
        {
            setOnInsert._id = this.dbeID( generatedDtoId );
        }

        if( this._softDelete && setOnInsert[this._softDelete.field] === undefined && updateOps.$set?.[this._softDelete.field] === undefined )
        {
            setOnInsert[this._softDelete.field] = this._softDelete.field === this._softDelete.deletedAtField ? null : false;
        }

        if( Object.keys( setOnInsert ).length > 0 )
        {
            updateOps.$setOnInsert = setOnInsert;
        }

        return generatedDtoId;
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
        const resolved = resolveBSONObject( options ) as ModelAggregateOptions<DBE, Extensions['smartFilters'], Extensions['computedProperties']> & { sample?: number };
        const { filter, sort, limit, skip, sample, pipeline, projection, computedProperties: optionsComputedProperties, smartFilter, access } = resolved;
        const cursor = normalizeCursorOption( resolved );
        const includeDeleted = Boolean( resolved.includeDeleted || ( options as any )?.[INCLUDE_DELETED] );

        const [ convProps, optProps, accessResult, resolvedSmartFilter ] = await Promise.all(
        [
            ( method !== 'listCount' && converterComputedProperties ) ? this.resolveComputedProperties( converterComputedProperties ) : undefined,
            optionsComputedProperties ? this.resolveComputedProperties( optionsComputedProperties ) : undefined,
            preResolvedAccess ?? this._access.resolveOrDeny({ operation: 'read', method, access }),
            smartFilter ? this.resolveSmartFilter( smartFilter ) : undefined
        ]);
        const computedProperties = ( convProps || optProps ) ? mergeComputedProperties({ '': convProps }, { '': optProps })[''] : undefined;
        const softDeleteFilter = this._softDeleteFilter( includeDeleted ) as Filter<DBE> | undefined;
        const accessFilter = accessResult.denied
            ? ({ _id: { $exists: false } } as Filter<DBE>)
            : combineMongoFilters( accessResult.filter, softDeleteFilter );

        return this._pipelineBuilder.pipeline(
        {
            filter,
            projection,
            computedProperties,
            sort,
            cursor,
            limit,
            skip,
            sample,
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

            const start = Date.now();
            const isAutoId = id === undefined;
            const { maxRetries, verifyUniqueness } = this._resolveIdRetryOptions( options );
            const usedIds = isAutoId ? new Set<string>() : undefined;
            const generated = isAutoId
                ? await this._tryGenerateUniqueId( usedIds, maxRetries, verifyUniqueness, options?.session )
                : { id: id as DTO['id'], collided: false };
            let _id: DTO['id'] = generated.id;

            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            let initialDoc = this._applyCreateTimestamps({ ...dbe, _id: this.dbeID( _id ) }) as Partial<DBE>;

            if( this._softDelete && ( initialDoc as any )[this._softDelete.field] === undefined )
            {
                initialDoc = { ...initialDoc, [this._softDelete.field]: null };
            }

            const hookedData = await this._runBeforeHook( 'beforeCreate',
            {
                operation   : 'create',
                method      : 'create',
                id          : _id,
                data        : initialDoc,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );

            const validated = await this._validateWrite(
                { ...hookedData, _id: this.dbeID( _id ) } as Partial<DBE>,
                { operation: 'create', method: 'create', id: _id },
                start,
                options
            );

            try
            {
                if( generated.collided )
                {
                    throw new ModelIdCollisionError( this, _id, maxRetries + 1 );
                }
                for( let attempt = 0; ; attempt++ )
                {
                    try
                    {
                        await this.collection.insertOne(
                            resolveBSONObject({ ...validated, _id: this.dbeID( _id ) }) as OptionalUnlessRequiredId<DBE>,
                            ...this._sessionArg( options?.session )
                        );

                        break;
                    }
                    catch( insertErr: any )
                    {
                        if( isAutoId && options?.duplicateIgnore !== true && isIdDuplicateKeyError( insertErr, '_id' ) )
                        {
                            if( attempt < maxRetries )
                            {
                                const nextGen = await this._tryGenerateUniqueId( usedIds, maxRetries - attempt - 1, verifyUniqueness, options?.session );

                                _id = nextGen.id;

                                if( !nextGen.collided )
                                {
                                    continue;
                                }
                            }

                            throw new ModelIdCollisionError( this, _id, maxRetries + 1, undefined, insertErr instanceof Error ? insertErr : undefined );
                        }

                        throw insertErr;
                    }
                }

                this._notifySiblingCacheInvalidation();
                await this._runAfterHook( 'afterCreate',
                {
                    operation       : 'create',
                    method          : 'create',
                    id              : _id,
                    data            : { ...validated, _id: this.dbeID( _id ) } as Partial<DBE>,
                    insertedCount   : 1,
                    context         : options?.context,
                    traceID         : options?.traceID,
                    session
                }, pendingAfterCommit );
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
                        existingDoc = await this.collection.findOne(
                            e.keyValue,
                            this._withSession({ projection: { _id: 1 }, collation: { locale: 'en' } }, options.session )
                        );
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
            const validatedDocs: Array<Partial<DBE>> = [];
            const autoIndices: number[] = [];
            const usedIds = new Set<string>();
            const { maxRetries, verifyUniqueness } = this._resolveIdRetryOptions( resolvedOptions );
            const start = Date.now();
            const now = new Date();
            const session = this._resolveSession( resolvedOptions?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            let collidedId: DTO['id'] | undefined;
            let hasCollision = false;

            for( let i = 0; i < items.length; i++ )
            {
                const item = items[i];
                const isAutoId = explicitIds?.[i] === undefined && item._id === undefined;
                let dtoId: DTO['id'];

                if( isAutoId )
                {
                    const generated = await this._tryGenerateUniqueId( usedIds, maxRetries, verifyUniqueness, resolvedOptions?.session );

                    dtoId = generated.id;

                    if( generated.collided && !hasCollision )
                    {
                        hasCollision = true;
                        collidedId = dtoId;
                    }

                    autoIndices.push( i );
                }
                else
                {
                    dtoId = this.dtoID( explicitIds?.[i] ?? item._id ) as DTO['id'];
                    usedIds.add( String( dtoId ));
                }

                let initialDoc = this._applyCreateTimestamps({ ...item, _id: this.dbeID( dtoId ) }, now ) as Partial<DBE>;

                if( this._softDelete && ( initialDoc as any )[this._softDelete.field] === undefined )
                {
                    initialDoc = { ...initialDoc, [this._softDelete.field]: null };
                }

                const hookedData = await this._runBeforeHook( 'beforeCreate',
                {
                    operation   : 'create',
                    method      : 'createMany',
                    id          : dtoId,
                    data        : initialDoc,
                    context     : resolvedOptions?.context,
                    traceID     : resolvedOptions?.traceID,
                    session
                }, pendingAfterCommit );

                const validated = await this._validateWrite(
                    { ...hookedData, _id: this.dbeID( dtoId ) } as Partial<DBE>,
                    { operation: 'create', method: 'createMany', id: dtoId },
                    start,
                    resolvedOptions
                );

                ids.push( dtoId );
                validatedDocs.push( validated );
                docs.push( resolveBSONObject({ ...validated, _id: this.dbeID( dtoId ) }) as OptionalUnlessRequiredId<DBE> );
            }

            try
            {
                if( hasCollision )
                {
                    throw new ModelIdCollisionError( this, collidedId, maxRetries + 1 );
                }
                for( let attempt = 0; ; attempt++ )
                {
                    try
                    {
                        await this.collection.insertMany( docs, ...this._sessionArg( resolvedOptions?.session ));

                        break;
                    }
                    catch( insertErr: any )
                    {
                        if( autoIndices.length > 0 && isIdDuplicateKeyError( insertErr, '_id' ) )
                        {
                            if( attempt < maxRetries )
                            {
                                let retryCollided = false;

                                for( const idx of autoIndices )
                                {
                                    const nextGen = await this._tryGenerateUniqueId( usedIds, maxRetries - attempt - 1, verifyUniqueness, resolvedOptions?.session );

                                    ids[idx] = nextGen.id;
                                    docs[idx] = resolveBSONObject({ ...validatedDocs[idx], _id: this.dbeID( nextGen.id ) }) as OptionalUnlessRequiredId<DBE>;

                                    if( nextGen.collided )
                                    {
                                        retryCollided = true;
                                    }
                                }

                                if( !retryCollided )
                                {
                                    continue;
                                }
                            }

                            throw new ModelIdCollisionError( this, ids[autoIndices[0]], maxRetries + 1, undefined, insertErr instanceof Error ? insertErr : undefined );
                        }

                        throw insertErr;
                    }
                }

                this._notifySiblingCacheInvalidation();
                await this._runAfterHook( 'afterCreate',
                {
                    operation       : 'create',
                    method          : 'createMany',
                    ids,
                    insertedCount   : docs.length,
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID,
                    session
                }, pendingAfterCommit );
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
            const baseMatch = await this._access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'update', method: 'update', access: options?.access }
            );

            if( !baseMatch )
            {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            const baseMatchWithSoftDelete = combineMongoFilters( baseMatch, this._softDeleteFilter( false ) as Filter<DBE> | undefined )!;
            const match = combineMongoFilters( baseMatchWithSoftDelete, this.#versionFilter( options?.expectedVersion ))!;
            const start = Date.now();
            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any> );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'update',
                id,
                filter      : match,
                update      : timestampedUpdate,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );

            const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'update', id },
                start,
                options,
                match
            ));

            try
            {
                if( options?.documentBefore || options?.documentAfter )
                {
                    const snapshot = await this.#findOneAndUpdateWithSnapshots( match, validatedUpdate, options, 'update' );

                    if( snapshot.matchedCount === 0 && options?.expectedVersion !== undefined )
                    {
                        await this.#assertNoVersionConflict( baseMatchWithSoftDelete, options.expectedVersion, options.session, id );
                    }

                    this._invalidateCache([ id ], snapshot.matchedCount > 0 );
                    await this._runAfterHook( 'afterUpdate',
                    {
                        operation       : 'update',
                        method          : 'update',
                        id,
                        filter          : match,
                        update          : validatedUpdate as Document,
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter,
                        context         : options.context,
                        traceID         : options.traceID,
                        session
                    }, pendingAfterCommit );
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

                const res = await this.collection.updateOne(
                    match,
                    toUpdateOperations( validatedUpdate ),
                    ...this._sessionArg( options?.session )
                );

                if( res.matchedCount === 0 && options?.expectedVersion !== undefined )
                {
                    await this.#assertNoVersionConflict( baseMatchWithSoftDelete, options.expectedVersion, options.session, id );
                }

                this._invalidateCache([ id ], res.matchedCount > 0 );
                await this._runAfterHook( 'afterUpdate',
                {
                    operation       : 'update',
                    method          : 'update',
                    id,
                    filter          : match,
                    update          : validatedUpdate as Document,
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    context         : options?.context,
                    traceID         : options?.traceID,
                    session
                }, pendingAfterCommit );
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
        options: ModelUpdateOptions & { upsert?: boolean },
        parentOperation: 'update' | 'updateOne' | 'upsert'
    ): Promise<{ document?: DBE, documentBefore?: DBE, documentAfter?: DBE, matchedCount: number, modifiedCount: number, upsertedCount: number, upsertedId?: DTO['id'] }>
    {
        let beforeDoc: DBE | undefined;
        let effectiveMatch = match;

        if( options.documentBefore && options.documentAfter )
        {
            const preStart = Date.now();

            beforeDoc = ( await this.collection.findOne(
                match,
                this._withSession({ collation: { locale: 'en' } }, options.session )
            ) as DBE | null ) || undefined;

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

            if( !beforeDoc && !options.upsert )
            {
                return {
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    upsertedCount   : 0,
                    documentBefore  : undefined,
                    documentAfter   : undefined
                };
            }

            if( beforeDoc && beforeDoc._id !== undefined )
            {
                effectiveMatch = ({ $and: [ match, { _id: beforeDoc._id } ] } as Filter<DBE>);
            }
        }

        const result = await this.collection.findOneAndUpdate(
            effectiveMatch,
            toUpdateOperations( update ),
            this._withSession(
            {
                returnDocument  : options.documentAfter ? 'after' : 'before',
                ...( options.upsert ? { upsert: true } : {} ),
                collation       : { locale: 'en' }
            }, options.session )
        );

        const document = ( result as DBE | null ) || undefined;
        const wasInserted = Boolean( options.upsert && options.documentBefore && options.documentAfter && !beforeDoc && document );
        const matchedCount = wasInserted ? 0 : ( document ? 1 : 0 );
        const modifiedCount = wasInserted ? 0 : ( document ? 1 : 0 );
        const upsertedCount = wasInserted ? 1 : 0;

        return {
            document,
            matchedCount,
            modifiedCount,
            upsertedCount,
            upsertedId      : wasInserted && document?._id !== undefined ? this.dtoID( document._id ) : undefined,
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
        options?: { access?: string, context?: Record<string, unknown>, traceID?: string, session?: ModelUpdateOptions['session'], includeDeleted?: boolean },
        limit?: number,
        sort?: FindOptions['sort']
    ): Promise<{
        finalMatch  : Filter<DBE> | null
        targetIds   : string[]
        empty?      : boolean
        rawFilter   : Filter<DBE>
        smartFilter?: Record<string, unknown>
        context?    : Record<string, unknown>
        traceID?    : string
        session?    : ModelUpdateOptions['session']
    }>
    {
        const { filter: rawFilter, smartFilter, access, context, traceID, session, includeDeleted } = normalizeFindMatch<Filter<DBE>, any>( matchInput, options );
        const [ resolvedSmart, accessResult ] = await Promise.all(
        [
            smartFilter ? this.resolveSmartFilter( smartFilter ) : undefined,
            this._access.resolveOrDeny({ operation, method, access })
        ]);

        if( accessResult.denied )
        {
            return { finalMatch: null, targetIds: [], rawFilter, smartFilter, context, traceID, session };
        }

        const softDeleteFilter = this._softDeleteFilter( includeDeleted || options?.includeDeleted ) as Filter<DBE> | undefined;
        const effectiveAccessFilter = combineMongoFilters( accessResult.filter, softDeleteFilter );
        const targetIds = extractTargetIdsFromFilter( matchInput, '_id', id => String( this.dtoID( id )));

        if( resolvedSmart?.pipeline?.length )
        {
            let pipeline = await this._pipelineBuilder.pipeline(
            {
                filter          : resolveBSONObject( rawFilter ) as Filter<DBE>,
                smartFilter     : resolvedSmart,
                accessFilter    : effectiveAccessFilter,
                projection      : { _id: 1 },
                sort,
                limit
            });

            pipeline = this._optimizePipeline( pipeline );

            const preStart = Date.now();
            let docs: Array<{ _id: DBE['_id'] }>;

            try
            {
                docs = await this.collection.aggregate(
                    pipeline,
                    this._withSession({ collation: { locale: 'en' } }, session )
                ).toArray() as Array<{ _id: DBE['_id'] }>;
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
                return { finalMatch: null, targetIds: targetIds.length > 0 ? targetIds : matchedDtoIds, empty: true, rawFilter, smartFilter, context, traceID, session };
            }

            const finalMatch = ( limit === 1
                ? { _id: matchedDbeIds[0] }
                : { _id: { $in: matchedDbeIds } } ) as Filter<DBE>;

            return { finalMatch, targetIds: matchedDtoIds, rawFilter, smartFilter, context, traceID, session };
        }

        const combinedFilter = resolvedSmart?.filter
            ? ( Object.keys( rawFilter ).length > 0 ? { $and: [ rawFilter, resolvedSmart.filter ] } : resolvedSmart.filter )
            : rawFilter;
        const resolvedBase = resolveBSONObject( combinedFilter ) as Filter<DBE>;
        const finalMatch = combineMongoFilters( resolvedBase, effectiveAccessFilter ) ?? resolvedBase;

        return { finalMatch, targetIds, rawFilter, smartFilter, context, traceID, session };
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
                const baseMatch = await this._access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'update', method: 'updateMany', access: options?.access }
                );

                if( !baseMatch )
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

                const baseMatchWithSoftDelete = combineMongoFilters( baseMatch, this._softDeleteFilter( false ) as Filter<DBE> | undefined )!;
                const match = combineMongoFilters( baseMatchWithSoftDelete, this.#versionFilter( options?.expectedVersion ))!;
                const start = Date.now();
                const session = this._resolveSession( options?.session );
                const pendingAfterCommit: Array<() => void | Promise<void>> = [];
                const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any> );
                const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
                {
                    operation   : 'update',
                    method      : 'updateMany',
                    ids         : idsOrFilter,
                    filter      : match,
                    update      : timestampedUpdate,
                    context     : options?.context,
                    traceID     : options?.traceID,
                    session
                }, pendingAfterCommit );

                const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                    hookedUpdate,
                    { operation: 'update', method: 'updateMany', ids: idsOrFilter },
                    start,
                    options,
                    match
                ));
                let res: { matchedCount: number, modifiedCount: number };

                try
                {
                    res = await this.collection.updateMany(
                        match,
                        toUpdateOperations( validatedUpdate ),
                        ...this._sessionArg( options?.session )
                    );

                    if( res.matchedCount === 0 && options?.expectedVersion !== undefined )
                    {
                        await this.#assertNoVersionConflict( baseMatchWithSoftDelete, options.expectedVersion, options.session, idsOrFilter[0] );
                    }
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
                await this._runAfterHook( 'afterUpdate',
                {
                    operation       : 'update',
                    method          : 'updateMany',
                    ids             : idsOrFilter,
                    filter          : match,
                    update          : validatedUpdate as Document,
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    context         : options?.context,
                    traceID         : options?.traceID,
                    session
                }, pendingAfterCommit );
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

            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID, session } = await this.#resolveFilterMatch(
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

            const versionedMatch = combineMongoFilters( finalMatch, this.#versionFilter( options?.expectedVersion ))!;
            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any> );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'updateMany',
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : versionedMatch,
                update      : timestampedUpdate,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'updateMany', ids: targetIds.length > 0 ? targetIds : undefined, filter: rawFilter },
                start,
                { ...options, context, traceID },
                versionedMatch,
                smartFilter
            ));
            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateMany(
                    versionedMatch,
                    toUpdateOperations( validatedUpdate ),
                    ...this._sessionArg( session )
                );

                if( res.matchedCount === 0 && options?.expectedVersion !== undefined )
                {
                    await this.#assertNoVersionConflict( finalMatch, options.expectedVersion, session, targetIds[0] );
                }
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

            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'updateMany',
                ids             : targetIds.length > 0 ? targetIds : undefined,
                filter          : finalMatch,
                update          : validatedUpdate as Document,
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                context,
                traceID,
                session         : resolvedSession
            }, pendingAfterCommit );

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
            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID, session } = await this.#resolveFilterMatch(
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

            const versionedMatch = combineMongoFilters( finalMatch, this.#versionFilter( options?.expectedVersion ))!;
            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any> );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'updateOne',
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : versionedMatch,
                update      : timestampedUpdate,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'updateOne', ids: targetIds.length > 0 ? targetIds : undefined, filter: rawFilter },
                start,
                { ...options, context, traceID },
                versionedMatch,
                smartFilter
            ));

            try
            {
                if( options?.documentBefore || options?.documentAfter )
                {
                    const snapshot = await this.#findOneAndUpdateWithSnapshots(
                        versionedMatch,
                        validatedUpdate,
                        { ...options, context, traceID, session },
                        'updateOne'
                    );

                    if( snapshot.matchedCount === 0 && options?.expectedVersion !== undefined )
                    {
                        await this.#assertNoVersionConflict( finalMatch, options.expectedVersion, session, targetIds[0] );
                    }

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

                    await this._runAfterHook( 'afterUpdate',
                    {
                        operation       : 'update',
                        method          : 'updateOne',
                        ids             : idsToEvict ?? undefined,
                        filter          : versionedMatch,
                        update          : validatedUpdate as Document,
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter,
                        context,
                        traceID,
                        session         : resolvedSession
                    }, pendingAfterCommit );

                    this._emitMutation( 'updateOne', Date.now() - start,
                    {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        ids             : idsToEvict ?? undefined,
                        filter          : versionedMatch,
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

                const res = await this.collection.updateOne(
                    versionedMatch,
                    toUpdateOperations( validatedUpdate ),
                    ...this._sessionArg( session )
                );

                if( res.matchedCount === 0 && options?.expectedVersion !== undefined )
                {
                    await this.#assertNoVersionConflict( finalMatch, options.expectedVersion, session, targetIds[0] );
                }

                if( targetIds.length > 0 )
                {
                    this._invalidateCache( targetIds, res.matchedCount > 0 );
                }
                else if( res.matchedCount > 0 || res.modifiedCount > 0 )
                {
                    this._clearCache();
                }

                await this._runAfterHook( 'afterUpdate',
                {
                    operation       : 'update',
                    method          : 'updateOne',
                    ids             : targetIds.length > 0 ? targetIds : undefined,
                    filter          : finalMatch,
                    update          : validatedUpdate as Document,
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    context,
                    traceID,
                    session         : resolvedSession
                }, pendingAfterCommit );

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

    public async upsert(
        filter: Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpsertOptions
    ): Promise<ModelUpsertResponse<DBE, DTO['id']>>
    {
        return this.runOperation( async() =>
        {
            const { finalMatch, targetIds, rawFilter, smartFilter, context, traceID, session } = await this.#resolveFilterMatch(
                filter,
                'update',
                'upsert',
                options,
                1
            );

            if( !finalMatch )
            {
                return {
                    id              : undefined,
                    upsertedId      : undefined,
                    upserted        : false,
                    created         : false,
                    upsertedCount   : 0,
                    matchedCount    : 0,
                    modifiedCount   : 0
                };
            }

            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const now = new Date();
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any>, now, true );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'upsert',
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : finalMatch,
                update      : timestampedUpdate,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'upsert', ids: targetIds.length > 0 ? targetIds : undefined, filter: rawFilter },
                start,
                { ...options, context, traceID },
                finalMatch,
                smartFilter
            ));

            const versionedMatch = combineMongoFilters( finalMatch, this.#versionFilter( options?.expectedVersion ))!;
            const updateOps = toUpdateOperations( validatedUpdate ) as Record<string, any>;
            const generatedDtoId = await this.#prepareUpsertSetOnInsert( updateOps, finalMatch, targetIds, options?.id );

            try
            {
                if( options?.documentBefore || options?.documentAfter )
                {
                    const snapshot = await this.#findOneAndUpdateWithSnapshots(
                        versionedMatch,
                        updateOps as UpdateFilter<DBE>,
                        { ...options, context, traceID, session, upsert: true },
                        'upsert'
                    );
                    const upsertedId = snapshot.upsertedId ?? ( snapshot.upsertedCount > 0 ? generatedDtoId : undefined );
                    const resolvedId = upsertedId ?? ( snapshot.document?._id !== undefined ? this.dtoID( snapshot.document._id ) : ( targetIds[0] as DTO['id'] | undefined ));
                    const idsToEvict = targetIds.length > 0
                        ? targetIds
                        : ( snapshot.document?._id !== undefined ? [ String( this.dtoID( snapshot.document._id )) ] : null );

                    if( idsToEvict && idsToEvict.length > 0 )
                    {
                        this._invalidateCache( idsToEvict, true );
                    }
                    else
                    {
                        this._clearCache();
                    }

                    await this._runAfterHook( 'afterUpdate',
                    {
                        operation       : 'update',
                        method          : 'upsert',
                        id              : resolvedId,
                        ids             : idsToEvict ?? undefined,
                        filter          : versionedMatch,
                        update          : updateOps,
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        upsertedCount   : snapshot.upsertedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter,
                        context,
                        traceID,
                        session         : resolvedSession
                    }, pendingAfterCommit );

                    this._emitMutation( 'upsert', Date.now() - start,
                    {
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        upsertedCount   : snapshot.upsertedCount,
                        ids             : idsToEvict ?? ( upsertedId !== undefined ? [ upsertedId ] : undefined ),
                        filter          : versionedMatch,
                        smartFilter,
                        context,
                        traceID
                    });

                    return {
                        id              : resolvedId,
                        upsertedId,
                        upserted        : snapshot.upsertedCount > 0,
                        created         : snapshot.upsertedCount > 0,
                        upsertedCount   : snapshot.upsertedCount,
                        matchedCount    : snapshot.matchedCount,
                        modifiedCount   : snapshot.modifiedCount,
                        documentBefore  : snapshot.documentBefore,
                        documentAfter   : snapshot.documentAfter
                    };
                }

                const res = await this.collection.updateOne(
                    versionedMatch,
                    updateOps as UpdateFilter<DBE>,
                    this._withSession({ upsert: true }, session )
                );

                const upsertedCount = ( res as any ).upsertedCount ?? ( res.upsertedId ? 1 : 0 );
                const upsertedId = res.upsertedId !== undefined && res.upsertedId !== null
                    ? this.dtoID( res.upsertedId as any )
                    : ( upsertedCount > 0 ? generatedDtoId : undefined );
                const resolvedId = upsertedId ?? ( targetIds[0] as DTO['id'] | undefined );
                const affectedIds = targetIds.length > 0
                    ? targetIds
                    : ( upsertedId !== undefined ? [ String( upsertedId ) ] : [] );

                if( affectedIds.length > 0 )
                {
                    this._invalidateCache( affectedIds, true );
                }
                else
                {
                    this._clearCache();
                }

                await this._runAfterHook( 'afterUpdate',
                {
                    operation       : 'update',
                    method          : 'upsert',
                    id              : resolvedId,
                    ids             : affectedIds.length > 0 ? affectedIds : undefined,
                    filter          : finalMatch,
                    update          : updateOps,
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    upsertedCount,
                    context,
                    traceID,
                    session         : resolvedSession
                }, pendingAfterCommit );

                this._emitMutation( 'upsert', Date.now() - start,
                {
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount,
                    upsertedCount,
                    ids             : affectedIds.length > 0 ? affectedIds : undefined,
                    filter          : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                return {
                    id              : resolvedId,
                    upsertedId,
                    upserted        : upsertedCount > 0,
                    created         : upsertedCount > 0,
                    upsertedCount,
                    matchedCount    : res.matchedCount,
                    modifiedCount   : res.modifiedCount
                };
            }
            catch( e: any )
            {
                const errToThrow = options?.expectedVersion !== undefined && e?.code === 11000
                    ? new ModelVersionConflictError( this, targetIds[0], options.expectedVersion )
                    : e;

                this._emitError( errToThrow, 'upsert', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw errToThrow;
            }
        });
    }

    public async findOneAndUpdate<K extends keyof Extensions['converters'] = 'dto'>(
        idOrFilter: DTO['id'] | DBE['_id'] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelFindOneAndUpdateOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async(): Promise<any> =>
        {
            const opts: ModelFindOneAndUpdateOptions<K> = options !== undefined && ( typeof options !== 'object' || options === null )
                ? { as: options as K }
                : ( options ?? {} );
            const conversion = ( opts.as ?? 'dto' ) as K;
            const returnDocument = opts.returnDocument ?? 'after';
            const isPrimitiveId = typeof idOrFilter === 'string'
                || typeof idOrFilter === 'number'
                || isLibraryObjectId( idOrFilter )
                || isForeignObjectIdLike( idOrFilter );
            const matchInput = isPrimitiveId
                ? { _id: this.dbeID( idOrFilter as any ) } as Filter<DBE>
                : idOrFilter as any;
            const {
                finalMatch  : baseMatchWithoutVersion,
                targetIds,
                rawFilter,
                smartFilter,
                context = opts.context,
                traceID = opts.traceID,
                session = opts.session
            } = await this.#resolveFilterMatch(
                matchInput,
                'update',
                'findOneAndUpdate',
                opts,
                1,
                opts.sort
            );

            if( !baseMatchWithoutVersion )
            {
                return null;
            }

            const finalMatch = combineMongoFilters( baseMatchWithoutVersion, this.#versionFilter( opts.expectedVersion ))!;
            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const now = new Date();
            const isUpsert = Boolean( opts.upsert );
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any>, now, isUpsert );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'findOneAndUpdate',
                id          : isPrimitiveId ? idOrFilter : undefined,
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : finalMatch,
                update      : timestampedUpdate,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            const validatedUpdate = this._applyUpdateVersioning( await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'findOneAndUpdate', id: isPrimitiveId ? idOrFilter : undefined, ids: targetIds.length > 0 ? targetIds : undefined, filter: rawFilter },
                start,
                { ...opts, context, traceID },
                finalMatch,
                smartFilter
            ));

            const updateOps = toUpdateOperations( validatedUpdate ) as Record<string, any>;

            if( isUpsert )
            {
                await this.#prepareUpsertSetOnInsert( updateOps, finalMatch, targetIds, opts.id );
            }

            let rawDoc: DBE | null = null;

            try
            {
                const findAndUpdateOpts = this._withSession(
                {
                    returnDocument,
                    ...( isUpsert ? { upsert: true } : {} ),
                    ...( opts.sort ? { sort: opts.sort } : {} ),
                    collation : { locale: 'en' }
                }, session );

                if( typeof ( this.collection as any ).findOneAndUpdate === 'function' )
                {
                    const res = await this.collection.findOneAndUpdate(
                        finalMatch,
                        updateOps as UpdateFilter<DBE>,
                        findAndUpdateOpts
                    );
                    rawDoc = ( ( res as any )?.value !== undefined ? ( res as any ).value : res ) as DBE | null;
                }
                else
                {
                    const before = await this.collection.findOne( finalMatch, this._withSession({ ...( opts.sort ? { sort: opts.sort } : {} ), collation: { locale: 'en' } }, session )) as DBE | null;
                    const upRes = await this.collection.updateOne(
                        finalMatch,
                        updateOps as UpdateFilter<DBE>,
                        this._withSession( isUpsert ? { upsert: true } : {}, session )
                    );

                    if( returnDocument === 'before' )
                    {
                        rawDoc = before;
                    }
                    else if( upRes.matchedCount > 0 || ( upRes as any ).upsertedCount > 0 )
                    {
                        rawDoc = await this.collection.findOne( baseMatchWithoutVersion, this._withSession({ collation: { locale: 'en' } }, session )) as DBE | null;
                    }
                }

                if( !rawDoc && !isUpsert && opts.expectedVersion !== undefined )
                {
                    await this.#assertNoVersionConflict( baseMatchWithoutVersion, opts.expectedVersion, session, isPrimitiveId ? idOrFilter : targetIds[0] );
                }
            }
            catch( e: any )
            {
                const errToThrow = opts.expectedVersion !== undefined && e?.code === 11000
                    ? new ModelVersionConflictError( this, isPrimitiveId ? idOrFilter : targetIds[0], opts.expectedVersion )
                    : e;

                this._emitError( errToThrow, 'findOneAndUpdate', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw errToThrow;
            }

            const duration = Date.now() - start;
            const count = rawDoc ? 1 : 0;
            const docId = rawDoc?._id !== undefined ? this.dtoID( rawDoc._id ) : ( isPrimitiveId ? idOrFilter : undefined );
            const affectedIds = rawDoc?._id !== undefined ? [ String( docId ) ] : targetIds;

            this._invalidateCache( affectedIds, count > 0 );

            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'findOneAndUpdate',
                id              : docId,
                ids             : affectedIds,
                filter          : finalMatch,
                update          : updateOps,
                matchedCount    : count,
                modifiedCount   : count,
                documentBefore  : returnDocument === 'before' ? ( rawDoc ?? undefined ) : undefined,
                documentAfter   : returnDocument === 'after' ? ( rawDoc ?? undefined ) : undefined,
                context,
                traceID,
                session         : resolvedSession
            }, pendingAfterCommit );

            const convStart = Date.now();
            const converted = rawDoc
                ? await this._converters.convert( rawDoc, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>
                : null;
            const converterDuration = Date.now() - convStart;

            if( converted && opts.populate )
            {
                await this._hydrateRelations([ converted ], opts.populate, { ...opts, context, traceID, session });
            }

            this._emitMutation( 'findOneAndUpdate', duration,
            {
                converterDuration,
                matchedCount    : count,
                modifiedCount   : count,
                ids             : affectedIds,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return converted;
        });
    }

    public async findOneAndDelete<K extends keyof Extensions['converters'] = 'dto'>(
        idOrFilter: DTO['id'] | DBE['_id'] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelFindOneAndDeleteOptions<K> | K
    ): Promise<Awaited<ReturnType<Extensions['converters'][K]['converter']>> | null>
    {
        return this.runOperation( async(): Promise<any> =>
        {
            const opts: ModelFindOneAndDeleteOptions<K> = options !== undefined && ( typeof options !== 'object' || options === null )
                ? { as: options as K }
                : ( options ?? {} );
            const conversion = ( opts.as ?? 'dto' ) as K;
            const isSoft = Boolean( this._softDelete && !opts.hard );
            const isPrimitiveId = typeof idOrFilter === 'string'
                || typeof idOrFilter === 'number'
                || isLibraryObjectId( idOrFilter )
                || isForeignObjectIdLike( idOrFilter );
            const matchInput = isPrimitiveId
                ? { _id: this.dbeID( idOrFilter as any ) } as Filter<DBE>
                : idOrFilter as any;
            const {
                finalMatch,
                targetIds,
                smartFilter,
                context = opts.context,
                traceID = opts.traceID,
                session = opts.session
            } = await this.#resolveFilterMatch(
                matchInput,
                'delete',
                'findOneAndDelete',
                { ...opts, includeDeleted: Boolean( opts.includeDeleted || !isSoft ) },
                1,
                opts.sort
            );

            if( !finalMatch )
            {
                return null;
            }

            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeDelete',
            {
                operation   : 'delete',
                method      : 'findOneAndDelete',
                id          : isPrimitiveId ? idOrFilter : undefined,
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : finalMatch,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            let rawDoc: DBE | null = null;

            try
            {
                const findOpts = this._withSession({ ...( opts.sort ? { sort: opts.sort } : {} ), collation: { locale: 'en' } }, session );

                if( isSoft )
                {
                    const softUpdate = this._applyUpdateVersioning( buildSoftDeleteUpdate( this._softDelete!, this._timestamps ) as Record<string, any> );

                    if( typeof ( this.collection as any ).findOneAndUpdate === 'function' )
                    {
                        const res = await this.collection.findOneAndUpdate(
                            finalMatch,
                            softUpdate as UpdateFilter<DBE>,
                            { ...findOpts, returnDocument: 'before' }
                        );
                        rawDoc = ( ( res as any )?.value !== undefined ? ( res as any ).value : res ) as DBE | null;
                    }
                    else
                    {
                        const before = await this.collection.findOne( finalMatch, findOpts ) as DBE | null;
                        const upRes = await this.collection.updateOne( finalMatch, softUpdate as UpdateFilter<DBE>, ...this._sessionArg( session ));
                        rawDoc = ( upRes.modifiedCount || upRes.matchedCount ) ? before : null;
                    }
                }
                else if( typeof ( this.collection as any ).findOneAndDelete === 'function' )
                {
                    const res = await this.collection.findOneAndDelete( finalMatch, findOpts );
                    rawDoc = ( ( res as any )?.value !== undefined ? ( res as any ).value : res ) as DBE | null;
                }
                else
                {
                    const before = await this.collection.findOne( finalMatch, findOpts ) as DBE | null;
                    const delRes = await this.collection.deleteOne( finalMatch, ...this._sessionArg( session ));
                    rawDoc = delRes.deletedCount > 0 ? before : null;
                }
            }
            catch( e )
            {
                this._emitError( e, 'findOneAndDelete', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw e;
            }

            const duration = Date.now() - start;
            const deletedCount = rawDoc ? 1 : 0;
            const docId = rawDoc?._id !== undefined ? this.dtoID( rawDoc._id ) : ( isPrimitiveId ? idOrFilter : undefined );
            const affectedIds = rawDoc?._id !== undefined ? [ String( docId ) ] : targetIds;

            this._invalidateCache( affectedIds, deletedCount > 0 );

            await this._runAfterHook( 'afterDelete',
            {
                operation   : 'delete',
                method      : 'findOneAndDelete',
                id          : docId,
                ids         : affectedIds,
                filter      : finalMatch,
                deletedCount,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            const convStart = Date.now();
            const converted = rawDoc
                ? await this._converters.convert( rawDoc, conversion ) as Awaited<ReturnType<Extensions['converters'][K]['converter']>>
                : null;
            const converterDuration = Date.now() - convStart;

            if( converted && opts.populate )
            {
                await this._hydrateRelations([ converted ], opts.populate, { ...opts, context, traceID, session });
            }

            this._emitMutation( 'findOneAndDelete', duration,
            {
                converterDuration,
                deletedCount,
                ids             : affectedIds,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return converted;
        });
    }

    public async delete( id: DTO['id'] | DBE['_id'], options?: ModelDeleteOptions ): Promise<boolean>
    {
        return this.#executeDeleteById( id, options, options?.hard ? 'hardDelete' : 'delete' );
    }

    public async hardDelete( id: DTO['id'] | DBE['_id'], options?: Omit<ModelDeleteOptions, 'hard'> ): Promise<boolean>
    {
        return this.#executeDeleteById( id, { ...options, hard: true }, 'hardDelete' );
    }

    async #executeDeleteById(
        id: DTO['id'] | DBE['_id'],
        options: ModelDeleteOptions | undefined,
        method: 'delete' | 'hardDelete'
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const baseMatch = await this._access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'delete', method, access: options?.access }
            );

            if( !baseMatch ){ return false }

            const isSoft = Boolean( this._softDelete && !options?.hard );
            const match = isSoft
                ? combineMongoFilters( baseMatch, this._softDeleteFilter( false ) as Filter<DBE> | undefined )!
                : baseMatch;
            const start = Date.now();
            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeDelete',
            {
                operation   : 'delete',
                method,
                id,
                filter      : match,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );

            let deletedCount = 0;

            try
            {
                if( isSoft )
                {
                    const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps );
                    const res = await this.collection.updateOne(
                        match,
                        softUpdate as UpdateFilter<DBE>,
                        ...this._sessionArg( options?.session )
                    );

                    deletedCount = res.modifiedCount ?? res.matchedCount ?? 0;
                }
                else
                {
                    const res = await this.collection.deleteOne( match, ...this._sessionArg( options?.session ));

                    deletedCount = res.deletedCount;
                }
            }
            catch( e )
            {
                this._emitError( e, method, Date.now() - start,
                {
                    filter  : match,
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }

            this._invalidateCache([ id ], deletedCount > 0 );
            await this._runAfterHook( 'afterDelete',
            {
                operation   : 'delete',
                method,
                id,
                filter      : match,
                deletedCount,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );
            this._emitMutation( method, Date.now() - start,
            {
                deletedCount,
                ids             : [ id ],
                filter          : match,
                context         : options?.context,
                traceID         : options?.traceID
            });

            return deletedCount === 1;
        });
    }

    public async deleteMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelDeleteOptions
    ): Promise<number>
    {
        return this.#executeDeleteMany( idsOrFilter, options, options?.hard ? 'hardDeleteMany' : 'deleteMany' );
    }

    public async hardDeleteMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: Omit<ModelDeleteOptions, 'hard'>
    ): Promise<number>
    {
        return this.#executeDeleteMany( idsOrFilter, { ...options, hard: true }, 'hardDeleteMany' );
    }

    async #executeDeleteMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options: ModelDeleteOptions | undefined,
        method: 'deleteMany' | 'hardDeleteMany'
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            const isSoft = Boolean( this._softDelete && !options?.hard );

            if( Array.isArray( idsOrFilter ) )
            {
                const baseMatch = await this._access.match(
                    resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>,
                    { operation: 'delete', method, access: options?.access }
                );

                if( !baseMatch ){ return 0 }

                if( idsOrFilter.length === 0 )
                {
                    this._emitMutation( method, 0,
                    {
                        deletedCount    : 0,
                        ids             : [],
                        context         : options?.context,
                        traceID         : options?.traceID
                    });

                    return 0;
                }

                const match = isSoft
                    ? combineMongoFilters( baseMatch, this._softDeleteFilter( false ) as Filter<DBE> | undefined )!
                    : baseMatch;
                const start = Date.now();
                const session = this._resolveSession( options?.session );
                const pendingAfterCommit: Array<() => void | Promise<void>> = [];

                await this._runBeforeHook( 'beforeDelete',
                {
                    operation   : 'delete',
                    method,
                    ids         : idsOrFilter,
                    filter      : match,
                    context     : options?.context,
                    traceID     : options?.traceID,
                    session
                }, pendingAfterCommit );

                let deletedCount = 0;

                try
                {
                    if( isSoft )
                    {
                        const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps );
                        const res = await this.collection.updateMany(
                            match,
                            softUpdate as UpdateFilter<DBE>,
                            ...this._sessionArg( options?.session )
                        );

                        deletedCount = res.modifiedCount ?? res.matchedCount ?? 0;
                    }
                    else
                    {
                        const res = await this.collection.deleteMany( match, ...this._sessionArg( options?.session ));

                        deletedCount = res.deletedCount;
                    }
                }
                catch( e )
                {
                    this._emitError( e, method, Date.now() - start,
                    {
                        filter  : match,
                        context : options?.context,
                        traceID : options?.traceID
                    });

                    throw e;
                }

                this._invalidateCache( idsOrFilter, deletedCount > 0 );
                await this._runAfterHook( 'afterDelete',
                {
                    operation   : 'delete',
                    method,
                    ids         : idsOrFilter,
                    filter      : match,
                    deletedCount,
                    context     : options?.context,
                    traceID     : options?.traceID,
                    session
                }, pendingAfterCommit );
                this._emitMutation( method, Date.now() - start,
                {
                    deletedCount,
                    ids             : idsOrFilter,
                    filter          : match,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return deletedCount;
            }

            const { finalMatch, targetIds, empty, rawFilter, smartFilter, context, traceID, session } = await this.#resolveFilterMatch(
                idsOrFilter,
                'delete',
                method,
                { ...options, includeDeleted: !isSoft }
            );

            if( !finalMatch )
            {
                if( empty )
                {
                    if( targetIds.length > 0 )
                    {
                        this._invalidateCache( targetIds, false );
                    }

                    this._emitMutation( method, 0,
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
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeDelete',
            {
                operation   : 'delete',
                method,
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : finalMatch,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            let deletedCount = 0;

            try
            {
                if( isSoft )
                {
                    const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps );
                    const res = await this.collection.updateMany(
                        finalMatch,
                        softUpdate as UpdateFilter<DBE>,
                        ...this._sessionArg( session )
                    );

                    deletedCount = res.modifiedCount ?? res.matchedCount ?? 0;
                }
                else
                {
                    const res = await this.collection.deleteMany( finalMatch, ...this._sessionArg( session ));

                    deletedCount = res.deletedCount;
                }
            }
            catch( e )
            {
                this._emitError( e, method, Date.now() - start,
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
                this._invalidateCache( targetIds, deletedCount > 0 );
            }
            else if( deletedCount > 0 )
            {
                this._clearCache();
            }

            await this._runAfterHook( 'afterDelete',
            {
                operation   : 'delete',
                method,
                ids         : targetIds.length > 0 ? targetIds : undefined,
                filter      : finalMatch,
                deletedCount,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            this._emitMutation( method, Date.now() - start,
            {
                deletedCount,
                ids             : targetIds.length > 0 ? targetIds : undefined,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return deletedCount;
        });
    }

    public async restore( id: DTO['id'] | DBE['_id'], options?: Omit<ModelDeleteOptions, 'hard'> ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            if( !this._softDelete ){ return false }

            const baseMatch = await this._access.match(
                resolveBSONObject({ _id: this.dbeID( id ) }) as Filter<DBE>,
                { operation: 'update', method: 'restore', access: options?.access }
            );

            if( !baseMatch ){ return false }

            const match = combineMongoFilters( baseMatch, { [this._softDelete.field]: { $nin: [ null, false ] } } as Filter<DBE> )!;
            const start = Date.now();
            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const restoreUpdate = buildRestoreUpdate( this._softDelete, this._timestamps );

            await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'restore',
                id,
                filter      : match,
                update      : restoreUpdate,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateOne(
                    match,
                    restoreUpdate as UpdateFilter<DBE>,
                    ...this._sessionArg( options?.session )
                );
            }
            catch( e )
            {
                this._emitError( e, 'restore', Date.now() - start,
                {
                    filter  : match,
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }

            const modifiedCount = res.modifiedCount ?? res.matchedCount ?? 0;

            this._invalidateCache([ id ], modifiedCount > 0 );
            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'restore',
                id,
                filter          : match,
                update          : restoreUpdate,
                matchedCount    : res.matchedCount,
                modifiedCount,
                context         : options?.context,
                traceID         : options?.traceID,
                session
            }, pendingAfterCommit );
            this._emitMutation( 'restore', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount,
                ids             : [ id ],
                filter          : match,
                context         : options?.context,
                traceID         : options?.traceID
            });

            return modifiedCount === 1;
        });
    }

    public async restoreMany(
        idsOrFilter: DTO['id'][] | DBE['_id'][] | Filter<DBE> | ModelFindOptions<DBE, ExtractSmartFilters<Extensions>>,
        options?: Omit<ModelDeleteOptions, 'hard'>
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            if( !this._softDelete ){ return 0 }

            const isIdArray = Array.isArray( idsOrFilter );

            if( isIdArray && idsOrFilter.length === 0 ){ return 0 }

            const deletedOnlyFilter = { [this._softDelete.field]: { $nin: [ null, false ] } } as Filter<DBE>;
            const restoreUpdate = buildRestoreUpdate( this._softDelete, this._timestamps );
            const normalizedFilter = isIdArray
                ? resolveBSONObject({ _id: { $in: idsOrFilter.map( id => this.dbeID( id )) } }) as Filter<DBE>
                : idsOrFilter;

            const { finalMatch: resolvedMatch, targetIds, smartFilter, context, traceID, session } = await this.#resolveFilterMatch(
                normalizedFilter,
                'update',
                'restoreMany',
                { ...options, includeDeleted: true }
            );

            if( !resolvedMatch ){ return 0 }

            const effectiveIds = isIdArray ? idsOrFilter.map( id => String( this.dtoID( id ))) : targetIds;
            const finalMatch = combineMongoFilters( resolvedMatch, deletedOnlyFilter )!;
            const start = Date.now();
            const resolvedSession = this._resolveSession( session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'restoreMany',
                ids         : effectiveIds.length > 0 ? effectiveIds : undefined,
                filter      : finalMatch,
                update      : restoreUpdate,
                context,
                traceID,
                session     : resolvedSession
            }, pendingAfterCommit );

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateMany(
                    finalMatch,
                    restoreUpdate as UpdateFilter<DBE>,
                    ...this._sessionArg( session )
                );
            }
            catch( e )
            {
                this._emitError( e, 'restoreMany', Date.now() - start,
                {
                    filter      : finalMatch,
                    smartFilter,
                    context,
                    traceID
                });

                throw e;
            }

            const modifiedCount = res.modifiedCount ?? res.matchedCount ?? 0;

            if( effectiveIds.length > 0 )
            {
                this._invalidateCache( effectiveIds, modifiedCount > 0 );
            }
            else if( modifiedCount > 0 )
            {
                this._clearCache();
            }

            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'restoreMany',
                ids             : effectiveIds.length > 0 ? effectiveIds : undefined,
                filter          : finalMatch,
                update          : restoreUpdate,
                matchedCount    : res.matchedCount,
                modifiedCount,
                context,
                traceID,
                session         : resolvedSession
            }, pendingAfterCommit );
            this._emitMutation( 'restoreMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount,
                ids             : effectiveIds.length > 0 ? effectiveIds : undefined,
                filter          : finalMatch,
                smartFilter,
                context,
                traceID
            });

            return modifiedCount;
        });
    }

    public async bulkWrite(
        operations: Array<ModelBulkWriteOperation<DBE, DTO['id'], ExtractSmartFilters<Extensions>>>,
        options?: ModelBulkWriteOptions
    ): Promise<ModelBulkWriteResult<DTO['id']>>
    {
        return this.runOperation( async() =>
        {
            if( operations.length === 0 )
            {
                this._emitMutation( 'bulkWrite', 0,
                {
                    insertedCount   : 0,
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    deletedCount    : 0,
                    upsertedCount   : 0,
                    ids             : [],
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return {
                    insertedCount   : 0,
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    deletedCount    : 0,
                    upsertedCount   : 0,
                    insertedIds     : [],
                    upsertedIds     : {}
                };
            }

            const start = Date.now();
            const now = new Date();
            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const pendingAfterHooks: Array<{ hook: 'afterCreate' | 'afterUpdate' | 'afterDelete', ctx: any }> = [];
            const rawOps: AnyBulkWriteOperation<DBE>[] = [];
            const insertedIds: DTO['id'][] = [];
            const targetedIds: string[] = [];
            const usedCreateIds = new Set<string>();
            const { maxRetries, verifyUniqueness } = this._resolveIdRetryOptions();
            let hasBroadMutation = false;
            let versionedOpCount = 0;
            let firstVersionedCheck: { id?: unknown, expectedVersion: number } | undefined;

            for( const op of operations )
            {
                if( 'create' in op || 'insertOne' in op )
                {
                    const access = await this._access.resolveOrDeny({ operation: 'create', method: 'bulkWrite', access: options?.access });

                    if( access.denied )
                    {
                        throw new ModelAccessDeniedError( this );
                    }

                    const createPayload: any = 'create' in op ? op.create : op.insertOne.document;
                    const isWrappedCreate = 'create' in op && createPayload && typeof createPayload === 'object' && 'data' in createPayload && typeof createPayload.data === 'object';
                    const rawDoc: any = isWrappedCreate ? createPayload.data : createPayload;
                    const explicitId = 'create' in op ? ( ( op as any ).id ?? ( isWrappedCreate ? createPayload.id : undefined )) : undefined;
                    const isAutoId = explicitId === undefined && rawDoc._id === undefined;
                    let dtoId: DTO['id'];

                    if( isAutoId )
                    {
                        dtoId = await this._generateUniqueId( usedCreateIds, maxRetries, verifyUniqueness, options?.session );
                    }
                    else
                    {
                        dtoId = ( explicitId ?? this.dtoID( rawDoc._id )) as DTO['id'];
                        usedCreateIds.add( String( dtoId ));
                    }

                    let initialDoc = this._applyCreateTimestamps({ ...rawDoc, _id: this.dbeID( dtoId ) }, now ) as Partial<DBE>;

                    if( this._softDelete && ( initialDoc as any )[this._softDelete.field] === undefined )
                    {
                        initialDoc = { ...initialDoc, [this._softDelete.field]: null };
                    }

                    const hookedData = await this._runBeforeHook( 'beforeCreate',
                    {
                        operation   : 'create',
                        method      : 'bulkWrite',
                        id          : dtoId,
                        data        : initialDoc,
                        context     : options?.context,
                        traceID     : options?.traceID,
                        session
                    }, pendingAfterCommit );

                    const validated = await this._validateWrite(
                        { ...hookedData, _id: this.dbeID( dtoId ) } as Partial<DBE>,
                        { operation: 'create', method: 'bulkWrite', id: dtoId },
                        start,
                        options
                    );

                    insertedIds.push( dtoId );
                    targetedIds.push( String( dtoId ));
                    pendingAfterHooks.push({
                        hook    : 'afterCreate',
                        ctx     :
                        {
                            operation       : 'create',
                            method          : 'bulkWrite',
                            id              : dtoId,
                            data            : validated,
                            result          : dtoId,
                            insertedCount   : 1,
                            context         : options?.context,
                            traceID         : options?.traceID,
                            session
                        }
                    });
                    rawOps.push({
                        insertOne : {
                            document : resolveBSONObject({ ...validated, _id: this.dbeID( dtoId ) }) as any
                        }
                    });
                }
                else if( 'update' in op || 'updateOne' in op || 'updateMany' in op || 'upsert' in op )
                {
                    const isMany = 'updateMany' in op;
                    const singleId = 'update' in op ? op.update.id : undefined;
                    const spec: any = 'update' in op
                        ? op.update
                        : ( 'updateOne' in op ? op.updateOne : ( 'updateMany' in op ? op.updateMany : op.upsert ));
                    const isUpsert = 'upsert' in op || Boolean( spec.upsert );
                    const normalizedFilter = singleId !== undefined
                        ? { _id: this.dbeID( singleId ) } as Filter<DBE>
                        : ( Array.isArray( spec.filter )
                            ? { _id: { $in: spec.filter.map(( id: any ) => this.dbeID( id )) } } as Filter<DBE>
                            : spec.filter );
                    const { finalMatch, targetIds } = await this.#resolveFilterMatch(
                        normalizedFilter,
                        'update',
                        'bulkWrite',
                        options,
                        isMany ? undefined : 1
                    );

                    if( !finalMatch ){ continue }

                    const expectedVer = spec.expectedVersion ?? options?.expectedVersion;
                    const versionedMatch = combineMongoFilters( finalMatch, this.#versionFilter( expectedVer ))!;

                    if( expectedVer !== undefined && !isUpsert )
                    {
                        versionedOpCount++;
                        firstVersionedCheck ??= { id: singleId ?? targetIds[0], expectedVersion: expectedVer };
                    }
                    const timestamped = this._applyUpdateTimestamps( spec.update as Record<string, any>, now, isUpsert );
                    const hooked = await this._runBeforeHook( 'beforeUpdate',
                    {
                        operation   : 'update',
                        method      : 'bulkWrite',
                        id          : singleId,
                        ids         : targetIds.length > 0 ? targetIds : undefined,
                        filter      : versionedMatch,
                        update      : timestamped,
                        context     : options?.context,
                        traceID     : options?.traceID,
                        session
                    }, pendingAfterCommit );
                    const validated = this._applyUpdateVersioning( await this._validateWrite( hooked, { operation: 'update', method: 'bulkWrite', id: singleId, filter: versionedMatch }, start, options, versionedMatch ));
                    const updateOps = toUpdateOperations( validated ) as Record<string, any>;

                    if( isUpsert && this._softDelete )
                    {
                        updateOps.$setOnInsert = { [this._softDelete.field]: null, ...( updateOps.$setOnInsert ?? {} ) };
                    }

                    if( targetIds.length > 0 ){ targetedIds.push( ...targetIds ) }
                    else { hasBroadMutation = true }

                    pendingAfterHooks.push({
                        hook    : 'afterUpdate',
                        ctx     :
                        {
                            operation   : 'update',
                            method      : 'bulkWrite',
                            id          : singleId,
                            ids         : targetIds.length > 0 ? targetIds : undefined,
                            filter      : versionedMatch,
                            update      : ( singleId !== undefined ? validated : updateOps ) as Document,
                            context     : options?.context,
                            traceID     : options?.traceID,
                            session
                        }
                    });

                    const opPayload =
                    {
                        filter  : versionedMatch,
                        update  : updateOps as UpdateFilter<DBE>,
                        ...( isUpsert ? { upsert: true } : {} )
                    };

                    rawOps.push( isMany ? { updateMany: opPayload } : { updateOne: opPayload });
                }
                else if( 'delete' in op || 'deleteOne' in op || 'deleteMany' in op )
                {
                    const isMany = 'deleteMany' in op;
                    const singleId = 'delete' in op ? op.delete.id : undefined;
                    const spec: any = 'delete' in op ? op.delete : ( 'deleteOne' in op ? op.deleteOne : op.deleteMany );
                    const isSoft = Boolean( this._softDelete && !spec.hard );
                    const normalizedFilter = singleId !== undefined
                        ? { _id: this.dbeID( singleId ) } as Filter<DBE>
                        : ( Array.isArray( spec.filter )
                            ? { _id: { $in: spec.filter.map(( id: any ) => this.dbeID( id )) } } as Filter<DBE>
                            : spec.filter );
                    const { finalMatch, targetIds } = await this.#resolveFilterMatch(
                        normalizedFilter,
                        'delete',
                        'bulkWrite',
                        { ...options, includeDeleted: !isSoft },
                        isMany ? undefined : 1
                    );

                    if( !finalMatch ){ continue }

                    await this._runBeforeHook( 'beforeDelete',
                    {
                        operation   : 'delete',
                        method      : 'bulkWrite',
                        id          : singleId,
                        ids         : targetIds.length > 0 ? targetIds : undefined,
                        filter      : finalMatch,
                        context     : options?.context,
                        traceID     : options?.traceID,
                        session
                    }, pendingAfterCommit );

                    if( targetIds.length > 0 ){ targetedIds.push( ...targetIds ) }
                    else { hasBroadMutation = true }

                    pendingAfterHooks.push({
                        hook    : 'afterDelete',
                        ctx     :
                        {
                            operation   : 'delete',
                            method      : 'bulkWrite',
                            id          : singleId,
                            ids         : targetIds.length > 0 ? targetIds : undefined,
                            filter      : finalMatch,
                            context     : options?.context,
                            traceID     : options?.traceID,
                            session
                        }
                    });

                    if( isSoft )
                    {
                        const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps, now ) as UpdateFilter<DBE>;

                        rawOps.push( isMany
                            ? { updateMany: { filter: finalMatch, update: softUpdate } }
                            : { updateOne: { filter: finalMatch, update: softUpdate } }
                        );
                    }
                    else
                    {
                        rawOps.push( isMany
                            ? { deleteMany: { filter: finalMatch } }
                            : { deleteOne: { filter: finalMatch } }
                        );
                    }
                }
            }

            if( rawOps.length === 0 )
            {
                return {
                    insertedCount   : 0,
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    deletedCount    : 0,
                    upsertedCount   : 0,
                    insertedIds     : [],
                    upsertedIds     : {}
                };
            }

            const bulkOpts = this._withSession(
                options?.ordered !== undefined ? { ordered: options.ordered } : {},
                options?.session
            );
            let res: any;

            try
            {
                res = Object.keys( bulkOpts ).length > 0
                    ? await this.collection.bulkWrite( rawOps, bulkOpts )
                    : await this.collection.bulkWrite( rawOps );

                if( versionedOpCount > 0 && firstVersionedCheck && ( res?.matchedCount ?? 0 ) < versionedOpCount )
                {
                    throw new ModelVersionConflictError( this, firstVersionedCheck.id, firstVersionedCheck.expectedVersion );
                }
            }
            catch( e )
            {
                this._emitError( e, 'bulkWrite', Date.now() - start,
                {
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }

            if( hasBroadMutation )
            {
                this._clearCache();
            }
            else if( targetedIds.length > 0 )
            {
                this._invalidateCache( targetedIds, true );
            }
            else if( insertedIds.length > 0 )
            {
                this._notifySiblingCacheInvalidation();
            }

            for( const item of pendingAfterHooks )
            {
                await this._runAfterHook( item.hook, item.ctx, pendingAfterCommit );
            }

            for( const cb of pendingAfterCommit )
            {
                await cb();
            }

            const upsertedIds: Record<number, DTO['id']> = {};

            if( res?.upsertedIds && typeof res.upsertedIds === 'object' )
            {
                for( const [ idx, val ] of Object.entries( res.upsertedIds ) )
                {
                    upsertedIds[Number( idx )] = this.dtoID( val as any );
                }
            }

            const result: ModelBulkWriteResult<DTO['id']> =
            {
                insertedCount   : res?.insertedCount ?? insertedIds.length,
                matchedCount    : res?.matchedCount ?? 0,
                modifiedCount   : res?.modifiedCount ?? 0,
                deletedCount    : res?.deletedCount ?? 0,
                upsertedCount   : res?.upsertedCount ?? 0,
                insertedIds,
                upsertedIds
            };

            this._emitMutation( 'bulkWrite', Date.now() - start,
            {
                insertedCount   : result.insertedCount,
                matchedCount    : result.matchedCount,
                modifiedCount   : result.modifiedCount,
                deletedCount    : result.deletedCount,
                upsertedCount   : result.upsertedCount,
                ids             : targetedIds.length > 0 ? targetedIds : undefined,
                context         : options?.context,
                traceID         : options?.traceID
            });

            return result;
        });
    }
}
