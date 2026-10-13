import type { ExampleModels } from '../../index.js';
import type { JobDBE, JobDetailDTO, JobStatus } from '../../types.js';

export class JobFilters
{
    constructor( private models: ExampleModels ) {}

    byOrganization( organizationID: string )
    {
        return {
            filter      : { organizationID: this.models.organizations.dbeID( organizationID ) },
            pipeline    : null
        };
    }

    byStatus( status: JobStatus | JobStatus[] )
    {
        const statuses = Array.isArray( status ) ? status : [ status ];

        return {
            filter      : { status: { $in: statuses } },
            pipeline    : null
        };
    }

    tagged( tag: string )
    {
        return {
            filter      : { tags: tag },
            pipeline    : null
        };
    }

    /** Pipeline smart-filter: keep jobs that have at least one application. */
    hasApplications( _flag: true = true )
    {
        return {
            filter      : null,
            pipeline    :
            [
                {
                    $match:
                    {
                        $expr: { $gt: [{ $size: { $ifNull: [ '$applications', [] ] } }, 0 ] }
                    }
                }
            ]
        };
    }
}

export class JobProperties
{
    applicationCount()
    {
        return {
            fields:
            {
                applicationCount: { $size: { $ifNull: [ '$applications', [] ] } }
            },
            pipeline: null
        };
    }

    organization()
    {
        return {
            fields      : null,
            pipeline    :
            [
                {
                    $lookup:
                    {
                        from            : 'organizations',
                        localField      : 'organizationID',
                        foreignField    : '_id',
                        as              : '_organization'
                    }
                },
                {
                    $addFields:
                    {
                        _organization: { $arrayElemAt: [ '$_organization', 0 ] }
                    }
                }
            ]
        };
    }
}

/** Converter recipes — compiled with compileConverters() in the model constructor. */
export function jobConverterRecipes( models: ExampleModels )
{
    return {
        basicDTO:
        {
            pick: [ 'title', 'status' ] as const
        },
        suggestDTO:
        {
            rename: { id: '_id' as const, label: 'title' as const }
        },
        listItemDTO:
        {
            computedProperties: { applicationCount: true },
            custom: async( dbe: JobDBE & { applicationCount?: number }) =>
            ({
                id                  : models.jobs.dtoID( dbe._id ),
                title               : dbe.title,
                status              : dbe.status,
                organizationID      : models.organizations.dtoID( dbe.organizationID ),
                tags                : dbe.tags,
                applicationCount    : dbe.applicationCount ?? dbe.applications?.length ?? 0,
                events              : dbe.events
            })
        },
        detailDTO:
        {
            computedProperties: { organization: true, applicationCount: true },
            custom: async( dbe: JobDBE & { applicationCount?: number, _organization?: any }): Promise<JobDetailDTO> =>
            {
                const organization = dbe._organization
                    ? await models.organizations.converters.dto.converter( dbe._organization )
                    : null;

                return {
                    id                  : models.jobs.dtoID( dbe._id ),
                    title               : dbe.title,
                    status              : dbe.status,
                    organizationID      : models.organizations.dtoID( dbe.organizationID ),
                    tags                : dbe.tags,
                    applicationCount    : dbe.applicationCount ?? dbe.applications?.length ?? 0,
                    events              : dbe.events,
                    organization        : organization as JobDetailDTO['organization']
                };
            }
        }
    };
}
