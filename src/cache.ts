import { ObjectId } from 'mongodb';
import { isForeignObjectIdLike, isLibraryObjectId } from './helpers/mongo.js';

export type ModelCacheOptions =
{
    ttl?     : number
    maxTTL?  : number
    sliding? : boolean
    maxSize? : number
    clone?   : boolean
};

export interface ModelCacheInstance
{
    get( key: string ): unknown | undefined;
    set( key: string, value: unknown, ids?: string[] ): void;
    invalidateIds( ids: string[] ): string[];
    clear(): void;
}

export type ModelCacheConfig = boolean | ModelCacheOptions | ModelCacheInstance;

type CacheEntry =
{
    value       : unknown
    createdAt   : number
    expiresAt   : number
    ids         : string[]
};

function isCustomCacheInstance( config: ModelCacheConfig ): config is ModelCacheInstance
{
    return typeof config === 'object'
        && config !== null
        && typeof ( config as ModelCacheInstance ).get === 'function'
        && typeof ( config as ModelCacheInstance ).set === 'function'
        && typeof ( config as ModelCacheInstance ).invalidateIds === 'function'
        && typeof ( config as ModelCacheInstance ).clear === 'function';
}

export function cloneCachedValue<T>( value: T ): T
{
    if( value === null || typeof value !== 'object' )
    {
        return value;
    }

    if( isLibraryObjectId( value ) )
    {
        return new ObjectId( value.toHexString() ) as unknown as T;
    }

    if( isForeignObjectIdLike( value ) )
    {
        return new ObjectId( String( value ) ) as unknown as T;
    }

    if( value instanceof Date )
    {
        return new Date( value.getTime() ) as unknown as T;
    }

    if( value instanceof RegExp )
    {
        return new RegExp( value.source, value.flags ) as unknown as T;
    }

    if( Array.isArray( value ) )
    {
        return value.map( item => cloneCachedValue( item ) ) as unknown as T;
    }

    const cloned: Record<string, unknown> = {};

    for( const [ key, val ] of Object.entries( value as Record<string, unknown> ) )
    {
        cloned[key] = cloneCachedValue( val );
    }

    return cloned as T;
}

export function buildCacheKey( conversion: string, id: string, scopeKey?: string ): string
{
    return scopeKey ? `${conversion}:${id}:${scopeKey}` : `${conversion}:${id}`;
}

function isDirectIdCandidate( value: unknown ): boolean
{
    if( typeof value === 'string' || typeof value === 'number' )
    {
        return true;
    }

    if( isLibraryObjectId( value ) || isForeignObjectIdLike( value ) )
    {
        return true;
    }

    if( typeof value === 'object' && value !== null && !Array.isArray( value ) )
    {
        const keys = Object.keys( value );

        return keys.length === 1 && keys[0] === '$oid' && typeof ( value as { $oid?: unknown } ).$oid === 'string';
    }

    return false;
}

function normalizeCandidate( value: unknown, normalizeId: ( id: any ) => string ): string
{
    if( typeof value === 'object' && value !== null && '$oid' in value && typeof ( value as { $oid?: unknown } ).$oid === 'string' )
    {
        return normalizeId(( value as { $oid: string } ).$oid );
    }

    return normalizeId( value );
}

function extractFieldTargetIds( fieldCondition: unknown, normalizeId: ( id: any ) => string ): string[]
{
    if( isDirectIdCandidate( fieldCondition ) )
    {
        return [ normalizeCandidate( fieldCondition, normalizeId ) ];
    }

    if( typeof fieldCondition !== 'object' || fieldCondition === null || Array.isArray( fieldCondition ) || fieldCondition instanceof RegExp || fieldCondition instanceof Date )
    {
        return [];
    }

    const opObj = fieldCondition as Record<string, unknown>;
    const opKeys = Object.keys( opObj );

    if( opKeys.length === 0 || !opKeys.every( k => k === '$eq' || k === '$in' ) )
    {
        return [];
    }

    const ids: string[] = [];

    if( '$eq' in opObj && isDirectIdCandidate( opObj.$eq ) )
    {
        ids.push( normalizeCandidate( opObj.$eq, normalizeId ) );
    }

    if( Array.isArray( opObj.$in ) )
    {
        for( const item of opObj.$in )
        {
            if( isDirectIdCandidate( item ) )
            {
                ids.push( normalizeCandidate( item, normalizeId ) );
            }
        }
    }

    return ids;
}

export function extractTargetIdsFromFilter(
    match: unknown,
    idField: '_id' | 'id',
    normalizeId: ( id: any ) => string
): string[]
{
    if( typeof match !== 'object' || match === null || Array.isArray( match ) )
    {
        return [];
    }

    const record = match as Record<string, unknown>;

    if( 'filter' in record && !( idField in record ) && !( '$and' in record ) && !( '$or' in record ) )
    {
        return extractTargetIdsFromFilter( record.filter, idField, normalizeId );
    }

    const collected: string[] = [];

    if( idField in record )
    {
        collected.push( ...extractFieldTargetIds( record[idField], normalizeId ) );
    }
    else if( idField === '_id' && 'id' in record )
    {
        collected.push( ...extractFieldTargetIds( record.id, normalizeId ) );
    }

    if( Array.isArray( record.$and ) )
    {
        for( const branch of record.$and )
        {
            collected.push( ...extractTargetIdsFromFilter( branch, idField, normalizeId ) );
        }
    }

    if( Array.isArray( record.$or ) && record.$or.length > 0 )
    {
        const branchResults = record.$or.map( branch => extractTargetIdsFromFilter( branch, idField, normalizeId ) );

        if( branchResults.every( ids => ids.length > 0 ) )
        {
            for( const ids of branchResults )
            {
                collected.push( ...ids );
            }
        }
    }

    return Array.from( new Set( collected ) );
}

export class ModelCache implements ModelCacheInstance
{
    #delegate?: ModelCacheInstance;
    #entries = new Map<string, CacheEntry>();
    #idIndex = new Map<string, Set<string>>();
    #ttl: number;
    #maxTTL?: number;
    #sliding: boolean;
    #maxSize?: number;
    #clone: boolean;

    constructor( config: ModelCacheConfig = true )
    {
        if( isCustomCacheInstance( config ) )
        {
            this.#delegate = config;
            this.#ttl = 60_000;
            this.#sliding = false;
            this.#clone = true;

            return;
        }

        const options: ModelCacheOptions = typeof config === 'object' && config !== null ? config : {};

        this.#ttl = options.ttl ?? 60_000;
        this.#maxTTL = options.maxTTL;
        this.#sliding = options.sliding ?? false;
        this.#maxSize = options.maxSize;
        this.#clone = options.clone ?? true;
    }

    public get<T = unknown>( key: string ): T | undefined
    {
        if( this.#delegate )
        {
            const val = this.#delegate.get( key );

            return ( val !== undefined && this.#clone ? cloneCachedValue( val ) : val ) as T | undefined;
        }

        const entry = this.#entries.get( key );

        if( !entry )
        {
            return undefined;
        }

        const now = Date.now();

        if( now >= entry.expiresAt )
        {
            this.#deleteKey( key, entry );

            return undefined;
        }

        if( this.#sliding )
        {
            const nextExpiry = now + this.#ttl;
            entry.expiresAt = this.#maxTTL !== undefined
                ? Math.min( nextExpiry, entry.createdAt + this.#maxTTL )
                : nextExpiry;
        }

        // Refresh LRU order
        this.#entries.delete( key );
        this.#entries.set( key, entry );

        return ( this.#clone ? cloneCachedValue( entry.value ) : entry.value ) as T;
    }

    public set( key: string, value: unknown, ids: string[] = [] ): void
    {
        const storedValue = this.#clone ? cloneCachedValue( value ) : value;

        if( this.#delegate )
        {
            this.#delegate.set( key, storedValue, ids );

            return;
        }

        const existing = this.#entries.get( key );

        if( existing )
        {
            this.#deleteKey( key, existing );
        }
        else if( this.#maxSize !== undefined && this.#maxSize > 0 && this.#entries.size >= this.#maxSize )
        {
            const oldestKey = this.#entries.keys().next().value;

            if( oldestKey !== undefined )
            {
                const oldestEntry = this.#entries.get( oldestKey );
                oldestEntry && this.#deleteKey( oldestKey, oldestEntry );
            }
        }

        const now = Date.now();
        const initialExpiry = now + this.#ttl;
        const expiresAt = this.#maxTTL !== undefined
            ? Math.min( initialExpiry, now + this.#maxTTL )
            : initialExpiry;

        const entry: CacheEntry =
        {
            value       : storedValue,
            createdAt   : now,
            expiresAt,
            ids
        };

        this.#entries.set( key, entry );

        for( const id of ids )
        {
            let keysForId = this.#idIndex.get( id );

            if( !keysForId )
            {
                keysForId = new Set<string>();
                this.#idIndex.set( id, keysForId );
            }

            keysForId.add( key );
        }
    }

    public invalidateIds( ids: string[] ): string[]
    {
        if( this.#delegate )
        {
            return this.#delegate.invalidateIds( ids );
        }

        const evictedKeys: string[] = [];

        for( const id of ids )
        {
            const keys = this.#idIndex.get( id );

            if( !keys )
            {
                continue;
            }

            for( const key of Array.from( keys ) )
            {
                const entry = this.#entries.get( key );

                if( entry )
                {
                    this.#deleteKey( key, entry );
                    evictedKeys.push( key );
                }
            }

            this.#idIndex.delete( id );
        }

        return evictedKeys;
    }

    public clear(): void
    {
        if( this.#delegate )
        {
            this.#delegate.clear();

            return;
        }

        this.#entries.clear();
        this.#idIndex.clear();
    }

    #deleteKey( key: string, entry: CacheEntry ): void
    {
        this.#entries.delete( key );

        for( const id of entry.ids )
        {
            const keysForId = this.#idIndex.get( id );

            if( keysForId )
            {
                keysForId.delete( key );

                if( keysForId.size === 0 )
                {
                    this.#idIndex.delete( id );
                }
            }
        }
    }
}
