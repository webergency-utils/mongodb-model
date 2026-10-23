import { Document, ObjectId, UpdateFilter, UpdateOptions } from 'mongodb';
import { getCursor, isForeignObjectIdLike, isLibraryObjectId, propertyModelTargetUpdateParams } from './helpers/mongo.js';
import { ConverterManager } from './converters.js';
import { GetManyOptions, GetOptions, ListResult, ModelCreateOptions, PropertyModelUpdateResponse, WithTotal } from './types/external.js';

export function attachListMetadata<T>(
    items: T[],
    total: number | undefined,
    cursors: { prev?: string, next?: string }
): WithTotal<T[]>
{
    Object.defineProperties( items,
    {
        items   : { value: items, enumerable: false, writable: false, configurable: true },
        total   : { value: total, enumerable: false, writable: false, configurable: true },
        cursors : { value: cursors, enumerable: false, writable: false, configurable: true }
    });

    return items as WithTotal<T[]>;
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

const FIND_OPTION_KEYS = new Set([ 'filter', 'smartFilter', 'access', 'context', 'traceID' ]);

export function isCreateOptionsObject( v: unknown ): v is ModelCreateOptions
{
    return typeof v === 'object'
        && v !== null
        && !Array.isArray( v )
        && !isLibraryObjectId( v )
        && !isForeignObjectIdLike( v )
        && ( 'duplicateIgnore' in v || 'access' in v || 'context' in v || 'traceID' in v );
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

export function isFindOptionsObject( match: unknown ): match is { filter?: unknown, smartFilter?: unknown, access?: string, context?: Record<string, unknown>, traceID?: string }
{
    return Boolean(
        match
        && typeof match === 'object'
        && !Array.isArray( match )
        && !isLibraryObjectId( match )
        && !isForeignObjectIdLike( match )
        && (
            'filter' in match
            || 'smartFilter' in match
            || (( 'access' in match || 'context' in match || 'traceID' in match ) && Object.keys( match ).every( k => FIND_OPTION_KEYS.has( k ) ))
        )
    );
}

export function normalizeFindMatch<FilterType = Record<string, any>, SmartFilterType = any>(
    match: FilterType | { filter?: FilterType, smartFilter?: SmartFilterType, access?: string, context?: Record<string, unknown>, traceID?: string },
    optionsOrAccess?: string | { access?: string, context?: Record<string, unknown>, traceID?: string }
): { filter: FilterType, smartFilter?: SmartFilterType, access?: string, context?: Record<string, unknown>, traceID?: string }
{
    const opts = typeof optionsOrAccess === 'string' ? { access: optionsOrAccess } : optionsOrAccess;

    if( isFindOptionsObject( match ) )
    {
        const context = opts?.context && match.context
            ? { ...match.context, ...opts.context }
            : ( opts?.context ?? match.context );
        const traceID = opts?.traceID ?? match.traceID;

        return {
            filter      : ( match.filter ?? {} ) as FilterType,
            smartFilter : match.smartFilter as SmartFilterType | undefined,
            access      : opts?.access ?? match.access,
            ...( context !== undefined ? { context } : {} ),
            ...( traceID !== undefined ? { traceID } : {} )
        };
    }

    return {
        filter : ( match ?? {} ) as FilterType,
        access : opts?.access,
        ...( opts?.context !== undefined ? { context: opts.context } : {} ),
        ...( opts?.traceID !== undefined ? { traceID: opts.traceID } : {} )
    };
}

export function normalizeExistsOptions<FilterType = Record<string, any>, SmartFilterType = any>(
    idOrFilter: unknown,
    idKey: '_id' | 'id',
    dbeID: ( id: any ) => any,
    optionsOrAccess?: string | { access?: string, context?: Record<string, unknown>, traceID?: string }
): { filter: FilterType, smartFilter?: SmartFilterType, access?: string, context?: Record<string, unknown>, traceID?: string }
{
    const opts = typeof optionsOrAccess === 'string' ? { access: optionsOrAccess } : optionsOrAccess;

    if( idOrFilter === undefined || idOrFilter === null )
    {
        return {
            filter : {} as FilterType,
            access : opts?.access,
            ...( opts?.context !== undefined ? { context: opts.context } : {} ),
            ...( opts?.traceID !== undefined ? { traceID: opts.traceID } : {} )
        };
    }

    if(
        typeof idOrFilter === 'string'
        || typeof idOrFilter === 'number'
        || isLibraryObjectId( idOrFilter )
        || isForeignObjectIdLike( idOrFilter )
    )
    {
        return {
            filter : { [idKey]: dbeID( idOrFilter ) } as unknown as FilterType,
            access : opts?.access,
            ...( opts?.context !== undefined ? { context: opts.context } : {} ),
            ...( opts?.traceID !== undefined ? { traceID: opts.traceID } : {} )
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

    return {
        items   : ordered,
        total   : options?.total,
        cursors :
        {
            prev    : first ? getCursor( first, sort ) : undefined,
            next    : last ? getCursor( last, sort ) : undefined
        }
    };
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

