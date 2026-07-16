import { Filter } from 'mongodb';
import { ModelAccessDeniedError } from './errors.js';
import { AccessFilterResult } from './types/external.js';

export class AccessControl<DBE>
{
    #resolver: () => Promise<AccessFilterResult<DBE>> | AccessFilterResult<DBE>;
    #model: object;

    constructor( model: object, resolver: () => Promise<AccessFilterResult<DBE>> | AccessFilterResult<DBE> )
    {
        this.#model = model;
        this.#resolver = resolver;
    }

    async resolve(): Promise<Filter<DBE> | undefined>
    {
        const result = await this.#resolver();

        if( result === false )
        {
            throw new ModelAccessDeniedError( this.#model );
        }

        if( !result ){ return undefined }

        return result as Filter<DBE>;
    }

    async resolveOrDeny(): Promise<{ denied: true } | { denied: false, filter?: Filter<DBE> }>
    {
        const result = await this.#resolver();

        if( result === false )
        {
            return { denied: true };
        }

        return { denied: false, filter: result || undefined };
    }

    async match( base: Filter<DBE> ): Promise<Filter<DBE> | null>
    {
        const access = await this.resolveOrDeny();

        if( access.denied ){ return null }

        if( !access.filter ){ return base }

        return { $and: [ base, access.filter ] } as Filter<DBE>;
    }
}
