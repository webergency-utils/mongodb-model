import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ExampleModels } from '../../../example/index.js';
import
{
    createExampleModels,
    dropIntegrationDatabase,
    seedExampleData,
    withAuth,
    type SeedIds
}
from './helpers.js';

const DB = 'webergency_mongodb_model_smoke';

describe( 'example models (real MongoDB)', () =>
{
    let models  : ExampleModels;
    let seed    : SeedIds;

    beforeAll( async() =>
    {
        await dropIntegrationDatabase( DB );

        models = createExampleModels( DB );
        seed = await seedExampleData( models );
    });

    afterAll( async() =>
    {
        if( models )
        {
            await models.shutdown({ timeout: 10_000 });
        }
    });

    test( 'guest list returns only published jobs', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            const result = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            }, 'listItemDTO' );

            expect( result.items.every( j => j.status === 'published' ) ).toBe( true );
            expect( result.items.map( j => j.title ).sort() ).toEqual(
            [
                'Other Org Role',
                'Platform Engineer',
                'Staff Engineer'
            ]);
            expect( result.total ).toBe( 3 );
            expect( result.items.find( j => j.title === 'Intern (draft)' ) ).toBeUndefined();
        });
    });

    test( 'recruiter list is scoped to organization published jobs only', async() =>
    {
        await withAuth( models, { role: 'recruiter', orgId: seed.acmeId.toString() }, async() =>
        {
            const result = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            }, 'listItemDTO' );

            expect( result.total ).toBe( 2 );
            expect( result.items.map( j => j.title ).sort() ).toEqual(
            [
                'Platform Engineer',
                'Staff Engineer'
            ]);
            expect( result.items.every( j => j.organizationID === seed.acmeId.toString() ) ).toBe( true );
            expect( result.items.every( j => j.status !== 'draft' ) ).toBe( true );
        });
    });

    test( 'smartFilter hasApplications keeps jobs with applications', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const result = await models.jobs.list(
            {
                smartFilter : { hasApplications: true },
                sort        : { title: 1, _id: 1 },
                count       : false
            }, 'listItemDTO' );

            expect( result.items.map( j => j.title ).sort() ).toEqual(
            [
                'Other Org Role',
                'Staff Engineer'
            ]);
            expect( result.items.every( j => ( j.applicationCount ?? 0 ) > 0 ) ).toBe( true );
        });
    });

    test( 'listItemDTO attaches applicationCount computed property', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const job = await models.jobs.get( seed.staffJobId.toString(), { as: 'listItemDTO' });

            expect( job ).toMatchObject(
            {
                title               : 'Staff Engineer',
                applicationCount    : 2
            });
        });
    });

    test( 'detailDTO loads organization via computed property', async() =>
    {
        await withAuth( models, { role: 'employer', orgId: seed.acmeId.toString() }, async() =>
        {
            const job = await models.jobs.get( seed.staffJobId.toString(), { as: 'detailDTO' });

            expect( job?.organization ).toMatchObject(
            {
                id      : seed.acmeId.toString(),
                name    : 'Acme Hiring',
                slug    : 'acme',
                active  : true
            });
        });
    });

    test( 'organization listItemDTO attaches jobCount', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const result = await models.organizations.list(
            {
                smartFilter : { bySlug: 'acme' },
                count       : false
            }, 'listItemDTO' );

            expect( result.items ).toHaveLength( 1 );
            expect( result.items[0] ).toMatchObject(
            {
                slug        : 'acme',
                jobCount    : 3
            });
        });
    });

    test( 'guest organization list hides inactive orgs', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            const result = await models.organizations.list({ count: false }, 'basicDTO' );

            expect( result.items.map( o => o.slug ).sort() ).toEqual([ 'acme' ]);
        });
    });

    test( 'cursor pagination walks forward and back', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const page1 = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                count   : false
            }, 'listItemDTO' );

            expect( page1.items ).toHaveLength( 2 );
            expect( page1.cursors.next ).toBeTypeOf( 'string' );

            const page2 = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                cursor  : `next:${page1.cursors.next}`,
                count   : false
            }, 'listItemDTO' );

            expect( page2.items ).toHaveLength( 2 );
            expect( page2.items[0].id ).not.toBe( page1.items[0].id );

            const back = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                cursor  : `prev:${page2.cursors.prev}`,
                count   : false
            }, 'listItemDTO' );

            expect( back.items.map( j => j.id ) ).toEqual( page1.items.map( j => j.id ) );
        });
    });

    test( 'stream yields converted jobs without buffering the full array API', async() =>
    {
        await withAuth( models, { role: 'employer', orgId: seed.acmeId.toString() }, async() =>
        {
            const titles: string[] = [];

            for await( const job of models.jobs.stream(
            {
                smartFilter : { byOrganization: seed.acmeId.toString() },
                sort        : { title: 1, _id: 1 }
            }, 'basicDTO' ) )
            {
                titles.push( job.title );
            }

            expect( titles ).toEqual(
            [
                'Intern (draft)',
                'Platform Engineer',
                'Staff Engineer'
            ]);
        });
    });

    test( 'property model lists and streams applications', async() =>
    {
        await withAuth( models, { role: 'recruiter', orgId: seed.acmeId.toString() }, async() =>
        {
            const listed = await models.applications.list(
            {
                smartFilter : { byStatus: 'new' },
                sort        : { created: 1, id: 1 },
                count       : true
            }, 'listItemDTO' );

            expect( listed.total ).toBeGreaterThanOrEqual( 1 );
            expect( listed.items.every( a => a.status === 'new' ) ).toBe( true );
            expect( listed.items.some( a => a.candidateName === 'Ada Lovelace' ) ).toBe( true );

            const streamed: string[] = [];

            for await( const app of models.applications.stream(
            {
                smartFilter : { byStatus: 'new' },
                sort        : { created: 1, id: 1 }
            }, 'listItemDTO' ) )
            {
                streamed.push( app.candidateName );
            }

            expect( streamed ).toContain( 'Ada Lovelace' );
            expect( streamed ).not.toContain( 'Grace Hopper' );
        });
    });

    test( 'publish updates draft under employer write policy', async() =>
    {
        await withAuth( models, { role: 'employer', orgId: seed.acmeId.toString() }, async() =>
        {
            const updated = await models.jobs.publish( seed.draftJobId.toString() );

            expect( updated ).toBeTruthy();

            const job = await models.jobs.get( seed.draftJobId.toString(), { as: 'listItemDTO' });

            expect( job?.status ).toBe( 'published' );
        });
    });

    test( 'create inserts a job and get returns it', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'QA Engineer',
                status          : 'published',
                organizationID  : seed.acmeId,
                tags            : [ 'qa' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            expect( id ).toBeTypeOf( 'string' );

            const job = await models.jobs.get( id, { as: 'listItemDTO' });

            expect( job ).toMatchObject(
            {
                title   : 'QA Engineer',
                status  : 'published'
            });
        });
    });
});
