import { ObjectId } from 'mongodb';
import { isForeignObjectIdLike, isLibraryObjectId } from './helpers/mongo.js';

export interface ModelExternalCacheStore
{
    get( key: string ): unknown | undefined | Promise<unknown | undefined>;
    set( key: string, value: unknown, ttlMs?: number, ids?: string[] ): void | Promise<void>;
    invalidateIds?( ids: string[] ): string[] | void | Promise<string[] | void>;
    delete?( key: string | string[] ): void | Promise<void>;
    clear?(): void | Promise<void>;
}

export type ModelCacheStats =
{
    enabled         : boolean
    hits            : number
    misses          : number
    sets            : number
    invalidations   : number
    clears          : number
    size            : number
    hitRate         : number
};

export type ModelCacheOptions =
{
    ttl?     : number
    maxTTL?  : number
    sliding? : boolean
    maxSize? : number
    clone?   : boolean
    store?   : ModelExternalCacheStore
};

export interface ModelCacheInstance
{
    get( key: string ): unknown | undefined;
    set( key: string, value: unknown, ids?: string[] ): void;
    invalidateIds( ids: string[] ): string[];
    clear(): void;
    stats?(): ModelCacheStats;
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
    #store?: ModelExternalCacheStore;
    #entries = new Map<string, CacheEntry>();
    #idIndex = new Map<string, Set<string>>();
    #ttl: number;
    #maxTTL?: number;
    #sliding: boolean;
    #maxSize?: number;
    #clone: boolean;
    #hits = 0;
    #misses = 0;
    #sets = 0;
    #invalidations = 0;
    #clears = 0;

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
        this.#store = options.store;
    }

    public get hasAsyncStore(): boolean
    {
        return Boolean( this.#store );
    }

    public stats(): ModelCacheStats
    {
        if( this.#delegate?.stats )
        {
            return this.#delegate.stats();
        }

        const total = this.#hits + this.#misses;

        return {
            enabled         : true,
            hits            : this.#hits,
            misses          : this.#misses,
            sets            : this.#sets,
            invalidations   : this.#invalidations,
            clears          : this.#clears,
            size            : this.#entries.size,
            hitRate         : total > 0 ? this.#hits / total : 0
        };
    }

    public get<T = unknown>( key: string ): T | undefined
    {
        if( this.#delegate )
        {
            const val = this.#delegate.get( key );

            if( val !== undefined )
            {
                this.#hits++;

                return ( this.#clone ? cloneCachedValue( val ) : val ) as T;
            }

            this.#misses++;

            return undefined;
        }

        const entry = this.#entries.get( key );

        if( !entry )
        {
            this.#misses++;

            return undefined;
        }

        const now = Date.now();

        if( now >= entry.expiresAt )
        {
            this.#deleteKey( key, entry );
            this.#misses++;

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
        this.#hits++;

        return ( this.#clone ? cloneCachedValue( entry.value ) : entry.value ) as T;
    }

    public async getAsync<T = unknown>( key: string, ids: string[] = [] ): Promise<T | undefined>
    {
        const local = this.get<T>( key );

        if( local !== undefined || !this.#store )
        {
            return local;
        }

        const externalVal = await this.#store.get( key );

        if( externalVal !== undefined )
        {
            this.#misses--;
            this.#hits++;
            this.#setLocal( key, externalVal, ids );

            return ( this.#clone ? cloneCachedValue( externalVal ) : externalVal ) as T;
        }

        return undefined;
    }

    #setLocal( key: string, value: unknown, ids: string[] = [] ): unknown
    {
        const storedValue = this.#clone ? cloneCachedValue( value ) : value;
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

        return storedValue;
    }

    public set( key: string, value: unknown, ids: string[] = [] ): void
    {
        this.#sets++;

        if( this.#delegate )
        {
            const storedValue = this.#clone ? cloneCachedValue( value ) : value;

            this.#delegate.set( key, storedValue, ids );

            return;
        }

        const storedValue = this.#setLocal( key, value, ids );

        if( this.#store )
        {
            void Promise.resolve( this.#store.set( key, storedValue, this.#ttl, ids )).catch(() => {});
        }
    }

    public async setAsync( key: string, value: unknown, ids: string[] = [] ): Promise<void>
    {
        if( !this.#store )
        {
            this.set( key, value, ids );

            return;
        }

        this.#sets++;
        const storedValue = this.#setLocal( key, value, ids );
        await this.#store.set( key, storedValue, this.#ttl, ids );
    }

    #invalidateLocalIds( ids: string[] ): string[]
    {
        const evictedKeys: string[] = [];

        for( const id of ids )
        {
            const keys = this.#idIndex.get( id );

            if( !keys ){ continue }

            this.#idIndex.delete( id );

            for( const key of keys )
            {
                const entry = this.#entries.get( key );

                if( entry )
                {
                    this.#deleteKey( key, entry );
                    evictedKeys.push( key );
                }
            }
        }

        return evictedKeys;
    }

    public invalidateIds( ids: string[] ): string[]
    {
        this.#invalidations++;

        if( this.#delegate )
        {
            return this.#delegate.invalidateIds( ids );
        }

        const evictedKeys = this.#invalidateLocalIds( ids );

        if( this.#store )
        {
            if( typeof this.#store.invalidateIds === 'function' )
            {
                void Promise.resolve( this.#store.invalidateIds( ids )).catch(() => {});
            }
            else if( typeof this.#store.delete === 'function' && evictedKeys.length > 0 )
            {
                void Promise.resolve( this.#store.delete( evictedKeys )).catch(() => {});
            }
        }

        return evictedKeys;
    }

    public async invalidateIdsAsync( ids: string[] ): Promise<string[]>
    {
        if( !this.#store )
        {
            return this.invalidateIds( ids );
        }

        this.#invalidations++;
        const evictedKeys = this.#invalidateLocalIds( ids );

        if( typeof this.#store.invalidateIds === 'function' )
        {
            const storeEvicted = await this.#store.invalidateIds( ids );

            if( Array.isArray( storeEvicted ) && storeEvicted.length > 0 )
            {
                return Array.from( new Set([ ...evictedKeys, ...storeEvicted ]) );
            }
        }
        else if( typeof this.#store.delete === 'function' && evictedKeys.length > 0 )
        {
            await this.#store.delete( evictedKeys );
        }

        return evictedKeys;
    }

    public clear(): void
    {
        this.#clears++;

        if( this.#delegate )
        {
            this.#delegate.clear();

            return;
        }

        this.#entries.clear();
        this.#idIndex.clear();

        if( this.#store?.clear )
        {
            void Promise.resolve( this.#store.clear() ).catch(() => {});
        }
    }

    public async clearAsync(): Promise<void>
    {
        if( !this.#store )
        {
            this.clear();

            return;
        }

        this.#clears++;
        this.#entries.clear();
        this.#idIndex.clear();
        await this.#store.clear?.();
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
