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

const DB = 'webergency_mongodb_model_root_query';

describe( 'example models root query (real MongoDB)', () =>
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

    test( 'find with filter and smartFilter', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const byFilter = await models.jobs.find(
            {
                filter  : { title: 'Staff Engineer' },
                sort    : { _id: 1 }
            },
            'basicDTO' );

            expect( byFilter ).toMatchObject({ title: 'Staff Engineer', status: 'published' });

            const bySmart = await models.jobs.find(
            {
                smartFilter : { byStatus: 'draft' },
                sort        : { title: 1, _id: 1 }
            },
            'basicDTO' );

            expect( bySmart ).toMatchObject({ title: 'Intern (draft)', status: 'draft' });
        });
    });

    test( 'list count sample limit sort and cursors', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const counted = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            },
            'listItemDTO' );

            expect( counted.total ).toBe( 4 );
            expect( counted.items ).toHaveLength( 4 );

            const limited = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                limit   : 2,
                count   : false
            },
            'basicDTO' );

            expect( limited.items ).toHaveLength( 2 );
            expect( limited.cursors.next ).toBeTypeOf( 'string' );
            expect( limited.cursors.prev ).toBeTypeOf( 'string' );

            const page2 = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                limit   : 2,
                cursor  : `next:${limited.cursors.next}`,
                count   : false
            },
            'basicDTO' );

            expect( page2.items ).toHaveLength( 2 );
            expect( page2.items[0].id ).not.toBe( limited.items[0].id );

            const back = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                limit   : 2,
                cursor  : `prev:${page2.cursors.prev}`,
                count   : false
            },
            'basicDTO' );

            expect( back.items.map( j => j.id ) ).toEqual( limited.items.map( j => j.id ) );

            const sampled = await models.jobs.list(
            {
                sample  : 2,
                count   : false
            },
            'basicDTO' );

            expect( sampled.items.length ).toBeLessThanOrEqual( 2 );
        });
    });

    test( 'list access deny returns empty', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            const denied = await models.jobs.list(
            {
                access  : false,
                count   : true
            },
            'basicDTO' );

            expect( denied.items ).toEqual([]);
            expect( denied.total ).toBe( 0 );
        });
    });

    test( 'stream forward early break and prev cursor', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const titles: string[] = [];

            for await( const job of models.jobs.stream(
            {
                sort    : { title: 1, _id: 1 },
                limit   : 10
            },
            'basicDTO' ) )
            {
                titles.push( job.title );

                if( titles.length >= 2 ){ break }
            }

            expect( titles ).toHaveLength( 2 );

            const page1 = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                count   : false
            },
            'basicDTO' );

            const page2 = await models.jobs.list(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                cursor  : `next:${page1.cursors.next}`,
                count   : false
            },
            'basicDTO' );

            const streamed: string[] = [];

            for await( const job of models.jobs.stream(
            {
                sort    : { 'events.created': 1, _id: 1 },
                limit   : 2,
                cursor  : `prev:${page2.cursors.prev}`
            },
            'basicDTO' ) )
            {
                streamed.push( job.id );
            }

            expect( streamed ).toEqual( page1.items.map( j => j.id ) );
        });
    });

    test( 'aggregate and count', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const rows = await models.jobs.aggregate<{ _id: string, n: number }>(
            [
                { $group: { _id: '$status', n: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]);

            expect( rows.some( r => r._id === 'published' && r.n >= 3 ) ).toBe( true );

            const n = await models.jobs.count([], { smartFilter: { byOrganization: seed.acmeId.toString() } });

            expect( n ).toBe( 3 );

            const orgCount = await models.organizations.count([], { smartFilter: { activeOnly: true } });

            expect( orgCount ).toBe( 1 );
        });
    });

    test( 'resolveSmartFilter and resolveComputedProperties', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const byOrg = await models.jobs.resolveSmartFilter({ byOrganization: seed.acmeId.toString() });

            expect( JSON.stringify( byOrg.filter ) ).toContain( seed.acmeId.toString() );

            const byStatus = await models.jobs.resolveSmartFilter({ byStatus: 'published' });

            expect( JSON.stringify( byStatus.filter ) ).toContain( 'published' );

            const combined = await models.jobs.resolveSmartFilter(
            {
                byOrganization  : seed.acmeId.toString(),
                byStatus        : 'published'
            });

            expect( combined.filter ).toBeTruthy();
            expect( JSON.stringify( combined.filter ) ).toContain( 'published' );

            const orgFilter = await models.organizations.resolveSmartFilter(
            {
                bySlug          : 'acme',
                nameContains    : 'Hiring'
            });

            expect( JSON.stringify( orgFilter.filter ) ).toContain( 'acme' );
            expect( JSON.stringify( orgFilter.filter ) ).toContain( 'Hiring' );

            const jobProps = await models.jobs.resolveComputedProperties({ applicationCount: true }) as
            {
                fields?     : Record<string, unknown>
                pipeline?   : unknown
            };

            expect( jobProps.fields ).toMatchObject(
            {
                applicationCount: expect.any( Object )
            });

            const orgProps = await models.organizations.resolveComputedProperties({ jobCount: true }) as
            {
                fields?     : Record<string, unknown>
                pipeline?   : unknown
            };

            expect( Array.isArray( orgProps.pipeline ) ).toBe( true );
            expect(( orgProps.pipeline as unknown[] ).length ).toBeGreaterThan( 0 );
        });
    });

    test( 'on and off query events', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const events: string[] = [];
            const handler = ( e: { operation: string }) => { events.push( e.operation ) };
            const unsubscribe = models.jobs.on( 'query', handler );

            await models.jobs.list({ limit: 1, count: false }, 'basicDTO' );
            await models.jobs.count([]);

            expect( events ).toContain( 'list' );
            expect( events ).toContain( 'aggregate' );

            unsubscribe();
            const before = events.length;

            await models.jobs.count([]);

            expect( events.length ).toBe( before );

            models.jobs.on( 'query', handler );
            await models.jobs.list({ limit: 1, count: false }, 'basicDTO' );
            models.jobs.off( 'query', handler );

            const mid = events.length;

            await models.jobs.list({ limit: 1, count: false }, 'basicDTO' );

            expect( events.length ).toBe( mid );
        });
    });

    test( 'job converters basicDTO suggestDTO listItemDTO detailDTO dto', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const id = seed.staffJobId.toString();

            const basic = await models.jobs.get( id, { as: 'basicDTO' });

            expect( basic ).toMatchObject({ title: 'Staff Engineer', status: 'published' });
            expect( basic ).toHaveProperty( 'id' );

            const suggest = await models.jobs.get( id, { as: 'suggestDTO' });

            expect( suggest ).toMatchObject({ id, label: 'Staff Engineer' });

            const listItem = await models.jobs.get( id, { as: 'listItemDTO' });

            expect( listItem ).toMatchObject(
            {
                title               : 'Staff Engineer',
                applicationCount    : 2,
                organizationID      : seed.acmeId.toString()
            });

            const detail = await models.jobs.get( id, { as: 'detailDTO' });

            expect( detail?.organization ).toMatchObject(
            {
                id      : seed.acmeId.toString(),
                name    : 'Acme Hiring',
                slug    : 'acme'
            });

            const dto = await models.jobs.get( id, { as: 'dto' });

            expect( dto ).toMatchObject({ title: 'Staff Engineer', status: 'published' });
            expect( dto ).toHaveProperty( 'id', id );
        });
    });

    test( 'organization converters basicDTO suggestDTO listItemDTO dto', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const id = seed.acmeId.toString();

            const basic = await models.organizations.get( id, { as: 'basicDTO' });

            expect( basic ).toMatchObject({ name: 'Acme Hiring', slug: 'acme', active: true });

            const suggest = await models.organizations.get( id, { as: 'suggestDTO' });

            expect( suggest ).toMatchObject({ id, label: 'Acme Hiring' });

            const listItem = await models.organizations.get( id, { as: 'listItemDTO' });

            expect( listItem ).toMatchObject({ slug: 'acme', jobCount: 3 });

            const dto = await models.organizations.get( id, { as: 'dto' });

            expect( dto ).toMatchObject({ name: 'Acme Hiring', slug: 'acme' });
        });
    });

    test( 'job smartFilters byOrganization byStatus tagged hasApplications', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const byOrg = await models.jobs.list(
            {
                smartFilter : { byOrganization: seed.acmeId.toString() },
                sort        : { title: 1, _id: 1 },
                count       : true
            },
            'basicDTO' );

            expect( byOrg.total ).toBe( 3 );

            const byStatus = await models.jobs.list(
            {
                smartFilter : { byStatus: [ 'draft', 'closed' ] },
                count       : true
            },
            'basicDTO' );

            expect( byStatus.items.every( j => j.status === 'draft' || j.status === 'closed' ) ).toBe( true );
            expect( byStatus.items.some( j => j.title === 'Intern (draft)' ) ).toBe( true );

            const tagged = await models.jobs.list(
            {
                smartFilter : { tagged: 'mongodb' },
                count       : false
            },
            'basicDTO' );

            expect( tagged.items.map( j => j.title ) ).toEqual([ 'Staff Engineer' ]);

            const withApps = await models.jobs.list(
            {
                smartFilter : { hasApplications: true },
                sort        : { title: 1, _id: 1 },
                count       : false
            },
            'listItemDTO' );

            expect( withApps.items.map( j => j.title ).sort() ).toEqual(
            [
                'Other Org Role',
                'Staff Engineer'
            ]);
        });
    });

    test( 'organization smartFilters bySlug activeOnly nameContains', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const bySlug = await models.organizations.list(
            {
                smartFilter : { bySlug: 'closed' },
                count       : false
            },
            'basicDTO' );

            expect( bySlug.items ).toHaveLength( 1 );
            expect( bySlug.items[0].slug ).toBe( 'closed' );

            const active = await models.organizations.list(
            {
                smartFilter : { activeOnly: true },
                count       : false
            },
            'basicDTO' );

            expect( active.items.map( o => o.slug ) ).toEqual([ 'acme' ]);

            const named = await models.organizations.list(
            {
                smartFilter : { nameContains: 'closed' },
                count       : false
            },
            'basicDTO' );

            expect( named.items.map( o => o.slug ) ).toEqual([ 'closed' ]);
        });
    });
});
