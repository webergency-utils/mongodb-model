import { Document, Filter as MongoFilter, ObjectId } from 'mongodb';
import { getStageInfo, optimizeFilter } from '@webergency-utils/mongodb-query-optimizer';
import { isNonPlainOptimizerValue } from './bson.js';
import { objectHash } from './object.js';
import { SyncComputedPropertyMethod } from '../types/index.js';

export * from './bson.js';
export * from './prefix.js';

export function collectAddedFields( pipeline: any[] ): string[]
{
    const fields = new Set<string>();

    for( let i = 0; i < pipeline.length; i++ )
    {
        const stage = pipeline[i];
        const info = getStageInfo( stage, i );

        if( info.isUnknown )
        {
            const addedFields = stage?.$addFields || stage?.$set;

            if( addedFields && typeof addedFields === 'object' && !Array.isArray( addedFields ) )
            {
                Object.keys( addedFields ).forEach( prop => fields.add( prop ));
                continue;
            }

            if( stage?.$lookup && typeof stage.$lookup.as === 'string' )
            {
                fields.add( stage.$lookup.as );
                continue;
            }

            if( stage?.$unset && Array.isArray( stage.$unset ) && stage.$unset.length === 0 )
            {
                continue;
            }

            throw new Error( `Unsupported pipeline stage: "${Object.keys( stage || {} )[0]}"` );
        }

        for( const field of info.producedFields )
        {
            if( field !== '*' )
            {
                fields.add( field );
            }
        }

        for( const field of info.removedFields )
        {
            fields.delete( field );
        }
    }

    return [ ...fields ];
}

function cleanFilterForOptimizer( obj: any ): any
{
    if( !obj || typeof obj !== 'object' )
    {
        return obj;
    }

    if( Array.isArray( obj ) )
    {
        return obj
            .map( item => cleanFilterForOptimizer( item ))
            .filter( item => item !== undefined && item !== null && ( typeof item !== 'object' || Object.keys( item ).length > 0 ));
    }

    if( isNonPlainOptimizerValue( obj ) )
    {
        return obj;
    }

    const result: Record<string, any> = {};

    for( const [ key, value ] of Object.entries( obj ) )
    {
        if( value === undefined )
        {
            if( key.startsWith( '$' ) && key !== '$and' && key !== '$or' )
            {
                result[key] = value;
            }

            continue;
        }

        if( key === '$and' || key === '$or' )
        {
            const cleanedArr = Array.isArray( value ) ? cleanFilterForOptimizer( value ) : [];

            if( cleanedArr.length > 0 )
            {
                result[key] = cleanedArr;
            }

            continue;
        }

        if( value !== null && typeof value === 'object' && !Array.isArray( value ) && !isNonPlainOptimizerValue( value ) )
        {
            const cleanedSub = cleanFilterForOptimizer( value );

            if( Object.keys( cleanedSub ).length > 0 || Object.keys( value ).length === 0 )
            {
                result[key] = cleanedSub;
            }

            continue;
        }

        result[key] = value;
    }

    return result;
}

/**
 * Optimizes match filter by delegating to @webergency-utils/mongodb-query-optimizer
 * @param obj - filter to optimize
 * @returns optimized filter
 */
export function optimizeMatch( obj: MongoFilter<any> ): MongoFilter<any> | undefined
{
    if( !obj ){ return undefined }

    const cleaned = cleanFilterForOptimizer( obj );

    if( !cleaned || typeof cleaned !== 'object' )
    {
        return undefined;
    }

    return optimizeFilter( cleaned );
}

export function mergeComputedProperties( ...objects: Array<{ [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> | undefined } | undefined> ): { [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> }
{
    const computed: { [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> } = {};

    for( const properties of objects )
    {
        if( !properties ){ continue }

        for( const prefix in properties )
        {
            const prop = properties[prefix];

            if( !prop ){ continue }

            if( !computed[prefix] )
            {
                computed[prefix] = { fields: {}, pipeline: [] };
            }

            computed[prefix].fields = { ...computed[prefix].fields, ...prop.fields };
            prop.pipeline && computed[prefix].pipeline!.push( ...prop.pipeline );
        }
    }

    for( const prefix in computed )
    {
        if( !Object.entries( computed[prefix].fields || {} ).length )
        {
            computed[prefix].fields = null;
        }

        if( !computed[prefix].pipeline?.length )
        {
            computed[prefix].pipeline = null;
        }

        if( !computed[prefix].fields && !computed[prefix].pipeline )
        {
            delete computed[prefix];
        }
    }

    return computed;
}

/**
 * Merges properties of multiple objects into one object - helper for optimizeMatch
 * @param objects - objects to merge
 * @returns merged object or false if there are conflicting properties
 */
export function mergeProperties( ...objects: object[] ): object | false
{
    const result: any = {};

    if( !objects.every( el => typeof el === 'object' && !Array.isArray( el )) )
    {
        throw new Error( 'Invalid input - expected objects' );
    }

    for( const obj of objects as any[] )
    {
        for( const [ key, value ] of Object.entries( obj ) )
        {
            if( !result[key] )
            {
                result[key] = value;
                continue;
            }

            if( isConflicting( result[key], value ) )
            {
                return false;
            }

            if( isEq( result[key] ) && !result[key]['$eq'] )
            {
                result[key] = { $eq: result[key] };
            }

            if( typeof value === 'object' && ( value instanceof Date || value instanceof ObjectId || value instanceof RegExp ) )
            {
                result[key] = { ...result[key], $eq: value };
            }
            else if( typeof value === 'object' )
            {
                result[key] = { ...result[key], ...value };
            }
            else if( Object.keys( result[key] ).length === 0 )
            {
                result[key] = value;
            }
            else
            {
                result[key] = { ...result[key], $eq: value };
            }
        }
    }

    return result;
}

function isConflicting( obj1: any, obj2: any )
{
    if( !obj1 || !obj2 ){ return false }

    if( isEq( obj1 ) && isEq( obj2 ) )
    {
        return true;
    }

    if( typeof obj1 === 'object' && typeof obj2 === 'object' )
    {
        for( const key of Object.keys( obj1 ) )
        {
            if( obj2.hasOwnProperty( key ) )
            {
                return true;
            }
        }
    }

    return false;
}

function isEq( obj: any )
{
    return typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean' || obj === null
        || ( typeof obj === 'object'
            && (
                obj instanceof ObjectId
                || obj instanceof Date
                || obj instanceof RegExp
                || ( Object.keys( obj ).length === 1 && Object.keys( obj ).every( key => key === '$eq' ))
            )
        );
}

/**
 * Extracts fields used in the pipeline by delegating to @webergency-utils/mongodb-query-optimizer
 * @param pipeline
 */
export function getUsedFields( pipeline: Document[] ): { used: string[], ignored: string[] }
{
    const usedFields = new Set<string>();
    const ignoredFields = new Set<string>();

    for( let i = 0; i < pipeline.length; i++ )
    {
        const el = pipeline[i];
        const stage = Object.keys( el || {} )[0];
        const info = getStageInfo( el, i );

        if( info.isUnknown )
        {
            if( stage === '$match' && el.$match && typeof el.$match === 'object' )
            {
                for( const key of Object.keys( el.$match ) )
                {
                    if( !key.startsWith( '$' ) && !ignoredFields.has( key ) ){ usedFields.add( key ) }
                }

                continue;
            }

            if( stage === '$group' && el.$group && typeof el.$group === 'object' )
            {
                const withId = getStageInfo({ $group: { _id: null, ...el.$group } }, i );

                if( !withId.isUnknown )
                {
                    for( const field of withId.usedFields )
                    {
                        if( field !== '*' && !ignoredFields.has( field ) )
                        {
                            usedFields.add( field );
                        }
                    }

                    for( const key of Object.keys( el.$group ) )
                    {
                        ignoredFields.add( key );
                    }

                    continue;
                }
            }

            throw new Error( `Unsupported pipeline stage: "${stage}"` );
        }

        for( const field of info.usedFields )
        {
            if( field === '*' || ignoredFields.has( field ) )
            {
                continue;
            }

            if( stage === '$project' && el.$project?.[field] === 1 )
            {
                continue;
            }

            usedFields.add( field );
        }

        if( stage === '$replaceWith' && el.$replaceWith && typeof el.$replaceWith === 'object' && !Array.isArray( el.$replaceWith ) )
        {
            for( const key of Object.keys( el.$replaceWith ) )
            {
                if( !key.startsWith( '$' ) )
                {
                    ignoredFields.add( key );
                }
            }
        }
        else if( stage === '$project' && el.$project && typeof el.$project === 'object' )
        {
            for( const key of Object.keys( el.$project ) )
            {
                ignoredFields.add( key );
            }
        }
        else
        {
            for( const field of info.producedFields )
            {
                if( field !== '*' )
                {
                    ignoredFields.add( field );
                }
            }
        }
    }

    return { used: Array.from( usedFields ), ignored: Array.from( ignoredFields ) };
}

/**
 * Splits filter into stages to be put between unwinds based on the path
 * @param filter
 * @param paths
 * @returns {MongoFilter[]} - array of optimized filters for each stage
 */
export function splitFilterToStages<DBE>( filter: MongoFilter<DBE>, paths: { path: string, array: boolean }[] ): MongoFilter<DBE>[]
{
    const result: MongoFilter<DBE>[] = [];
    const subPaths = getSubPaths( paths );

    for( let i = 0; i <= subPaths.length; i++ )
    {
        const stage = subPaths.slice( 0, i ).join( '.' );
        const nextStage = subPaths.slice( 0, i + 1 ).join( '.' );

        result.push( optimizeMatch( subfilter( filter, stage, nextStage, paths ) ) as MongoFilter<DBE> );
    }

    return result;
}

/**
 * Create subPaths for unwinds
 * a[].b.c[].d[].e.f  =>  a, b.c, d, e.f
 * @param paths
 */
export function getSubPaths( paths: { path: string, array: boolean }[] ): string[]
{
    const subPaths: string[] = [];
    let current = '';

    for( const el of paths )
    {
        if( !el.array )
        {
            current += ( current ? '.' : '' ) + el.path;
        }
        else
        {
            current += ( current ? '.' : '' ) + el.path;
            subPaths.push( current );
            current = '';
        }
    }

    if( current !== '' )
    {
        subPaths.push( current );
    }

    return subPaths;
}

/**
 * Extracts properties from filter that are relevant for the given stage
 * @param filter
 * @param stage
 * @param nextStage
 * @param paths
 */
export function subfilter( filter: MongoFilter<any>, stage: string, nextStage: string, paths: { path: string, array: boolean }[] )
{
    const result: MongoFilter<any> = {};

    if( stage === nextStage )
    {
        return filter;
    }

    const currentStageIndex = paths.findIndex( s => s.path === stage.split( '.' ).reverse()[0] );
    const lastArrayStageIndex = [ ...paths ].reverse().findIndex( s => s.array );
    const isAfterLastArrayStage = currentStageIndex >= lastArrayStageIndex;

    for( const [ key, value ] of Object.entries( filter ) )
    {
        if( key === '$and' )
        {
            for( const andCondition of value as any[] )
            {
                const sub = subfilter( andCondition, stage, nextStage, paths );

                if( Object.keys( sub ).length )
                {
                    if( !result.$and )
                    {
                        result.$and = [];
                    }

                    result.$and.push( sub );
                }
            }
        }
        else if( key === '$or' )
        {
            const tmpFilter: MongoFilter<any> = {};

            for( const orCondition of value as any[] )
            {
                const sub = subfilter( orCondition, stage, nextStage, paths );

                if( !tmpFilter.$or )
                {
                    tmpFilter.$or = [];
                }

                tmpFilter.$or.push( sub );
            }

            if( objectHash( tmpFilter.$or ) === objectHash( value ) )
            {
                result.$or = tmpFilter.$or;
            }
        }
        else if( shouldBeAddedToStage( key, value, stage, nextStage ) )
        {
            result[key] = value;
        }
        else if( typeof value === 'object' && Object.keys( value ).length === 1 )
        {
            const operator = value.$in
                ? '$in'
                : ( value.$nin || value.$not?.$in ? '$nin' : undefined );

            if( operator && !isAfterLastArrayStage )
            {
                const elemMatch = transformToElemMatch( key, value.$in || value.$nin || value.$not.$in, operator, paths );

                if( elemMatch )
                {
                    result[elemMatch.key] = elemMatch.value;
                }
            }
            else if( isAfterLastArrayStage )
            {
                result[key] = value;
            }
        }
    }

    return result;
}

export function transformToElemMatch( key: string, value: any[], operator: '$in' | '$nin', paths: { path: string, array: boolean }[] ): { key: string, value: { $elemMatch: object } } | false
{
    const path = splitToSubPaths( key, paths );

    return {
        key     : path.prefix,
        value   : { $elemMatch: { [path.property]: { [operator]: value } } }
    };
}

/**
 * Splits given path into prefix that is part of the full model path and the rest. Prefix is the furthest path that leads to an array, property is the rest.
 * @param path - path to split
 * @param paths - reference full path
 */
function splitToSubPaths( path: string, paths: { path: string, array: boolean }[] ): { prefix: string, property: string }
{
    const splitPath = path.split( '.' );
    const furthestArrayIndex = [ ...splitPath ].reverse().findIndex( p => paths.find( s => s.path === p && s.array ));

    if( furthestArrayIndex === -1 )
    {
        return { prefix: '', property: path };
    }

    return {
        prefix      : splitPath.slice( 0, splitPath.length - furthestArrayIndex ).join( '.' ),
        property    : splitPath.slice( splitPath.length - furthestArrayIndex ).join( '.' )
    };
}

const BREAKING_OPERATORS = [ '$not', '$ne', '$in', '$nin', '$expr', '$elemMatch', '$function' ];

function shouldBeAddedToStage( key: string, value: any, stage: string, nextStage: string ): boolean
{
    if( !key.startsWith( '$' ) && ( !key.startsWith( stage ) || ( key.startsWith( stage ) && !key.startsWith( nextStage ) ) ) )
    {
        return true;
    }

    if( key.startsWith( nextStage ) )
    {
        if( typeof value !== 'object' || value === null || allOperationsAllowed( value ) )
        {
            return true;
        }
    }

    return false;
}

function allOperationsAllowed( obj: any )
{
    const operations = getOperations( obj );

    return operations.every( operation => !BREAKING_OPERATORS.includes( operation ))
        && ( obj['$exists'] === undefined || obj['$exists'] === true );
}

/**
 * Gets all operations in an object recursively
 * @param obj
 */
function getOperations( obj: object )
{
    const operations: string[] = [];

    for( const [ key, value ] of Object.entries( obj || {} ) )
    {
        if( key.startsWith( '$' ) )
        {
            operations.push( key );
        }

        if( typeof value === 'object' )
        {
            operations.push( ...getOperations( value ));
        }
    }

    return operations;
}
