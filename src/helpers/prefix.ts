import { Document, FindOptions, ObjectId, UpdateFilter } from 'mongodb';
import { isNonPlainOptimizerValue } from './bson.js';
import { objectSet } from './object.js';

type Filter = Record<string, any>;

function addPrefixToValue( filter: Filter | any, prefix: string, prefixKeys: boolean = true ): Filter | any
{
    if( typeof filter === 'string' && filter.match( /^\$\$ROOT\./ ) ){ return filter.replace( /^\$\$ROOT\./, '$' ) }
    if( typeof filter === 'string' && filter.match( /^\$_root\./ ) ){ return '$' + filter.substring( '$_root.'.length ) }
    if( typeof filter === 'string' && filter.match( /^\$[^\$]/ ) ){ return prefix ? filter.replace( /^\$/, '$' + prefix + '.' ) : filter }
    if( typeof filter === 'string' ){ return filter }
    if( typeof filter !== 'object' || filter === null ){ return filter }

    if( typeof filter === 'object' && !Array.isArray( filter ) && Object.keys( filter ).length === 1 && [ '$cond', '$switch', '$function', '$accumulator', '$reduce', '$map', '$filter', '$convert', '$dateFromString' ].includes( Object.keys( filter )[0] ) )
    {
        const key = Object.keys( filter )[0];

        if( key === '$switch' )
        {
            return {
                $switch:
                {
                    branches    : filter.$switch.branches.map(( branch: any ) => ({ ...branch, case: addPrefixToValue( branch.case, prefix, prefixKeys ) })),
                    default     : addPrefixToValue( filter.$switch.default, prefix, prefixKeys )
                }
            };
        }
        else if( key === '$function' )
        {
            return {
                $function:
                {
                    lang    : filter[key].lang,
                    args    : addPrefixToValue( filter[key].args, prefix, false ),
                    body    : filter[key].body
                }
            };
        }

        return { [key]: Object.fromEntries( Object.entries( filter[key] ).map(([ k, value ]) => [ k, addPrefixToValue( value, prefix ) ])) };
    }

    if( typeof filter === 'object' && isNonPlainOptimizerValue( filter ) )
    {
        return filter;
    }

    return addPrefixToFilter( filter, prefix, prefixKeys );
}

export function addPrefixToFilter( filter: Filter, prefix: string, prefixKeys: boolean = true ): Filter
{
    if( Array.isArray( filter ) )
    {
        return filter.map( item => addPrefixToValue( item, prefix, prefixKeys ));
    }

    let newFilter: Filter = {};

    for( const key in filter )
    {
        if( filter.hasOwnProperty( key ) )
        {
            if( key === '_root' )
            {
                Object.assign( newFilter, addPrefixToValue( filter[key], prefix, false ));
            }
            else if( key.startsWith( '_root.' ) )
            {
                newFilter[key.substring( '_root.'.length )] = addPrefixToValue( filter[key], prefix, false );
            }
            else if( key === '$function' )
            {
                newFilter = addPrefixToValue( filter, prefix, prefixKeys );
                break;
            }
            else if( !prefixKeys || key.startsWith( '$' ) )
            {
                newFilter[key] = addPrefixToValue( filter[key], prefix, prefixKeys );
            }
            else
            {
                newFilter[`${prefix}.${key}`] = addPrefixToValue( filter[key], prefix, false );
            }
        }
    }

    return newFilter;
}

export function addPrefixToPipeline( pipeline: Document[], prefix: string ): Document[]
{
    if( !prefix ){ return pipeline }

    const prefixed = [];

    for( const pipelineStage of pipeline )
    {
        const [ stage, query ] = Object.entries( pipelineStage )[0];

        if([ '$addFields', '$facet', '$match', '$set', '$sort' ].includes( stage ) )
        {
            prefixed.push({ [stage]: addPrefixToValue( query, prefix ) });
        }
        else if([ '$group' ].includes( stage ) )
        {
            prefixed.push({ [stage]: Object.fromEntries( Object.entries( query ).map(([ key, value ]) => [ key === '_id' ? key : prefix + '.' + key, addPrefixToValue( value, prefix ) ])) });
        }
        else if([ '$limit', '$skip' ].includes( stage ) )
        {
            prefixed.push({ [stage]: query });
        }
        else if([ '$unset', '$count' ].includes( stage ) )
        {
            prefixed.push({ [stage]: Array.isArray( query ) ? query.map( field => `${prefix}.${field}` ) : `${prefix}.${query}` });
        }
        else if([ '$project' ].includes( stage ) )
        {
            prefixed.push({ [stage]: projectionToProject( query, prefix ) });
        }
        else if([ '$densify' ].includes( stage ) )
        {
            prefixed.push(
            {
                $densify:
                {
                    field               : addPrefixToValue( query.field, prefix ),
                    partitionByFields   : query.partitionByFields.map(( field: string ) => addPrefixToValue( field, prefix )),
                    range               :
                    {
                        step    : query.range.step,
                        unit    : query.range.unit,
                        bounds  : query.range.bounds.map(( bound: any ) => addPrefixToValue( bound, prefix ))
                    }
                }
            });
        }
        else if([ '$geoNear' ].includes( stage ) )
        {
            prefixed.push(
            {
                $geoNear:
                {
                    ...Object.fromEntries( Object.entries( query ).map(([ key, value ]) => [ key, addPrefixToValue( value, prefix ) ])),
                    near: query.near
                }
            });
        }
        else if([ '$lookup' ].includes( stage ) )
        {
            prefixed.push(
            {
                $lookup:
                {
                    ...query,
                    from    : query.from,
                    ...( query.localField ? { localField: prefix + '.' + query.localField } : undefined ),
                    ...( query.foreignField ? { foreignField: query.foreignField } : undefined ),
                    as      : prefix + '.' + query.as,
                    ...( query.let ? { let: Object.fromEntries( Object.entries( query.let ).map(([ key, value ]) => [ key, addPrefixToValue( value, prefix ) ])) } : undefined )
                }
            });
        }
        else if([ '$bucket', '$bucketAuto', '$fill', '$graphLookup', '$replaceRoot', '$replaceWith', '$sample', '$unwind' ].includes( stage ) )
        {
            if( typeof query === 'string' )
            {
                prefixed.push({ [stage]: addPrefixToValue( query, prefix ) });
            }
            else
            {
                prefixed.push({ [stage]: Object.fromEntries( Object.entries( query ).map(([ key, value ]) => [ key, addPrefixToValue( value, prefix ) ])) });
            }
        }
        else
        {
            throw new Error( `Unsupported pipeline stage: "${stage}"` );
        }
    }

    return prefixed;
}

export function addPrefixToUpdate<RootDBE, DBE>( update: Partial<DBE> | UpdateFilter<DBE>, prefix: string ): Partial<RootDBE> | UpdateFilter<RootDBE>
{
    const newUpdate: Record<string, any> = {};

    for( const [ key, value ] of Object.entries( update ) )
    {
        if( key.startsWith( '$' ) )
        {
            newUpdate[key] = addPrefixToUpdate( value, prefix );
        }
        else
        {
            newUpdate[`${prefix}.${key}`] = value;
        }
    }

    return newUpdate;
}

export function isExclusionProjection( projection: FindOptions['projection'] ): boolean
{
    if( typeof projection !== 'object' || projection === null )
    {
        return false;
    }

    let isExclusion = undefined;

    for( const value of Object.values( projection ) )
    {
        if( typeof value === 'number' && value === 0 )
        {
            if( isExclusion === false )
            {
                throw new Error( 'Projection cannot contain both exclusion and inclusion' );
            }

            isExclusion = true;
        }
        else if( typeof value === 'object' && Object.keys( value ).every( key => !key.startsWith( '$' )) )
        {
            const res = isExclusionProjection( value );

            if( isExclusion !== undefined && isExclusion !== res )
            {
                throw new Error( 'Projection cannot contain both exclusion and inclusion' );
            }

            isExclusion = res;
        }
        else
        {
            if( isExclusion === true )
            {
                throw new Error( 'Projection cannot contain both exclusion and inclusion' );
            }

            isExclusion = false;
        }
    }

    return isExclusion ?? false;
}

/**
 * Converts projection to project object
 * @param projection - projection to convert
 * @param prefix - prefix to add to keys
 * @param prefixKeys - whether to add prefix to object keys
 * @param fullPath - full path to the object - used for nested object projections
 * @param simpleKeys - true if keys are simple - without dots
 */
function projectionToProjectInternal(
    projection: FindOptions['projection'] = {},
    prefix: string = '',
    prefixKeys: boolean = false,
    fullPath: string = '',
    simpleKeys?: boolean
): Record<string, unknown>
{
    if( Array.isArray( projection ) )
    {
        // @ts-ignore
        return projection.map( item =>
        {
            if( item )
            {
                if( item instanceof ObjectId || item instanceof Date || item instanceof RegExp )
                {
                    return item;
                }
                else if( typeof item === 'string' )
                {
                    return addPrefixToValue( item, prefix, false );
                }
                else if( typeof item === 'object' )
                {
                    return projectionToProjectInternal( item, prefix, false, fullPath );
                }
            }

            return item;
        });
    }

    const result: Document = {};

    for( const [ key, value ] of Object.entries( projection || {} ) )
    {
        if( key.startsWith( '$' ) && prefixKeys ){ throw new Error( 'Projection key cannot start with "$"' ) }

        if( key.startsWith( '$' ) )
        {
            result[key] = projectionToProjectInternal( value, prefix, false, fullPath );
        }
        else
        {
            const prefixedKey = prefix ? prefix + '.' + key : key;
            const keyFullPath = fullPath ? fullPath + '.' + key : key;
            let projectedValue: any;

            switch( typeof value )
            {
                case 'number':
                    projectedValue = ( value === 0 ) ? 0 : '$' + keyFullPath;
                    break;

                case 'string':
                    projectedValue = addPrefixToValue( value, prefix, false );
                    break;

                case 'object':
                    projectedValue = projectionToProjectInternal( value, prefix, false, keyFullPath );
                    break;

                default:
                    throw new Error( 'Unsupported projection value type' );
            }

            if( simpleKeys )
            {
                objectSet( result, ( prefixKeys ? prefixedKey : key ).split( '.' ), projectedValue );
            }
            else
            {
                result[prefixKeys ? prefixedKey : key] = projectedValue;
            }
        }
    }

    return result;
}

export function projectionToReplace( projection: FindOptions['projection'] = {}, prefix?: string ): Record<string, unknown>
{
    return projectionToProjectInternal( projection, prefix, false, prefix, true );
}

export function projectionToProject( projection: FindOptions['projection'] = {}, prefix?: string, prefixKeys: boolean = true ): Record<string, unknown>
{
    return projectionToProjectInternal( projection, prefix, prefixKeys, prefix, false );
}

/**
 * Builds update parameters for property model update
 * @param paths
 * @param parentID
 */
export function propertyModelUpdateParams( paths: { path: string, array: boolean }[], parentID: any, ancestorIds?: any[] )
{
    let parentPath: string | undefined = paths.slice( 0, paths.length - 1 ).map( p => p.path ).join( '.' );
    parentPath = parentPath !== '' ? parentPath + '.' : undefined;
    const parentIDPath = parentPath ? parentPath + 'id' : '_id';

    const currModelSubPath = paths[paths.length - 1];

    let updatePath = paths.slice( 0, paths.length - 1 ).map(( p, i ) => p.path + ( p.array ? `.$[path${i}]` : '' )).join( '.' );
    updatePath = updatePath !== '' ? `${updatePath}.${currModelSubPath.path}` : currModelSubPath.path;

    const arrayFilters: Document[] = [];
    let ancestorIdx = 0;

    for( let i = 0; i < paths.length - 1; i++ )
    {
        const path = paths[i];

        if( path.array )
        {
            if( ancestorIds && ancestorIdx < ancestorIds.length )
            {
                let nextArrayOrEnd = i + 1;

                while( nextArrayOrEnd < paths.length - 1 && !paths[nextArrayOrEnd].array )
                {
                    nextArrayOrEnd++;
                }

                let segmentRest = paths.slice( i + 1, nextArrayOrEnd ).map( p => p.path ).join( '.' );
                segmentRest = segmentRest !== '' ? segmentRest + '.' : '';
                arrayFilters.push({ [`path${i}.${segmentRest}id`]: ancestorIds[ancestorIdx] });
                ancestorIdx++;
            }
            else
            {
                let pathRest = paths.slice( i + 1, paths.length - 1 ).map( p => p.path ).join( '.' );
                pathRest = pathRest !== '' ? pathRest + '.' : '';
                arrayFilters.push({ [`path${i}.${pathRest}id`]: parentID });
            }
        }
    }

    return { parentIDPath, updatePath, arrayFilters };
}

export function propertyModelTargetUpdateParams( paths: { path: string, array: boolean }[], targetIdCondition: any ): { updatePrefix: string, arrayFilters?: Document[] }
{
    const leaf = paths[paths.length - 1];

    if( leaf.array )
    {
        const ancestorPrefix = paths.slice( 0, -1 ).map( p => p.path + ( p.array ? '.$[]' : '' )).join( '.' );
        const updatePrefix = ( ancestorPrefix ? ancestorPrefix + '.' : '' ) + leaf.path + '.$[entry]';

        return {
            updatePrefix,
            arrayFilters: [{ 'entry.id': targetIdCondition }]
        };
    }

    const lastArrayIdx = paths.findLastIndex( p => p.array );

    if( lastArrayIdx === -1 )
    {
        return {
            updatePrefix: paths.map( p => p.path ).join( '.' )
        };
    }

    const prefixParts = paths.map(( p, idx ) =>
    {
        if( idx < lastArrayIdx )
        {
            return p.path + ( p.array ? '.$[]' : '' );
        }

        if( idx === lastArrayIdx )
        {
            return p.path + '.$[entry]';
        }

        return p.path;
    });

    const tailPath = paths.slice( lastArrayIdx + 1 ).map( p => p.path ).join( '.' );

    return {
        updatePrefix: prefixParts.join( '.' ),
        arrayFilters: [{ [`entry.${tailPath}.id`]: targetIdCondition }]
    };
}
