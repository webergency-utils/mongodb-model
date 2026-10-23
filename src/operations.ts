import { ClientSession, Document, Filter, ObjectId, UpdateFilter, UpdateOptions } from 'mongodb';
import { getCursor, isForeignObjectIdLike, isLibraryObjectId, isUpdateOperator, propertyModelTargetUpdateParams } from './helpers/mongo.js';
import { ConverterManager } from './converters.js';
import { ModelValidationError } from './errors.js';
import
{
    GetManyOptions,
    GetOptions,
    ListResult,
    ModelChangeEvent,
    ModelChangeStream,
    ModelCreateOptions,
    ModelExplainResult,
    ModelIndexDefinition,
    ModelIndexSpecification,
    ModelSoftDeleteConfig,
    ModelTimestampsConfig,
    ModelValidationContext,
    ModelValidationOperation,
    ModelValidatorConfig,
    ModelValidatorFn,
    ModelValidatorInput,
    ModelVersioningConfig,
    NormalizedModelIndex,
    PopulateSpec,
    PropertyModelUpdateResponse,
    WithTotal
}
from './types/external.js';

export function combineMongoFilters<T = Document>( ...filters: Array<Filter<T> | Document | undefined | null> ): Filter<T> | undefined
{
    const nonEmpty = filters.filter(( f ): f is Filter<T> => Boolean( f && typeof f === 'object' && Object.keys( f ).length > 0 ));

    if( nonEmpty.length === 0 )
    {
        return undefined;
    }

    if( nonEmpty.length === 1 )
    {
        return nonEmpty[0];
    }

    return { $and: nonEmpty } as unknown as Filter<T>;
}

export function attachListMetadata<T>(
    items: T[],
    total: number | undefined,
    cursors: { prev?: string, next?: string }
): WithTotal<T[]>
{
    const nextCursor = cursors.next ? `next:${cursors.next}` : undefined;
    const prevCursor = cursors.prev ? `prev:${cursors.prev}` : undefined;

    Object.defineProperties( items,
    {
        items       : { value: items, enumerable: false, writable: false, configurable: true },
        total       : { value: total, enumerable: false, writable: false, configurable: true },
        cursors     : { value: cursors, enumerable: false, writable: false, configurable: true },
        nextCursor  : { value: nextCursor, enumerable: false, writable: false, configurable: true },
        prevCursor  : { value: prevCursor, enumerable: false, writable: false, configurable: true }
    });

    return items as WithTotal<T[]>;
}

export function normalizeCursorOption( options?: { cursor?: string, after?: string, before?: string } ): string | undefined
{
    if( !options ){ return undefined }

    if( options.cursor !== undefined )
    {
        return options.cursor;
    }

    if( options.after !== undefined )
    {
        return options.after.startsWith( 'next:' ) || options.after.startsWith( 'prev:' )
            ? options.after
            : `next:${options.after}`;
    }

    if( options.before !== undefined )
    {
        return options.before.startsWith( 'prev:' ) || options.before.startsWith( 'next:' )
            ? options.before
            : `prev:${options.before}`;
    }

    return undefined;
}

export function attachCursorToItem<T>( dto: T, dbe: Document, sort: Document ): T & { $cursor?: string }
{
    if( dto && typeof dto === 'object' )
    {
        Object.defineProperty( dto, '$cursor',
        {
            value        : getCursor( dbe, sort ),
            enumerable   : false,
            writable     : true,
            configurable : true
        });
    }

    return dto as T & { $cursor?: string };
}

const FIND_OPTION_KEYS = new Set([ 'filter', 'smartFilter', 'populate', 'cursor', 'after', 'before', 'includeDeleted', 'access', 'context', 'traceID', 'session' ]);

export function isCreateOptionsObject( v: unknown ): v is ModelCreateOptions
{
    return typeof v === 'object'
        && v !== null
        && !Array.isArray( v )
        && !isLibraryObjectId( v )
        && !isForeignObjectIdLike( v )
        && ( 'duplicateIgnore' in v || 'access' in v || 'context' in v || 'traceID' in v || 'session' in v );
}

export function resolveCreateFromArgs<ID>(
    fromMap: Record<string, unknown> | undefined,
    fromKeyOrId?: string | ID | ModelCreateOptions,
    idOrOptions?: ID | ModelCreateOptions,
    options?: ModelCreateOptions
): { fromKey?: string, explicitId?: ID, resolvedOptions?: ModelCreateOptions }
{
    if( isCreateOptionsObject( fromKeyOrId ) )
    {
        return { resolvedOptions: fromKeyOrId };
    }

    const isKnownKey = typeof fromKeyOrId === 'string' && Boolean( fromMap && fromKeyOrId in fromMap );
    const isInferredKey = typeof fromKeyOrId === 'string' && !isKnownKey && (
        ( idOrOptions !== undefined && !isCreateOptionsObject( idOrOptions ))
        || options !== undefined
        || !fromMap
        || ( !( 'default' in fromMap ) && ( Object.keys( fromMap ).length !== 1 || !ObjectId.isValid( fromKeyOrId )))
    );

    if( isKnownKey || isInferredKey )
    {
        if( isCreateOptionsObject( idOrOptions ) )
        {
            return { fromKey: fromKeyOrId as string, resolvedOptions: idOrOptions };
        }

        return {
            fromKey         : fromKeyOrId as string,
            explicitId      : idOrOptions as ID | undefined,
            resolvedOptions : options
        };
    }

    return {
        explicitId      : fromKeyOrId as ID | undefined,
        resolvedOptions : isCreateOptionsObject( idOrOptions ) ? idOrOptions : options
    };
}

export function isFindOptionsObject( match: unknown ): match is { filter?: unknown, smartFilter?: unknown, populate?: PopulateSpec, cursor?: string, after?: string, before?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession }
{
    return Boolean(
        match
        && typeof match
        === 'object'
        && !Array.isArray( match )
        && !isLibraryObjectId( match )
        && !isForeignObjectIdLike( match )
        && (
            'filter' in match
            || 'smartFilter' in match
            || 'populate' in match
            || 'cursor' in match
            || 'after' in match
            || 'before' in match
            || 'includeDeleted' in match
            || (( 'access' in match || 'session' in match ) && Object.keys( match ).every( k => FIND_OPTION_KEYS.has( k ) ))
        )
    );
}

export function normalizeFindMatch<FilterType = Record<string, any>, SmartFilterType = any>(
    match: FilterType | { filter?: FilterType, smartFilter?: SmartFilterType, populate?: PopulateSpec, cursor?: string, after?: string, before?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession },
    optionsOrAccess?: string | { populate?: PopulateSpec, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession }
): { filter: FilterType, smartFilter?: SmartFilterType, populate?: PopulateSpec, cursor?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession }
{
    const opts = typeof optionsOrAccess === 'string' ? { access: optionsOrAccess } : optionsOrAccess;

    if( isFindOptionsObject( match ) )
    {
        const context = opts?.context && match.context
            ? { ...match.context, ...opts.context }
            : ( opts?.context ?? match.context );
        const traceID = opts?.traceID ?? match.traceID;
        const session = opts?.session ?? match.session;
        const includeDeleted = opts?.includeDeleted ?? match.includeDeleted;
        const populate = opts?.populate ?? match.populate;
        const cursor = normalizeCursorOption( match );

        return {
            filter      : ( match.filter ?? {} ) as FilterType,
            smartFilter : match.smartFilter as SmartFilterType | undefined,
            access      : opts?.access ?? match.access,
            ...( populate !== undefined ? { populate } : {} ),
            ...( cursor !== undefined ? { cursor } : {} ),
            ...( includeDeleted !== undefined ? { includeDeleted } : {} ),
            ...( context !== undefined ? { context } : {} ),
            ...( traceID !== undefined ? { traceID } : {} ),
            ...( session !== undefined ? { session } : {} )
        };
    }

    return {
        filter : ( match ?? {} ) as FilterType,
        access : opts?.access,
        ...( opts?.populate !== undefined ? { populate: opts.populate } : {} ),
        ...( opts?.includeDeleted !== undefined ? { includeDeleted: opts.includeDeleted } : {} ),
        ...( opts?.context !== undefined ? { context: opts.context } : {} ),
        ...( opts?.traceID !== undefined ? { traceID: opts.traceID } : {} ),
        ...( opts?.session !== undefined ? { session: opts.session } : {} )
    };
}

export function normalizeExistsOptions<FilterType = Record<string, any>, SmartFilterType = any>(
    idOrFilter: unknown,
    idKey: '_id' | 'id',
    dbeID: ( id: any ) => any,
    optionsOrAccess?: string | { includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession }
): { filter: FilterType, smartFilter?: SmartFilterType, cursor?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession, isPrimitiveId?: boolean }
{
    if( idOrFilter === undefined || idOrFilter === null )
    {
        return normalizeFindMatch<FilterType, SmartFilterType>( undefined as any, optionsOrAccess );
    }

    if(
        typeof idOrFilter === 'string'
        || typeof idOrFilter === 'number'
        || isLibraryObjectId( idOrFilter )
        || isForeignObjectIdLike( idOrFilter )
    )
    {
        return {
            ...normalizeFindMatch<FilterType, SmartFilterType>(
                { [idKey]: dbeID( idOrFilter ) } as unknown as FilterType,
                optionsOrAccess
            ),
            isPrimitiveId : true
        };
    }

    return normalizeFindMatch<FilterType, SmartFilterType>( idOrFilter as any, optionsOrAccess );
}

export function normalizeGetOptions<K extends string | number | symbol = 'dto'>( optionsOrConversion?: GetOptions<K> | K ): GetOptions<K>
{
    if( optionsOrConversion !== undefined && ( typeof optionsOrConversion !== 'object' || optionsOrConversion === null ) )
    {
        return { as: optionsOrConversion as K };
    }

    return ( optionsOrConversion ?? {} ) as GetOptions<K>;
}

export function normalizeGetManyOptions<K extends string | number | symbol = 'dto'>(
    optionsOrConversion?: GetManyOptions<K> | K,
    filtered?: boolean
): GetManyOptions<K>
{
    if( optionsOrConversion !== undefined && ( typeof optionsOrConversion !== 'object' || optionsOrConversion === null ) )
    {
        return { as: optionsOrConversion as K, filter: filtered };
    }

    return {
        ...( optionsOrConversion as GetManyOptions<K> | undefined ),
        ...( filtered !== undefined ? { filter: filtered } : {} )
    };
}

export function attachPropertyUpdateMetadata<DBE extends Document>(
    res: { matchedCount: number, modifiedCount: number, documentBefore?: DBE, documentAfter?: DBE }
): PropertyModelUpdateResponse<DBE> & { matchedCount: number, modifiedCount: number }
{
    const out: any =
    {
        matchedCount    : res.matchedCount,
        modifiedCount   : res.modifiedCount
    };

    if( res.documentBefore !== undefined ){ out.documentBefore = res.documentBefore }
    if( res.documentAfter !== undefined ){ out.documentAfter = res.documentAfter }

    Object.defineProperties( out,
    {
        matchedRootCount    : { value: res.matchedCount, enumerable: false, writable: true, configurable: true },
        modifiedRootCount   : { value: res.modifiedCount, enumerable: false, writable: true, configurable: true }
    });

    return out;
}

export function buildPropertyDeleteOperation<RootDBE extends Document>(
    paths: Array<{ path: string, array: boolean }>,
    dbeIdOrCondition: any
): { operations: UpdateFilter<RootDBE>, updateOptions: UpdateOptions }
{
    const leaf = paths[paths.length - 1];

    if( leaf.array )
    {
        const ancestorPrefix = paths.slice( 0, -1 ).map( p => p.path + ( p.array ? '.$[]' : '' )).join( '.' );
        const pullPath = ( ancestorPrefix ? ancestorPrefix + '.' : '' ) + leaf.path;

        return {
            operations      : { $pull: { [pullPath]: { id: dbeIdOrCondition } } } as unknown as UpdateFilter<RootDBE>,
            updateOptions   : {}
        };
    }

    const { updatePrefix, arrayFilters } = propertyModelTargetUpdateParams( paths, dbeIdOrCondition );

    return {
        operations      : { $unset: { [updatePrefix]: '' } } as unknown as UpdateFilter<RootDBE>,
        updateOptions   : arrayFilters ? { arrayFilters } : {}
    };
}

export function buildListResult<T extends Document>(
    items: T[],
    sort: Document,
    options?: { total?: number, reversed?: boolean }
): ListResult<T>
{
    const ordered = options?.reversed ? [ ...items ].reverse() : items;
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const prev = first ? getCursor( first, sort ) : undefined;
    const next = last ? getCursor( last, sort ) : undefined;

    return {
        items       : ordered,
        total       : options?.total,
        cursors     :
        {
            prev,
            next
        },
        nextCursor  : next ? `next:${next}` : undefined,
        prevCursor  : prev ? `prev:${prev}` : undefined
    };
}

function isPerOperationValidatorMap( config: ModelValidatorConfig<any> ): config is { create?: ModelValidatorInput<any>, update?: ModelValidatorInput<any> }
{
    return typeof config === 'object'
        && config !== null
        && !( '~standard' in config )
        && !( 'safeParse' in config )
        && !( 'safeParseAsync' in config )
        && !( 'parse' in config )
        && ( 'create' in config || 'update' in config );
}

async function runSingleValidator(
    model: object,
    validator: ModelValidatorInput<any>,
    data: any,
    context: ModelValidationContext
): Promise<any>
{
    try
    {
        if( typeof validator === 'function' )
        {
            const res = await validator( data, context );

            if( res === false )
            {
                throw new ModelValidationError( model, 'Validation failed' );
            }

            return res && typeof res === 'object' ? res : data;
        }

        const isSchemaTargetOperator = context.isUpdateOperator && data && typeof data === 'object';
        const target = isSchemaTargetOperator ? data.$set : data;

        if( isSchemaTargetOperator && ( target === undefined || typeof target !== 'object' || target === null ) )
        {
            return data;
        }

        let validatedTarget = target;

        if( '~standard' in validator )
        {
            const res = await validator['~standard'].validate( target );

            if( res.issues )
            {
                throw new ModelValidationError( model, res.issues[0]?.message ?? 'Validation failed', res.issues );
            }

            validatedTarget = res.value;
        }
        else if( 'safeParseAsync' in validator && typeof validator.safeParseAsync === 'function' )
        {
            const res = await validator.safeParseAsync( target );

            if( !res.success )
            {
                const issues = res.error?.issues ?? [];

                throw new ModelValidationError( model, issues[0]?.message ?? res.error?.message ?? 'Validation failed', issues );
            }

            validatedTarget = res.data ?? target;
        }
        else if( 'safeParse' in validator && typeof validator.safeParse === 'function' )
        {
            const res = validator.safeParse( target );

            if( !res.success )
            {
                const issues = res.error?.issues ?? [];

                throw new ModelValidationError( model, issues[0]?.message ?? res.error?.message ?? 'Validation failed', issues );
            }

            validatedTarget = res.data ?? target;
        }
        else if( 'parse' in validator && typeof validator.parse === 'function' )
        {
            validatedTarget = await validator.parse( target );
        }

        return isSchemaTargetOperator ? { ...data, $set: validatedTarget } : validatedTarget;
    }
    catch( err: any )
    {
        if( err instanceof ModelValidationError )
        {
            throw err;
        }

        const rawIssues = Array.isArray( err?.issues ) ? err.issues : ( Array.isArray( err?.errors ) ? err.errors : [] );
        const message = rawIssues[0]?.message ?? err?.message ?? String( err );
        const issues = rawIssues.length > 0 ? rawIssues : [{ message }];

        throw new ModelValidationError( model, message, issues, err instanceof Error ? err : undefined );
    }
}

export async function executeModelValidator<T>(
    model: object,
    validatorConfig: ModelValidatorConfig<any> | undefined,
    methodValidator: ModelValidatorFn<any> | undefined,
    data: T,
    operation: ModelValidationOperation
): Promise<T>
{
    if( !validatorConfig && !methodValidator )
    {
        return data;
    }

    const isCreate = operation === 'create' || operation === 'createMany';
    const isOp = !isCreate && typeof data === 'object' && data !== null && isUpdateOperator( data as object );
    const context: ModelValidationContext = { operation, isUpdateOperator: isOp };
    const configValidator = validatorConfig
        ? ( isPerOperationValidatorMap( validatorConfig )
            ? ( isCreate ? validatorConfig.create : validatorConfig.update )
            : validatorConfig )
        : undefined;

    let current: any = data;

    if( configValidator )
    {
        current = await runSingleValidator( model, configValidator, current, context );
    }

    if( methodValidator )
    {
        current = await runSingleValidator( model, methodValidator, current, context );
    }

    return current as T;
}

export async function convertDocuments
<
    DBE extends Document,
    K extends string | number | symbol
>(
    converters: ConverterManager<DBE>,
    documents: Array<DBE | null>,
    conversion: K,
    filtered: boolean = false
)
{
    let entries = await converters.convertMany( documents, conversion as any );

    if( filtered )
    {
        entries = entries.filter( Boolean );
    }

    return entries;
}

export type ResolvedTimestampsConfig =
{
    createdAt?  : string
    updatedAt?  : string
};

export type ResolvedSoftDeleteConfig =
{
    field           : string
    deletedAtField? : string
};

export type ResolvedVersioningConfig =
{
    field           : string
    initialVersion  : number
};

export type NormalizedPopulateSpec =
{
    path            : string
    as?             : string
    includeDeleted? : boolean
    populate?       : PopulateSpec
};

export function resolveVersioningConfig( config?: ModelVersioningConfig ): ResolvedVersioningConfig | undefined
{
    if( !config )
    {
        return undefined;
    }

    if( config === true )
    {
        return { field: 'version', initialVersion: 1 };
    }

    if( typeof config === 'string' )
    {
        return { field: config, initialVersion: 1 };
    }

    return {
        field           : config.field ?? 'version',
        initialVersion  : config.initialVersion ?? 1
    };
}

export function applyCreateVersioning<T extends Record<string, any>>(
    doc: T,
    versioning?: ResolvedVersioningConfig
): T
{
    if( !versioning || doc[versioning.field] !== undefined )
    {
        return doc;
    }

    return {
        ...doc,
        [versioning.field] : versioning.initialVersion
    };
}

export function applyUpdateVersioning<T extends Record<string, any>>(
    update: T,
    versioning?: ResolvedVersioningConfig
): T
{
    if( !versioning || !update || typeof update !== 'object' )
    {
        return update;
    }

    const field = versioning.field;

    if( isUpdateOperator( update ) )
    {
        if( update.$set?.[field] !== undefined || update.$inc?.[field] !== undefined )
        {
            return update;
        }

        return {
            ...update,
            $inc : { ...( update.$inc ?? {} ), [field]: 1 }
        } as unknown as T;
    }

    if( update[field] !== undefined )
    {
        return update;
    }

    const $set: Record<string, any> = {};
    const $unset: Record<string, 1> = {};

    for( const [ key, value ] of Object.entries( update ) )
    {
        if( value === undefined )
        {
            $unset[key] = 1;
        }
        else
        {
            $set[key] = value;
        }
    }

    return {
        ...( Object.keys( $set ).length > 0 ? { $set } : {} ),
        ...( Object.keys( $unset ).length > 0 ? { $unset } : {} ),
        $inc : { [field]: 1 }
    } as unknown as T;
}

export function normalizePopulateSpecs( populate?: PopulateSpec ): NormalizedPopulateSpec[]
{
    if( !populate )
    {
        return [];
    }

    const items = Array.isArray( populate ) ? populate : [ populate ];
    const byRootPath = new Map<string, NormalizedPopulateSpec>();

    for( const raw of items )
    {
        if( !raw ){ continue }

        const item = typeof raw === 'string' ? { path: raw } : raw;
        const dotIdx = item.path.indexOf( '.' );

        if( dotIdx !== -1 )
        {
            const rootPath = item.path.slice( 0, dotIdx );
            const childSpec: NormalizedPopulateSpec =
            {
                ...item,
                path : item.path.slice( dotIdx + 1 )
            };
            const existing = byRootPath.get( rootPath );

            if( existing )
            {
                const prevNested = existing.populate
                    ? ( Array.isArray( existing.populate ) ? existing.populate : [ existing.populate ] )
                    : [];
                existing.populate = [ ...prevNested, childSpec ];
            }
            else
            {
                byRootPath.set( rootPath, { path: rootPath, populate: [ childSpec ] });
            }
        }
        else
        {
            const existing = byRootPath.get( item.path );

            if( existing )
            {
                if( item.as !== undefined ){ existing.as = item.as }
                if( item.includeDeleted !== undefined ){ existing.includeDeleted = item.includeDeleted }

                if( item.populate !== undefined )
                {
                    const prevNested = existing.populate
                        ? ( Array.isArray( existing.populate ) ? existing.populate : [ existing.populate ] )
                        : [];
                    const nextNested = Array.isArray( item.populate ) ? item.populate : [ item.populate ];
                    existing.populate = [ ...prevNested, ...nextNested ];
                }
            }
            else
            {
                byRootPath.set( item.path, { ...item });
            }
        }
    }

    return Array.from( byRootPath.values() );
}

export function extractExplainSummary(
    collectionOrRaw: string | Document,
    pipelineOrUndefined?: Document[],
    maybeRaw?: Document
): ModelExplainResult
{
    const hasCollectionArg = typeof collectionOrRaw === 'string';
    const collection = hasCollectionArg ? collectionOrRaw : '';
    const pipeline = hasCollectionArg ? ( pipelineOrUndefined ?? [] ) : [];
    const raw = ( hasCollectionArg ? maybeRaw : collectionOrRaw ) ?? {};

    let isCollectionScan = false;
    const indexNames = new Set<string>();

    const walkPlan = ( node: any ): void =>
    {
        if( !node || typeof node !== 'object' ){ return }

        if( node.stage === 'COLLSCAN' )
        {
            isCollectionScan = true;
        }

        if( typeof node.indexName === 'string' )
        {
            indexNames.add( node.indexName );
        }

        for( const key of [ 'inputStage', 'queryPlan', 'queryPlanner', 'winningPlan', 'executionStats', 'executionStages', '$cursor' ] )
        {
            if( node[key] ){ walkPlan( node[key] ) }
        }

        for( const listKey of [ 'inputStages', 'stages' ] )
        {
            if( Array.isArray( node[listKey] ) )
            {
                for( const item of node[listKey] ){ walkPlan( item ) }
            }
        }

        if( node.shards && typeof node.shards === 'object' )
        {
            const shardList = Array.isArray( node.shards ) ? node.shards : Object.values( node.shards );

            for( const shard of shardList ){ walkPlan( shard ) }
        }
    };

    walkPlan( raw );

    const cursorBlock = Array.isArray( raw?.stages ) ? raw.stages[0]?.$cursor : undefined;
    const queryPlanner = raw?.queryPlanner ?? cursorBlock?.queryPlanner;
    const executionStats = raw?.executionStats ?? cursorBlock?.executionStats;
    const winningPlan = queryPlanner?.winningPlan;
    const indexes = Array.from( indexNames );

    return {
        collection,
        pipeline,
        winningPlan,
        indexUsed           : indexes.length === 1 ? indexes[0] : ( indexes.length > 1 ? indexes : undefined ),
        isCollectionScan,
        totalDocsExamined   : executionStats?.totalDocsExamined,
        totalKeysExamined   : executionStats?.totalKeysExamined,
        executionTimeMillis : executionStats?.executionTimeMillis,
        nReturned           : executionStats?.nReturned,
        raw
    };
}

export function createChangeStreamController<TEvent extends ModelChangeEvent<any, any, any> = ModelChangeEvent<any, any, any>>(
    onClose?: () => void | Promise<void>
): {
    stream      : ModelChangeStream<any, any, any>
    emitChange  : ( ev: TEvent ) => void
    emitError   : ( err: Error ) => void
    isClosed    : () => boolean
}
{
    const changeListeners = new Set<( ev: TEvent ) => void>();
    const errorListeners = new Set<( err: Error ) => void>();
    const queue: TEvent[] = [];
    const pendingResolvers: Array<( res: IteratorResult<TEvent> ) => void> = [];
    let closed = false;

    const emitChange = ( ev: TEvent ) =>
    {
        if( closed ){ return }

        for( const fn of changeListeners )
        {
            try { fn( ev ) } catch {}
        }

        if( pendingResolvers.length > 0 )
        {
            pendingResolvers.shift()!({ value: ev, done: false });
        }
        else
        {
            queue.push( ev );
        }
    };

    const emitError = ( err: Error ) =>
    {
        if( closed ){ return }

        for( const fn of errorListeners )
        {
            try { fn( err ) } catch {}
        }
    };

    const stream: ModelChangeStream<any, any, any> =
    {
        get closed()
        {
            return closed;
        },
        on( event: 'change' | 'error', listener: any )
        {
            if( event === 'change' ){ changeListeners.add( listener ) }
            else if( event === 'error' ){ errorListeners.add( listener ) }

            return stream;
        },
        async close()
        {
            if( closed ){ return }

            closed = true;

            while( pendingResolvers.length > 0 )
            {
                pendingResolvers.shift()!({ value: undefined as any, done: true });
            }

            await onClose?.();
        },
        [Symbol.asyncIterator]()
        {
            return {
                next(): Promise<IteratorResult<TEvent>>
                {
                    if( queue.length > 0 )
                    {
                        return Promise.resolve({ value: queue.shift()!, done: false });
                    }

                    if( closed )
                    {
                        return Promise.resolve({ value: undefined as any, done: true });
                    }

                    return new Promise<IteratorResult<TEvent>>( resolve => pendingResolvers.push( resolve ));
                },
                async return(): Promise<IteratorResult<TEvent>>
                {
                    await stream.close();

                    return { value: undefined as any, done: true };
                }
            };
        }
    };

    return {
        stream,
        emitChange,
        emitError,
        isClosed : () => closed
    };
}

export function resolveTimestampsConfig( config?: ModelTimestampsConfig ): ResolvedTimestampsConfig | undefined
{
    if( !config )
    {
        return undefined;
    }

    if( config === true )
    {
        return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
    }

    const createdAt = config.createdAt === false ? undefined : ( config.createdAt ?? 'createdAt' );
    const updatedAt = config.updatedAt === false ? undefined : ( config.updatedAt ?? 'updatedAt' );

    if( !createdAt && !updatedAt )
    {
        return undefined;
    }

    return { createdAt, updatedAt };
}

export function resolveSoftDeleteConfig( config?: ModelSoftDeleteConfig ): ResolvedSoftDeleteConfig | undefined
{
    if( !config )
    {
        return undefined;
    }

    if( config === true )
    {
        return { field: 'deleted', deletedAtField: 'deletedAt' };
    }

    const field = config.field ?? 'deleted';
    const deletedAtField = config.deletedAtField === false ? undefined : ( config.deletedAtField ?? 'deletedAt' );

    return { field, deletedAtField };
}

export function applyCreateTimestamps<T extends Record<string, any>>(
    doc: T,
    timestamps?: ResolvedTimestampsConfig,
    now: Date = new Date()
): T
{
    if( !timestamps )
    {
        return doc;
    }

    const out: Record<string, any> = { ...doc };

    if( timestamps.createdAt && out[timestamps.createdAt] === undefined )
    {
        out[timestamps.createdAt] = now;
    }

    if( timestamps.updatedAt && out[timestamps.updatedAt] === undefined )
    {
        out[timestamps.updatedAt] = now;
    }

    return out as T;
}

export function applyUpdateTimestamps<T extends Record<string, any>>(
    update: T,
    timestamps?: ResolvedTimestampsConfig,
    now: Date = new Date(),
    isUpsert: boolean = false
): T
{
    if( !timestamps || ( !timestamps.updatedAt && ( !isUpsert || !timestamps.createdAt )) )
    {
        return update;
    }

    if( isUpdateOperator( update ) )
    {
        const out: Record<string, any> = { ...update };

        if( timestamps.updatedAt && out.$set?.[timestamps.updatedAt] === undefined )
        {
            out.$set = { ...( out.$set ?? {} ), [timestamps.updatedAt]: now };
        }

        if( isUpsert && timestamps.createdAt && out.$set?.[timestamps.createdAt] === undefined && out.$setOnInsert?.[timestamps.createdAt] === undefined )
        {
            out.$setOnInsert = { ...( out.$setOnInsert ?? {} ), [timestamps.createdAt]: now };
        }

        return out as T;
    }

    const out: Record<string, any> = { ...update };

    if( timestamps.updatedAt && out[timestamps.updatedAt] === undefined )
    {
        out[timestamps.updatedAt] = now;
    }

    if( isUpsert && timestamps.createdAt && out[timestamps.createdAt] === undefined )
    {
        return {
            $set            : out,
            $setOnInsert    : { [timestamps.createdAt]: now }
        } as unknown as T;
    }

    return out as T;
}

export function buildSoftDeleteFilter<T = Document>( softDelete?: ResolvedSoftDeleteConfig, includeDeleted?: boolean ): Filter<T> | undefined
{
    if( !softDelete || includeDeleted )
    {
        return undefined;
    }

    return { [softDelete.field]: { $in: [ null, false ] } } as unknown as Filter<T>;
}

export function buildSoftDeleteUpdate<T = Document>(
    softDelete: ResolvedSoftDeleteConfig,
    timestamps?: ResolvedTimestampsConfig,
    now: Date = new Date()
): UpdateFilter<T>
{
    const setFields: Record<string, any> =
    {
        [softDelete.field]: softDelete.field === softDelete.deletedAtField ? now : true
    };

    if( softDelete.deletedAtField )
    {
        setFields[softDelete.deletedAtField] = now;
    }

    if( timestamps?.updatedAt )
    {
        setFields[timestamps.updatedAt] = now;
    }

    return { $set: setFields } as unknown as UpdateFilter<T>;
}

export function buildRestoreUpdate<T = Document>(
    softDelete: ResolvedSoftDeleteConfig,
    timestamps?: ResolvedTimestampsConfig,
    now: Date = new Date()
): UpdateFilter<T>
{
    const setFields: Record<string, any> =
    {
        [softDelete.field]: softDelete.field === softDelete.deletedAtField ? null : false
    };

    if( softDelete.deletedAtField && softDelete.deletedAtField !== softDelete.field )
    {
        setFields[softDelete.deletedAtField] = null;
    }

    if( timestamps?.updatedAt )
    {
        setFields[timestamps.updatedAt] = now;
    }

    return { $set: setFields } as unknown as UpdateFilter<T>;
}

export function defaultIndexName( keys: ModelIndexSpecification ): string
{
    return Object.entries( keys ).map(([ field, dir ]) => `${field}_${String( dir )}`).join( '_' );
}

export function normalizeModelIndexes(
    indexes: ModelIndexDefinition<any>[] | undefined,
    prefix?: string
): NormalizedModelIndex[]
{
    if( !indexes?.length )
    {
        return [];
    }

    return indexes.map(( def: any ) =>
    {
        const hasKeyProp = def && typeof def === 'object' && ( ( 'key' in def && typeof def.key === 'object' ) || ( 'keys' in def && typeof def.keys === 'object' ) );
        const rawKeySpec: ModelIndexSpecification = hasKeyProp ? ( def.key ?? def.keys ) : def;
        const { key: _k, keys: _ks, options: nestedOptions, ...topLevelOptions } = hasKeyProp ? def : { key: undefined, keys: undefined, options: undefined };
        const mergedOptions = { ...topLevelOptions, ...( nestedOptions ?? {} ) };
        const key: ModelIndexSpecification = {};

        for( const [ field, dir ] of Object.entries( rawKeySpec ) )
        {
            if( prefix )
            {
                const normalizedKey = field === '_root' || field.startsWith( '_root.' )
                    ? field.replace( /^_root\.?/, '' )
                    : ( field.startsWith( `${prefix}.` ) ? field : `${prefix}.${field}` );

                key[normalizedKey] = dir;
            }
            else
            {
                key[field] = dir;
            }
        }

        const name = mergedOptions.name ?? defaultIndexName( key );

        return {
            key,
            name,
            options : { ...mergedOptions, name }
        };
    });
}


