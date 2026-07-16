import { ObjectId } from 'mongodb';
import { objectStringify } from '@liqd-js/fast-object-hash';
import { flowGet } from '../internal';
import crypto from 'crypto';

export function i18n( i18n: { [key: string]: string } | string ): string
{
    if( typeof i18n === 'string' ){ return i18n }

    const locales: Set<string> = flowGet('locales') || new Set();

    for( let locale of locales )
    {
        if( i18n.hasOwnProperty( locale ))
        {
            return i18n[locale]!;
        }
    }

    if( i18n.en ){ return i18n.en }

    return i18n[Object.keys(i18n)[0]]!;
}

export function multiI18n( i18n: { [key: string]: string } | string ): {[key: string]: string }
{
    const locales: Set<string> = flowGet('locales') || new Set();
    const result: {[key: string]: string } = {};

    for( let locale of locales )
    {
        if( typeof i18n === 'string' )
        {
            result[locale] = i18n;
        }
        else if( i18n.hasOwnProperty( locale ))
        {
            result[locale] = i18n[locale]!;
        }
        else
        {
            result[locale] = i18n.en ?? i18n[Object.keys(i18n)[0]]!;
        }
    }

    return result;
}

export function deleteNullishProperties<T,R=T>( obj: T ): R
{
    if( typeof obj !== 'object' ){ throw new Error('Unsupported type ' + typeof obj ) }
    else if( obj instanceof Date ){ return obj as R }
    else if( obj instanceof ObjectId ){ return obj as R }
    else if( obj instanceof RegExp ){ return obj as R }
    else if( obj === null || obj === undefined ){ return obj as unknown as R }

    if( Array.isArray( obj ))
    {
        return obj.map( value => value === null || value === undefined ? undefined : typeof value === 'object' ? deleteNullishProperties( value ) : value ).filter( value => value !== undefined ) as R;
    }

    const result: any = {};

    for( var [ key, value ] of Object.entries( obj ))
    {
        if( value !== null && value !== undefined )
        {
            result[key] = typeof value === 'object' ? deleteNullishProperties( value ) : value;
        }
    }

    return result;
}

export function deleteUndefinedProperties<T,R=T>( obj: T ): R
{
    if( typeof obj !== 'object' ){ throw new Error('Unsupported type ' + typeof obj ) }
    else if( obj instanceof Date ){ return obj as R }
    else if( obj instanceof ObjectId ){ return obj as R }
    else if( obj instanceof RegExp ){ return obj as R }
    else if( obj === null ){ return obj as unknown as R }

    if( Array.isArray( obj ))
    {
        return obj.map( value => value === undefined ? undefined : typeof value === 'object' ? deleteUndefinedProperties( value ) : value ).filter( value => value !== undefined ) as R;
    }

    const result: any = {};

    for( var [ key, value ] of Object.entries( obj ))
    {
        if( value !== undefined )
        {
            result[key] = typeof value === 'object' ? deleteUndefinedProperties( value ) : value;
        }
    }

    return result;
}

/**
 * TODO
 * @param obj
 * @param options
 */
export function objectHash( obj: any, options: { sort?: boolean, alg?: 'plain' | 'sha1' | 'sha256' | 'cyrb64' } = {})
{
    const value = objectStringify( obj, { sortArrays: options.sort, ignoreUndefinedProperties: true, stringify: ( obj: any ) => obj instanceof ObjectId ? `ObjectId("${obj.toString()}")` : undefined });

    return options.alg !== 'plain' ? crypto.createHash( options.alg ?? 'sha1' ).update( value ).digest('hex') : value;
}

export function objectHashID( obj: any, options: { sort?: boolean, alg?: 'sha1' | 'sha256'  } = {})
{
    return new ObjectId( objectHash( obj, options ).substring(0, 24) );
}


export function objectSet( obj: Record<string, unknown>, path: string[], value: unknown )
{
    if ( !path.length )
    {
        throw new Error('Path is empty');
    }

    if( path.length === 1 )
    {
        obj[ path[0] ] = value;
    }
    else
    {
        if( !obj[ path[0] ]){ obj[ path[0] ] = {}}

        objectSet( obj[ path[0] ] as Record<string, unknown>, path.slice(1), value );
    }

    return obj;
}

export function objectGet( obj: Record<string, unknown>, path: string[] ): any
{
    if ( !path.length )
    {
        throw new Error('Path is empty');
    }

    if( path.length === 1 )
    {
        return obj[ path[0] ];
    }
    else
    {
        if( !obj[ path[0] ]){ return undefined }

        return objectGet( obj[ path[0] ] as Record<string, unknown>, path.slice(1));
    }
}

function objectFlattenRecursive( value: any, result: Record<string, unknown>, prefix: string )
{
    if( typeof value !== 'object' ||
        (
            ( value instanceof ObjectId ) ||
            ( value instanceof Date )  ||
            ( value instanceof RegExp ) || // TODO is basic object alternative?
            ( value === null )
        ))
    {
        result[prefix] = value;
    }
    else if ( Array.isArray( value ) )
    {
        for ( let i = 0; i < value.length; i++ )
        {
            objectFlattenRecursive( value[i], result, prefix ? `${prefix}.${i}` : `${i}` );
        }
    }
    else
    {
        for( const [ key, val ] of Object.entries( value ))
        {
            objectFlattenRecursive( val, result, prefix ? `${prefix}.${key}` : key );
        }
    }
}

export function objectFlatten( obj: Record<string, unknown> ): Record<string, unknown>
{
    const result: Record<string, unknown> = {};

    for( const [ key, value ] of Object.entries( obj ))
    {
        objectFlattenRecursive( value, result, key );
    }

    return result;
}