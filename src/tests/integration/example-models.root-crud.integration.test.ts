import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ModelError, ObjectId } from '../../index.js';
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

const DB = 'webergency_mongodb_model_root_crud';

describe( 'example models root CRUD (real MongoDB)', () =>
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

    test( 'create without id generates an ObjectId string', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'CRUD No Id',
                status          : 'published',
                organizationID  : seed.acmeId,
                tags            : [ 'crud' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            expect( id ).toBeTypeOf( 'string' );
            expect( ObjectId.isValid( id ) ).toBe( true );

            const job = await models.jobs.get( id, { as: 'basicDTO' });

            expect( job ).toMatchObject({ title: 'CRUD No Id', status: 'published' });
        });
    });

    test( 'create with explicit id uses that id', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const explicitId = new ObjectId().toString();
            const id = await models.jobs.create(
            {
                title           : 'CRUD With Id',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [ 'crud' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any,
            explicitId );

            expect( id ).toBe( explicitId );

            const job = await models.jobs.get( explicitId, { as: 'basicDTO' });

            expect( job?.title ).toBe( 'CRUD With Id' );
        });
    });

    test( 'create duplicateIgnore returns existing id on 11000', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const explicitId = new ObjectId().toString();
            const payload =
            {
                title           : 'CRUD Dup',
                status          : 'published',
                organizationID  : seed.acmeId,
                tags            : [ 'crud' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any;

            const first = await models.jobs.create( payload, explicitId );

            expect( first ).toBe( explicitId );

            const second = await models.jobs.create( payload, explicitId, { duplicateIgnore: true });

            expect( second ).toBe( explicitId );
        });
    });

    test( 'createFrom without configured from converter throws MODEL_CONFIG_ERROR', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            await expect( models.jobs.createFrom({ title: 'x' }) ).rejects.toMatchObject(
            {
                code: 'MODEL_CONFIG_ERROR'
            });

            await expect( models.organizations.createFrom({ name: 'x' }) ).rejects.toBeInstanceOf( ModelError );
        });
    });

    test( 'update modifies a document', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'CRUD Update Target',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            const res = await models.jobs.update( id, { title: 'CRUD Updated', 'events.updated': now + 1 } as any );

            expect( res.matchedCount ).toBe( 1 );
            expect( res.modifiedCount ).toBe( 1 );

            const job = await models.jobs.get( id, { as: 'basicDTO' });

            expect( job?.title ).toBe( 'CRUD Updated' );
        });
    });

    test( 'update with documentBefore and documentAfter', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'CRUD Before After',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            const beforeRes = await models.jobs.update( id, { status: 'published' } as any, { documentBefore: true });

            expect( beforeRes.documentBefore ).toMatchObject({ title: 'CRUD Before After', status: 'draft' });
            expect( beforeRes.documentAfter ).toBeUndefined();

            const afterRes = await models.jobs.update( id, { status: 'closed' } as any, { documentAfter: true });

            expect( afterRes.documentAfter ).toMatchObject({ title: 'CRUD Before After', status: 'closed' });
            expect( afterRes.documentBefore ).toBeUndefined();
        });
    });

    test( 'update denied returns zero matchedCount', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            const res = await models.jobs.update( seed.staffJobId.toString(), { title: 'Nope' } as any );

            expect( res ).toEqual({ matchedCount: 0, modifiedCount: 0 });
        });
    });

    test( 'updateMany updates matching ids', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const a = await models.jobs.create(
            {
                title           : 'CRUD Many A',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [ 'many' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );
            const b = await models.jobs.create(
            {
                title           : 'CRUD Many B',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [ 'many' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            const res = await models.jobs.updateMany([ a, b ], { status: 'published' } as any );

            expect( res.matchedCount ).toBe( 2 );
            expect( res.modifiedCount ).toBe( 2 );

            const jobs = await models.jobs.getMany([ a, b ], { as: 'basicDTO' });

            expect( jobs.every( j => j?.status === 'published' ) ).toBe( true );
        });
    });

    test( 'updateOne updates single matching document', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'CRUD UpdateOne Target',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [ 'update-one' ],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            const res = await models.jobs.updateOne({ filter: { _id: new ObjectId( id ) } }, { status: 'closed' } as any );

            expect( res ).toEqual({ matchedCount: 1, modifiedCount: 1 });

            const job = await models.jobs.get( id, { as: 'basicDTO' });

            expect( job?.status ).toBe( 'closed' );
        });
    });

    test( 'get returns dto and get denied returns null', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const job = await models.jobs.get( seed.staffJobId.toString(), { as: 'basicDTO' });

            expect( job ).toMatchObject({ title: 'Staff Engineer', status: 'published' });
        });

        await withAuth( models, { role: 'guest' }, async() =>
        {
            const draft = await models.jobs.get( seed.draftJobId.toString(), { as: 'basicDTO' });

            expect( draft ).toBeNull();
        });
    });

    test( 'getMany keeps null holes unless filter:true', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const missing = new ObjectId().toString();
            const all = await models.jobs.getMany(
            [
                seed.staffJobId.toString(),
                missing,
                seed.platformJobId.toString()
            ],
            { as: 'basicDTO' });

            expect( all ).toHaveLength( 3 );
            expect( all[0]?.title ).toBe( 'Staff Engineer' );
            expect( all[1] ).toBeNull();
            expect( all[2]?.title ).toBe( 'Platform Engineer' );

            const filtered = await models.jobs.getMany(
            [
                seed.staffJobId.toString(),
                missing,
                seed.platformJobId.toString()
            ],
            { as: 'basicDTO', filter: true });

            expect( filtered ).toHaveLength( 2 );
            expect( filtered.every( Boolean ) ).toBe( true );
        });
    });

    test( 'delete removes a document', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const id = await models.jobs.create(
            {
                title           : 'CRUD Delete Me',
                status          : 'draft',
                organizationID  : seed.acmeId,
                tags            : [],
                applications    : [],
                events          : { created: now, updated: now }
            } as any );

            const ok = await models.jobs.delete( id );

            expect( ok ).toBe( true );
            expect( await models.jobs.get( id, { as: 'basicDTO' }) ).toBeNull();
        });
    });

    test( 'organization create and update', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const id = await models.organizations.create(
            {
                name    : 'CRUD Org',
                slug    : 'crud-org',
                active  : true
            } as any );

            expect( id ).toBeTypeOf( 'string' );

            const res = await models.organizations.update( id, { name: 'CRUD Org Renamed' } as any );

            expect( res.matchedCount ).toBe( 1 );

            const org = await models.organizations.get( id, { as: 'basicDTO' });

            expect( org ).toMatchObject({ name: 'CRUD Org Renamed', slug: 'crud-org' });
        });
    });

    test( 'guest cannot create organization', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            await expect(
                models.organizations.create({ name: 'X', slug: 'x', active: true } as any )
            ).rejects.toMatchObject({ code: 'MODEL_ACCESS_DENIED' });
        });
    });

    test( 'createMany, exists, and deleteMany work on root models', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const ids = await models.jobs.createMany(
            [
                {
                    title           : 'Batch Job 1',
                    status          : 'draft',
                    organizationID  : seed.acmeId,
                    tags            : [ 'batch' ],
                    applications    : [],
                    events          : { created: now, updated: now }
                } as any,
                {
                    title           : 'Batch Job 2',
                    status          : 'draft',
                    organizationID  : seed.acmeId,
                    tags            : [ 'batch' ],
                    applications    : [],
                    events          : { created: now, updated: now }
                } as any
            ]);

            expect( ids ).toHaveLength( 2 );
            expect( await models.jobs.exists( ids[0] ) ).toBe( true );
            expect( await models.jobs.exists({ tags: 'batch' } as any ) ).toBe( true );

            const deletedCount = await models.jobs.deleteMany( ids );

            expect( deletedCount ).toBe( 2 );
            expect( await models.jobs.exists( ids[0] ) ).toBe( false );
            expect( await models.jobs.exists( ids[1] ) ).toBe( false );
        });
    });
});
