import {ObjectId} from "mongodb";
import { Log } from "./log";

export const REGISTER_MODEL = Symbol('REGISTER_MODEL');
export const GET_PARENT = Symbol('GET_PARENT');
const fs = require('fs');

const Flow = require('@liqd-js/flow');

export function flowStart( callback: Function, scope: object )
{
    Flow.start( callback, scope );
}

export function flowGet<T>( key: string, fallback?: T ): T
{
    return Flow.get( key, fallback );
}

export function flowSet( key: string, value: any )
{
    Flow.set( key, value );
}

export function flowExecute<T>( callback: () => T | Promise<T>, scope: object, freeze: boolean | { exit?: boolean, freeze?: boolean } = true ): Promise<T>
{
    return  Flow.execute( callback, scope, freeze );
}

export function map<T,E>(ids: T[], entries: E[], getID: (e: E ) => T ): Array<E | null>
{
    const index = new Map<T | string,E>( entries.map( e => [ idToIndexKey(getID( e )), e ] ));

    return ids.map( id => index.get( idToIndexKey(id) ) ?? null );
}

function idToIndexKey<T>( id: T )
{
    return id instanceof ObjectId ? id.toString() : id;
}

const { inspect } = require('util');

export function LOG( ...args: unknown[] )
{
    console.log( ...args.map( a => typeof a === 'string' ? a : inspect( a, { colors: true, depth: Infinity })));
}

function stringify(value: any, indentation: string = ''): string
{
    if (typeof value === 'undefined') {
        return 'undefined';
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value.toString();
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        const elements = value.map((element) => stringify(element, indentation));
        return '[' + elements.join(',') + ']';
    }
    if (typeof value === 'object') {
        if (value instanceof Date) { return 'ISODate("' + value.toISOString() + '")' }
        if (value instanceof RegExp) { return value.toString() }
        if (value instanceof ObjectId) { return 'ObjectId("' + value.toHexString() + '")' }

        const properties = Object.keys(value).map((key) => {
            const val = stringify(value[key], indentation + '  ');
            return indentation + '"' + key + '": ' + val;
        });
        return '{\n' + properties.join(',\n') + '\n' + indentation + '}';
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
    const path = (flowGet( 'experimentalFlags' ) as any)?.['logQueries'];
    const traceID = flowGet( 'traceID' );

    if ( !path || !traceID )
    {
        return;
    }

    Log.append( path + '/' + traceID + '.txt', stringify( query ) + ( separator ? '\n===============================\n\n' : '\n' ));
}