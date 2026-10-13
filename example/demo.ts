/**
 * Runnable walkthrough (needs a MongoDB URI).
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017 npx tsx --tsconfig example/tsconfig.json example/demo.ts
 *
 * Demonstrates: converters, smartFilters, computedProperties, named access, property model,
 * cursor pagination (`list` → `cursors`), and `stream` (async generator).
 *
 * Access policies read `auth` from Flow scope — use `models.scope.execute(fn, { auth })`.
 */

import { ObjectId } from '@webergency-utils/mongodb-model';
import { ExampleModels } from './index.js';
import type { ExampleAuth } from './types.js';

async function main()
{
    const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
    const models = new ExampleModels( uri, 'mongodb_model_example' );

    const orgId = new ObjectId();
    const now = Date.now();

    await models.organizations.collection.insertOne(
    {
        _id     : orgId,
        name    : 'Acme Hiring',
        slug    : 'acme',
        active  : true
    });

    const jobDocs =
    [
        {
            _id             : new ObjectId(),
            title           : 'Staff Engineer',
            status          : 'published' as const,
            organizationID  : orgId,
            tags            : [ 'typescript', 'mongodb' ],
            applications    :
            [
                {
                    id              : 'app-1',
                    candidateName   : 'Ada Lovelace',
                    status          : 'new' as const,
                    created         : now
                }
            ],
            events: { created: now, updated: now }
        },
        {
            _id             : new ObjectId(),
            title           : 'Platform Engineer',
            status          : 'published' as const,
            organizationID  : orgId,
            tags            : [ 'typescript' ],
            applications    : [],
            events: { created: now + 1, updated: now + 1 }
        },
        {
            _id             : new ObjectId(),
            title           : 'Backend Engineer',
            status          : 'published' as const,
            organizationID  : orgId,
            tags            : [ 'mongodb' ],
            applications    :
            [
                {
                    id              : 'app-2',
                    candidateName   : 'Grace Hopper',
                    status          : 'review' as const,
                    created         : now + 2
                }
            ],
            events: { created: now + 2, updated: now + 2 }
        }
    ];

    await models.jobs.collection.insertMany( jobDocs );
    const jobId = jobDocs[0]._id;

    await models.scope.execute( async() =>
    {
        const guestList = await models.jobs.list(
        {
            smartFilter : { hasApplications: true, tagged: 'typescript' },
            count       : false
        }, 'listItemDTO' );

        console.log( 'guest listItemDTO', guestList.items );

        const page1 = await models.jobs.list(
        {
            sort    : { 'events.created': 1, _id: 1 },
            limit   : 2,
            count   : false
        }, 'basicDTO' );

        console.log( 'page1', page1.items, 'cursors', page1.cursors );

        if( page1.cursors.next )
        {
            const page2 = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                cursor  : `next:${page1.cursors.next}`,
                count   : false
            }, 'basicDTO' );

            console.log( 'page2', page2.items, 'cursors', page2.cursors );

            if( page2.cursors.prev )
            {
                const back = await models.jobs.list(
                {
                    sort    : { 'events.created': 1, _id: 1 },
                    limit   : 2,
                    cursor  : `prev:${page2.cursors.prev}`,
                    count   : false
                }, 'basicDTO' );

                console.log( 'prev from page2', back.items );
            }
        }
    }, { auth: { role: 'guest' } satisfies ExampleAuth });

    await models.scope.execute( async() =>
    {
        const detail = await models.jobs.get( jobId.toString(), { as: 'detailDTO' });
        console.log( 'employer detailDTO', detail );

        const streamed: string[] = [];

        for await( const job of models.jobs.stream(
        {
            smartFilter : { byOrganization: orgId.toString() },
            sort        : { title: 1, _id: 1 }
        }, 'basicDTO' ) )
        {
            streamed.push( job.title );
        }

        console.log( 'streamed titles', streamed );

        for await( const app of models.applications.stream(
        {
            smartFilter : { byStatus: 'new' },
            sort        : { created: 1, id: 1 }
        }, 'listItemDTO' ) )
        {
            console.log( 'streamed application', app );
        }

        const apps = await models.applications.list(
        {
            smartFilter : { byStatus: 'new' },
            limit       : 1,
            count       : false
        }, 'listItemDTO' );

        console.log( 'applications page', apps.items, 'cursors', apps.cursors );

        const orgs = await models.organizations.list(
        {
            smartFilter : { activeOnly: true },
            count       : false
        }, 'listItemDTO' );

        console.log( 'organizations', orgs.items );
    }, { auth: { role: 'employer', orgId: orgId.toString() } satisfies ExampleAuth });

    await models.shutdown({ timeout: 5000 });
}

main().catch( async( err ) =>
{
    console.error( err );
    process.exitCode = 1;
});
