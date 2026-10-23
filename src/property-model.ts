import
{
    Collection,
    Document,
    Filter,
    UpdateFilter,
    UpdateOptions
}
from 'mongodb';
import { AbstractBaseModel } from './base-model.js';
import { extractTargetIdsFromFilter } from './cache.js';
import { ModelAccessDeniedError, ModelError } from './errors.js';
import { ModelMutationOperation } from './events.js';
import { flowGet } from './flow.js';
import
{
    LOG,
    addPrefixToFilter,
    addPrefixToUpdate,
    collectAddedFields,
    generateCursorCondition,
    getSubPaths,
    getUsedFields,
    isExclusionProjection,
    isSet,
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
import { propertyModelTargetUpdateParams } from './helpers/mongo.js';
import { AbstractModels } from './models.js';
import
{
     attachPropertyUpdateMetadata,
    buildPropertyDeleteOperation,
    buildRestoreUpdate,
    buildSoftDeleteUpdate,
    normalizeCursorOption,
    normalizeFindMatch,
    resolveCreateFromArgs
}
from './operations.js';
import { GET_PARENT, INCLUDE_DELETED, RESOLVED_ACCESS } from './symbols.js';
import
{
    AbstractPropertyModelComputedProperties,
    AbstractPropertyModelSmartFilters,
    ConstructorExtensions,
    ExtractComputedProperties,
    ExtractSmartFilters,
    FirstType,
    ModelBulkWriteOptions,
    ModelBulkWriteResult,
    ModelCreateOptions,
    ModelDeleteOptions,
    ModelUpdateOptions,
    ModelUpsertOptions,
    MongoPropertyDocument,
    MongoRootDocument,
    PropertyModelAggregateOptions,
    PropertyModelBulkWriteOperation,
    PropertyModelExtensions,
    PropertyModelFilter,
    PropertyModelFindOptions,
    PropertyModelListOptions,
    PropertyModelStreamOptions,
    PropertyModelUpdateResponse,
    PropertyModelUpsertResponse
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
extends AbstractBaseModel<
    DBE,
    DTO,
    Extensions,
    RootDBE,
    PropertyModelFilter<RootDBE, DBE>,
    DTO['id'] | DBE['id'],
    PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
    PropertyModelAggregateOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
    DTO['id'] | DBE['id'] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
    { [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> },
    PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
    PropertyModelStreamOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>
>
{
    #paths: { path: string, array: boolean }[];
    #prefix: string;

    public smartFilters?: FirstType<ExtractSmartFilters<Extensions>>;

    protected constructor(
        models: AbstractModels,
        collection: Collection<RootDBE>,
        path: string,
        params: ConstructorExtensions<Extensions>
    )
    {
        const paths = [ ...path.matchAll( /[^\[\]]+(\[\])?/g ) ].map( m => ({ path: m[0].replace( /^\./, '' ).replace( /\[\]$/, '' ), array: m[0].endsWith( '[]' ) }));
        const prefix = paths.map( p => p.path ).join( '.' );

        super( models, collection,
        {
            cache                       : params.cache,
            converters                  : params.converters,
            smartFilters                : params.smartFilters,
            computedProperties          : params.computedProperties,
            access                      : params.access,
            optimizer                   : params.optimizer,
            observability               : params.observability,
            validate                    : params.validate,
            indexes                     : params.indexes,
            timestamps                  : params.timestamps,
            softDelete                  : params.softDelete,
            hooks                       : params.hooks,
            idField                     : 'id',
            prefix,
            smartFilterOptions          :
            {
                prefix,
                parentResolve : ( smartFilter: Record<string, any> ) =>
                {
                    const parent = models[GET_PARENT]( collection.collectionName, prefix );

                    return parent ? parent.resolveSmartFilter( smartFilter ) : Promise.resolve({});
                }
            },
            computedPropertyOptions     :
            {
                prefix,
                parentResolve : ( properties?: ComputedPropertiesParam<any> ) =>
                {
                    const parent = models[GET_PARENT]( collection.collectionName, prefix );

                    return parent ? parent.resolveComputedProperties( properties ) : Promise.resolve({});
                }
            }
        });

        this.#paths = paths;
        this.#prefix = prefix;
        this.smartFilters = params.smartFilters;
    }

    public override dbeID( id: DTO['id'] | DBE['id'] ): DBE['id']
    {
        return id as DBE['id'];
    }

    public override dtoID( dbeID: DBE['id'] | DTO['id'] ): DTO['id']
    {
        return dbeID as DTO['id'];
    }

    protected override async pipeline<K extends keyof Extensions['converters']>(
        options: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>> = {},
        conversion?: K,
        method: string = 'list'
    ): Promise<Document[]>
    {
        const preResolvedAccess = ( options as any )?.[RESOLVED_ACCESS] as { denied: boolean, filter?: Filter<DBE> } | undefined;
        const { computedProperties } = this.converters[conversion ?? 'dto'];
        const { sort = { id: -1 }, projection, skip, limit, pipeline: userPipeline } = resolveBSONObject( options );
        const cursor = normalizeCursorOption( options );

        let pipeline: Document[] = [], prefix = '$';

        const [ smartFilter, converterProperties, optionsProperties ] = await Promise.all(
        [
            options.smartFilter
                ? this.resolveSmartFilter( options.smartFilter as any ) as Promise<{ [prefix: string]: { filter?: Filter<any>, pipeline?: Document[] } }>
                : undefined,
            computedProperties ? this.resolveComputedProperties( computedProperties ) : undefined,
            options.computedProperties ? this.resolveComputedProperties( options.computedProperties ) : undefined
        ]);
        const computed = ( converterProperties || optionsProperties )
            ? mergeComputedProperties( converterProperties as any, optionsProperties as any )
            : undefined;

        const gatheredFields = computed
            ? Object.values( computed ).reduce<{ fields: Record<string, any>, pipeline: Document[] }>(( acc, val ) =>
            {
                const fields = { ...acc.fields, ...val?.fields };
                const stages = [ ...acc.pipeline, ...( val?.pipeline || [] ) ];

                return { fields, pipeline: stages };
            }, { fields: {}, pipeline: [] })
            : { fields: {} as Record<string, any>, pipeline: [] as Document[] };

        let computedAddedFields: Record<string, any> = {};

        if( isSet( gatheredFields.fields ) || gatheredFields.pipeline.length > 0 )
        {
            const prefixDot = this.#prefix + '.';

            computedAddedFields = Object.fromEntries(([
                ...( isSet( gatheredFields.fields ) ? collectAddedFields( [{ $addFields: gatheredFields.fields }] ) : [] ),
                ...( gatheredFields.pipeline.length > 0 ? collectAddedFields( gatheredFields.pipeline ) : [] )
            ]).map( f =>
            {
                if( f.startsWith( prefixDot ) )
                {
                    return [ f.slice( prefixDot.length ), 1 ];
                }

                return [ f.split( '.' ).reverse()[0], '$_root.' + f ];
            }));
            computedAddedFields = projectionToReplace( computedAddedFields, this.#prefix ) as Record<string, any>;
        }

        const gatheredPipeline = smartFilter
            ? Object.values( smartFilter ).flatMap( val => val?.pipeline || [] )
            : [];
        const needRoot = gatheredPipeline.length > 0 && getUsedFields( gatheredPipeline ).used.some( el => el.startsWith( '_root.' ));

        const stages = await this.#filterStages( options, method, preResolvedAccess );
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
            pipeline.push( ...await this._pipelineBuilder.pipeline(
            {
                filter              : stages[i],
                smartFilter         : smartFilter?.[tmpPrefix] ? smartFilter?.[tmpPrefix] as { filter?: Filter<RootDBE>, pipeline: Document[] } : undefined,
                computedProperties  : computed?.[tmpPrefix] ? computed[tmpPrefix] : undefined
            }));
            needRoot && last && pipeline.push({ $unset: '_root' });
        }

        let $project: string | Record<string, unknown> = '$' + this.#prefix, $rootProject;

        const { rootProjection, propertyProjection } = this.#splitProjection( projection ?? {});

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

        const prev = cursor?.startsWith( 'prev:' );

        pipeline.push( ...await this._pipelineBuilder.pipeline(
        {
            sort        : prev ? reverseSort( sort ) : sort,
            skip,
            limit,
            pipeline    : userPipeline
        }));

        return pipeline;
    }

    public async create( parentID: any, dbe: Omit<DBE, 'id'>, id?: DTO['id'], options?: ModelCreateOptions ): Promise<DTO['id']>
    {
        return this.runOperation( async() =>
        {
            const access = await this._access.resolveOrDeny({ operation: 'create', method: 'create', access: options?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            const _id: DTO['id'] = id ?? await this.id();
            const parentModel = this._models[GET_PARENT]( this.collection.collectionName, this.#prefix );
            const parent = parentModel
                ? await parentModel.get( parentID, options?.session ? { session: options.session } : undefined )
                : null;

            if( !parent || !parentModel )
            {
                throw new ModelError( 'MODEL_PARENT_NOT_FOUND', this, `Parent document not found: ${parentID}` );
            }

            const start = Date.now();
            const session = this._resolveSession( options?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            let initialDoc = this._applyCreateTimestamps({ id: this.dbeID( _id ), ...dbe }) as Partial<DBE>;

            if( this._softDelete && ( initialDoc as any )[this._softDelete.field] === undefined )
            {
                initialDoc = { ...initialDoc, [this._softDelete.field]: null };
            }

            const hookedData = await this._runBeforeHook( 'beforeCreate',
            {
                operation   : 'create',
                method      : 'create',
                id          : _id,
                parentID,
                data        : initialDoc,
                context     : options?.context,
                traceID     : options?.traceID,
                session
            }, pendingAfterCommit );

            const validated = await this._validateWrite(
                { id: this.dbeID( _id ), ...hookedData } as Partial<DBE>,
                { operation: 'create', method: 'create', id: _id, parentID },
                start,
                options,
                undefined,
                undefined,
                parentID
            );

            const { parentIDPath, updatePath, arrayFilters } = propertyModelUpdateParams( this.#paths, parentModel.dbeID( parentID ));
            const operation = this.#paths[this.#paths.length - 1].array ? '$push' : '$set';

            try
            {
                await this.collection.updateOne(
                    resolveBSONObject({ [parentIDPath]: parentModel.dbeID( parentID ) }) as any,
                    resolveBSONObject({ [operation]: { [updatePath]: { id: this.dbeID( _id ), ...validated } } }),
                    this._withSession( resolveBSONObject({ arrayFilters }), options?.session )
                );

                this._notifySiblingCacheInvalidation();
                await this._runAfterHook( 'afterCreate',
                {
                    operation       : 'create',
                    method          : 'create',
                    id              : _id,
                    parentID,
                    data            : validated,
                    insertedCount   : 1,
                    context         : options?.context,
                    traceID         : options?.traceID,
                    session
                }, pendingAfterCommit );
                this._emitMutation( 'create', Date.now() - start,
                {
                    insertedCount   : 1,
                    ids             : [ _id ],
                    parentID,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return _id;
            }
            catch( e )
            {
                this._emitError( e, 'create', Date.now() - start,
                {
                    parentID,
                    context : options?.context,
                    traceID : options?.traceID
                });

                throw e;
            }
        });
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
                dbe = await this._converters.convertFrom( data, fromKey ) as unknown as Omit<DBE, 'id'> & { id?: DBE['id'] };
            }
            catch( e )
            {
                this._emitError( e, 'createFrom', Date.now() - start,
                {
                    parentID,
                    context : resolvedOptions?.context,
                    traceID : resolvedOptions?.traceID
                });

                throw e;
            }

            const resolvedId = explicitId ?? ( dbe.id !== undefined ? this.dtoID( dbe.id ) as DTO['id'] : undefined );
            const createdId = await this.create( parentID, dbe, resolvedId, resolvedOptions );

            this._emitMutation( 'createFrom', Date.now() - start,
            {
                insertedCount   : 1,
                ids             : [ createdId ],
                parentID,
                context         : resolvedOptions?.context,
                traceID         : resolvedOptions?.traceID
            });

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

            const access = await this._access.resolveOrDeny({ operation: 'create', method: 'createMany', access: resolvedOptions?.access });

            if( access.denied )
            {
                throw new ModelAccessDeniedError( this );
            }

            const parentModel = this._models[GET_PARENT]( this.collection.collectionName, this.#prefix );
            const parent = parentModel
                ? await parentModel.get( parentID, resolvedOptions?.session ? { session: resolvedOptions.session } : undefined )
                : null;

            if( !parent || !parentModel )
            {
                throw new ModelError( 'MODEL_PARENT_NOT_FOUND', this, `Parent document not found: ${parentID}` );
            }

            if( items.length === 0 )
            {
                this._emitMutation( 'createMany', 0,
                {
                    insertedCount   : 0,
                    ids             : [],
                    parentID,
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID
                });

                return [];
            }

            const ids: DTO['id'][] = [];
            const docs: Document[] = [];
            const start = Date.now();
            const now = new Date();
            const session = this._resolveSession( resolvedOptions?.session );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            for( let i = 0; i < items.length; i++ )
            {
                const item = items[i];
                const rawId = explicitIds?.[i] ?? ( item.id !== undefined ? this.dtoID( item.id ) : await this.id());
                const dtoId = this.dtoID( rawId ) as DTO['id'];
                let initialDoc = this._applyCreateTimestamps({ ...item, id: this.dbeID( dtoId ) }, now ) as Partial<DBE>;

                if( this._softDelete && ( initialDoc as any )[this._softDelete.field] === undefined )
                {
                    initialDoc = { ...initialDoc, [this._softDelete.field]: null };
                }

                const hookedData = await this._runBeforeHook( 'beforeCreate',
                {
                    operation   : 'create',
                    method      : 'createMany',
                    id          : dtoId,
                    parentID,
                    data        : initialDoc,
                    context     : resolvedOptions?.context,
                    traceID     : resolvedOptions?.traceID,
                    session
                }, pendingAfterCommit );

                const validated = await this._validateWrite(
                    { ...hookedData, id: this.dbeID( dtoId ) } as Partial<DBE>,
                    { operation: 'create', method: 'createMany', id: dtoId, parentID },
                    start,
                    resolvedOptions,
                    undefined,
                    undefined,
                    parentID
                );

                ids.push( dtoId );
                docs.push( resolveBSONObject({ ...validated, id: this.dbeID( dtoId ) }));
            }

            const { parentIDPath, updatePath, arrayFilters } = propertyModelUpdateParams( this.#paths, parentModel.dbeID( parentID ));
            const isLeafArray = this.#paths[this.#paths.length - 1].array;
            const updatePayload = isLeafArray
                ? { $push: { [updatePath]: { $each: docs } } }
                : { $set: { [updatePath]: docs[docs.length - 1] } };

            try
            {
                await this.collection.updateOne(
                    resolveBSONObject({ [parentIDPath]: parentModel.dbeID( parentID ) }) as any,
                    resolveBSONObject( updatePayload ),
                    this._withSession( resolveBSONObject({ arrayFilters }), resolvedOptions?.session )
                );

                this._notifySiblingCacheInvalidation();
                await this._runAfterHook( 'afterCreate',
                {
                    operation       : 'create',
                    method          : 'createMany',
                    ids,
                    parentID,
                    insertedCount   : docs.length,
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID,
                    session
                }, pendingAfterCommit );
                this._emitMutation( 'createMany', Date.now() - start,
                {
                    insertedCount   : docs.length,
                    ids,
                    parentID,
                    context         : resolvedOptions?.context,
                    traceID         : resolvedOptions?.traceID
                });

                return ids;
            }
            catch( e: any )
            {
                this._emitError( e, 'createMany', Date.now() - start,
                {
                    parentID,
                    context : resolvedOptions?.context,
                    traceID : resolvedOptions?.traceID
                });

                throw e;
            }
        });
    }

    #hasEffectiveSubdocAccessFilter( accessFilter?: Filter<any>, includeDeleted: boolean = false ): boolean
    {
        if( this._softDelete && !includeDeleted ){ return true }

        if( !accessFilter ){ return false }

        const keys = Object.keys( accessFilter );

        if( keys.length === 0 ){ return false }

        return !keys.every( k => k === '_root' || k.startsWith( '_root.' ) );
    }

    public async update( id: DTO['id'] | DBE['id'], update: Partial<DBE> | UpdateFilter<DBE>, options?: ModelUpdateOptions ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'update', access: options?.access });

            if( access.denied )
            {
                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            return this.#updateById( id, update, options, access, false, 'update' );
        });
    }

    async #updateById(
        id: DTO['id'] | DBE['id'],
        update: Partial<DBE> | UpdateFilter<DBE>,
        options: ModelUpdateOptions | undefined,
        access: { denied: boolean, filter?: Filter<any> },
        accessVerified: boolean,
        method: 'update' | 'updateOne' | 'upsert' | 'restore',
        callerFilter?: { filter?: Document, smartFilter?: Record<string, unknown> },
        includeDeleted: boolean = false
    ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        const path = `${this.#prefix}.id`;
        const dbeId = this.dbeID( id );

        if( !accessVerified && this.#hasEffectiveSubdocAccessFilter( access.filter, includeDeleted ) )
        {
            const matchedIds = await this.#findMatchingSubdocIds(
                {
                    filter          : { id: dbeId, ...( callerFilter?.filter ?? {} ) } as any,
                    access          : options?.access,
                    context         : options?.context,
                    traceID         : options?.traceID,
                    session         : options?.session,
                    includeDeleted
                },
                access.filter,
                1,
                method
            );

            if( matchedIds.length === 0 )
            {
                this._invalidateCache([ id ], false );
                this._emitMutation( method, 0,
                {
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    ids             : [ id ],
                    filter          : callerFilter?.filter,
                    smartFilter     : callerFilter?.smartFilter,
                    context         : options?.context,
                    traceID         : options?.traceID
                });

                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }
        }

        const start = Date.now();
        const session = this._resolveSession( options?.session );
        const pendingAfterCommit: Array<() => void | Promise<void>> = [];
        const timestampedUpdate = method === 'restore'
            ? ( update as Record<string, any> )
            : this._applyUpdateTimestamps( update as Record<string, any> );
        const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
        {
            operation   : 'update',
            method,
            id,
            filter      : callerFilter?.filter ?? { [path]: dbeId },
            update      : timestampedUpdate,
            context     : options?.context,
            traceID     : options?.traceID,
            session
        }, pendingAfterCommit );

        const validatedUpdate = method === 'restore'
            ? hookedUpdate
            : await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method, id, filter: callerFilter?.filter },
                start,
                options,
                callerFilter?.filter ?? { [path]: dbeId },
                callerFilter?.smartFilter
            );

        const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, dbeId );
        const operations = addPrefixToUpdate<RootDBE, DBE>( validatedUpdate, updatePrefix );
        const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

        const match: Filter<RootDBE> = access.filter
            ? { $and: [{ [path]: dbeId }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
            : { [path]: dbeId } as Filter<RootDBE>;

        flowGet( 'log' ) && LOG({ match, operations, options: updateOptions });

        const documentBefore = options?.documentBefore ? await this.#fetchSubdocSnapshot( id, dbeId, access, method, options ) : undefined;
        let res: { matchedCount: number, modifiedCount: number };

        try
        {
            res = await this.collection.updateOne(
                resolveBSONObject( match ) as Filter<RootDBE>,
                toUpdateOperations( operations ),
                this._withSession( resolveBSONObject( updateOptions ), options?.session )
            );
        }
        catch( e )
        {
            this._emitError( e, method, Date.now() - start,
            {
                filter      : callerFilter?.filter ?? match,
                smartFilter : callerFilter?.smartFilter,
                context     : options?.context,
                traceID     : options?.traceID
            });

            throw e;
        }

        const duration = Date.now() - start;

        this._invalidateCache([ id ], res.matchedCount > 0 );

        const documentAfter = options?.documentAfter ? await this.#fetchSubdocSnapshot( id, dbeId, access, method, options ) : undefined;

        await this._runAfterHook( 'afterUpdate',
        {
            operation       : 'update',
            method,
            id,
            filter          : callerFilter?.filter ?? match,
            update          : validatedUpdate as Document,
            matchedCount    : res.matchedCount,
            modifiedCount   : res.modifiedCount,
            documentBefore,
            documentAfter,
            context         : options?.context,
            traceID         : options?.traceID,
            session
        }, pendingAfterCommit );

        this._emitMutation( method, duration,
        {
            matchedCount    : res.matchedCount,
            modifiedCount   : res.modifiedCount,
            ids             : [ id ],
            filter          : callerFilter?.filter,
            smartFilter     : callerFilter?.smartFilter,
            context         : options?.context,
            traceID         : options?.traceID
        });

        flowGet( 'log' ) && LOG({ res });

        return { matchedRootCount: res.matchedCount, modifiedRootCount: res.modifiedCount, documentBefore, documentAfter };
    }

    async #fetchSubdocSnapshot(
        id: DBE['id'] | DTO['id'],
        dbeId: DBE['id'],
        access: { denied: boolean, filter?: Filter<any> },
        method: 'update' | 'updateOne' | 'upsert' | 'restore',
        options?: ModelUpdateOptions
    ): Promise<DBE | undefined>
    {
        const { projection } = this.converters.dbe;
        let pipeline = await this.pipeline(
        {
            filter              : { id: dbeId } as any,
            projection,
            access              : options?.access,
            [RESOLVED_ACCESS]   : access
        } as any, 'dbe' as any, 'get' );

        pipeline = this._optimizePipeline( pipeline );

        const start = Date.now();
        let docs: DBE[];

        try
        {
            docs = await this.collection.aggregate(
                pipeline,
                this._withSession({ collation: { locale: 'en' } }, options?.session )
            ).toArray() as DBE[];
        }
        catch( e )
        {
            this._emitError( e, method, Date.now() - start, () => (
            {
                filter  : { id: dbeId },
                query   : { ids: [ id ], access: options?.access },
                context : options?.context,
                traceID : options?.traceID
            }));

            throw e;
        }

        const duration = Date.now() - start;
        const convStart = Date.now();
        const converted = docs[0] ? await this._converters.convert( docs[0], 'dbe' ) as DBE : undefined;
        const converterDuration = Date.now() - convStart;

        this._emitQuery( 'get', pipeline, duration, () => (
        {
            converterDuration,
            resultCount     : docs.length,
            conversion      : 'dbe',
            internal        : true,
            parentOperation : method,
            query           : { ids: [ id ], access: options?.access },
            context         : options?.context,
            traceID         : options?.traceID
        }), { internal: true, parentOperation: method });

        return converted || undefined;
    }

    async #findMatchingSubdocIds(
        findOptions: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        accessFilter?: Filter<any>,
        limit?: number,
        parentOperation: ModelMutationOperation = 'updateMany'
    ): Promise<Array<DBE['id']>>
    {
        const combinedFilter: PropertyModelFilter<RootDBE, DBE> = accessFilter
            ? ( Object.keys( findOptions.filter ?? {} ).length > 0
                ? { $and: [ findOptions.filter, accessFilter ] } as any
                : accessFilter )
            : ( findOptions.filter ?? {} as PropertyModelFilter<RootDBE, DBE> );

        let pipeline = await this.pipeline(
        {
            filter              : combinedFilter,
            smartFilter         : findOptions.smartFilter as any,
            projection          : { id: 1 },
            limit,
            access              : findOptions.access,
            includeDeleted      : findOptions.includeDeleted,
            [RESOLVED_ACCESS]   : { denied: false, filter: undefined },
            [INCLUDE_DELETED]   : findOptions.includeDeleted
        } as any, 'dbe' as any, 'find' );

        pipeline = this._optimizePipeline( pipeline );

        const preStart = Date.now();
        let docs: Array<{ id: DBE['id'] }>;

        try
        {
            docs = await this.collection.aggregate(
                pipeline,
                this._withSession({ collation: { locale: 'en' } }, findOptions.session )
            ).toArray() as Array<{ id: DBE['id'] }>;
        }
        catch( e )
        {
            this._emitError( e, parentOperation, Date.now() - preStart,
            {
                filter      : findOptions.filter,
                smartFilter : findOptions.smartFilter as Record<string, unknown>,
                query       :
                {
                    filter      : findOptions.filter,
                    smartFilter : findOptions.smartFilter as Record<string, unknown>,
                    limit,
                    access      : findOptions.access
                },
                context     : findOptions.context,
                traceID     : findOptions.traceID
            });

            throw e;
        }

        const preDuration = Date.now() - preStart;

        this._emitQuery( 'aggregate', pipeline, preDuration, () => (
        {
            resultCount     : docs.length,
            internal        : true,
            parentOperation,
            query           :
            {
                filter      : findOptions.filter,
                smartFilter : findOptions.smartFilter as Record<string, unknown>,
                limit,
                access      : findOptions.access
            },
            context         : findOptions.context,
            traceID         : findOptions.traceID
        }), { internal: true, parentOperation });

        return docs.map( d => d.id ).filter( id => id !== undefined );
    }

    async #resolveBatchTargetIds(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        findOptions: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>> | undefined,
        accessFilter?: Filter<any>,
        parentOperation: ModelMutationOperation = 'updateMany',
        options?: { access?: string, context?: Record<string, unknown>, traceID?: string, session?: ModelUpdateOptions['session'], includeDeleted?: boolean },
        extraSubdocFilter?: Document
    ): Promise<{ dbeIds: Array<DBE['id']>, cacheIdsToInvalidate: Array<DBE['id'] | DTO['id'] | string> | null }>
    {
        const includeDeleted = Boolean( options?.includeDeleted || findOptions?.includeDeleted );
        const hasSubdocAccess = this.#hasEffectiveSubdocAccessFilter( accessFilter, includeDeleted ) || Boolean( extraSubdocFilter );

        if( Array.isArray( idsOrFilter ) )
        {
            const dbeIds = idsOrFilter.map( id => this.dbeID( id ));

            if( hasSubdocAccess && idsOrFilter.length > 0 )
            {
                const filterObj = extraSubdocFilter
                    ? { $and: [{ id: { $in: dbeIds } }, extraSubdocFilter ] }
                    : { id: { $in: dbeIds } };
                const matchedDbeIds = await this.#findMatchingSubdocIds(
                    {
                        filter          : filterObj as any,
                        access          : options?.access,
                        context         : options?.context,
                        traceID         : options?.traceID,
                        session         : options?.session,
                        includeDeleted
                    },
                    accessFilter,
                    undefined,
                    parentOperation
                );

                return { dbeIds: matchedDbeIds, cacheIdsToInvalidate: idsOrFilter };
            }

            return { dbeIds, cacheIdsToInvalidate: idsOrFilter };
        }

        const rawExtracted = extractTargetIdsFromFilter( idsOrFilter, 'id', id => id );
        const extractedCacheIds = rawExtracted.map( id => String( this.dtoID( id )));
        const filterKeys = Object.keys( findOptions!.filter ?? {});
        const isOnlyIdFilter = Boolean( rawExtracted.length > 0 && !findOptions!.smartFilter && filterKeys.every( k => k === 'id' ));

        if( isOnlyIdFilter && !hasSubdocAccess )
        {
            return {
                cacheIdsToInvalidate    : extractedCacheIds,
                dbeIds                  : rawExtracted.map( id => this.dbeID( id ))
            };
        }

        const effectiveFindOptions: PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>> = extraSubdocFilter
            ? {
                ...findOptions!,
                includeDeleted,
                filter : findOptions!.filter && Object.keys( findOptions!.filter ).length > 0
                    ? ({ $and: [ findOptions!.filter, extraSubdocFilter ] } as any)
                    : ( extraSubdocFilter as any )
            }
            : { ...findOptions!, includeDeleted };

        const matchedDbeIds = await this.#findMatchingSubdocIds( effectiveFindOptions, accessFilter, undefined, parentOperation );

        return {
            cacheIdsToInvalidate    : extractedCacheIds.length > 0 ? extractedCacheIds : matchedDbeIds,
            dbeIds                  : matchedDbeIds
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
            const findOptions = normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( match, options );
            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'updateOne', access: findOptions.access });

            if( access.denied )
            {
                return attachPropertyUpdateMetadata<DBE>({ matchedCount: 0, modifiedCount: 0 });
            }

            const rawTargetIds = extractTargetIdsFromFilter( match, 'id', id => id );
            const cacheIds = rawTargetIds.map( id => String( this.dtoID( id )));
            const filterKeys = Object.keys( findOptions.filter ?? {});
            const isDirectSingleId = Boolean(
                rawTargetIds.length === 1
                && !findOptions.smartFilter
                && !this.#hasEffectiveSubdocAccessFilter( access.filter, false )
                && filterKeys.length === 1
                && filterKeys[0] === 'id'
            );

            let targetId: DTO['id'] | DBE['id'] | undefined = isDirectSingleId ? rawTargetIds[0] : undefined;

            if( targetId === undefined )
            {
                const matchedIds = await this.#findMatchingSubdocIds( findOptions, access.filter, 1, 'updateOne' );
                targetId = matchedIds[0];
            }

            if( targetId === undefined )
            {
                if( cacheIds.length > 0 )
                {
                    this._invalidateCache( cacheIds, false );
                }

                this._emitMutation( 'updateOne', 0,
                {
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    ids             : cacheIds.length > 0 ? cacheIds : undefined,
                    filter          : findOptions.filter,
                    smartFilter     : findOptions.smartFilter as Record<string, unknown>,
                    context         : findOptions.context,
                    traceID         : findOptions.traceID
                });

                return attachPropertyUpdateMetadata<DBE>({ matchedCount: 0, modifiedCount: 0 });
            }

            const res = await this.#updateById(
                targetId,
                update,
                { ...options, access: findOptions.access, context: findOptions.context, traceID: findOptions.traceID, session: findOptions.session },
                access,
                !isDirectSingleId,
                'updateOne',
                { filter: findOptions.filter, smartFilter: findOptions.smartFilter as Record<string, unknown> | undefined }
            );

            const targetDtoId = String( this.dtoID( targetId ));
            const extraIds = cacheIds.filter( id => String( id ) !== targetDtoId );

            if( extraIds.length > 0 )
            {
                this._invalidateCache( extraIds, false );
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

    public async upsert(
        parentID: any,
        filter: PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpsertOptions
    ): Promise<PropertyModelUpsertResponse<DBE, DTO['id']>>;
    public async upsert(
        filter: PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpsertOptions & { parentID?: any }
    ): Promise<PropertyModelUpsertResponse<DBE, DTO['id']>>;
    public async upsert(
        parentIdOrFilter: any,
        filterOrUpdate: any,
        updateOrOptions?: any,
        maybeOptions?: ModelUpsertOptions
    ): Promise<PropertyModelUpsertResponse<DBE, DTO['id']>>
    {
        return this.runOperation( async() =>
        {
            const hasExplicitParent = maybeOptions !== undefined
                || ( updateOrOptions !== undefined && typeof parentIdOrFilter !== 'object' );
            const parentID = hasExplicitParent ? parentIdOrFilter : updateOrOptions?.parentID;
            const rawMatch = hasExplicitParent ? filterOrUpdate : parentIdOrFilter;
            const update = hasExplicitParent ? updateOrOptions : filterOrUpdate;
            const options = ( hasExplicitParent ? maybeOptions : updateOrOptions ) as ModelUpsertOptions | undefined;

            const findOptions = normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( rawMatch, options );
            const scopedFilter = parentID !== undefined
                ? { ...( findOptions.filter ?? {} ), '_root._id': parentID } as any
                : findOptions.filter;

            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'upsert', access: findOptions.access });

            if( access.denied )
            {
                return {
                    id                  : undefined,
                    matchedRootCount    : 0,
                    modifiedRootCount   : 0,
                    matchedCount        : 0,
                    modifiedCount       : 0,
                    upsertedCount       : 0,
                    upserted            : false,
                    created             : false
                };
            }

            const matchedIds = await this.#findMatchingSubdocIds(
                { ...findOptions, filter: scopedFilter },
                access.filter,
                1,
                'upsert'
            );

            if( matchedIds.length > 0 )
            {
                const targetId = matchedIds[0];
                const dtoId = this.dtoID( targetId );
                const res = await this.#updateById(
                    targetId,
                    update,
                    { ...options, access: findOptions.access, context: findOptions.context, traceID: findOptions.traceID, session: findOptions.session },
                    access,
                    true,
                    'upsert',
                    { filter: scopedFilter, smartFilter: findOptions.smartFilter as Record<string, unknown> | undefined }
                );

                return {
                    id                  : dtoId,
                    matchedRootCount    : res.matchedRootCount,
                    modifiedRootCount   : res.modifiedRootCount,
                    matchedCount        : res.matchedRootCount,
                    modifiedCount       : res.modifiedRootCount,
                    upsertedCount       : 0,
                    upserted            : false,
                    created             : false,
                    documentBefore      : res.documentBefore,
                    documentAfter       : res.documentAfter
                };
            }

            const targetParentId = parentID ?? ( findOptions.filter as any )?.['_root._id'];

            if( targetParentId === undefined )
            {
                throw new ModelError( 'MODEL_PARENT_NOT_FOUND', this, 'Parent document ID is required when upserting a new PropertyModel subdocument' );
            }

            const baseDoc: Record<string, any> = {};

            for( const [ k, v ] of Object.entries( findOptions.filter ?? {} ) )
            {
                if( !k.startsWith( '$' ) && !k.startsWith( '_root' ) && ( typeof v !== 'object' || v === null || !( Object.keys( v ).some( ok => ok.startsWith( '$' ) ) ) ) )
                {
                    baseDoc[k] = v;
                }
            }

            const updateObj = update as Record<string, any>;

            if( updateObj && typeof updateObj === 'object' )
            {
                if( updateObj.$set && typeof updateObj.$set === 'object' )
                {
                    Object.assign( baseDoc, updateObj.$set );
                }

                if( updateObj.$setOnInsert && typeof updateObj.$setOnInsert === 'object' )
                {
                    for( const [ k, v ] of Object.entries( updateObj.$setOnInsert ) )
                    {
                        if( baseDoc[k] === undefined )
                        {
                            baseDoc[k] = v;
                        }
                    }
                }

                for( const [ k, v ] of Object.entries( updateObj ) )
                {
                    if( !k.startsWith( '$' ) )
                    {
                        baseDoc[k] = v;
                    }
                }
            }

            const explicitId = baseDoc.id !== undefined ? this.dtoID( baseDoc.id ) : undefined;
            const createdId = await this.create( targetParentId, baseDoc as Omit<DBE, 'id'>, explicitId,
            {
                access  : findOptions.access,
                context : findOptions.context,
                traceID : findOptions.traceID,
                session : findOptions.session
            });

            const documentAfter = options?.documentAfter
                ? await this.#fetchSubdocSnapshot( createdId, this.dbeID( createdId ), access, 'upsert', options )
                : undefined;

            return {
                id                  : createdId,
                matchedRootCount    : 0,
                modifiedRootCount   : 1,
                matchedCount        : 0,
                modifiedCount       : 0,
                upsertedCount       : 1,
                upsertedId          : createdId,
                upserted            : true,
                created             : true,
                documentAfter
            };
        });
    }

    async updateMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        update: Partial<DBE> | UpdateFilter<DBE>,
        options?: ModelUpdateOptions
    ): Promise<PropertyModelUpdateResponse<DBE>>
    {
        return this.runOperation( async() =>
        {
            const path = `${this.#prefix}.id`;
            const isIdArray = Array.isArray( idsOrFilter );
            const findOptions = !isIdArray ? normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( idsOrFilter, options ) : undefined;
            const effectiveAccess = isIdArray ? options?.access : findOptions?.access;
            const effectiveContext = isIdArray ? options?.context : findOptions?.context;
            const effectiveTraceID = isIdArray ? options?.traceID : findOptions?.traceID;
            const effectiveSession = isIdArray ? options?.session : findOptions?.session;

            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'updateMany', access: effectiveAccess });

            if( access.denied )
            {
                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            const { dbeIds, cacheIdsToInvalidate } = await this.#resolveBatchTargetIds(
                idsOrFilter,
                findOptions,
                access.filter,
                'updateMany',
                options
            );

            if( dbeIds.length === 0 )
            {
                if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
                {
                    this._invalidateCache( cacheIdsToInvalidate, false );
                }

                this._emitMutation( 'updateMany', 0,
                {
                    matchedCount    : 0,
                    modifiedCount   : 0,
                    ids             : cacheIdsToInvalidate ?? undefined,
                    filter          : findOptions?.filter,
                    smartFilter     : findOptions?.smartFilter as Record<string, unknown>,
                    context         : effectiveContext,
                    traceID         : effectiveTraceID
                });

                return { matchedRootCount: 0, modifiedRootCount: 0 };
            }

            const start = Date.now();
            const session = this._resolveSession( effectiveSession );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];
            const timestampedUpdate = this._applyUpdateTimestamps( update as Record<string, any> );
            const hookedUpdate = await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'updateMany',
                ids         : cacheIdsToInvalidate ?? dbeIds,
                filter      : findOptions?.filter,
                update      : timestampedUpdate,
                context     : effectiveContext,
                traceID     : effectiveTraceID,
                session
            }, pendingAfterCommit );

            const validatedUpdate = await this._validateWrite(
                hookedUpdate,
                { operation: 'update', method: 'updateMany', ids: cacheIdsToInvalidate ?? dbeIds, filter: findOptions?.filter },
                start,
                { ...options, context: effectiveContext, traceID: effectiveTraceID },
                findOptions?.filter,
                findOptions?.smartFilter as Record<string, unknown>
            );

            const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, { $in: dbeIds });
            const operations = addPrefixToUpdate<RootDBE, DBE>( validatedUpdate, updatePrefix );
            const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: { $in: dbeIds } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: { $in: dbeIds } } as Filter<RootDBE>;

            flowGet( 'log' ) && LOG({ match, operations, options: updateOptions });

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateMany(
                    resolveBSONObject( match ) as Filter<RootDBE>,
                    toUpdateOperations( operations ),
                    this._withSession( resolveBSONObject( updateOptions ), effectiveSession )
                );
            }
            catch( e )
            {
                this._emitError( e, 'updateMany', Date.now() - start,
                {
                    filter      : findOptions?.filter ?? match,
                    smartFilter : findOptions?.smartFilter as Record<string, unknown>,
                    context     : effectiveContext,
                    traceID     : effectiveTraceID
                });

                throw e;
            }

            if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
            {
                this._invalidateCache( cacheIdsToInvalidate, res.matchedCount > 0 );
            }

            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'updateMany',
                ids             : cacheIdsToInvalidate ?? dbeIds,
                filter          : findOptions?.filter ?? match,
                update          : validatedUpdate as Document,
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                context         : effectiveContext,
                traceID         : effectiveTraceID,
                session
            }, pendingAfterCommit );

            this._emitMutation( 'updateMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                ids             : cacheIdsToInvalidate ?? undefined,
                filter          : findOptions?.filter,
                smartFilter     : findOptions?.smartFilter as Record<string, unknown>,
                context         : effectiveContext,
                traceID         : effectiveTraceID
            });

            flowGet( 'log' ) && LOG({ res });

            return { matchedRootCount: res.matchedCount, modifiedRootCount: res.modifiedCount };
        });
    }

    public async delete( id: DTO['id'] | DBE['id'], options?: ModelDeleteOptions ): Promise<boolean>
    {
        return this.#executeDeleteById( id, options, options?.hard ? 'hardDelete' : 'delete' );
    }

    public async hardDelete( id: DTO['id'] | DBE['id'], options?: Omit<ModelDeleteOptions, 'hard'> ): Promise<boolean>
    {
        return this.#executeDeleteById( id, { ...options, hard: true }, 'hardDelete' );
    }

    async #executeDeleteById(
        id: DTO['id'] | DBE['id'],
        options: ModelDeleteOptions | undefined,
        method: 'delete' | 'hardDelete'
    ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            const access = await this._access.resolveOrDeny({ operation: 'delete', method, access: options?.access });

            if( access.denied )
            {
                return false;
            }

            const isSoft = Boolean( this._softDelete && !options?.hard );
            const dbeId = this.dbeID( id );

            if( this.#hasEffectiveSubdocAccessFilter( access.filter, !isSoft ) )
            {
                const matchedIds = await this.#findMatchingSubdocIds(
                    {
                        filter          : { id: dbeId } as any,
                        access          : options?.access,
                        context         : options?.context,
                        traceID         : options?.traceID,
                        session         : options?.session,
                        includeDeleted  : !isSoft
                    },
                    access.filter,
                    1,
                    method
                );

                if( matchedIds.length === 0 )
                {
                    this._invalidateCache([ id ], false );
                    this._emitMutation( method, 0,
                    {
                        matchedCount    : 0,
                        modifiedCount   : 0,
                        deletedCount    : 0,
                        ids             : [ id ],
                        context         : options?.context,
                        traceID         : options?.traceID
                    });

                    return false;
                }
            }

            const path = `${this.#prefix}.id`;
            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: dbeId }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: dbeId } as Filter<RootDBE>;

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

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                if( isSoft )
                {
                    const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps );
                    const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, dbeId );
                    const operations = addPrefixToUpdate<RootDBE, DBE>( softUpdate as any, updatePrefix );
                    const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

                    res = await this.collection.updateOne(
                        resolveBSONObject( match ) as Filter<RootDBE>,
                        toUpdateOperations( operations ),
                        this._withSession( resolveBSONObject( updateOptions ), options?.session )
                    );
                }
                else
                {
                    const { operations, updateOptions } = buildPropertyDeleteOperation<RootDBE>( this.#paths, dbeId );

                    res = await this.collection.updateOne(
                        resolveBSONObject( match ) as Filter<RootDBE>,
                        resolveBSONObject( operations ) as UpdateFilter<RootDBE>,
                        this._withSession( resolveBSONObject( updateOptions ), options?.session )
                    );
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

            const deletedCount = res.modifiedCount ?? res.matchedCount ?? 0;

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
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                deletedCount,
                ids             : [ id ],
                context         : options?.context,
                traceID         : options?.traceID
            });

            return deletedCount > 0;
        });
    }

    public async deleteMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options?: ModelDeleteOptions
    ): Promise<number>
    {
        return this.#executeDeleteMany( idsOrFilter, options, options?.hard ? 'hardDeleteMany' : 'deleteMany' );
    }

    public async hardDeleteMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options?: Omit<ModelDeleteOptions, 'hard'>
    ): Promise<number>
    {
        return this.#executeDeleteMany( idsOrFilter, { ...options, hard: true }, 'hardDeleteMany' );
    }

    async #executeDeleteMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options: ModelDeleteOptions | undefined,
        method: 'deleteMany' | 'hardDeleteMany'
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            const isSoft = Boolean( this._softDelete && !options?.hard );
            const isIdArray = Array.isArray( idsOrFilter );
            const findOptions = !isIdArray ? normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( idsOrFilter, options ) : undefined;
            const effectiveAccess = isIdArray ? options?.access : findOptions?.access;
            const effectiveContext = isIdArray ? options?.context : findOptions?.context;
            const effectiveTraceID = isIdArray ? options?.traceID : findOptions?.traceID;
            const effectiveSession = isIdArray ? options?.session : findOptions?.session;

            const access = await this._access.resolveOrDeny({ operation: 'delete', method, access: effectiveAccess });

            if( access.denied )
            {
                return 0;
            }

            const { dbeIds, cacheIdsToInvalidate } = await this.#resolveBatchTargetIds(
                idsOrFilter,
                findOptions,
                access.filter,
                method,
                { ...options, includeDeleted: !isSoft }
            );

            if( dbeIds.length === 0 )
            {
                if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
                {
                    this._invalidateCache( cacheIdsToInvalidate, false );
                }

                this._emitMutation( method, 0,
                {
                    deletedCount : 0,
                    ids          : cacheIdsToInvalidate ?? undefined,
                    filter       : findOptions?.filter,
                    smartFilter  : findOptions?.smartFilter as Record<string, unknown>,
                    context      : effectiveContext,
                    traceID      : effectiveTraceID
                });

                return 0;
            }

            const path = `${this.#prefix}.id`;
            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: { $in: dbeIds } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: { $in: dbeIds } } as Filter<RootDBE>;

            const start = Date.now();
            const session = this._resolveSession( effectiveSession );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeDelete',
            {
                operation   : 'delete',
                method,
                ids         : cacheIdsToInvalidate ?? dbeIds,
                filter      : findOptions?.filter ?? match,
                context     : effectiveContext,
                traceID     : effectiveTraceID,
                session
            }, pendingAfterCommit );

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                if( isSoft )
                {
                    const softUpdate = buildSoftDeleteUpdate( this._softDelete!, this._timestamps );
                    const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, { $in: dbeIds });
                    const operations = addPrefixToUpdate<RootDBE, DBE>( softUpdate as any, updatePrefix );
                    const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

                    res = await this.collection.updateMany(
                        resolveBSONObject( match ) as Filter<RootDBE>,
                        toUpdateOperations( operations ),
                        this._withSession( resolveBSONObject( updateOptions ), effectiveSession )
                    );
                }
                else
                {
                    const { operations, updateOptions } = buildPropertyDeleteOperation<RootDBE>( this.#paths, { $in: dbeIds });

                    res = await this.collection.updateMany(
                        resolveBSONObject( match ) as Filter<RootDBE>,
                        resolveBSONObject( operations ) as UpdateFilter<RootDBE>,
                        this._withSession( resolveBSONObject( updateOptions ), effectiveSession )
                    );
                }
            }
            catch( e )
            {
                this._emitError( e, method, Date.now() - start,
                {
                    filter      : findOptions?.filter ?? match,
                    smartFilter : findOptions?.smartFilter as Record<string, unknown>,
                    context     : effectiveContext,
                    traceID     : effectiveTraceID
                });

                throw e;
            }

            const deletedCount = res.modifiedCount ?? res.matchedCount ?? 0;

            if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
            {
                this._invalidateCache( cacheIdsToInvalidate, deletedCount > 0 );
            }

            await this._runAfterHook( 'afterDelete',
            {
                operation   : 'delete',
                method,
                ids         : cacheIdsToInvalidate ?? dbeIds,
                filter      : findOptions?.filter ?? match,
                deletedCount,
                context     : effectiveContext,
                traceID     : effectiveTraceID,
                session
            }, pendingAfterCommit );

            this._emitMutation( method, Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount   : res.modifiedCount,
                deletedCount,
                ids             : cacheIdsToInvalidate ?? undefined,
                filter          : findOptions?.filter,
                smartFilter     : findOptions?.smartFilter as Record<string, unknown>,
                context         : effectiveContext,
                traceID         : effectiveTraceID
            });

            return deletedCount;
        });
    }

    public async restore( id: DTO['id'] | DBE['id'], options?: Omit<ModelDeleteOptions, 'hard'> ): Promise<boolean>
    {
        return this.runOperation( async() =>
        {
            if( !this._softDelete ){ return false }

            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'restore', access: options?.access });

            if( access.denied ){ return false }

            const restoreUpdate = buildRestoreUpdate( this._softDelete, this._timestamps );
            const res = await this.#updateById(
                id,
                restoreUpdate as any,
                options,
                access,
                false,
                'restore',
                { filter: { [this._softDelete.field]: { $nin: [ null, false ] } } },
                true
            );

            return ( res.modifiedRootCount ?? res.matchedRootCount ?? 0 ) > 0;
        });
    }

    public async restoreMany(
        idsOrFilter: DBE['id'][] | DTO['id'][] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>>,
        options?: Omit<ModelDeleteOptions, 'hard'>
    ): Promise<number>
    {
        return this.runOperation( async() =>
        {
            if( !this._softDelete ){ return 0 }

            const isIdArray = Array.isArray( idsOrFilter );
            const findOptions = !isIdArray ? normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( idsOrFilter, options ) : undefined;
            const effectiveAccess = isIdArray ? options?.access : findOptions?.access;
            const effectiveContext = isIdArray ? options?.context : findOptions?.context;
            const effectiveTraceID = isIdArray ? options?.traceID : findOptions?.traceID;
            const effectiveSession = isIdArray ? options?.session : findOptions?.session;

            const access = await this._access.resolveOrDeny({ operation: 'update', method: 'restoreMany', access: effectiveAccess });

            if( access.denied ){ return 0 }

            const deletedOnlyFilter = { [this._softDelete.field]: { $nin: [ null, false ] } };
            const { dbeIds, cacheIdsToInvalidate } = await this.#resolveBatchTargetIds(
                idsOrFilter,
                findOptions,
                access.filter,
                'restoreMany',
                { ...options, includeDeleted: true },
                deletedOnlyFilter
            );

            if( dbeIds.length === 0 ){ return 0 }

            const path = `${this.#prefix}.id`;
            const match: Filter<RootDBE> = access.filter
                ? { $and: [{ [path]: { $in: dbeIds } }, addPrefixToFilter( access.filter as any, this.#prefix ) ] } as any
                : { [path]: { $in: dbeIds } } as Filter<RootDBE>;

            const restoreUpdate = buildRestoreUpdate( this._softDelete, this._timestamps );
            const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( this.#paths, { $in: dbeIds });
            const operations = addPrefixToUpdate<RootDBE, DBE>( restoreUpdate as any, updatePrefix );
            const updateOptions: UpdateOptions = arrayFilters ? { arrayFilters } : {};

            const start = Date.now();
            const session = this._resolveSession( effectiveSession );
            const pendingAfterCommit: Array<() => void | Promise<void>> = [];

            await this._runBeforeHook( 'beforeUpdate',
            {
                operation   : 'update',
                method      : 'restoreMany',
                ids         : cacheIdsToInvalidate ?? dbeIds,
                filter      : findOptions?.filter ?? match,
                update      : restoreUpdate,
                context     : effectiveContext,
                traceID     : effectiveTraceID,
                session
            }, pendingAfterCommit );

            let res: { matchedCount: number, modifiedCount: number };

            try
            {
                res = await this.collection.updateMany(
                    resolveBSONObject( match ) as Filter<RootDBE>,
                    toUpdateOperations( operations ),
                    this._withSession( resolveBSONObject( updateOptions ), effectiveSession )
                );
            }
            catch( e )
            {
                this._emitError( e, 'restoreMany', Date.now() - start,
                {
                    filter      : findOptions?.filter ?? match,
                    smartFilter : findOptions?.smartFilter as Record<string, unknown>,
                    context     : effectiveContext,
                    traceID     : effectiveTraceID
                });

                throw e;
            }

            const modifiedCount = res.modifiedCount ?? res.matchedCount ?? 0;

            if( cacheIdsToInvalidate && cacheIdsToInvalidate.length > 0 )
            {
                this._invalidateCache( cacheIdsToInvalidate, modifiedCount > 0 );
            }

            await this._runAfterHook( 'afterUpdate',
            {
                operation       : 'update',
                method          : 'restoreMany',
                ids             : cacheIdsToInvalidate ?? dbeIds,
                filter          : findOptions?.filter ?? match,
                update          : restoreUpdate,
                matchedCount    : res.matchedCount,
                modifiedCount,
                context         : effectiveContext,
                traceID         : effectiveTraceID,
                session
            }, pendingAfterCommit );

            this._emitMutation( 'restoreMany', Date.now() - start,
            {
                matchedCount    : res.matchedCount,
                modifiedCount,
                ids             : cacheIdsToInvalidate ?? undefined,
                filter          : findOptions?.filter,
                smartFilter     : findOptions?.smartFilter as Record<string, unknown>,
                context         : effectiveContext,
                traceID         : effectiveTraceID
            });

            return modifiedCount;
        });
    }

    public async bulkWrite(
        operations: Array<PropertyModelBulkWriteOperation<RootDBE, DBE, DTO['id'], ExtractSmartFilters<Extensions>>>,
        options?: ModelBulkWriteOptions
    ): Promise<ModelBulkWriteResult<DTO['id']>>
    {
        return this.runOperation( async() =>
        {
            const start = Date.now();
            const insertedIds: DTO['id'][] = [];
            const upsertedIds: Record<number, DTO['id']> = {};
            let insertedCount = 0;
            let matchedCount = 0;
            let modifiedCount = 0;
            let deletedCount = 0;
            let upsertedCount = 0;

            for( let i = 0; i < operations.length; i++ )
            {
                const op = operations[i];

                if( 'create' in op )
                {
                    const createdId = await this.create( op.create.parentID, op.create.data, op.create.id, options );

                    insertedIds.push( createdId );
                    insertedCount++;
                }
                else if( 'update' in op )
                {
                    const res = await this.update( op.update.id, op.update.update, options );

                    matchedCount += res.matchedRootCount;
                    modifiedCount += res.modifiedRootCount;
                }
                else if( 'updateOne' in op )
                {
                    const res = await this.updateOne( op.updateOne.filter as any, op.updateOne.update, options );

                    matchedCount += res.matchedCount;
                    modifiedCount += res.modifiedCount;
                }
                else if( 'updateMany' in op )
                {
                    const res = await this.updateMany( op.updateMany.filter as any, op.updateMany.update, options );

                    matchedCount += res.matchedRootCount;
                    modifiedCount += res.modifiedRootCount;
                }
                else if( 'delete' in op )
                {
                    const deleted = await this.delete( op.delete.id, { ...options, hard: op.delete.hard });

                    if( deleted ){ deletedCount++ }
                }
                else if( 'deleteOne' in op )
                {
                    const findOptions = normalizeFindMatch<PropertyModelFilter<RootDBE, DBE>>( op.deleteOne.filter as any, options );
                    const access = await this._access.resolveOrDeny({ operation: 'delete', method: 'bulkWrite', access: findOptions.access });

                    if( !access.denied )
                    {
                        const matched = await this.#findMatchingSubdocIds(
                            { ...findOptions, includeDeleted: Boolean( op.deleteOne.hard ) },
                            access.filter,
                            1,
                            'bulkWrite'
                        );

                        if( matched.length > 0 )
                        {
                            const deleted = await this.delete( matched[0], { ...options, hard: op.deleteOne.hard });

                            if( deleted ){ deletedCount++ }
                        }
                    }
                }
                else if( 'deleteMany' in op )
                {
                    const count = await this.deleteMany( op.deleteMany.filter as any, { ...options, hard: op.deleteMany.hard });

                    deletedCount += count;
                }
            }

            this._emitMutation( 'bulkWrite', Date.now() - start,
            {
                insertedCount,
                matchedCount,
                modifiedCount,
                deletedCount,
                upsertedCount,
                ids     : insertedIds.length > 0 ? insertedIds : undefined,
                context : options?.context,
                traceID : options?.traceID
            });

            return {
                insertedCount,
                matchedCount,
                modifiedCount,
                deletedCount,
                upsertedCount,
                insertedIds,
                upsertedIds
            };
        });
    }

    async #filterStages(
        list: PropertyModelListOptions<RootDBE, DBE, ExtractSmartFilters<Extensions>, ExtractComputedProperties<Extensions>>,
        method: string = 'list',
        preResolvedAccess?: { denied: boolean, filter?: Filter<DBE> }
    )
    {
        const sort = list.sort ?? { id: -1 };
        const access = preResolvedAccess ?? await this._access.resolveOrDeny({ operation: 'read', method, access: list.access });
        const accessFilter = access.denied ? { '_root._id': { $exists: false }, id: { $exists: false } } : access.filter;
        const includeDeleted = Boolean( list.includeDeleted || ( list as any )?.[INCLUDE_DELETED] );
        const softDeleteFilter = this._softDeleteFilter( includeDeleted );
        const cursor = normalizeCursorOption( list );
        const cursorFilter = cursor ? generateCursorCondition( cursor, sort ) : undefined;
        const stageFilter = optimizeMatch( resolveBSONObject(
        {
            $and: [ addPrefixToFilter({ $and: [ list.filter, accessFilter, softDeleteFilter, cursorFilter ] }, this.#prefix ) ]
        }) as Filter<DBE> );

        return splitFilterToStages( stageFilter as Filter<DBE>, this.#paths ) as Filter<RootDBE>[];
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
