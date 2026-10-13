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

const DB = 'webergency_mongodb_model_access';

describe( 'example models access matrix (real MongoDB)', () =>
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

    test( 'guest reads published jobs and active orgs only', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            const jobs = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            },
            'listItemDTO' );

            expect( jobs.total ).toBe( 3 );
            expect( jobs.items.every( j => j.status === 'published' ) ).toBe( true );
            expect( await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO' }) ).toBeNull();
            expect( await models.jobs.get( seed.staffJobId.toString(), { as: 'basicDTO' }) ).toMatchObject(
            {
                title: 'Staff Engineer'
            });

            const orgs = await models.organizations.list({ count: false }, 'basicDTO' );

            expect( orgs.items.map( o => o.slug ) ).toEqual([ 'acme' ]);
            expect( await models.organizations.get( seed.inactiveOrgId.toString(), { as: 'basicDTO' }) ).toBeNull();

            await expect(
                models.jobs.create(
                {
                    title           : 'Guest Create',
                    status          : 'draft',
                    organizationID  : seed.acmeId,
                    tags            : [],
                    applications    : [],
                    events          : { created: Date.now(), updated: Date.now() }
                } as any
                )
            ).rejects.toMatchObject({ code: 'MODEL_ACCESS_DENIED' });

            const deniedUpdate = await models.jobs.update( seed.staffJobId.toString(), { title: 'Hacked' } as any );

            expect( deniedUpdate.matchedCount ).toBe( 0 );

            const deniedDelete = await models.jobs.delete( seed.staffJobId.toString() );

            expect( deniedDelete ).toBe( false );
        });
    });

    test( 'employer is scoped to organization including drafts', async() =>
    {
        await withAuth( models, { role: 'employer', orgId: seed.acmeId.toString() }, async() =>
        {
            const jobs = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            },
            'listItemDTO' );

            expect( jobs.total ).toBe( 3 );
            expect( jobs.items.map( j => j.title ).sort() ).toEqual(
            [
                'Intern (draft)',
                'Platform Engineer',
                'Staff Engineer'
            ]);
            expect( await models.jobs.get( seed.otherOrgJobId.toString(), { as: 'basicDTO' }) ).toBeNull();
            expect( await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO' }) ).toMatchObject(
            {
                status: 'draft'
            });

            const updated = await models.jobs.update(
                seed.draftJobId.toString(),
                { tags: [ 'internship', 'employer-touched' ] } as any
            );

            expect( updated.matchedCount ).toBe( 1 );

            const draft = await models.jobs.get( seed.draftJobId.toString(), { as: 'listItemDTO' });

            expect( draft?.title ).toBe( 'Intern (draft)' );
            expect( draft?.tags ).toContain( 'employer-touched' );

            const crossOrg = await models.jobs.update(
                seed.otherOrgJobId.toString(),
                { title: 'Should Not' } as any
            );

            expect( crossOrg.matchedCount ).toBe( 0 );

            const apps = await models.applications.list({ count: true }, 'listItemDTO' );

            expect( apps.total ).toBeGreaterThanOrEqual( 1 );

            const appWrite = await models.applications.update( 'app-grace', { status: 'rejected' } as any );

            expect( appWrite.matchedRootCount ).toBe( 1 );
        });
    });

    test( 'recruiter reads published org jobs only and cannot see drafts', async() =>
    {
        await withAuth( models, { role: 'recruiter', orgId: seed.acmeId.toString() }, async() =>
        {
            const jobs = await models.jobs.list(
            {
                sort    : { title: 1, _id: 1 },
                count   : true
            },
            'listItemDTO' );

            expect( jobs.total ).toBe( 2 );
            expect( jobs.items.map( j => j.title ).sort() ).toEqual(
            [
                'Platform Engineer',
                'Staff Engineer'
            ]);
            expect( await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO' }) ).toBeNull();
            expect( await models.jobs.get( seed.otherOrgJobId.toString(), { as: 'basicDTO' }) ).toBeNull();

            const deniedDraftWrite = await models.jobs.update(
                seed.draftJobId.toString(),
                { tags: [ 'nope' ] } as any
            );

            expect( deniedDraftWrite.matchedCount ).toBe( 0 );

            const apps = await models.applications.list({ count: true }, 'listItemDTO' );

            expect( apps.total ).toBeGreaterThanOrEqual( 1 );
        });
    });

    test( 'recruiter without orgId is denied for job reads', async() =>
    {
        await withAuth( models, { role: 'recruiter' }, async() =>
        {
            const jobs = await models.jobs.list({ count: true }, 'basicDTO' );

            expect( jobs.items ).toEqual([]);
            expect( jobs.total ).toBe( 0 );

            expect( await models.jobs.get( seed.staffJobId.toString(), { as: 'basicDTO' }) ).toBeNull();
        });
    });

    test( 'admin reads and writes everything', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const jobs = await models.jobs.list({ count: true }, 'basicDTO' );

            expect( jobs.total ).toBe( 4 );

            const orgs = await models.organizations.list({ count: true }, 'basicDTO' );

            expect( orgs.total ).toBe( 2 );
            expect( await models.organizations.get( seed.inactiveOrgId.toString(), { as: 'basicDTO' }) ).toMatchObject(
            {
                slug    : 'closed',
                active  : false
            });

            const apps = await models.applications.list({ count: true }, 'basicDTO' );

            expect( apps.total ).toBeGreaterThanOrEqual( 3 );

            const updated = await models.applications.update( 'app-other', { status: 'hired' } as any );

            expect( updated.matchedRootCount ).toBe( 1 );
        });
    });

    test( 'per-call access override wins over defaults', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            expect( await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO' }) ).toBeNull();

            const viaAdmin = await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO', access: 'admin' });

            expect( viaAdmin ).toMatchObject({ title: 'Intern (draft)', status: 'draft' });

            const denied = await models.jobs.get( seed.staffJobId.toString(), { as: 'basicDTO', access: false });

            expect( denied ).toBeNull();

            const listed = await models.jobs.list(
            {
                access  : 'admin',
                sort    : { title: 1, _id: 1 },
                count   : true
            },
            'basicDTO' );

            expect( listed.total ).toBe( 4 );
            expect( listed.items.some( j => j.status === 'draft' ) ).toBe( true );

            const orgViaAdmin = await models.organizations.get(
                seed.inactiveOrgId.toString(),
                { as: 'basicDTO', access: 'admin-read' }
            );

            expect( orgViaAdmin ).toMatchObject({ slug: 'closed' });
        });
    });

    test( 'recruiter can elevate application write via access override', async() =>
    {
        await withAuth( models, { role: 'recruiter', orgId: seed.acmeId.toString() }, async() =>
        {
            const elevated = await models.applications.update(
                'app-grace',
                { status: 'rejected' } as any,
                { access: 'admin' }
            );

            expect( elevated.matchedRootCount ).toBe( 1 );

            const app = await models.applications.get( 'app-grace', { as: 'listItemDTO' });

            expect( app?.status ).toBe( 'rejected' );
        });
    });
});
