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

const DB = 'webergency_mongodb_model_property';

describe( 'example models property ApplicationModel (real MongoDB)', () =>
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

    test( 'create on parent and get returns application', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const id = await models.applications.create(
                seed.platformJobId.toString(),
                {
                    candidateName   : 'Prop Create',
                    status          : 'new',
                    created         : Date.now()
                } as any
            );

            expect( id ).toBeTypeOf( 'string' );

            const app = await models.applications.get( id, { as: 'listItemDTO' });

            expect( app ).toMatchObject(
            {
                id,
                candidateName   : 'Prop Create',
                status          : 'new'
            });
        });
    });

    test( 'create with explicit id', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const explicitId = 'app-explicit-' + new ObjectId().toString();
            const id = await models.applications.create(
                seed.platformJobId.toString(),
                {
                    candidateName   : 'Explicit App',
                    status          : 'review',
                    created         : Date.now()
                } as any,
                explicitId
            );

            expect( id ).toBe( explicitId );

            const app = await models.applications.get( explicitId, { as: 'basicDTO' });

            expect( app ).toMatchObject({ id: explicitId, candidateName: 'Explicit App' });
        });
    });

    test( 'create missing parent throws MODEL_PARENT_NOT_FOUND', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const missingParent = new ObjectId().toString();

            await expect(
                models.applications.create(
                    missingParent,
                    {
                        candidateName   : 'Orphan',
                        status          : 'new',
                        created         : Date.now()
                    } as any
                )
            ).rejects.toMatchObject({ code: 'MODEL_PARENT_NOT_FOUND' });

            await expect(
                models.applications.create(
                    missingParent,
                    {
                        candidateName   : 'Orphan',
                        status          : 'new',
                        created         : Date.now()
                    } as any
                )
            ).rejects.toBeInstanceOf( ModelError );
        });
    });

    test( 'update status', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const res = await models.applications.update( 'app-ada', { status: 'hired' } as any );

            expect( res.matchedRootCount ).toBe( 1 );
            expect( res.modifiedRootCount ).toBe( 1 );

            const app = await models.applications.get( 'app-ada', { as: 'listItemDTO' });

            expect( app?.status ).toBe( 'hired' );
        });
    });

    test( 'get getMany find list cursor stream count aggregate', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const one = await models.applications.get( 'app-grace', { as: 'listItemDTO' });

            expect( one ).toMatchObject({ candidateName: 'Grace Hopper', status: 'review' });

            const many = await models.applications.getMany([ 'app-grace', 'missing-app', 'app-other' ], { as: 'basicDTO' });

            expect( many ).toHaveLength( 3 );
            expect( many[0]?.candidateName ).toBe( 'Grace Hopper' );
            expect( many[1] ).toBeNull();
            expect( many[2]?.candidateName ).toBe( 'Other Candidate' );

            const filtered = await models.applications.getMany(
            [
                'app-grace',
                'missing-app'
            ],
            { as: 'basicDTO', filter: true });

            expect( filtered ).toHaveLength( 1 );

            const found = await models.applications.find(
            {
                smartFilter : { byStatus: 'review' },
                sort        : { created: 1, id: 1 }
            },
            'listItemDTO' );

            expect( found?.candidateName ).toBe( 'Grace Hopper' );

            const listed = await models.applications.list(
            {
                sort    : { id: 1 },
                limit   : 2,
                count   : true
            },
            'listItemDTO' );

            expect( listed.total ).toBeGreaterThanOrEqual( 2 );
            expect( listed.items ).toHaveLength( 2 );
            expect( listed.cursors.next ).toBeTypeOf( 'string' );

            const page2 = await models.applications.list(
            {
                sort    : { id: 1 },
                limit   : 2,
                cursor  : `next:${listed.cursors.next}`,
                count   : false
            },
            'listItemDTO' );

            expect( page2.items.length ).toBeGreaterThan( 0 );
            expect( page2.items[0].id ).not.toBe( listed.items[0].id );

            const streamed: string[] = [];

            for await( const app of models.applications.stream(
            {
                smartFilter : { byStatus: 'review' },
                sort        : { created: 1, id: 1 }
            },
            'listItemDTO' ) )
            {
                streamed.push( app.candidateName );

                if( streamed.length >= 1 ){ break }
            }

            expect( streamed ).toContain( 'Grace Hopper' );

            const n = await models.applications.count([], { smartFilter: { byStatus: 'review' } });

            expect( n ).toBeGreaterThanOrEqual( 1 );

            const rows = await models.applications.aggregate<{ _id: string, n: number }>(
            [
                { $group: { _id: '$status', n: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]);

            expect( rows.length ).toBeGreaterThan( 0 );
            expect( rows.every( r => typeof r.n === 'number' ) ).toBe( true );
        });
    });

    test( 'access deny paths for guest', async() =>
    {
        await withAuth( models, { role: 'guest' }, async() =>
        {
            expect( await models.applications.get( 'app-ada', { as: 'basicDTO' }) ).toBeNull();

            const many = await models.applications.getMany([ 'app-ada' ], { as: 'basicDTO' });

            expect( many ).toEqual([ null ]);

            const listed = await models.applications.list({ count: true }, 'basicDTO' );

            expect( listed.items ).toEqual([]);
            expect( listed.total ).toBe( 0 );

            const streamed: string[] = [];

            for await( const app of models.applications.stream({}, 'basicDTO' ) )
            {
                streamed.push( app.id );
            }

            expect( streamed ).toEqual([]);

            await expect(
                models.applications.create(
                    seed.staffJobId.toString(),
                    {
                        candidateName   : 'Guest App',
                        status          : 'new',
                        created         : Date.now()
                    } as any
                )
            ).rejects.toMatchObject({ code: 'MODEL_ACCESS_DENIED' });

            const updateRes = await models.applications.update( 'app-grace', { status: 'rejected' } as any );

            expect( updateRes ).toEqual({ matchedRootCount: 0, modifiedRootCount: 0 });
        });
    });

    test( 'recruiter can read and update applications in org', async() =>
    {
        await withAuth( models, { role: 'recruiter', orgId: seed.acmeId.toString() }, async() =>
        {
            const listed = await models.applications.list(
            {
                smartFilter : { byStatus: 'review' },
                count       : true
            },
            'listItemDTO' );

            expect( listed.total ).toBeGreaterThanOrEqual( 1 );
            expect( listed.items.some( a => a.candidateName === 'Grace Hopper' ) ).toBe( true );

            const updateRes = await models.applications.update( 'app-grace', { status: 'rejected' } as any );

            expect( updateRes.matchedRootCount ).toBe( 1 );

            const crossOrg = await models.applications.update( 'app-other', { status: 'hired' } as any );

            expect( crossOrg.matchedRootCount ).toBe( 0 );
        });
    });

    test( 'on and off query events', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const ops: string[] = [];
            const handler = ( e: { operation: string }) => { ops.push( e.operation ) };
            const off = models.applications.on( 'query', handler );

            await models.applications.list({ limit: 1, count: false }, 'basicDTO' );
            await models.applications.count([]);

            expect( ops ).toContain( 'list' );
            expect( ops ).toContain( 'aggregate' );

            off();
            const before = ops.length;

            await models.applications.count([]);

            expect( ops.length ).toBe( before );

            models.applications.on( 'query', handler );
            await models.applications.get( 'app-grace', { as: 'basicDTO' });
            models.applications.off( 'query', handler );

            const mid = ops.length;

            await models.applications.get( 'app-grace', { as: 'basicDTO' });

            expect( ops.length ).toBe( mid );
        });
    });

    test( 'createMany, updateOne, exists, delete, and deleteMany work on property models', async() =>
    {
        await withAuth( models, { role: 'admin' }, async() =>
        {
            const now = Date.now();
            const createdIds = await models.applications.createMany(
                seed.platformJobId.toString(),
                [
                    { candidateName: 'Batch App 1', status: 'new', created: now } as any,
                    { candidateName: 'Batch App 2', status: 'new', created: now + 1 } as any
                ]
            );

            expect( createdIds ).toHaveLength( 2 );
            expect( await models.applications.exists( createdIds[0] ) ).toBe( true );

            const updRes = await models.applications.updateOne(
                { id: createdIds[0] } as any,
                { status: 'review' } as any
            );

            expect( updRes.matchedCount ).toBe( 1 );
            expect( updRes.modifiedCount ).toBe( 1 );

            const deletedFirst = await models.applications.delete( createdIds[0] );

            expect( deletedFirst ).toBe( true );
            expect( await models.applications.exists( createdIds[0] ) ).toBe( false );

            const deletedRemaining = await models.applications.deleteMany([ createdIds[1] ]);

            expect( deletedRemaining ).toBe( 1 );
            expect( await models.applications.exists( createdIds[1] ) ).toBe( false );
        });
    });
});
