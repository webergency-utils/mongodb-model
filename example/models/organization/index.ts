import
{
    AbstractModel,
    ObjectId,
    compileConverters,
    createDefaultConverters
}
from '@webergency-utils/mongodb-model';
import type { AccessResolveContext, Db } from '@webergency-utils/mongodb-model';
import type { OrganizationDBE, OrganizationDTO } from '../../types.js';
import type { ExampleModels } from '../../index.js';
import { getAuth, resolveAccessPolicy } from '../../helpers/access.js';
import
{
    OrganizationFilters,
    OrganizationProperties,
    organizationConverterRecipes
}
from './extensions.js';

export class OrganizationModel extends AbstractModel
<
    OrganizationDBE,
    OrganizationDTO,
    {
        converters          : any
        smartFilters        : OrganizationFilters
        computedProperties  : OrganizationProperties
    }
>
{
    constructor( models: ExampleModels, db: Db )
    {
        const filters = new OrganizationFilters();
        const properties = new OrganizationProperties();
        const dtoID = ( id: unknown ) => String( id );
        const converters =
        {
            ...createDefaultConverters<OrganizationDBE>({ dtoID }),
            ...compileConverters( organizationConverterRecipes( models ) as any, { dtoID })
        };

        super( models, db.collection( 'organizations' ),
        {
            converters,
            smartFilters        : filters,
            computedProperties  : properties,
            access              :
            {
                filters:
                {
                    'guest-read'        : async() => ({ active: true }),
                    'employer-read'     : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return { _id: models.organizations.dbeID( auth.orgId ) };
                    },
                    'employer-write'    : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return { _id: models.organizations.dbeID( auth.orgId ) };
                    },
                    'recruiter-read'    : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return {
                            _id     : models.organizations.dbeID( auth.orgId ),
                            active  : true
                        };
                    },
                    'admin-read'        : async() => ({}),
                    'admin-write'       : async() => ({})
                },
                defaults: ( ctx: Pick<AccessResolveContext, 'operation' | 'method'> ) =>
                {
                    const auth = getAuth( models );

                    // Recruiters may read their org; writes stay employer/admin only
                    if( auth?.role === 'recruiter' && ctx.operation !== 'read' ){ return undefined }

                    return resolveAccessPolicy( models, ctx,
                    {
                        guestRead   : 'guest-read',
                        adminRead   : 'admin-read',
                        adminWrite  : 'admin-write'
                    });
                }
            }
        } as any );
    }

    public dbeID( id: OrganizationDBE['_id'] | OrganizationDTO['id'] ): OrganizationDBE['_id']
    {
        return id instanceof ObjectId ? id : new ObjectId( id );
    }

    public dtoID( id: OrganizationDBE['_id'] | OrganizationDTO['id'] ): string
    {
        return id instanceof ObjectId ? id.toString() : String( id );
    }
}
