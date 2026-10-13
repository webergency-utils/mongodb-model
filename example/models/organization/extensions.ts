import type { ExampleModels } from '../../index.js';
import type { OrganizationDBE } from '../../types.js';

export class OrganizationFilters
{
    bySlug( slug: string )
    {
        return {
            filter      : { slug },
            pipeline    : null
        };
    }

    activeOnly( active: boolean = true )
    {
        return {
            filter      : { active },
            pipeline    : null
        };
    }

    nameContains( term: string )
    {
        return {
            filter      : { name: { $regex: term, $options: 'i' } },
            pipeline    : null
        };
    }
}

export class OrganizationProperties
{
    /** Adds a denormalized jobCount via $lookup (illustrative). */
    jobCount()
    {
        return {
            fields      : null,
            pipeline    :
            [
                {
                    $lookup:
                    {
                        from            : 'jobs',
                        localField      : '_id',
                        foreignField    : 'organizationID',
                        as              : '_jobs'
                    }
                },
                {
                    $addFields:
                    {
                        jobCount: { $size: '$_jobs' }
                    }
                },
                {
                    $unset: [ '_jobs' ]
                }
            ]
        };
    }
}

/** Converter recipes — compiled with compileConverters() in the model constructor. */
export function organizationConverterRecipes( models: ExampleModels )
{
    return {
        basicDTO:
        {
            pick: [ 'name', 'slug', 'active' ] as const
        },
        suggestDTO:
        {
            rename: { id: '_id' as const, label: 'name' as const }
        },
        listItemDTO:
        {
            computedProperties: { jobCount: true },
            custom: async( dbe: OrganizationDBE & { jobCount?: number }) =>
            ({
                id          : models.organizations.dtoID( dbe._id ),
                name        : dbe.name,
                slug        : dbe.slug,
                active      : dbe.active,
                jobCount    : dbe.jobCount ?? 0
            })
        }
    };
}
