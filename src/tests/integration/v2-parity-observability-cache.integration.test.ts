import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import
{
    AbstractModel,
    AbstractModels,
    AbstractPropertyModel,
    ModelConverterError,
    ObjectId,
    type MongoPropertyDocument,
    type MongoRootDocument
}
from '../../index.js';
import { flowExecute } from '../../flow.js';
import { dropIntegrationDatabase, INTEGRATION_URI } from './helpers.js';

const DB = 'webergency_mongodb_model_v2_parity';

type StageItemDBE = MongoPropertyDocument &
{
    id      : ObjectId
    label   : string
    status  : 'open' | 'done'
};

type StageDBE = MongoPropertyDocument &
{
    id      : ObjectId
    title   : string
    items   : StageItemDBE[]
};

type ProjectDBE = MongoRootDocument &
{
    _id     : ObjectId
    name    : string
    status  : 'pending' | 'active' | 'archived'
    secret? : string
    stages  : StageDBE[]
};

type ProjectDTO =
{
    id          : string
    name        : string
    status      : string
    computedTag?: string
    customRank? : number
};

type StageDTO =
{
    id      : string
    title   : string
};

type StageItemDTO =
{
    id      : string
    label   : string
    status  : string
};

class ProjectComputedProperties
{
    computedTag()
    {
        return {
            fields      : { computedTag: { $concat: [ 'tag:', '$name' ] } },
            pipeline    : null
        };
    }
}

class ParityModels extends AbstractModels
{
    projects    : ProjectModel;
    stages      : StageModel;
    stageItems  : StageItemModel;

    constructor( uri: string, dbName: string )
    {
        super( uri,
        {
            observability:
            {
                enabled     : true,
                slowQueryMs : 0
            }
        });

        const collection = this.client.db( dbName ).collection<ProjectDBE>( 'projects' );

        this.projects = new ProjectModel( this, collection );
        this.stages = new StageModel( this, collection );
        this.stageItems = new StageItemModel( this, collection );
    }
}

class ProjectModel extends AbstractModel<ProjectDBE, ProjectDTO, any>
{
    constructor( models: AbstractModels, collection: any )
    {
        super( models, collection,
        {
            cache               : true,
            computedProperties  : new ProjectComputedProperties(),
            access              :
            {
                filters:
                {
                    allowAll    : () => undefined,
                    admin       : () => undefined,
                    denyAll     : () => false
                },
                defaults:
                {
                    create  : 'allowAll',
                    read    : 'allowAll',
                    update  : 'allowAll',
                    delete  : 'allowAll'
                }
            },
            converters:
            {
                from:
                {
                    webhook: ( payload: { externalName: string }) =>
                    ({
                        name    : payload.externalName,
                        status  : 'pending' as const,
                        stages  : []
                    }),
                    broken: () =>
                    {
                        throw new Error( 'webhook converter failed' );
                    }
                },
                dto:
                {
                    projection          : { _id: 1, name: 1, status: 1, computedTag: 1, customRank: 1 },
                    computedProperties  : () => [ 'computedTag' ],
                    converter           : ( dbe: ProjectDBE & { computedTag?: string, customRank?: number }) =>
                    ({
                        id          : this.dtoID( dbe._id ),
                        name        : dbe.name,
                        status      : dbe.status,
                        ...( dbe.computedTag !== undefined ? { computedTag: dbe.computedTag } : {}),
                        ...( dbe.customRank !== undefined ? { customRank: dbe.customRank } : {})
                    })
                },
                dbe:
                {
                    converter: ( dbe: ProjectDBE ) => dbe
                },
                failingDTO:
                {
                    converter: () =>
                    {
                        throw new Error( 'dto conversion boom' );
                    }
                }
            }
        });
    }

    public override dbeID( id: string | ObjectId ): ObjectId
    {
        return id instanceof ObjectId ? id : new ObjectId( id );
    }

    public override dtoID( dbeID: string | ObjectId ): string
    {
        return dbeID instanceof ObjectId ? dbeID.toString() : String( dbeID );
    }
}

class StageModel extends AbstractPropertyModel<ProjectDBE, StageDBE, StageDTO, any>
{
    constructor( models: AbstractModels, collection: any )
    {
        super( models, collection, 'stages[]',
        {
            cache   : true,
            access  :
            {
                filters:
                {
                    allowAll    : () => undefined,
                    admin       : () => undefined,
                    denyAll     : () => false
                },
                defaults:
                {
                    create  : 'allowAll',
                    read    : 'allowAll',
                    update  : 'allowAll',
                    delete  : 'allowAll'
                }
            },
            converters:
            {
                dto : { converter: ( dbe: StageDBE ) => ({ id: this.dtoID( dbe.id ), title: dbe.title }) },
                dbe : { converter: ( dbe: StageDBE ) => dbe }
            }
        });
    }

    public override dbeID( id: string | ObjectId ): ObjectId
    {
        return id instanceof ObjectId ? id : new ObjectId( id );
    }

    public override dtoID( dbeID: string | ObjectId ): string
    {
        return dbeID instanceof ObjectId ? dbeID.toString() : String( dbeID );
    }
}

class StageItemModel extends AbstractPropertyModel<ProjectDBE, StageItemDBE, StageItemDTO, any>
{
    constructor( models: AbstractModels, collection: any )
    {
        super( models, collection, 'stages[].items[]',
        {
            cache   : true,
            access  :
            {
                filters:
                {
                    allowAll    : () => undefined,
                    denyAll     : () => false
                },
                defaults:
                {
                    create  : 'allowAll',
                    read    : 'allowAll',
                    update  : 'allowAll',
                    delete  : 'allowAll'
                }
            },
            converters:
            {
                dto : { converter: ( dbe: StageItemDBE ) => ({ id: this.dtoID( dbe.id ), label: dbe.label, status: dbe.status }) },
                dbe : { converter: ( dbe: StageItemDBE ) => dbe }
            }
        });
    }

    public override dbeID( id: string | ObjectId ): ObjectId
    {
        return id instanceof ObjectId ? id : new ObjectId( id );
    }

    public override dtoID( dbeID: string | ObjectId ): string
    {
        return dbeID instanceof ObjectId ? dbeID.toString() : String( dbeID );
    }
}

describe( 'v2 Parity, Observability, Cache & 2-Level Nested Array Integration (AE1-AE6)', () =>
{
    let models: ParityModels;

    beforeAll( async() =>
    {
        await dropIntegrationDatabase( DB );
        models = new ParityModels( INTEGRATION_URI, DB );
    });

    afterAll( async() =>
    {
        if( models )
        {
            await models.shutdown({ timeout: 10_000 });
        }
    });

    test( 'AE1: PropertyModel denied access returns null from find() and 0 items from list()', async() =>
    {
        const projId = await models.projects.create(
        {
            name    : 'Secret Project',
            status  : 'active',
            stages  : []
        });
        await models.stages.create( projId, { title: 'Confidential Stage', items: [] });

        const found = await models.stages.find({ filter: { title: 'Confidential Stage' }, access: 'denyAll' });
        const listed = await models.stages.list({ count: true, access: 'denyAll' });

        expect( found ).toBeNull();
        expect( Array.isArray( listed )).toBe( true );
        expect( listed.length ).toBe( 0 );
        expect( listed.total ).toBe( 0 );
    });

    test( 'AE2 & AE6: Dual-compatible list() supports array iteration, destructuring, converter projection/computedProperties, and custom options.pipeline', async() =>
    {
        await models.projects.deleteMany({});
        await models.projects.createMany(
        [
            { name: 'Alpha', status: 'active', secret: 'hidden-1', stages: [] },
            { name: 'Beta', status: 'active', secret: 'hidden-2', stages: [] }
        ]);

        const rows = await models.projects.list({ limit: 1, count: true, sort: { name: 1 } });
        const { items, total, cursors } = await models.projects.list({ limit: 1, count: true, sort: { name: 1 } });

        expect( Array.isArray( rows )).toBe( true );
        expect( rows.length ).toBe( 1 );
        expect( rows.total ).toBe( 2 );
        expect( rows[0].$cursor ).toBeTypeOf( 'string' );
        expect( rows[0].$cursor!.length ).toBeGreaterThan( 0 );
        expect( items ).toEqual( rows );
        expect( total ).toBe( 2 );
        expect( cursors.next ).toBe( rows[0].$cursor );
        expect( rows[0].computedTag ).toBe( 'tag:Alpha' );
        expect(( rows[0] as any ).secret ).toBeUndefined();

        // AE6: custom options.pipeline with $addFields and $sort preserves customRank and computedTag
        const ranked = await models.projects.list(
        {
            pipeline:
            [
                { $addFields: { customRank: 42 } },
                { $sort: { customRank: -1, name: 1 } }
            ]
        });

        expect( ranked.length ).toBe( 2 );
        expect( ranked[0].computedTag ).toBe( 'tag:Alpha' );
        expect( ranked[0].customRank ).toBe( 42 );
    });

    test( 'AE3: Dual-compatible get() handles single ID, ID array, positional conversion, and options', async() =>
    {
        await models.projects.deleteMany({});
        const [ id1, id2 ] = await models.projects.createMany(
        [
            { name: 'First', status: 'pending', stages: [] },
            { name: 'Second', status: 'active', stages: [] }
        ]);
        const missingId = new ObjectId().toString();

        const dbe1 = await models.projects.get( id1, 'dbe' );

        expect( dbe1?._id ).toBeInstanceOf( ObjectId );
        expect( dbe1?.name ).toBe( 'First' );

        const batchFiltered = await models.projects.get([ id2, missingId, id1 ], 'dto', true );

        expect( batchFiltered.map( p => p.name )).toEqual([ 'Second', 'First' ]);

        const adminDto = await models.projects.get( id1, { as: 'dto', access: 'admin' });

        expect( adminDto?.id ).toBe( id1 );
        expect( adminDto?.name ).toBe( 'First' );
    });

    test( 'AE4: ID-scoped cache invalidation evicts targeted IDs and clears cache on non-ID filter updates that mutate documents', async() =>
    {
        await models.projects.deleteMany({});
        const [ id1, id2 ] = await models.projects.createMany(
        [
            { name: 'CachedOne', status: 'pending', stages: [] },
            { name: 'CachedTwo', status: 'pending', stages: [] }
        ]);

        const cacheEvents: Array<{ op: string, ids?: string[] }> = [];
        const off = models.projects.on( 'cache', ev =>
        {
            cacheEvents.push({ op: ev.operation, ids: ev.ids });
        });

        try
        {
            // Seed cache for id1 ('dto' & 'dbe') and id2 ('dto')
            await models.projects.get( id1, 'dto' );
            await models.projects.get( id1, 'dbe' );
            await models.projects.get( id2, 'dto' );

            cacheEvents.length = 0;

            // Verify hits
            await models.projects.get( id1, 'dto' );
            await models.projects.get( id1, 'dbe' );
            await models.projects.get( id2, 'dto' );
            expect( cacheEvents.filter( e => e.op === 'hit' )).toHaveLength( 3 );

            // ID-based updateOne evicts id1 ('dto' and 'dbe'), keeps id2
            await models.projects.updateOne({ _id: new ObjectId( id1 ) }, { name: 'CachedOneUpdated' });

            cacheEvents.length = 0;
            const dto2AfterIdUpdate = await models.projects.get( id2, 'dto' );

            expect( dto2AfterIdUpdate?.name ).toBe( 'CachedTwo' );
            expect( cacheEvents.some( e => e.op === 'hit' )).toBe( true );

            cacheEvents.length = 0;
            const dto1AfterIdUpdate = await models.projects.get( id1, 'dto' );
            const dbe1AfterIdUpdate = await models.projects.get( id1, 'dbe' );

            expect( dto1AfterIdUpdate?.name ).toBe( 'CachedOneUpdated' );
            expect( dbe1AfterIdUpdate?.name ).toBe( 'CachedOneUpdated' );
            expect( cacheEvents.filter( e => e.op === 'miss' )).toHaveLength( 2 );

            // Non-ID updateOne that affects 0 documents preserves cached entries
            await models.projects.updateOne({ status: 'nonexistent' }, { status: 'active' });

            cacheEvents.length = 0;
            await models.projects.get( id1, 'dto' );
            await models.projects.get( id2, 'dto' );
            expect( cacheEvents.filter( e => e.op === 'hit' )).toHaveLength( 2 );

            // Non-ID updateOne that modifies documents clears cache to prevent stale reads
            await models.projects.updateOne({ status: 'pending' }, { status: 'active' });

            cacheEvents.length = 0;
            await models.projects.get( id1, 'dto' );
            await models.projects.get( id2, 'dto' );
            expect( cacheEvents.filter( e => e.op === 'miss' )).toHaveLength( 2 );
        }
        finally
        {
            off();
        }
    });

    test( 'AE5: Observability hierarchy emits query, slowQuery, mutation, cache, and error events with flow traceID', async() =>
    {
        const observed =
        {
            queries     : [] as any[],
            slowQueries : [] as any[],
            mutations   : [] as any[],
            caches      : [] as any[],
            errors      : [] as any[]
        };

        const offQ = models.on( 'query', e => observed.queries.push( e ));
        const offS = models.on( 'slowQuery', e => observed.slowQueries.push( e ));
        const offM = models.on( 'mutation', e => observed.mutations.push( e ));
        const offC = models.on( 'cache', e => observed.caches.push( e ));
        const offE = models.on( 'error', e => observed.errors.push( e ));

        try
        {
            await flowExecute( async() =>
            {
                const id = await models.projects.createFrom({ externalName: 'ObservedProject' }, 'webhook' );

                await models.projects.get( id, 'dto' );
                await models.projects.get( id, 'dto' ); // cache hit

                await expect(
                    models.projects.get( id, 'failingDTO' as any )
                ).rejects.toBeInstanceOf( ModelConverterError );
            }, { traceID: 'trace-ae5-999' });

            expect( observed.mutations.some( m => m.operation === 'createFrom' && m.traceID === 'trace-ae5-999' )).toBe( true );
            expect( observed.queries.some( q => q.operation === 'get' && q.traceID === 'trace-ae5-999' )).toBe( true );
            expect( observed.slowQueries.some( s => s.traceID === 'trace-ae5-999' )).toBe( true );
            expect( observed.caches.some( c => c.operation === 'hit' && c.traceID === 'trace-ae5-999' )).toBe( true );
            expect( observed.errors.some( e => e.traceID === 'trace-ae5-999' )).toBe( true );
        }
        finally
        {
            offQ();
            offS();
            offM();
            offC();
            offE();
        }
    });

    test( '2-level nested array PropertyModel (stages[].items[]) supports full CRUD lifecycle against real MongoDB', async() =>
    {
        const projId = await models.projects.create(
        {
            name    : 'Nested Project',
            status  : 'active',
            stages  : []
        });

        const stageId = await models.stages.create( projId, { title: 'Stage One', items: [] });
        const item1Id = await models.stageItems.create( stageId, { label: 'Item 1', status: 'open' });
        const [ item2Id, item3Id ] = await models.stageItems.createMany(
            stageId,
            [
                { label: 'Item 2', status: 'open' },
                { label: 'Item 3', status: 'open' }
            ]
        );

        const listedItems = await models.stageItems.list({ count: true });

        expect( listedItems.total ).toBeGreaterThanOrEqual( 3 );

        const updRes = await models.stageItems.updateOne({ id: new ObjectId( item1Id ) }, { status: 'done' });

        expect( updRes.matchedCount ).toBe( 1 );
        expect( ( await models.stageItems.get( item1Id ))?.status ).toBe( 'done' );

        const delOne = await models.stageItems.delete( item2Id );

        expect( delOne ).toBe( true );
        expect( await models.stageItems.exists( item2Id )).toBe( false );

        const delMany = await models.stageItems.deleteMany([ item1Id, item3Id ]);

        expect( delMany ).toBe( 1 );
        expect( await models.stageItems.exists( item1Id )).toBe( false );
        expect( await models.stageItems.exists( item3Id )).toBe( false );
    });
});
