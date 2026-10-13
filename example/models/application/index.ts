import
{
    AbstractPropertyModel,
    compileConverters,
    createDefaultConverters
}
from '@webergency-utils/mongodb-model';
import type { AccessResolveContext, Db } from '@webergency-utils/mongodb-model';
import type { JobApplicationDBE, JobApplicationDTO, JobDBE } from '../../types.js';
import type { ExampleModels } from '../../index.js';
import { getAuth, resolveAccessPolicy } from '../../helpers/access.js';

export class ApplicationFilters
{
    byStatus( status: JobApplicationDBE['status'] )
    {
        return {
            filter      : { status },
            pipeline    : null
        };
    }

    createdAfter( timestamp: number )
    {
        return {
            filter      : { created: { $gte: timestamp } },
            pipeline    : null
        };
    }
}

export function applicationConverterRecipes( models: ExampleModels )
{
    return {
        basicDTO:
        {
            pick: [ 'id', 'candidateName', 'status' ] as const
        },
        listItemDTO:
        {
            custom: async( dbe: JobApplicationDBE ): Promise<JobApplicationDTO> =>
            ({
                id              : models.applications.dtoID( dbe.id ),
                candidateName   : dbe.candidateName,
                status          : dbe.status,
                created         : dbe.created
            })
        }
    };
}

export class ApplicationModel extends AbstractPropertyModel
<
    JobDBE,
    JobApplicationDBE,
    JobApplicationDTO,
    {
        converters      : any
        smartFilters    : [ ApplicationFilters, ApplicationFilters ]
    }
>
{
    constructor( models: ExampleModels, db: Db )
    {
        const filters = new ApplicationFilters();
        const dtoID = ( id: unknown ) => String( id );
        const converters =
        {
            ...createDefaultConverters<JobApplicationDBE>({ dtoID }),
            ...compileConverters( applicationConverterRecipes( models ) as any, { dtoID })
        };

        /** Scope embedded apps to the auth org via parent (`_root`) filter. */
        const orgRootFilter = () =>
        {
            const auth = getAuth( models );

            if( !auth?.orgId ){ return false }

            return {
                _root: { organizationID: models.organizations.dbeID( auth.orgId ) }
            };
        };

        super(
            models,
            db.collection( 'jobs' ),
            'applications[]',
            {
                converters,
                smartFilters    : filters,
                access          :
                {
                    filters:
                    {
                        'employer-read'     : async() => orgRootFilter(),
                        'employer-write'    : async() => orgRootFilter(),
                        'recruiter-read'    : async() => orgRootFilter(),
                        'recruiter-write'   : async() => orgRootFilter(),
                        'admin'             : async() => ({})
                    },
                    defaults: ( ctx: Pick<AccessResolveContext, 'operation' | 'method'> ) =>
                    {
                        const policy = resolveAccessPolicy( models, ctx );

                        // Guests have no application access
                        if( policy === 'guest-read' ){ return undefined }

                        return policy;
                    }
                }
            } as any
        );
    }

    public dbeID( id: JobApplicationDBE['id'] | JobApplicationDTO['id'] ): string
    {
        return String( id );
    }

    public dtoID( id: JobApplicationDBE['id'] | JobApplicationDTO['id'] ): string
    {
        return String( id );
    }
}
