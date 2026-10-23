import { Document, ObjectId, OnlyFieldsOfType, Sort, UpdateFilter } from 'mongodb';
import { deleteUndefinedProperties, objectGet } from './object.js';
import { ModelConverterError } from '../errors.js';
import { AbstractModelConverter } from '../types/index.js';

type Filter = Record<string, any>;
const SORT_DESC = [ -1, '-1', 'desc', 'descending' ];

export const toBase64 = ( str: string ) => Buffer.from( str, 'utf8' ).toString( 'base64url' );
export const fromBase64 = ( str: string ) => Buffer.from( str, 'base64url' ).toString( 'utf8' );

export async function convert<DBE extends Document>( model: object, converter: AbstractModelConverter<DBE>, dbe: DBE, conversion: string | number | symbol )
{
    try
    {
        return await converter( dbe );
    }
    catch( e )
    {
        if( e instanceof ModelConverterError )
        {
            throw e;
        }

        throw new ModelConverterError( model, conversion.toString(), dbe._id ?? dbe.id, e as Error );
    }
}

export function reverseSort( sort: Sort ): Sort
{
    return Object.fromEntries( Object.entries( sort ).map(([ key, value ]) => [ key, SORT_DESC.includes( value ) ? 1 : -1 ]));
}

export function sortProjection( sort: Sort, id: string ): Record<string, 1>
{
    return Object.fromEntries([ ...Object.keys( sort ).map( key => [ key, 1 ] ), [ id, 1 ]]);
}

export function isLibraryObjectId( value: unknown ): value is ObjectId
{
    return value instanceof ObjectId;
}

export function isForeignObjectIdLike( value: unknown ): boolean
{
    if( typeof value !== 'object' || value === null || Array.isArray( value ) )
    {
        return false;
    }

    if( value instanceof Date || value instanceof RegExp || isLibraryObjectId( value ) )
    {
        return false;
    }

    const candidate = value as { _bsontype?: string, constructor?: { name?: string }, toString?: () => string };
    const hasShape = candidate._bsontype === 'ObjectId' || candidate.constructor?.name === 'ObjectId';

    if( !hasShape || typeof candidate.toString !== 'function' )
    {
        return false;
    }

    return ObjectId.isValid( candidate.toString() );
}

export function coerceToLibraryObjectId( value: unknown ): unknown
{
    if( isLibraryObjectId( value ) )
    {
        return value;
    }

    if( isForeignObjectIdLike( value ) )
    {
        return new ObjectId(( value as { toString: () => string }).toString() );
    }

    return value;
}

export function isNonPlainOptimizerValue( value: unknown ): boolean
{
    return isLibraryObjectId( value ) || isForeignObjectIdLike( value ) || value instanceof Date || value instanceof RegExp;
}

export function resolveBSONValue( value: any ): any
{
    if( typeof value === 'string' ){ return value }
    if( typeof value !== 'object' || value === null ){ return value }
    if( value instanceof Date || value instanceof RegExp )
    {
        return value;
    }

    const coerced = coerceToLibraryObjectId( value );

    if( isLibraryObjectId( coerced ) )
    {
        return coerced;
    }

    if( typeof value === 'object' && Object.keys( value ).length === 1 )
    {
        if( value.hasOwnProperty( '$oid' ) ){ return new ObjectId( value.$oid as string ) }
        if( value.hasOwnProperty( '$date' ) ){ return new Date( value.$date ) }
        if( value.hasOwnProperty( '$function' ) )
        {
            if( typeof value.$function.body === 'function' )
            {
                return { $function: { ...value.$function, body: value.$function.body.toString() } };
            }

            return value;
        }
    }

    return resolveBSONObject( value );
}

export function resolveBSONObject( obj: Record<string, any> ): Record<string, any>
{
    if( Array.isArray( obj ) )
    {
        return obj.map( item => resolveBSONValue( item ));
    }

    const resolved: Record<string, any> = {};

    for( const key in obj )
    {
        if( obj.hasOwnProperty( key ) )
        {
            resolved[key] = resolveBSONValue( obj[key] );
        }
    }

    return resolved;
}

export function bsonValue( value: any )
{
    const coerced = coerceToLibraryObjectId( value );

    if( isLibraryObjectId( coerced ) ){ return { $oid: coerced.toString() } }
    if( value instanceof Date ){ return { $date: value.getTime() } }

    return value;
}

export function isUpdateOperator( update: object ): boolean
{
    return typeof update === 'object' && update !== null && Object.keys( update ).every( key => key.startsWith( '$' ));
}

export function toUpdateOperations<T>( update: Partial<T> | UpdateFilter<T> ): UpdateFilter<T>
{
    if( isUpdateOperator( update ) )
    {
        return resolveBSONObject( update as Record<string, any> ) as UpdateFilter<T>;
    }

    const $set = deleteUndefinedProperties( update ) as Partial<T>;
    const $unset = Object.fromEntries( Object.entries( update ).filter(([ , value ]) => value === undefined ).map(([ key ]) => [ key, 1 ])) as OnlyFieldsOfType<T, 1>;
    const result = Object.keys( $unset ).length ? { $unset, $set } : { $set };

    return resolveBSONObject( result ) as UpdateFilter<T>;
}

export function getCursor( dbe: Document, sort: Sort ): string
{
    return toBase64( JSON.stringify( Object.keys( sort ).map( key => bsonValue( objectGet( dbe, key.split( '.' ))))));
}

export function generateCursorCondition( cursor: string, sort: Sort ): Filter
{
    const direction = cursor.startsWith( 'prev:' ) ? 'prev' : cursor.startsWith( 'next:' ) ? 'next' : undefined;
    const properties = Object.keys( sort );
    const directions = Object.values( sort ).map( value => ( direction === 'prev' ? -1 : 1 ) * ( SORT_DESC.includes( value ) ? -1 : 1 ));
    const values = JSON.parse( fromBase64( cursor.substring( direction ? direction.length + 1 : 0 )));

    if( properties.length !== values.length )
    {
        throw new Error( 'Cursor does not match sort properties' );
    }

    if( properties.length === 1 )
    {
        return { [properties[0]]: { [( directions[0] === 1 ? '$gt' : '$lt' ) + ( !direction ? 'e' : '' )]: values[0] } };
    }

    const filter: Filter[] = [];

    for( let i = 0; i < properties.length; i++ )
    {
        const condition: Filter = {};
        filter.push( condition );

        for( let j = 0; j <= i; j++ )
        {
            condition[properties[j]] = { [( j < i ? '$eq' : directions[j] === 1 ? '$gt' : '$lt' ) + ( j === properties.length - 1 && !direction ? 'e' : '' )]: values[j] };
        }
    }

    return { $or: filter };
}

export const isSet = ( value: any ): boolean => value !== undefined && value !== null && ( Array.isArray( value ) ? value.length > 0 : ( typeof value === 'object' ? Object.keys( value ).length > 0 : true ));
export const Arr = ( value: any ): any[] => Array.isArray( value ) ? value : [ value ];
