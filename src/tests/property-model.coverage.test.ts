import { describe, expect, test, vi } from 'vitest';
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';
import { getCursor } from '../helpers/mongo.js';
import { ModelError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import type { ModelsOptions, MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

vi.mock( '@webergency-utils/mongodb-query-optimizer', async( importOriginal ) =>
{
    const actual = await importOriginal<typeof import( '@webergency-utils/mongodb-query-optimizer' )>();

    return {
        ...actual,
        optimizePipeline: vi.fn( actual.optimizePipeline )
    };
});

type RootDBE = MongoRootDocument & { _id: string, profile?: ProfileDBE, items?: ItemDBE[], engagements?: Array<{ id: string, applications: AppDBE[] }> };
type ItemDBE = MongoPropertyDocument & { id: string, orgId: string, label: string };
type ProfileDBE = MongoPropertyDocument & { id: string, bio: string };
type AppDBE = MongoPropertyDocument & { id: string, status: string };
type ItemDTO = { id: string, orgId?: string, label?: string, bio?: string, status?: string };
type RootDTO = { id: string };

class TestModels extends AbstractModels
{
    constructor( options?: ModelsOptions )
    {
        super( 'mongodb://localhost/test-property-coverage', options );
    }
}

describe( 'AbstractPropertyModel coverage branches', () =>
{
    test( 'create succeeds with registered parent', async() =>
    {
        const models = new TestModels();
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const aggregate = vi.fn(() => ({ toArray: async() => [{ _id: 'root-1' }] }));
        const collection = { collectionName: 'roots', aggregate, updateOne };

        class RootModel extends AbstractModel<RootDBE, RootDTO, any>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: ( dbe: RootDBE ) => ({ id: dbe._id }) },
                        dbe : { converter: ( dbe: RootDBE ) => dbe }
                    }
                });
            }
        }

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor()
            {
                super( models, collection as any, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }
        }

        new RootModel();
        const items = new ItemModel();
        const id = await items.create( 'root-1', { orgId: 'o', label: 'L' } as any, 'item-1' );

        expect( id ).toBe( 'item-1' );
        expect( updateOne ).toHaveBeenCalledOnce();
    });

    test( 'non-array property update and updateMany', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        class ProfileModel extends AbstractPropertyModel<RootDBE, ProfileDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'profile',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ProfileDBE ) => ({ id: dbe.id, bio: dbe.bio }) },
                        dbe : { converter: ( dbe: ProfileDBE ) => dbe }
                    }
                });
            }
        }

        const models = new TestModels();
        const model = new ProfileModel( models, { collectionName: 'roots', updateOne, updateMany, aggregate: vi.fn() });

        await model.update( 'p1', { bio: 'x' });
        await model.updateMany([ 'p1' ], { bio: 'y' });

        expect( updateOne.mock.calls[0][1] ).toEqual({ $set: { 'profile.bio': 'x' } });
        expect( updateMany.mock.calls[0][1] ).toEqual({ $set: { 'profile.bio': 'y' } });
    });

    test( 'nested array updateMany uses nested arrayFilters', async() =>
    {
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        class AppModel extends AbstractPropertyModel<RootDBE, AppDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'engagements[].applications[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: AppDBE ) => ({ id: dbe.id, status: dbe.status }) },
                        dbe : { converter: ( dbe: AppDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { org: async() => ({ orgId: '1' }) },
                        defaults : { update: 'org' }
                    }
                });
            }
        }

        const models = new TestModels();
        const model = new AppModel( models, { collectionName: 'roots', updateMany, aggregate: vi.fn() });

        await model.updateMany([ 'a1' ], { status: 'ok' });

        const [ match, , options ] = updateMany.mock.calls[0];

        expect( match.$and[0] ).toEqual({ 'engagements.applications.id': { $in: [ 'a1' ] } });
        expect( options.arrayFilters[0]['entry.id'] ).toEqual({ $in: [ 'a1' ] });
    });

    test( 'get error path and getMany deny', async() =>
    {
        const aggregate = vi.fn(() => { throw new Error( 'boom' ) });

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { deny: async() => false },
                        defaults : { read: 'deny' }
                    }
                });
            }
        }

        const deny = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate: vi.fn() });

        expect( await deny.getMany([ '1' ])).toEqual([ null ]);
        expect( await deny.getMany([ '1' ], { filter: true })).toEqual([]);

        const fail = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate });

        // override access by constructing without deny — reuse fail with no access:
        class OpenItem extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }
        }

        const open = new OpenItem( new TestModels(), { collectionName: 'roots', aggregate });
        const onError = vi.fn();

        open.on( 'error', onError );
        await expect( open.get( '1' )).rejects.toBeInstanceOf( ModelError );
        expect( onError ).toHaveBeenCalledOnce();
    });

    test( 'stream prev path and aggregate with options + optimizer', async() =>
    {
        const docs =
        [
            { id: '1', orgId: 'o', label: 'A' },
            { id: '2', orgId: 'o', label: 'B' }
        ];
        const sort = { id: 1 as const };
        const cursor = 'prev:' + getCursor( docs[1], sort );
        const aggregate = vi.fn(() => ({ toArray: async() => docs }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }
        }

        const model = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate });
        const items: ItemDTO[] = [];

        for await( const item of model.stream({ cursor, sort }) )
        {
            items.push( item );
        }

        expect( items.map( i => i.id )).toEqual([ '2', '1' ]);

        async function *gen()
        {
            yield docs[0];
        }

        aggregate.mockImplementation(() =>
        ({
            toArray                 : async() => docs,
            [Symbol.asyncIterator]  : gen
        }));

        vi.mocked( optimizePipeline ).mockClear();

        await model.aggregate([{ $limit: 1 }], { filter: { label: 'A' } });
        await model.count([], { filter: { label: 'A' } });

        const forward: ItemDTO[] = [];

        for await( const item of model.stream({ sort: { label: 1 } }) )
        {
            forward.push( item );
        }

        expect( forward ).toHaveLength( 1 );
        expect( forward[0].orgId ).toBe( 'o' );
        expect( optimizePipeline ).toHaveBeenCalledTimes( 3 );
    });

    test( 'list with sort without bare id and projection split', async() =>
    {
        const docs = [{ id: '1', orgId: 'o', label: 'A' }];
        let call = 0;
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            {
                call++;

                return call === 1 ? docs : [{ count: 1 }];
            }
        }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : {
                            converter   : ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }),
                            projection  : { label: 1, '_root._id': 1 }
                        },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    smartFilters:
                    {
                        byLabel: async( label: string ) => ({ filter: { label } })
                    },
                    computedProperties:
                    {
                        upper: async() => ({ fields: { upper: { $toUpper: '$label' } }, pipeline: [] })
                    }
                });
            }
        }

        const models = new TestModels();

        class RootModel extends AbstractModel<RootDBE, RootDTO, any>
        {
            constructor()
            {
                super( models, { collectionName: 'roots', aggregate: vi.fn() } as any,
                {
                    converters:
                    {
                        dto : { converter: ( dbe: RootDBE ) => ({ id: dbe._id }) },
                        dbe : { converter: ( dbe: RootDBE ) => dbe }
                    },
                    smartFilters:
                    {
                        byOrg: async( orgId: string ) => ({ filter: { orgId } })
                    },
                    computedProperties:
                    {
                        rootFlag: async() => ({ fields: { rootFlag: 1 }, pipeline: [] })
                    }
                });
            }
        }

        new RootModel();
        const model = new ItemModel( models, { collectionName: 'roots', aggregate });

        vi.mocked( optimizePipeline ).mockClear();

        const result = await model.list({
            sort                : { label: 1 },
            count               : true,
            smartFilter         : { byLabel: 'A', byOrg: '1' },
            computedProperties  : [ 'upper', 'rootFlag' ]
        });

        expect( result.items[0].id ).toBe( '1' );
        expect( result.total ).toBe( 1 );
        expect( optimizePipeline ).toHaveBeenCalledTimes( 2 );
    });

    test( 'list/stream rethrow non-access errors', async() =>
    {
        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { bad: async() => { throw new TypeError( 'nope' ) } },
                        defaults : { read: 'bad' }
                    }
                });
            }
        }

        const model = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate: vi.fn() });

        await expect( model.list({})).rejects.toThrow( 'nope' );

        const iter = model.stream({});

        await expect( iter.next()).rejects.toThrow( 'nope' );
    });

    test( 'empty stream emits query and off works', async() =>
    {
        async function *empty() {}

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }
        }

        const model = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate: vi.fn(() => empty()) });
        const handler = vi.fn();

        model.on( 'query', handler );
        model.off( 'query', handler );

        for await( const _ of model.stream({}) ){ /* drain */ }

        expect( handler ).not.toHaveBeenCalled();

        model.on( 'query', handler );

        for await( const _ of model.stream({}) ){ /* drain */ }

        expect( handler ).toHaveBeenCalledWith( expect.objectContaining({ operation: 'stream' }));
    });

    test( 'ensureOpen and accessFilter hooks are callable', async() =>
    {
        class HookModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }

            public ping()
            {
                this.ensureOpen();

                return this.accessFilter( 'default' );
            }
        }

        const model = new HookModel( new TestModels(), { collectionName: 'roots', aggregate: vi.fn() });

        await expect( model.ping() ).resolves.toBeUndefined();
    });

    test( 'list and stream append id sort and honor optimizer', async() =>
    {
        const docs = [{ id: '1', orgId: 'o', label: 'A' }];
        const aggregate = vi.fn(() =>
        ({
            toArray                     : async() => docs,
            [Symbol.asyncIterator]      : async function *(){ yield *docs }
        }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    converters:
                    {
                        dto : {
                            converter   : ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }),
                            projection  : { label: 1, '_root.title': 1, _root: { org: 1 } }
                        },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    optimizer: { strictFieldOrder: true }
                });
            }
        }

        const model = new ItemModel( new TestModels(), { collectionName: 'roots', aggregate });

        vi.mocked( optimizePipeline ).mockClear();

        const listed = await model.list({ sort: { label: 1 }, count: false });

        expect( listed.items[0].id ).toBe( '1' );

        const streamed: string[] = [];

        for await( const item of model.stream({ sort: { label: 1 } }) )
        {
            streamed.push( item.id );
        }

        expect( streamed ).toEqual([ '1' ]);
        expect( optimizePipeline ).toHaveBeenCalledTimes( 2 );
        expect( optimizePipeline ).toHaveBeenNthCalledWith( 1, expect.any( Array ), { strictFieldOrder: true });
        expect( optimizePipeline ).toHaveBeenNthCalledWith( 2, expect.any( Array ), { strictFieldOrder: true });
    });

    test( 'optimizes get, getMany, find, and internal .get() calls in create and update while excluding writes and honoring disabled optimizer', async() =>
    {
        const docs = [{ _id: 'root-1', id: 'item-1', orgId: 'o', label: 'A', status: 'ok', count: 1 }];
        const aggregate = vi.fn(() =>
        ({
            toArray                 : async() => docs,
            [Symbol.asyncIterator]  : async function *(){ yield *docs }
        }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const collection = { collectionName: 'roots', aggregate, updateOne, updateMany };
        const models = new TestModels({ optimizer: { strictErrors: true } });

        class RootModel extends AbstractModel<RootDBE, RootDTO, any>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: ( dbe: RootDBE ) => ({ id: dbe._id }) },
                        dbe : { converter: ( dbe: RootDBE ) => dbe }
                    },
                    optimizer: { strictFieldOrder: true }
                });
            }
        }

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( optimizer?: any )
            {
                super( models, collection as any, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    optimizer
                });
            }
        }

        // Instantiate child PropertyModel before RootModel to verify dynamic ancestor lookup on read queries (AE2 / R6)
        const items = new ItemModel();

        new RootModel();

        vi.mocked( optimizePipeline ).mockClear();

        // Direct read methods: get, getMany, find
        await items.get( 'item-1' );
        expect( optimizePipeline ).toHaveBeenCalledTimes( 1 );
        expect( optimizePipeline ).toHaveBeenLastCalledWith( expect.any( Array ), { strictFieldOrder: true });

        await items.getMany([ 'item-1' ]);
        expect( optimizePipeline ).toHaveBeenCalledTimes( 2 );

        await items.find({ filter: { label: 'A' } });
        expect( optimizePipeline ).toHaveBeenCalledTimes( 3 );

        // Internal parentModel.get() inside PropertyModel.create is optimized (R10 / AE3)
        vi.mocked( optimizePipeline ).mockClear();

        await items.create( 'root-1', { orgId: 'o', label: 'B' } as any, 'item-2' );
        expect( optimizePipeline ).toHaveBeenCalledTimes( 1 );
        expect( optimizePipeline ).toHaveBeenLastCalledWith( expect.any( Array ), { strictFieldOrder: true });

        // Internal this.get() inside PropertyModel.update with documentBefore & documentAfter is optimized (R10 / AE3)
        vi.mocked( optimizePipeline ).mockClear();

        const updated = await items.update( 'item-1', { label: 'C' }, { documentBefore: true, documentAfter: true });

        expect( updated.documentBefore ).toBeDefined();
        expect( updated.documentAfter ).toBeDefined();
        expect( optimizePipeline ).toHaveBeenCalledTimes( 2 );

        // Write operations without internal .get() do NOT call optimizePipeline
        vi.mocked( optimizePipeline ).mockClear();

        await items.update( 'item-1', { label: 'D' });
        await items.updateMany([ 'item-1' ], { label: 'E' });

        expect( optimizePipeline ).not.toHaveBeenCalled();

        // Disabled optimizer on PropertyModel skips optimizePipeline on all read methods and internal .get() in update
        const disabledItems = new ItemModel( false );

        await disabledItems.get( 'item-1' );
        await disabledItems.getMany([ 'item-1' ]);
        await disabledItems.find({ filter: { label: 'A' } });
        await disabledItems.list({ count: true });
        for await( const _ of disabledItems.stream({}) ){ /* drain */ }
        await disabledItems.aggregate([{ $limit: 1 }]);
        await disabledItems.count([]);
        await disabledItems.update( 'item-1', { label: 'F' }, { documentBefore: true, documentAfter: true });

        expect( optimizePipeline ).not.toHaveBeenCalled();
    });
});
