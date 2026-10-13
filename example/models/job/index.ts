import
{
    AbstractModel,
    ObjectId,
    compileConverters,
    createDefaultConverters
}
from '@webergency-utils/mongodb-model';
import type { AccessResolveContext, Db } from '@webergency-utils/mongodb-model';
import type { JobDBE, JobDTO } from '../../types.js';
import type { ExampleModels } from '../../index.js';
import { getAuth, resolveAccessPolicy } from '../../helpers/access.js';
import { JobFilters, JobProperties, jobConverterRecipes } from './extensions.js';

export class JobModel extends AbstractModel
<
    JobDBE,
    JobDTO,
    {
        converters          : any
        smartFilters        : JobFilters
        computedProperties  : JobProperties
    }
>
{
    constructor( models: ExampleModels, db: Db )
    {
        const filters = new JobFilters( models );
        const properties = new JobProperties();
        const dtoID = ( id: unknown ) => String( id );
        const converters =
        {
            ...createDefaultConverters<JobDBE>({ dtoID }),
            ...compileConverters( jobConverterRecipes( models ) as any, { dtoID })
        };

        super( models, db.collection( 'jobs' ),
        {
            converters,
            smartFilters        : filters,
            computedProperties  : properties,
            access              :
            {
                filters:
                {
                    'guest-read'        : async() => ({ status: 'published' }),
                    /**
                     * Employer: own organization, all job statuses (incl. drafts).
                     * Auth comes from Flow via `models.scope.get('auth')`.
                     */
                    'employer-read'     : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return { organizationID: models.organizations.dbeID( auth.orgId ) };
                    },
                    'employer-write'    : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return { organizationID: models.organizations.dbeID( auth.orgId ) };
                    },
                    /**
                     * Recruiter: own organization, published/closed only (no drafts).
                     */
                    'recruiter-read'    : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return {
                            organizationID  : models.organizations.dbeID( auth.orgId ),
                            status          : { $in: [ 'published', 'closed' ] }
                        };
                    },
                    'recruiter-write'   : async() =>
                    {
                        const auth = getAuth( models );

                        if( !auth?.orgId ){ return false }

                        return {
                            organizationID  : models.organizations.dbeID( auth.orgId ),
                            status          : { $in: [ 'published', 'closed' ] }
                        };
                    },
                    'admin'             : async() => ({})
                },
                defaults: ( ctx: Pick<AccessResolveContext, 'operation' | 'method'> ) => resolveAccessPolicy( models, ctx )
            }
        } as any );
    }

    public dbeID( id: JobDBE['_id'] | JobDTO['id'] ): JobDBE['_id']
    {
        return id instanceof ObjectId ? id : new ObjectId( id );
    }

    public dtoID( id: JobDBE['_id'] | JobDTO['id'] ): string
    {
        return id instanceof ObjectId ? id.toString() : String( id );
    }

    /** Domain helper: publish a draft job (employer/admin write). */
    public async publish( id: JobDTO['id'] )
    {
        return this.update( id, { status: 'published', 'events.updated': Date.now() } as any );
    }
}
