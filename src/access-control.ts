import { Filter } from 'mongodb';
import { ModelAccessConfigError, ModelAccessDeniedError } from './errors.js';
import
{
    AccessFilterFn,
    AccessFilterResult,
    AccessResolveContext,
    ModelAccessConfig
}
from './types/external.js';

export type AccessControlOptions<DBE> =
{
    model             : object
    config?           : ModelAccessConfig<DBE>
    filterOverridden? : boolean
    invokeFilter      : AccessFilterFn<DBE>
}

export class AccessControl<DBE>
{
    #model: object;
    #config?: ModelAccessConfig<DBE>;
    #filterOverridden: boolean;
    #invokeFilter: AccessFilterFn<DBE>;

    constructor( options: AccessControlOptions<DBE> )
    {
        this.#model = options.model;
        this.#config = options.config;
        this.#filterOverridden = options.filterOverridden ?? false;
        this.#invokeFilter = options.invokeFilter;
    }

    #isAclActive(): boolean
    {
        if( this.#filterOverridden ){ return true }

        if( this.#config?.defaults !== undefined ){ return true }

        if( this.#config?.filters && Object.keys( this.#config.filters ).length > 0 ){ return true }

        return false;
    }

    #isLegacyMode(): boolean
    {
        if( !this.#filterOverridden ){ return false }

        if( this.#config?.defaults !== undefined ){ return false }

        if( this.#config?.filters && Object.keys( this.#config.filters ).length > 0 ){ return false }

        return true;
    }

    async #resolveName( ctx: AccessResolveContext ): Promise<string | undefined>
    {
        if( ctx.access !== undefined && ctx.access !== '' ){ return ctx.access }

        const defaults = this.#config?.defaults;

        if( typeof defaults === 'function' )
        {
            const name = await defaults({ operation: ctx.operation, method: ctx.method });

            if( name !== undefined && name !== '' ){ return name }
        }
        else if( defaults )
        {
            const name = defaults[ctx.operation];

            if( name !== undefined && name !== '' ){ return name }
        }

        if( this.#isLegacyMode() ){ return 'default' }

        return undefined;
    }

    async #invoke( name: string ): Promise<AccessFilterResult<DBE>>
    {
        const filters = this.#config?.filters;

        if( filters !== undefined )
        {
            if( !( name in filters ))
            {
                throw new ModelAccessConfigError( this.#model, `Unknown access policy "${name}"` );
            }

            return filters[name]( name );
        }

        return this.#invokeFilter( name );
    }

    async resolve( ctx: AccessResolveContext ): Promise<Filter<DBE> | undefined>
    {
        const result = await this.resolveOrDeny( ctx );

        if( result.denied )
        {
            throw new ModelAccessDeniedError( this.#model );
        }

        return result.filter;
    }

    async resolveOrDeny( ctx: AccessResolveContext ): Promise<{ denied: true } | { denied: false, filter?: Filter<DBE> }>
    {
        if( !this.#isAclActive() )
        {
            return { denied: false };
        }

        const name = await this.#resolveName( ctx );

        if( !name )
        {
            return { denied: true };
        }

        const result = await this.#invoke( name );

        if( result === false )
        {
            return { denied: true };
        }

        return { denied: false, filter: result || undefined };
    }

    async match( base: Filter<DBE>, ctx: AccessResolveContext ): Promise<Filter<DBE> | null>
    {
        const access = await this.resolveOrDeny( ctx );

        if( access.denied ){ return null }

        if( !access.filter ){ return base }

        return { $and: [ base, access.filter ] } as Filter<DBE>;
    }
}
