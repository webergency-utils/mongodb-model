import { Document, Filter } from 'mongodb';
import { ModelError } from './errors.js';
import { addPrefixToFilter, addPrefixToPipeline } from './helpers/mongo.js';
import { hasPublicMethod } from './helpers/utils.js';
import
{
    ComputedPropertiesParam,
    ComputedPropertyMethod,
    SmartFilterMethod,
    SyncComputedPropertyMethod
}
from './types/internal.js';

export class SmartFilterResolver
{
    #model: object;
    #smartFilters: any;
    #prefix?: string;
    #parentResolve?: ( smartFilter: Record<string, any> ) => Promise<any>;

    constructor( model: object, smartFilters: any, options?: { prefix?: string, parentResolve?: ( smartFilter: Record<string, any> ) => Promise<any> })
    {
        this.#model = model;
        this.#smartFilters = smartFilters;
        this.#prefix = options?.prefix;
        this.#parentResolve = options?.parentResolve;
    }

    async resolve( smartFilter: Record<string, any> ): Promise<{ filter?: Filter<any>, pipeline?: Document[] } | { [prefix: string]: { filter?: Filter<any>, pipeline?: Document[] } }>
    {
        if( this.#prefix !== undefined )
        {
            return this.#resolveProperty( smartFilter );
        }

        return this.#resolveRoot( smartFilter );
    }

    async #resolveRoot( smartFilter: Record<string, any> ): Promise<{ filter?: Filter<any>, pipeline?: Document[] }>
    {
        const pipeline: Document[] = [];
        let filter: Filter<any> = {};
        const extraFilters: Record<string, any> = {};

        for( const [ key, value ] of Object.entries( smartFilter ) )
        {
            if( hasPublicMethod( this.#smartFilters, key ) )
            {
                const result = await (( this.#smartFilters as any )[key] as SmartFilterMethod )( value );

                result.pipeline && pipeline.push( ...result.pipeline );
                result.filter && ( filter = { $and: [{ ...filter }, result.filter ].filter( f => Object.keys( f ).length > 0 ) });
            }
            else
            {
                extraFilters[key] = value;
            }
        }

        if( Object.keys( extraFilters ).length > 0 )
        {
            throw new ModelError( 'MODEL_SMART_FILTER_UNSUPPORTED', this.#model, `Unsupported smart filters - ${JSON.stringify( extraFilters, null, 2 )}` );
        }

        return { filter, pipeline };
    }

    async #resolveProperty( smartFilter: Record<string, any> ): Promise<{ [prefix: string]: { filter?: Filter<any>, pipeline?: Document[] } }>
    {
        const result: { [path: string]: { filter?: Filter<any>, pipeline?: Document[] }} = {};
        const pipeline: Document[] = [];
        let filter: Filter<any> = {};
        const extraFilters: Document = {};
        const prefix = this.#prefix!;

        for( const [ key, value ] of Object.entries( smartFilter ) )
        {
            if( hasPublicMethod( this.#smartFilters, key ) )
            {
                const resolved = await (( this.#smartFilters as any )[key] as SmartFilterMethod )( value );

                resolved.pipeline && pipeline.push( ...addPrefixToPipeline( resolved.pipeline, prefix ));
                resolved.filter && ( filter = { $and: [{ ...filter }, addPrefixToFilter( resolved.filter, prefix )].filter( f => Object.keys( f ).length > 0 ) });
            }
            else
            {
                extraFilters[key] = value;
            }
        }

        if( pipeline.length > 0 || Object.keys( filter ).length > 0 )
        {
            result[prefix] = { filter, pipeline };
        }

        if( this.#parentResolve )
        {
            const resolved = await this.#parentResolve( extraFilters );

            if( 'filter' in resolved && 'pipeline' in resolved )
            {
                result[''] = resolved;
            }
            else if( Object.keys( resolved ).length > 0 )
            {
                for( const path in resolved )
                {
                    result[path] = ( resolved as any )[path];
                }
            }
        }
        else if( Object.keys( extraFilters ).length > 0 )
        {
            throw new ModelError( 'MODEL_SMART_FILTER_UNSUPPORTED', this.#model, `Unsupported smart filters - ${JSON.stringify( extraFilters, null, 2 )}` );
        }

        return result;
    }
}

export class ComputedPropertyResolver
{
    #model: object;
    #computedProperties: any;
    #prefix?: string;
    #parentResolve?: ( properties?: ComputedPropertiesParam<any> ) => Promise<any>;

    constructor( model: object, computedProperties: any, options?: { prefix?: string, parentResolve?: ( properties?: ComputedPropertiesParam<any> ) => Promise<any> })
    {
        this.#model = model;
        this.#computedProperties = computedProperties;
        this.#prefix = options?.prefix;
        this.#parentResolve = options?.parentResolve;
    }

    async resolve( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>> | { [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> }>
    {
        if( this.#prefix !== undefined )
        {
            return this.#resolveProperty( properties );
        }

        return this.#resolveRoot( properties );
    }

    async #resolveRoot( properties?: ComputedPropertiesParam<any> ): Promise<Awaited<ReturnType<SyncComputedPropertyMethod>>>
    {
        const result: ReturnType<ComputedPropertyMethod> = { fields: {}, pipeline: [] };

        if( Array.isArray( properties ) )
        {
            properties = properties.reduce(( acc, val ) => { acc[val] = null; return acc }, {} as any );
        }

        for( const property in ( properties as object ) )
        {
            if( hasPublicMethod( this.#computedProperties, property ) )
            {
                const resolvedProperties: Awaited<ReturnType<ComputedPropertyMethod>> = await ( this.#computedProperties as any )[property](( properties as any )[property] );

                result.fields = { ...result.fields, ...resolvedProperties.fields };
                result.pipeline?.push( ...( resolvedProperties.pipeline || [] ));
            }
        }

        return {
            fields      : result.fields && Object.keys( result.fields ).length ? result.fields : null,
            pipeline    : result.pipeline?.length ? result.pipeline : null
        };
    }

    async #resolveProperty( properties?: ComputedPropertiesParam<any> ): Promise<{ [path: string]: Awaited<ReturnType<SyncComputedPropertyMethod>> }>
    {
        const result: { [path: string]: ReturnType<SyncComputedPropertyMethod>} = {};
        let pipeline: Document[] = [];
        let fields: Document = {};
        const extraProperties: any = {};
        const prefix = this.#prefix!;

        if( Array.isArray( properties ) )
        {
            properties = properties.reduce(( acc, val ) => { acc[val] = null; return acc }, {} as any );
        }

        for( const property in ( properties as object ) )
        {
            if( hasPublicMethod( this.#computedProperties, property ) )
            {
                const resolvedProperties: Awaited<ReturnType<SyncComputedPropertyMethod>> = await (( this.#computedProperties as any )[property] )(( properties as any )[property] );

                for( const field in resolvedProperties.fields )
                {
                    fields[prefix + '.' + field] = addPrefixToFilter( resolvedProperties.fields![field], prefix );
                }

                if( resolvedProperties.pipeline )
                {
                    pipeline.push( ...addPrefixToPipeline( resolvedProperties.pipeline, prefix ));
                }
            }
            else
            {
                extraProperties[property] = ( properties as any )[property];
            }
        }

        if( pipeline.length > 0 || Object.keys( fields ).length > 0 )
        {
            result[prefix] = { fields, pipeline };
        }

        if( this.#parentResolve )
        {
            const resolvedProperties = await this.#parentResolve( extraProperties );

            if( 'fields' in resolvedProperties && 'pipeline' in resolvedProperties )
            {
                result[''] = resolvedProperties as { fields: Document, pipeline: Document[] };
            }
            else if( Object.keys( resolvedProperties ).length > 0 )
            {
                for( const path in resolvedProperties )
                {
                    result[path] = resolvedProperties[path];
                }
            }
        }
        else if( Object.keys( extraProperties ).length > 0 )
        {
            throw new ModelError( 'MODEL_COMPUTED_PROPERTY_UNSUPPORTED', this.#model, `Unsupported computed properties - ${Object.keys( extraProperties ).join( ', ' )}` );
        }

        return result;
    }
}
