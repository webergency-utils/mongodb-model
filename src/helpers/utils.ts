import { inspect } from 'node:util';
import { flowGet } from '../flow.js';
import { Log } from './log.js';
import { isForeignObjectIdLike, isLibraryObjectId } from './mongo.js';

export function map<T, E>( ids: T[], entries: E[], getID: ( e: E ) => T ): Array<E | null>
{
    const index = new Map<T | string, E>( entries.map( e => [ idToIndexKey( getID( e ) ), e ] ));

    return ids.map( id => index.get( idToIndexKey( id ) ) ?? null );
}

function idToIndexKey<T>( id: T )
{
    return ( isLibraryObjectId( id ) || isForeignObjectIdLike( id ) ) ? ( id as { toString: () => string } ).toString() : id;
}

export function LOG( ...args: unknown[] )
{
    console.log( ...args.map( a => typeof a === 'string' ? a : inspect( a, { colors: true, depth: Infinity })));
}

function stringify( value: any, indentation: string = '' ): string
{
    if( typeof value === 'undefined' )
    {
        return 'undefined';
    }

    if( value === null )
    {
        return 'null';
    }

    if( typeof value === 'number' || typeof value === 'boolean' )
    {
        return value.toString();
    }

    if( typeof value === 'string' )
    {
        return JSON.stringify( value );
    }

    if( Array.isArray( value ) )
    {
        const elements = value.map(( element ) => stringify( element, indentation ));

        return '[' + elements.join( ',' ) + ']';
    }

    if( typeof value === 'object' )
    {
        if( value instanceof Date ){ return 'ISODate("' + value.toISOString() + '")' }
        if( value instanceof RegExp ){ return value.toString() }
        if( isLibraryObjectId( value ) || isForeignObjectIdLike( value ) )
        {
            const hex = typeof ( value as any ).toHexString === 'function' ? ( value as any ).toHexString() : String( value );

            return 'ObjectId("' + hex + '")';
        }

        const properties = Object.keys( value ).map(( key ) =>
        {
            const val = stringify( value[key], indentation + '  ' );

            return indentation + '"' + key + '": ' + val;
        });

        return '{\n' + properties.join( ',\n' ) + '\n' + indentation + '}';
    }

    return '';
}

export function hasPublicMethod( obj: any, method: string ): boolean
{
    return obj && method in obj && typeof obj[method] === 'function';
}

export function DUMP( obj: object )
{
    console.log( stringify( obj ));
}

export function LOG_FILE( query: any, separator: boolean = false )
{
    const path = ( flowGet( 'experimentalFlags' ) as any )?.['logQueries'];
    const traceID = flowGet( 'traceID' );

    if( !path || !traceID )
    {
        return;
    }

    Log.append( path + '/' + traceID + '.txt', stringify( query ) + ( separator ? '\n===============================\n\n' : '\n' ));
}
