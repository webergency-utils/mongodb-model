import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ClientSession, CollationOptions, Collection, Document, Filter, ObjectId, ReadPreferenceLike, UpdateFilter, UpdateOptions } from 'mongodb';
import { getCursor, isForeignObjectIdLike, isLibraryObjectId, isUpdateOperator, propertyModelTargetUpdateParams } from './helpers/mongo.js';
import { ConverterManager } from './converters.js';
import { ModelError, ModelValidationError } from './errors.js';
import { resolveRedactFieldsSet } from './events.js';
import
{
    GetManyOptions,
    GetOptions,
    ListResult,
    ModelAuditAction,
    ModelAuditCallback,
    ModelAuditConfig,
    ModelAuditDiffChange,
    ModelChangeEvent,
    ModelChangeStream,
    ModelCollationConfig,
    ModelCreateOptions,
    ModelExplainResult,
    ModelIdCollisionRiskLevel,
    ModelIdCollisionRiskOptions,
    ModelIdCollisionRiskResult,
    ModelIdConfig,
    ModelIdGeneratorContext,
    ModelIdGeneratorOptions,
    ModelIdStrategy,
    ModelIndexDefinition,
    ModelIndexSpecification,
    ModelQueryExecutionOptions,
    ModelRetryConfig,
    ModelRetryOptions,
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

const FIND_OPTION_KEYS = new Set([ 'filter', 'smartFilter', 'populate', 'cursor', 'after', 'before', 'includeDeleted', 'access', 'context', 'traceID', 'session', 'collation', 'maxTimeMS', 'hint', 'readPreference' ]);

export function isCreateOptionsObject( v: unknown ): v is ModelCreateOptions
{
    return typeof v === 'object'
        && v !== null
        && !Array.isArray( v )
        && !isLibraryObjectId( v )
        && !isForeignObjectIdLike( v )
        && ( 'duplicateIgnore' in v || 'maxRetries' in v || 'verifyUniqueness' in v || 'access' in v || 'context' in v || 'traceID' in v || 'session' in v );
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

export function resolveCreateManyFromArgs<ID>(
    fromMap: Record<string, unknown> | undefined,
    fromKeyOrIdsOrOptions?: string | ID[] | ModelCreateOptions,
    idsOrOptions?: ID[] | ModelCreateOptions,
    options?: ModelCreateOptions
): { fromKey?: string, explicitIds?: ID[], resolvedOptions?: ModelCreateOptions }
{
    void fromMap;

    if( isCreateOptionsObject( fromKeyOrIdsOrOptions ) )
    {
        return { resolvedOptions: fromKeyOrIdsOrOptions };
    }

    if( Array.isArray( fromKeyOrIdsOrOptions ) )
    {
        return {
            explicitIds     : fromKeyOrIdsOrOptions,
            resolvedOptions : isCreateOptionsObject( idsOrOptions ) ? idsOrOptions : options
        };
    }

    if( typeof fromKeyOrIdsOrOptions === 'string' )
    {
        if( isCreateOptionsObject( idsOrOptions ) )
        {
            return { fromKey: fromKeyOrIdsOrOptions, resolvedOptions: idsOrOptions };
        }

        return {
            fromKey         : fromKeyOrIdsOrOptions,
            explicitIds     : Array.isArray( idsOrOptions ) ? idsOrOptions : undefined,
            resolvedOptions : options
        };
    }

    return {
        resolvedOptions : isCreateOptionsObject( idsOrOptions ) ? idsOrOptions : options
    };
}

export function isFindOptionsObject( match: unknown ): match is { filter?: unknown, smartFilter?: unknown, populate?: PopulateSpec, cursor?: string, after?: string, before?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession, collation?: ModelCollationConfig, maxTimeMS?: number, hint?: string | Document, readPreference?: ReadPreferenceLike }
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
            || 'collation' in match
            || 'maxTimeMS' in match
            || 'hint' in match
            || 'readPreference' in match
            || (( 'access' in match || 'session' in match ) && Object.keys( match ).every( k => FIND_OPTION_KEYS.has( k ) ))
        )
    );
}

export function normalizeFindMatch<FilterType = Record<string, any>, SmartFilterType = any>(
    match: FilterType | ( ModelQueryExecutionOptions & { filter?: FilterType, smartFilter?: SmartFilterType, populate?: PopulateSpec, cursor?: string, after?: string, before?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession } ),
    optionsOrAccess?: string | ( ModelQueryExecutionOptions & { populate?: PopulateSpec, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession } )
): ModelQueryExecutionOptions & { filter: FilterType, smartFilter?: SmartFilterType, populate?: PopulateSpec, cursor?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession }
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
        const collation = opts?.collation !== undefined ? opts.collation : match.collation;
        const maxTimeMS = opts?.maxTimeMS ?? match.maxTimeMS;
        const hint = opts?.hint ?? match.hint;
        const readPreference = opts?.readPreference ?? match.readPreference;

        return {
            filter      : ( match.filter ?? {} ) as FilterType,
            smartFilter : match.smartFilter as SmartFilterType | undefined,
            access      : opts?.access ?? match.access,
            ...( populate !== undefined ? { populate } : {} ),
            ...( cursor !== undefined ? { cursor } : {} ),
            ...( includeDeleted !== undefined ? { includeDeleted } : {} ),
            ...( context !== undefined ? { context } : {} ),
            ...( traceID !== undefined ? { traceID } : {} ),
            ...( session !== undefined ? { session } : {} ),
            ...( collation !== undefined ? { collation } : {} ),
            ...( maxTimeMS !== undefined ? { maxTimeMS } : {} ),
            ...( hint !== undefined ? { hint } : {} ),
            ...( readPreference !== undefined ? { readPreference } : {} )
        };
    }

    return {
        filter : ( match ?? {} ) as FilterType,
        access : opts?.access,
        ...( opts?.populate !== undefined ? { populate: opts.populate } : {} ),
        ...( opts?.includeDeleted !== undefined ? { includeDeleted: opts.includeDeleted } : {} ),
        ...( opts?.context !== undefined ? { context: opts.context } : {} ),
        ...( opts?.traceID !== undefined ? { traceID: opts.traceID } : {} ),
        ...( opts?.session !== undefined ? { session: opts.session } : {} ),
        ...( opts?.collation !== undefined ? { collation: opts.collation } : {} ),
        ...( opts?.maxTimeMS !== undefined ? { maxTimeMS: opts.maxTimeMS } : {} ),
        ...( opts?.hint !== undefined ? { hint: opts.hint } : {} ),
        ...( opts?.readPreference !== undefined ? { readPreference: opts.readPreference } : {} )
    };
}

export function normalizeExistsOptions<FilterType = Record<string, any>, SmartFilterType = any>(
    idOrFilter: unknown,
    idKey: '_id' | 'id',
    dbeID: ( id: any ) => any,
    optionsOrAccess?: string | ( ModelQueryExecutionOptions & { includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession } )
): ModelQueryExecutionOptions & { filter: FilterType, smartFilter?: SmartFilterType, cursor?: string, includeDeleted?: boolean, access?: string, context?: Record<string, unknown>, traceID?: string, session?: ClientSession, isPrimitiveId?: boolean }
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

export const DEFAULT_ID_MAX_RETRIES = 5;

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ResolvedIdConfig<IdType = any> =
{
    strategy?           : ModelIdStrategy
    generator           : ( context?: ModelIdGeneratorContext ) => IdType | Promise<IdType>
    maxRetries          : number
    verifyUniqueness    : boolean
    risk                : ModelIdCollisionRiskResult
};

function generateCryptoObjectIdHex(): string
{
    const buf = Buffer.allocUnsafe( 12 );

    buf.writeUInt32BE( Math.floor( Date.now() / 1000 ) >>> 0, 0 );
    randomBytes( 8 ).copy( buf, 4 );

    return buf.toString( 'hex' );
}

function generateUlidString( now: number = Date.now() ): string
{
    let time = Math.max( 0, Math.floor( now ));
    const chars = new Array<string>( 26 );

    for( let i = 9; i >= 0; i-- )
    {
        const mod = time % 32;

        chars[i] = CROCKFORD_BASE32_ALPHABET[mod];
        time = ( time - mod ) / 32;
    }

    const rand = randomBytes( 10 );
    let hi = ( rand[0] * 0x100000000 ) + (( rand[1] << 24 ) >>> 0 ) + ( rand[2] << 16 ) + ( rand[3] << 8 ) + rand[4];
    let lo = ( rand[5] * 0x100000000 ) + (( rand[6] << 24 ) >>> 0 ) + ( rand[7] << 16 ) + ( rand[8] << 8 ) + rand[9];

    for( let i = 7; i >= 0; i-- )
    {
        const modHi = hi % 32;

        chars[10 + i] = CROCKFORD_BASE32_ALPHABET[modHi];
        hi = ( hi - modHi ) / 32;

        const modLo = lo % 32;

        chars[18 + i] = CROCKFORD_BASE32_ALPHABET[modLo];
        lo = ( lo - modLo ) / 32;
    }

    return chars.join( '' );
}

function generateCustomAlphabetString( alphabet: string, length: number ): string
{
    const safeLen = Math.max( 1, Math.floor( length ));
    const alphaLen = alphabet.length;

    if( alphaLen < 2 || alphaLen > 256 )
    {
        throw new RangeError( 'ID alphabet must contain between 2 and 256 characters' );
    }

    const mask = ( 2 << Math.floor( Math.log2( alphaLen - 1 ))) - 1;
    const step = Math.max( safeLen, Math.ceil(( 1.6 * mask * safeLen ) / alphaLen ));
    const out: string[] = [];

    while( out.length < safeLen )
    {
        const bytes = randomBytes( step );

        for( let i = 0; i < bytes.length && out.length < safeLen; i++ )
        {
            const idx = bytes[i] & mask;

            if( idx < alphaLen )
            {
                out.push( alphabet[idx] );
            }
        }
    }

    return out.join( '' );
}

export function generateRandomId( options?: ModelIdStrategy | ModelIdGeneratorOptions<string> ): string
{
    const opts: ModelIdGeneratorOptions<string> = typeof options === 'string'
        ? { strategy: options }
        : ( options ?? {} );
    const prefix = opts.prefix ?? '';

    if( opts.alphabet )
    {
        const defaultLen = opts.strategy === 'base62' ? 22 : ( opts.strategy === 'nanoid' ? 21 : 21 );

        return `${prefix}${generateCustomAlphabetString( opts.alphabet, opts.length ?? defaultLen )}`;
    }

    const strategy: ModelIdStrategy = opts.strategy ?? ( opts.length !== undefined ? 'cryptoHex' : 'objectId' );

    switch( strategy )
    {
        case 'objectId':
        {
            if( opts.length !== undefined && opts.length !== 24 )
            {
                const byteCount = Math.ceil( Math.max( 1, opts.length ) / 2 );

                return `${prefix}${randomBytes( byteCount ).toString( 'hex' ).slice( 0, Math.max( 1, opts.length ))}`;
            }

            return `${prefix}${generateCryptoObjectIdHex()}`;
        }

        case 'cryptoHex':
        {
            const len = Math.max( 1, Math.floor( opts.length ?? 24 ));
            const byteCount = Math.ceil( len / 2 );

            return `${prefix}${randomBytes( byteCount ).toString( 'hex' ).slice( 0, len )}`;
        }

        case 'uuid':
            return `${prefix}${randomUUID()}`;

        case 'ulid':
            return `${prefix}${generateUlidString()}`;

        case 'nanoid':
            return `${prefix}${generateCustomAlphabetString( NANOID_ALPHABET, opts.length ?? 21 )}`;

        case 'base62':
            return `${prefix}${generateCustomAlphabetString( BASE62_ALPHABET, opts.length ?? 22 )}`;
    }
}

export function estimateIdCollisionRisk( options?: ModelIdStrategy | ModelIdCollisionRiskOptions ): ModelIdCollisionRiskResult
{
    const opts: ModelIdCollisionRiskOptions = typeof options === 'string'
        ? { strategy: options }
        : ( options ?? {} );
    const expectedCount = Math.max( 0, Math.floor( opts.expectedCount ?? 1_000_000 ));
    const strategy: ModelIdStrategy | undefined = opts.strategy ?? ( opts.alphabet || opts.alphabetSize || opts.entropyBits !== undefined ? undefined : 'objectId' );
    let alphabetSize: number;
    let length: number;
    let entropyBits: number;

    if( opts.entropyBits !== undefined )
    {
        entropyBits = Math.max( 1, opts.entropyBits );
        alphabetSize = opts.alphabetSize ?? ( opts.alphabet ? new Set( opts.alphabet ).size : 16 );
        length = opts.length ?? Math.ceil( entropyBits / Math.log2( Math.max( 2, alphabetSize )));
    }
    else if( opts.alphabet || opts.alphabetSize !== undefined )
    {
        alphabetSize = Math.max( 2, opts.alphabetSize ?? new Set( opts.alphabet ).size );
        length = Math.max( 1, Math.floor( opts.length ?? 21 ));
        entropyBits = length * Math.log2( alphabetSize );
    }
    else
    {
        switch( strategy ?? 'objectId' )
        {
            case 'uuid':
                alphabetSize = 16;
                length = 32;
                entropyBits = 122;
                break;

            case 'ulid':
                alphabetSize = 32;
                length = 26;
                entropyBits = 80;
                break;

            case 'nanoid':
                alphabetSize = 64;
                length = Math.max( 1, Math.floor( opts.length ?? 21 ));
                entropyBits = length * 6;
                break;

            case 'base62':
                alphabetSize = 62;
                length = Math.max( 1, Math.floor( opts.length ?? 22 ));
                entropyBits = length * Math.log2( 62 );
                break;

            case 'cryptoHex':
                alphabetSize = 16;
                length = Math.max( 1, Math.floor( opts.length ?? 24 ));
                entropyBits = length * 4;
                break;

            case 'objectId':
            default:
                alphabetSize = 16;
                length = Math.max( 1, Math.floor( opts.length ?? 24 ));
                entropyBits = opts.length !== undefined && opts.length !== 24 ? length * 4 : 64;
                break;
        }
    }

    const spaceSize = Math.pow( 2, entropyBits );
    const pairs = expectedCount > 1 ? ( expectedCount * ( expectedCount - 1 )) / 2 : 0;
    const collisionProbability = pairs > 0
        ? Math.min( 1, Math.max( 0, -Math.expm1( -pairs / spaceSize )))
        : 0;
    const maxCountForProbability = ( targetProb: number ): number =>
    {
        const target = -Math.log1p( -targetProb );

        return Math.max( 1, Math.floor( Math.sqrt( 2 * spaceSize * target )));
    };

    let riskLevel: ModelIdCollisionRiskLevel;

    if( collisionProbability < 1e-9 )
    {
        riskLevel = 'negligible';
    }
    else if( collisionProbability < 1e-6 )
    {
        riskLevel = 'low';
    }
    else if( collisionProbability < 1e-3 )
    {
        riskLevel = 'moderate';
    }
    else if( collisionProbability < 1e-1 )
    {
        riskLevel = 'high';
    }
    else
    {
        riskLevel = 'critical';
    }

    return {
        strategy,
        alphabetSize,
        length,
        entropyBits             : Number( entropyBits.toFixed( 2 )),
        expectedCount,
        collisionProbability,
        maxCountForOneInBillion : maxCountForProbability( 1e-9 ),
        maxCountForOneInMillion : maxCountForProbability( 1e-6 ),
        maxCountForOneInThousand: maxCountForProbability( 1e-3 ),
        riskLevel
    };
}

export function resolveIdConfig<IdType = any>( config?: ModelIdConfig<IdType>, model?: object ): ResolvedIdConfig<IdType>
{
    if( !config )
    {
        return {
            strategy            : 'objectId',
            generator           : () => generateRandomId( 'objectId' ) as unknown as IdType,
            maxRetries          : DEFAULT_ID_MAX_RETRIES,
            verifyUniqueness    : false,
            risk                : estimateIdCollisionRisk( 'objectId' )
        };
    }

    if( typeof config === 'function' )
    {
        return {
            generator           : ( ctx ) => config( ctx ),
            maxRetries          : DEFAULT_ID_MAX_RETRIES,
            verifyUniqueness    : false,
            risk                : estimateIdCollisionRisk( 'objectId' )
        };
    }

    if( typeof config === 'string' )
    {
        return {
            strategy            : config,
            generator           : () => generateRandomId( config ) as unknown as IdType,
            maxRetries          : DEFAULT_ID_MAX_RETRIES,
            verifyUniqueness    : false,
            risk                : estimateIdCollisionRisk( config )
        };
    }

    const risk = estimateIdCollisionRisk(
    {
        strategy        : config.strategy ?? ( config.alphabet ? undefined : ( config.length !== undefined ? 'cryptoHex' : 'objectId' )),
        length          : config.length,
        alphabet        : config.alphabet,
        expectedCount   : config.expectedCount
    });

    if( config.minEntropyBits !== undefined && risk.entropyBits < config.minEntropyBits )
    {
        throw new ModelError(
            'MODEL_ID_CONFIG',
            model ?? {},
            `Configured ID generator provides ${risk.entropyBits} bits of entropy, below required minEntropyBits (${config.minEntropyBits})`
        );
    }

    if( config.maxCollisionRisk !== undefined && risk.collisionProbability > config.maxCollisionRisk )
    {
        throw new ModelError(
            'MODEL_ID_CONFIG',
            model ?? {},
            `Configured ID generator has collision probability ${risk.collisionProbability} at expectedCount=${risk.expectedCount}, exceeding maxCollisionRisk (${config.maxCollisionRisk})`
        );
    }

    const maxRetries = config.maxRetries !== undefined ? Math.max( 0, Math.floor( config.maxRetries )) : DEFAULT_ID_MAX_RETRIES;
    const verifyUniqueness = Boolean( config.verifyUniqueness );
    const generator = config.generator
        ? ( ctx?: ModelIdGeneratorContext ) => config.generator!( ctx )
        : () => generateRandomId( config as ModelIdGeneratorOptions<string> ) as unknown as IdType;

    return {
        strategy : config.strategy ?? risk.strategy,
        generator,
        maxRetries,
        verifyUniqueness,
        risk
    };
}

export function createIdGenerator<IdType = string>(
    config?: ModelIdConfig<IdType>,
    model?: object
): ( context?: ModelIdGeneratorContext ) => IdType | Promise<IdType>
{
    const resolved = resolveIdConfig( config, model );

    return ( context?: ModelIdGeneratorContext ) => resolved.generator( context );
}

export function isIdDuplicateKeyError( err: any, idField: '_id' | 'id' = '_id' ): boolean
{
    if( !err || ( err.code !== 11000 && err.code !== 11001 ) )
    {
        return false;
    }

    const keyPattern = err.keyPattern && typeof err.keyPattern === 'object' ? err.keyPattern : undefined;

    if( keyPattern && Object.keys( keyPattern ).length > 0 )
    {
        return idField in keyPattern || Object.keys( keyPattern ).some( k => k.endsWith( `.${idField}` ));
    }

    const keyValue = err.keyValue && typeof err.keyValue === 'object' ? err.keyValue : undefined;

    if( keyValue && Object.keys( keyValue ).length > 0 )
    {
        return idField in keyValue || Object.keys( keyValue ).some( k => k.endsWith( `.${idField}` ));
    }

    if( typeof err.message === 'string' && err.message.includes( 'index:' ) )
    {
        return err.message.includes( '_id_' ) || err.message.includes( `${idField}_` ) || err.message.includes( `.${idField}_` );
    }

    return true;
}

export function resolveCollationOption(
    collation?: ModelCollationConfig,
    fallback?: ModelCollationConfig,
    defaultLocale: string | false = 'en'
): CollationOptions | undefined
{
    const chosen = collation !== undefined ? collation : fallback;

    if( chosen === false )
    {
        return undefined;
    }

    if( typeof chosen === 'string' )
    {
        return { locale: chosen };
    }

    if( chosen && typeof chosen === 'object' )
    {
        return chosen;
    }

    if( defaultLocale === false )
    {
        return undefined;
    }

    return { locale: defaultLocale };
}

const TRANSIENT_MONGO_ERROR_CODES = new Set([
    6,      // HostUnreachable
    7,      // HostNotFound
    89,     // NetworkTimeout
    91,     // ShutdownInProgress
    112,    // WriteConflict
    189,    // PrimarySteppedDown
    262,    // ExceededTimeLimit
    9001,   // SocketException
    10107,  // NotWritablePrimary
    11600,  // InterruptedAtShutdown
    11602,  // InterruptedDueToReplStateChange
    13435,  // NotPrimaryNoSecondaryOk
    13436   // NotPrimaryOrSecondary
]);

const TRANSIENT_MONGO_ERROR_LABELS = new Set([
    'TransientTransactionError',
    'UnknownTransactionCommitResult',
    'RetryableWriteError'
]);

const TRANSIENT_MONGO_ERROR_NAMES = new Set([
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoServerSelectionError',
    'MongoWriteConcernError'
]);

export function isTransientMongoError( error: unknown ): boolean
{
    if( !error || typeof error !== 'object' )
    {
        return false;
    }

    const err = error as any;

    if( typeof err.hasErrorLabel === 'function' )
    {
        for( const label of TRANSIENT_MONGO_ERROR_LABELS )
        {
            if( err.hasErrorLabel( label ) )
            {
                return true;
            }
        }
    }

    if( Array.isArray( err.errorLabels ) && err.errorLabels.some(( l: unknown ) => typeof l === 'string' && TRANSIENT_MONGO_ERROR_LABELS.has( l )) )
    {
        return true;
    }

    if( typeof err.code === 'number' && TRANSIENT_MONGO_ERROR_CODES.has( err.code ) )
    {
        return true;
    }

    if( typeof err.name === 'string' && TRANSIENT_MONGO_ERROR_NAMES.has( err.name ) )
    {
        return true;
    }

    if( typeof err.codeName === 'string' && /WriteConflict|TransientTransactionError|UnknownTransactionCommitResult|PrimarySteppedDown|NotWritablePrimary|InterruptedAtShutdown|InterruptedDueToReplStateChange|HostUnreachable|NetworkTimeout|SocketException|ExceededTimeLimit/i.test( err.codeName ) )
    {
        return true;
    }

    if( typeof err.message === 'string' && /WriteConflict|TransientTransactionError|UnknownTransactionCommitResult|PrimarySteppedDown|NotWritablePrimary|ECONNRESET|ETIMEDOUT|socket hang up/i.test( err.message ) )
    {
        return true;
    }

    return false;
}

export type ResolvedRetryConfig =
{
    maxAttempts : number
    baseDelayMs : number
    maxDelayMs  : number
    jitter      : boolean
    shouldRetry?: ( error: unknown, attempt: number ) => boolean | Promise<boolean>
    onRetry?    : ( error: unknown, attempt: number, delayMs: number ) => void | Promise<void>
};

export function resolveRetryConfig( config?: ModelRetryConfig, fallback?: ResolvedRetryConfig ): ResolvedRetryConfig | undefined
{
    if( config === false )
    {
        return undefined;
    }

    if( config === undefined )
    {
        return fallback;
    }

    const opts: ModelRetryOptions = config === true
        ? {}
        : ( typeof config === 'number' ? { maxAttempts: config } : config );

    return {
        maxAttempts : Math.max( 1, Math.floor( opts.maxAttempts ?? fallback?.maxAttempts ?? 3 )),
        baseDelayMs : Math.max( 0, opts.baseDelayMs ?? fallback?.baseDelayMs ?? 25 ),
        maxDelayMs  : Math.max( 0, opts.maxDelayMs ?? fallback?.maxDelayMs ?? 1000 ),
        jitter      : opts.jitter ?? fallback?.jitter ?? true,
        shouldRetry : opts.shouldRetry ?? fallback?.shouldRetry,
        onRetry     : opts.onRetry ?? fallback?.onRetry
    };
}

export async function executeWithTransientRetry<T>(
    fn: ( attempt: number ) => Promise<T>,
    options?: ModelRetryConfig,
    fallback?: ResolvedRetryConfig
): Promise<T>
{
    const resolved = resolveRetryConfig( options ?? true, fallback );

    if( !resolved || resolved.maxAttempts <= 1 )
    {
        return fn( 1 );
    }

    for( let attempt = 1; attempt <= resolved.maxAttempts; attempt++ )
    {
        try
        {
            return await fn( attempt );
        }
        catch( error )
        {
            if( attempt >= resolved.maxAttempts )
            {
                throw error;
            }

            const retryable = resolved.shouldRetry
                ? await resolved.shouldRetry( error, attempt )
                : isTransientMongoError( error );

            if( !retryable )
            {
                throw error;
            }

            const expDelay = Math.min( resolved.maxDelayMs, resolved.baseDelayMs * Math.pow( 2, attempt - 1 ));
            const delayMs = resolved.jitter
                ? Math.floor( expDelay * ( 0.5 + ( Math.random() * 0.5 )))
                : expDelay;

            await resolved.onRetry?.( error, attempt, delayMs );

            if( delayMs > 0 )
            {
                await new Promise( resolve => setTimeout( resolve, delayMs ));
            }
        }
    }

    /* c8 ignore next */
    return fn( resolved.maxAttempts );
}

export type ResolvedAuditConfig<DBE extends Document = Document> =
{
    collection?         : string | Collection<Document>
    onAudit?            : ModelAuditCallback<DBE>
    actions             : Set<ModelAuditAction>
    captureBefore       : boolean
    captureAfter        : boolean
    computeDiff         : boolean
    redactFields?       : Set<string>
    redactReplacement   : string
};

export function resolveAuditConfig<DBE extends Document = Document>(
    config?: ModelAuditConfig<DBE>,
    fallback?: ResolvedAuditConfig<DBE>
): ResolvedAuditConfig<DBE> | undefined
{
    if( config === false )
    {
        return undefined;
    }

    if( config === undefined )
    {
        return fallback;
    }

    const opts = ( config === true
        ? {}
        : ( typeof config === 'string'
            ? { collection: config }
            : ( typeof config === 'function' ? { onAudit: config } : config ))) as {
        enabled?            : boolean
        collection?         : string | Collection<Document>
        onAudit?            : ModelAuditCallback<DBE>
        actions?            : ModelAuditAction[]
        captureBefore?      : boolean
        captureAfter?       : boolean
        computeDiff?        : boolean
        redactFields?       : string[] | boolean
        redactReplacement?  : string
    };

    if( opts.enabled === false )
    {
        return undefined;
    }

    const onAudit = opts.onAudit ?? fallback?.onAudit;

    return {
        collection          : opts.collection ?? fallback?.collection ?? ( onAudit ? undefined : 'audit_logs' ),
        onAudit,
        actions             : opts.actions ? new Set<ModelAuditAction>( opts.actions ) : ( fallback?.actions ?? new Set<ModelAuditAction>([ 'create', 'update', 'delete' ]) ),
        captureBefore       : opts.captureBefore ?? fallback?.captureBefore ?? true,
        captureAfter        : opts.captureAfter ?? fallback?.captureAfter ?? true,
        computeDiff         : opts.computeDiff ?? fallback?.computeDiff ?? true,
        redactFields        : opts.redactFields !== undefined ? resolveRedactFieldsSet( opts.redactFields ) : fallback?.redactFields,
        redactReplacement   : opts.redactReplacement ?? fallback?.redactReplacement ?? '[REDACTED]'
    };
}

function areAuditValuesEqual( a: unknown, b: unknown ): boolean
{
    if( a === b )
    {
        return true;
    }

    if( ( isLibraryObjectId( a ) || isForeignObjectIdLike( a )) && ( isLibraryObjectId( b ) || isForeignObjectIdLike( b )) )
    {
        return String( a ) === String( b );
    }

    return isDeepStrictEqual( a, b );
}

export function computeAuditDiff(
    before: Record<string, any> | undefined,
    after: Record<string, any> | undefined,
    redactFields?: Set<string>
): Record<string, ModelAuditDiffChange> | undefined
{
    if( !before || !after || typeof before !== 'object' || typeof after !== 'object' )
    {
        return undefined;
    }

    const keys = new Set([ ...Object.keys( before ), ...Object.keys( after ) ]);
    const changes: Record<string, ModelAuditDiffChange> = {};

    for( const key of keys )
    {
        if( redactFields && redactFields.has( key.toLowerCase() ) )
        {
            continue;
        }

        if( !areAuditValuesEqual( before[key], after[key] ) )
        {
            changes[key] =
            {
                before  : before[key],
                after   : after[key]
            };
        }
    }

    return Object.keys( changes ).length > 0 ? changes : undefined;
}



