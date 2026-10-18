import { describe, expect, test, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import { flowExecute, flowGet, flowSet } from '../flow.js';
import type { ModelCacheEvent, ModelQueryEvent } from '../events.js';
import type { ModelsOptions, MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument &
{
    _id     : ObjectId
    name    : string
    orgId   : string
    secret? : string
    items?  : ItemDBE[]
};

type UserDTO =
{
    id        : string
    name      : string
    orgId     : string
    greeting? : string
};

type ItemDBE = MongoPropertyDocument &
{
    id      : ObjectId
    label   : string
    secret? : string
};

type ItemDTO =
{
    id    : string
    label : string
};

class ParityModels extends AbstractModels
{
    constructor( options?: ModelsOptions )
    {
        super( 'mongodb://localhost/test-query-parity', options );
    }
}

function createParityFixture( options?:
{
    userDocs?    : UserDBE[]
    itemDocs?    : ItemDBE[]
    countResult? : number
    cache?       : any
    access?      : any
    itemAccess?  : any
})
{
    const id1 = new ObjectId( '507f1f77bcf86cd799439011' );
    const id2 = new ObjectId( '507f1f77bcf86cd799439012' );
    const itemId1 = new ObjectId( '507f1f77bcf86cd799439021' );
    const itemId2 = new ObjectId( '507f1f77bcf86cd799439022' );

    const defaultUsers: UserDBE[] = options?.userDocs ??
    [
        {
            _id    : id1,
            name   : 'Ada',
            orgId  : 'org-1',
            secret : 's1',
            items  : [{ id: itemId1, label: 'Item 1', secret: 'is1' }]
        },
        {
            _id    : id2,
            name   : 'Grace',
            orgId  : 'org-1',
            secret : 's2',
            items  : [{ id: itemId2, label: 'Item 2', secret: 'is2' }]
        }
    ];

    const defaultItems: ItemDBE[] = options?.itemDocs ??
    [
        { id: itemId1, label: 'Item 1', secret: 'is1' },
        { id: itemId2, label: 'Item 2', secret: 'is2' }
    ];

    const userAggregate = vi.fn(( pipeline: any[] ) =>
    {
        const hasCount = pipeline.some( s => '$count' in s );

        return {
            toArray: async() =>
            {
                if( hasCount )
                {
                    return [{ count: options?.countResult ?? defaultUsers.length }];
                }

                const matchStage = pipeline.find( s => s.$match );
                const inIds = matchStage?.$match?._id?.$in;

                if( Array.isArray( inIds ) )
                {
                    return defaultUsers.filter( u => inIds.some(( target: any ) => String( target ) === String( u._id )));
                }

                if( matchStage?.$match?._id && !( typeof matchStage.$match._id === 'object' && '$exists' in matchStage.$match._id ) )
                {
                    const targetId = matchStage.$match._id;

                    return defaultUsers.filter( u => String( u._id ) === String( targetId ));
                }

                const limitStage = pipeline.find( s => '$limit' in s );

                if( limitStage )
                {
                    return defaultUsers.slice( 0, limitStage.$limit );
                }

                return defaultUsers;
            },
            [Symbol.asyncIterator]: async function *()
            {
                for( const u of defaultUsers )
                {
                    yield u;
                }
            }
        };
    });

    const itemAggregate = vi.fn(( pipeline: any[] ) =>
    {
        const hasCount = pipeline.some( s => '$count' in s );

        return {
            toArray: async() =>
            {
                if( hasCount )
                {
                    return [{ count: options?.countResult ?? defaultItems.length }];
                }

                const limitStage = pipeline.find( s => '$limit' in s );

                if( limitStage )
                {
                    return defaultItems.slice( 0, limitStage.$limit );
                }

                return defaultItems;
            }
        };
    });

    class UserModel extends AbstractModel<UserDBE, UserDTO, any>
    {
        constructor( models: AbstractModels, col: any )
        {
            super( models, col,
            {
                cache      : options?.cache,
                access     : options?.access,
                converters :
                {
                    dto:
                    {
                        projection : { _id: 1, name: 1, orgId: 1 },
                        converter  : ( dbe: UserDBE ): UserDTO => (
                        {
                            id    : dbe._id.toString(),
                            name  : dbe.name,
                            orgId : dbe.orgId
                        })
                    },
                    customDTO:
                    {
                        projection         : { _id: 1, name: 1, orgId: 1, greeting: 1 },
                        computedProperties : [ 'withGreeting' ],
                        converter          : ( dbe: UserDBE & { greeting?: string } ): UserDTO => (
                        {
                            id       : dbe._id.toString(),
                            name     : dbe.name,
                            orgId    : dbe.orgId,
                            greeting : dbe.greeting ?? `Hi ${dbe.name}`
                        })
                    },
                    dbe:
                    {
                        converter: ( dbe: UserDBE ): UserDBE => dbe
                    }
                },
                computedProperties:
                {
                    withGreeting: () => (
                    {
                        fields: { greeting: { $concat: [ 'Hi ', '$name' ] } }
                    }),
                    extraFlag: () => (
                    {
                        fields: { extraFlag: true }
                    })
                }
            });
        }

        public override dbeID( id: string | ObjectId ): ObjectId
        {
            return id instanceof ObjectId ? id : new ObjectId( String( id ));
        }

        public override dtoID( id: string | ObjectId ): string
        {
            return id.toString();
        }
    }

    class ItemModel extends AbstractPropertyModel<UserDBE, ItemDBE, ItemDTO, any>
    {
        constructor( models: AbstractModels, col: any )
        {
            super( models, col, 'items[]',
            {
                cache      : options?.cache,
                access     : options?.itemAccess,
                converters :
                {
                    dto:
                    {
                        projection : { id: 1, label: 1 },
                        converter  : ( dbe: ItemDBE ): ItemDTO => (
                        {
                            id    : dbe.id.toString(),
                            label : dbe.label
                        })
                    },
                    dbe:
                    {
                        converter: ( dbe: ItemDBE ): ItemDBE => dbe
                    }
                }
            });
        }

        public override dbeID( id: string | ObjectId ): ObjectId
        {
            return id instanceof ObjectId ? id : new ObjectId( String( id ));
        }

        public override dtoID( id: string | ObjectId ): string
        {
            return id.toString();
        }
    }

    const models = new ParityModels();
    const users = new UserModel( models, { collectionName: 'users', aggregate: userAggregate });
    const items = new ItemModel( models, { collectionName: 'users', aggregate: itemAggregate });

    return { models, users, items, userAggregate, itemAggregate, id1, id2, itemId1, itemId2 };
}

describe( 'Unit U5: Query Surface Parity & Cache Integration', () =>
{
    test( 'R1 & R2 (AE3): get() supports single ID, positional conversion, array IDs, filtered flag, and v2 options on Root & Property models', async() =>
    {
        const { users, items, id1, id2, itemId1, itemId2 } = createParityFixture();
        const missingId = new ObjectId( '507f1f77bcf86cd799439099' );

        const singleDto = await users.get( id1.toString() );
        const singleDbePositional = await users.get( id1.toString(), 'dbe' );
        const singleDbeOptions = await users.get( id1.toString(), { as: 'dbe' });

        expect( singleDto ).toEqual({ id: id1.toString(), name: 'Ada', orgId: 'org-1' });
        expect( singleDbePositional?._id ).toBeInstanceOf( ObjectId );
        expect( singleDbeOptions?._id ).toBeInstanceOf( ObjectId );

        const batchUnfiltered = await users.get([ id2.toString(), missingId.toString(), id1.toString() ], { as: 'dto', filter: false });
        const batchFilteredPositional = await users.get([ id2.toString(), missingId.toString(), id1.toString() ], 'dto', true );

        expect( batchUnfiltered ).toEqual(
        [
            { id: id2.toString(), name: 'Grace', orgId: 'org-1' },
            null,
            { id: id1.toString(), name: 'Ada', orgId: 'org-1' }
        ]);
        expect( batchFilteredPositional ).toEqual(
        [
            { id: id2.toString(), name: 'Grace', orgId: 'org-1' },
            { id: id1.toString(), name: 'Ada', orgId: 'org-1' }
        ]);

        const propDbePositional = await items.get( itemId1.toString(), 'dbe' );
        const propBatchFiltered = await items.get([ itemId2.toString(), missingId.toString(), itemId1.toString() ], 'dto', true );

        expect( propDbePositional?.id ).toBeInstanceOf( ObjectId );
        expect( propBatchFiltered ).toEqual(
        [
            { id: itemId2.toString(), label: 'Item 2' },
            { id: itemId1.toString(), label: 'Item 1' }
        ]);
    });

    test( 'R3 & R9 (AE2): list() returns hybrid WithTotal array with $cursor AND supports destructuring { items, total, cursors } while applying converter projection & computedProperties', async() =>
    {
        const { users, items, userAggregate } = createParityFixture({ countResult: 2 });

        const rows = await users.list({ limit: 1, count: true }, 'customDTO' );
        const { items: destructuredItems, total, cursors } = rows;

        expect( Array.isArray( rows ) ).toBe( true );
        expect( rows.length ).toBe( 1 );
        expect( rows.total ).toBe( 2 );
        expect( rows[0].$cursor ).toBeTypeOf( 'string' );
        expect( rows[0].$cursor!.length ).toBeGreaterThan( 0 );
        expect( destructuredItems ).toBe( rows );
        expect( total ).toBe( 2 );
        expect( cursors.next ).toBe( rows[0].$cursor );

        const listPipeline = userAggregate.mock.calls[0][0] as any[];
        const serializedPipeline = JSON.stringify( listPipeline );

        expect( serializedPipeline ).toContain( '"greeting"' );
        expect( serializedPipeline ).toContain( '"$project"' );

        const propRows = await items.list({ limit: 1, count: true });
        const { items: propItems, total: propTotal, cursors: propCursors } = propRows;

        expect( Array.isArray( propRows ) ).toBe( true );
        expect( propRows.length ).toBe( 1 );
        expect( propRows[0].$cursor ).toBeTypeOf( 'string' );
        expect( propItems ).toBe( propRows );
        expect( propTotal ).toBe( 2 );
        expect( propCursors.next ).toBe( propRows[0].$cursor );
    });

    test( 'R9: stream() applies converter projection and merges options.computedProperties with converter computedProperties', async() =>
    {
        const { users, userAggregate } = createParityFixture();
        const streamed: UserDTO[] = [];

        for await( const user of users.stream({ computedProperties: [ 'extraFlag' ] } as any, 'customDTO' ) )
        {
            streamed.push( user );
        }

        expect( streamed ).toHaveLength( 2 );

        const streamPipeline = userAggregate.mock.calls[0][0] as any[];
        const serialized = JSON.stringify( streamPipeline );

        expect( serialized ).toContain( '"greeting"' );
        expect( serialized ).toContain( '"extraFlag"' );
        expect( serialized ).toContain( '"$project"' );
    });

    test( 'R10: Model.find() builds pipeline with target conversion projection/computedProperties and emits find query event', async() =>
    {
        const { users, userAggregate } = createParityFixture();
        const queryEvents: ModelQueryEvent[] = [];

        users.on( 'query', ( ev ) => queryEvents.push( ev ));

        const found = await users.find({ filter: { name: 'Ada' } }, 'customDTO' );

        expect( found ).toEqual(
        {
            id       : '507f1f77bcf86cd799439011',
            name     : 'Ada',
            orgId    : 'org-1',
            greeting : 'Hi Ada'
        });
        expect( queryEvents ).toHaveLength( 1 );
        expect( queryEvents[0].operation ).toBe( 'find' );
        expect( queryEvents[0].conversion ).toBe( 'customDTO' );
        expect( queryEvents[0].resultCount ).toBe( 1 );

        const findPipeline = userAggregate.mock.calls[0][0] as any[];

        expect( JSON.stringify( findPipeline ) ).toContain( '"greeting"' );
    });

    test( 'R7: count() accepts options object directly without leading pipeline array on Root & Property models', async() =>
    {
        const { users, items, userAggregate, itemAggregate } = createParityFixture({ countResult: 5 });

        const rootCountFromOptions = await users.count({ filter: { orgId: 'org-1' } });
        const rootCountEmpty = await users.count();
        const rootCountFromPipeline = await users.count([{ $match: { orgId: 'org-1' } }], { filter: { name: 'Ada' } });

        expect( rootCountFromOptions ).toBe( 5 );
        expect( rootCountEmpty ).toBe( 5 );
        expect( rootCountFromPipeline ).toBe( 5 );
        expect( JSON.stringify( userAggregate.mock.calls[0][0] ) ).toContain( '"orgId":"org-1"' );

        const propCountFromOptions = await items.count({ filter: { label: 'Item 1' } });
        const propCountEmpty = await items.count();

        expect( propCountFromOptions ).toBe( 5 );
        expect( propCountEmpty ).toBe( 5 );
        expect( JSON.stringify( itemAggregate.mock.calls[0][0] ) ).toContain( '"items.label":"Item 1"' );
    });

    test( 'R27: exists() checks document existence by ID, filter, or find options and respects access control on Root & Property models', async() =>
    {
        const { users, items, id1 } = createParityFixture(
        {
            access:
            {
                filters:
                {
                    allow : () => ({ orgId: 'org-1' }),
                    deny  : () => false
                },
                defaults: { read: 'allow' }
            },
            itemAccess:
            {
                filters:
                {
                    allow : () => ({ label: 'Item 1' }),
                    deny  : () => false
                },
                defaults: { read: 'allow' }
            }
        });

        const queryEvents: ModelQueryEvent[] = [];

        users.on( 'query', ( ev ) => queryEvents.push( ev ));

        expect( await users.exists( id1.toString() ) ).toBe( true );
        expect( await users.exists({ name: 'Ada' }) ).toBe( true );
        expect( await users.exists( id1.toString(), { access: 'deny' }) ).toBe( false );
        expect( queryEvents.some( e => e.operation === 'exists' ) ).toBe( true );

        expect( await items.exists({ label: 'Item 1' }) ).toBe( true );
        expect( await items.exists({ label: 'Item 1' }, { access: 'deny' }) ).toBe( false );

        const emptyFixture = createParityFixture({ userDocs: [], itemDocs: [] });

        expect( await emptyFixture.users.exists( id1.toString() ) ).toBe( false );
        expect( await emptyFixture.items.exists({ label: 'Missing' }) ).toBe( false );
    });

    test( 'R20 & R21: ModelCache serves get/getMany hits, clones values safely, and isolates Flow access scopes', async() =>
    {
        const { users, userAggregate, id1, id2 } = createParityFixture(
        {
            cache  : { max: 100 },
            access :
            {
                filters:
                {
                    tenantScoped: () => ({ orgId: flowGet( 'orgId' ) ?? 'org-1' })
                },
                defaults: { read: 'tenantScoped' }
            }
        });

        const cacheEvents: ModelCacheEvent[] = [];

        users.on( 'cache', ( ev ) => cacheEvents.push( ev ));

        const first = await users.get( id1.toString() );

        expect( first ).toEqual({ id: id1.toString(), name: 'Ada', orgId: 'org-1' });
        expect( userAggregate ).toHaveBeenCalledTimes( 1 );
        expect( cacheEvents.map( e => e.operation ) ).toEqual([ 'miss', 'set' ]);

        // Mutate returned DTO — cached copy must stay intact
        first!.name = 'Mutated';

        const second = await users.get( id1.toString() );

        expect( second ).toEqual({ id: id1.toString(), name: 'Ada', orgId: 'org-1' });
        expect( userAggregate ).toHaveBeenCalledTimes( 1 );
        expect( cacheEvents.map( e => e.operation ) ).toEqual([ 'miss', 'set', 'hit' ]);

        // getMany with 1 cached ID and 1 uncached ID only fetches the uncached ID from MongoDB
        const many = await users.getMany([ id1.toString(), id2.toString() ]);

        expect( many ).toEqual(
        [
            { id: id1.toString(), name: 'Ada', orgId: 'org-1' },
            { id: id2.toString(), name: 'Grace', orgId: 'org-1' }
        ]);
        expect( userAggregate ).toHaveBeenCalledTimes( 2 );

        // Different Flow orgId scope must miss the org-1 cache entry
        await flowExecute( async() =>
        {
            flowSet( 'orgId', 'org-2' );
            await users.get( id1.toString() );
        }, {});

        expect( userAggregate ).toHaveBeenCalledTimes( 3 );

        // PropertyModel.getMany with cache: true (partial hit + miss + filter: true + all cached hit)
        const cachedPropFixture = createParityFixture({ cache: true });
        await cachedPropFixture.items.get( cachedPropFixture.itemId1.toString() );
        expect( cachedPropFixture.itemAggregate ).toHaveBeenCalledTimes( 1 );

        const propMany = await cachedPropFixture.items.getMany([ cachedPropFixture.itemId1.toString(), cachedPropFixture.itemId2.toString() ], { filter: true });
        expect( propMany ).toHaveLength( 2 );
        expect( cachedPropFixture.itemAggregate ).toHaveBeenCalledTimes( 2 );

        // Second getMany when all items are cached does not hit MongoDB
        const propManyAllCached = await cachedPropFixture.items.getMany([ cachedPropFixture.itemId1.toString(), cachedPropFixture.itemId2.toString() ]);
        expect( propManyAllCached ).toHaveLength( 2 );
        expect( cachedPropFixture.itemAggregate ).toHaveBeenCalledTimes( 2 );
    });
});

