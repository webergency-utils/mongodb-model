import { describe, expect, test, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { ModelAccessDeniedError, ModelConverterError, ModelError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import { defineModel } from '../define-model.js';
import { definePropertyModel } from '../define-property-model.js';
import type { MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument &
{
    _id     : ObjectId
    name    : string
    status  : string
    stages? : StageDBE[]
    address?: AddressDBE
};

type StageDBE = MongoPropertyDocument &
{
    id      : ObjectId
    title   : string
    items?  : StageItemDBE[]
    meta?   : StageMetaDBE
};

type StageItemDBE = MongoPropertyDocument &
{
    id      : ObjectId
    label   : string
    status  : string
};

type StageMetaDBE = MongoPropertyDocument &
{
    id      : ObjectId
    note    : string
};

type AddressDBE = MongoPropertyDocument &
{
    id      : ObjectId
    city    : string
};

type UserDTO = { id: string, name: string, status: string };
type StageDTO = { id: string, title: string };
type StageItemDTO = { id: string, label: string, status: string };

class TestModels extends AbstractModels
{
    constructor( observability?: any )
    {
        super( 'mongodb://localhost/test-mutations-parity', { observability });
    }
}

describe( 'Unit U6: Symmetric Root & Property Mutations, Cache Invalidation & Builder Wiring', () =>
{
    test( 'AbstractModel.createFrom supports named fromKey, default single from converter, explicit id, and error handling', async() =>
    {
        const inserted: any[] = [];
        const collection =
        {
            collectionName  : 'users',
            insertOne       : vi.fn( async( doc: any ) =>
            {
                inserted.push( doc );

                return { insertedId: doc._id };
            }),
            aggregate       : vi.fn()
        };

        const models = new TestModels();
        const errors: any[] = [];
        const mutations: any[] = [];

        models.on( 'error', e => { errors.push( e ) });
        models.on( 'mutation', e => { mutations.push( e ) });

        class UserModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        from:
                        {
                            webhook : async( payload: { externalName: string }) =>
                            ({
                                name    : payload.externalName,
                                status  : 'active'
                            }),
                            broken  : async() =>
                            {
                                throw new Error( 'parse failed' );
                            }
                        },
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        const users = new UserModel();
        const id1 = await users.createFrom({ externalName: 'Grace' }, 'webhook' );

        expect( ObjectId.isValid( id1 )).toBe( true );
        expect( inserted[0] ).toMatchObject({ name: 'Grace', status: 'active' });
        expect( mutations.some( m => m.operation === 'create' || m.operation === 'createFrom' )).toBe( true );

        const customId = new ObjectId().toString();
        const id2 = await users.createFrom({ externalName: 'Ada' }, 'webhook', customId );

        expect( id2 ).toBe( customId );
        expect( String( inserted[1]._id )).toBe( customId );

        await expect( users.createFrom({ externalName: 'Fail' }, 'broken' )).rejects.toBeInstanceOf( ModelConverterError );
        expect( errors.length ).toBeGreaterThanOrEqual( 1 );

        await expect( users.createFrom({ externalName: 'Unknown' }, 'missingKey' )).rejects.toMatchObject(
        {
            code: 'MODEL_CONFIG_ERROR'
        });

        class SingleFromModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor()
            {
                super( new TestModels(), collection as any,
                {
                    converters:
                    {
                        from:
                        {
                            onlyOne : ( payload: { externalName: string }) =>
                            ({
                                name    : payload.externalName,
                                status  : 'single'
                            })
                        },
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        const singleFrom = new SingleFromModel();
        const id3 = await singleFrom.createFrom({ externalName: 'DefaultSingle' });

        expect( ObjectId.isValid( id3 )).toBe( true );
        expect( inserted[2] ).toMatchObject({ name: 'DefaultSingle', status: 'single' });
    });

    test( 'AbstractPropertyModel.createFrom converts and creates subdocument on parent', async() =>
    {
        const parentId = new ObjectId();
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: parentId, name: 'Parent', status: 'active' }]
        }));
        const collection = { collectionName: 'users', updateOne, aggregate };
        const models = new TestModels();

        class UserModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        class StageModel extends AbstractPropertyModel<UserDBE, StageDBE, StageDTO, any>
        {
            constructor()
            {
                super( models, collection as any, 'stages[]',
                {
                    converters:
                    {
                        from:
                        {
                            webhook : ( data: { stageTitle: string }) => ({ title: data.stageTitle })
                        },
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), title: dbe.title }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        new UserModel();
        const stages = new StageModel();

        const stageId = await stages.createFrom( parentId.toString(), { stageTitle: 'Phone Screen' }, 'webhook' );

        expect( ObjectId.isValid( stageId )).toBe( true );
        expect( updateOne ).toHaveBeenCalledOnce();
        expect( updateOne.mock.calls[0][1] ).toMatchObject(
        {
            $push:
            {
                stages: expect.objectContaining({ title: 'Phone Screen' })
            }
        });
    });

    test( 'createMany inserts batch on AbstractModel and AbstractPropertyModel and checks access', async() =>
    {
        const insertMany = vi.fn( async() => ({ insertedCount: 2 }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const parentId = new ObjectId();
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: parentId, name: 'Parent', status: 'active' }]
        }));
        const collection = { collectionName: 'users', insertMany, updateOne, aggregate };
        const models = new TestModels();

        class UserModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor( access?: any )
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    },
                    access
                });
            }
        }

        class StageModel extends AbstractPropertyModel<UserDBE, StageDBE, StageDTO, any>
        {
            constructor( access?: any )
            {
                super( models, collection as any, 'stages[]',
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), title: dbe.title }) },
                        dbe : { converter: dbe => dbe }
                    },
                    access
                });
            }
        }

        const users = new UserModel();
        const stages = new StageModel();

        expect( await users.createMany([])).toEqual([]);
        expect( insertMany ).not.toHaveBeenCalled();

        const createdUserIds = await users.createMany(
        [
            { name: 'U1', status: 'active' },
            { name: 'U2', status: 'draft' }
        ]);

        expect( createdUserIds ).toHaveLength( 2 );
        expect( insertMany ).toHaveBeenCalledOnce();
        expect( insertMany.mock.calls[0][0] ).toHaveLength( 2 );

        expect( await stages.createMany( parentId.toString(), [])).toEqual([]);
        expect( updateOne ).not.toHaveBeenCalled();

        const createdStageIds = await stages.createMany(
            parentId.toString(),
            [
                { title: 'S1' },
                { title: 'S2' }
            ]
        );

        expect( createdStageIds ).toHaveLength( 2 );
        expect( updateOne ).toHaveBeenCalledOnce();
        expect( updateOne.mock.calls[0][1] ).toMatchObject(
        {
            $push:
            {
                stages:
                {
                    $each:
                    [
                        expect.objectContaining({ title: 'S1' }),
                        expect.objectContaining({ title: 'S2' })
                    ]
                }
            }
        });

        const deniedUsers = new UserModel(
        {
            filters  : { deny: () => false },
            defaults : { create: 'deny' }
        });

        await expect( deniedUsers.createMany([{ name: 'No', status: 'active' }])).rejects.toBeInstanceOf( ModelAccessDeniedError );
    });

    test( '2-level nested array PropertyModel create, update, and delete build valid arrayFilters and paths', async() =>
    {
        const rootId = new ObjectId();
        const stageId = new ObjectId();
        const itemId = new ObjectId();

        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ id: stageId, title: 'Stage 1' }]
        }));
        const collection = { collectionName: 'users', updateOne, aggregate };
        const models = new TestModels();

        class UserModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor()
            {
                super( models, collection as any,
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        class StageModel extends AbstractPropertyModel<UserDBE, StageDBE, StageDTO, any>
        {
            constructor()
            {
                super( models, collection as any, 'stages[]',
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), title: dbe.title }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }

            public override dbeID( id: string | ObjectId ): ObjectId
            {
                return id instanceof ObjectId ? id : new ObjectId( id );
            }
        }

        class StageItemModel extends AbstractPropertyModel<UserDBE, StageItemDBE, StageItemDTO, any>
        {
            constructor()
            {
                super( models, collection as any, 'stages[].items[]',
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), label: dbe.label, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }

            public override dbeID( id: string | ObjectId ): ObjectId
            {
                return id instanceof ObjectId ? id : new ObjectId( id );
            }
        }

        new UserModel();
        new StageModel();
        const stageItems = new StageItemModel();

        const createdId = await stageItems.create( stageId.toString(), { label: 'Task 1', status: 'open' }, itemId.toString());

        expect( createdId ).toBe( itemId.toString());
        expect( updateOne ).toHaveBeenCalledWith(
            { 'stages.id': stageId },
            { $push: { 'stages.$[path0].items': { id: itemId, label: 'Task 1', status: 'open' } } },
            { arrayFilters: [{ 'path0.id': stageId }] }
        );

        updateOne.mockClear();
        const updRes = await stageItems.update( itemId.toString(), { status: 'done' });

        expect( updRes ).toEqual({ matchedRootCount: 1, modifiedRootCount: 1 });
        expect( updateOne ).toHaveBeenCalledWith(
            { 'stages.items.id': itemId },
            { $set: { 'stages.$[].items.$[entry].status': 'done' } },
            { arrayFilters: [{ 'entry.id': itemId }] }
        );

        updateOne.mockClear();
        const delRes = await stageItems.delete( itemId.toString());

        expect( delRes ).toBe( true );
        expect( updateOne ).toHaveBeenCalledWith(
            { 'stages.items.id': itemId },
            { $pull: { 'stages.$[].items': { id: itemId } } },
            {}
        );

        void rootId;
    });

    test( 'single-object PropertyModel delete uses $unset', async() =>
    {
        const addrId = new ObjectId();
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const collection = { collectionName: 'users', updateOne, aggregate: vi.fn() };
        const models = new TestModels();

        class AddressModel extends AbstractPropertyModel<UserDBE, AddressDBE, { id: string, city: string }, any>
        {
            constructor()
            {
                super( models, collection as any, 'address',
                {
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), city: dbe.city }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }

            public override dbeID( id: string | ObjectId ): ObjectId
            {
                return id instanceof ObjectId ? id : new ObjectId( id );
            }
        }

        const addresses = new AddressModel();
        const ok = await addresses.delete( addrId.toString());

        expect( ok ).toBe( true );
        expect( updateOne ).toHaveBeenCalledWith(
            { 'address.id': addrId },
            { $unset: { address: '' } },
            {}
        );
    });

    test( 'AE4: updateOne, updateMany, and deleteMany perform ID-scoped cache invalidation and preserve cache on non-ID filters', async() =>
    {
        const id1 = new ObjectId();
        const id2 = new ObjectId();
        const dbDocs = new Map<string, UserDBE>(
        [
            [ id1.toString(), { _id: id1, name: 'Alice', status: 'draft' }],
            [ id2.toString(), { _id: id2, name: 'Bob', status: 'draft' }]
        ]);

        const aggregate = vi.fn(( pipeline: any[] ) =>
        {
            const matchStage = pipeline.find( s => s.$match )?.$match;
            const inIds: ObjectId[] = matchStage?._id?.$in ?? ( matchStage?._id ? [ matchStage._id ] : [] );
            const results = inIds.length
                ? inIds.map( oid => dbDocs.get( oid.toString())).filter( Boolean )
                : Array.from( dbDocs.values());

            return { toArray: async() => results };
        });
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 2, modifiedCount: 2 }));
        const deleteMany = vi.fn( async() => ({ deletedCount: 1 }));
        const collection = { collectionName: 'users', aggregate, updateOne, updateMany, deleteMany };

        class CachedUserModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor()
            {
                super( new TestModels(), collection as any,
                {
                    cache: true,
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe._id ), name: dbe.name, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        const users = new CachedUserModel();

        // Populate cache for id1 ('dto' and 'dbe') and id2 ('dto')
        await users.get( id1, 'dto' );
        await users.get( id1, 'dbe' );
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 3 );

        // Verify all 3 are cached
        await users.get( id1, 'dto' );
        await users.get( id1, 'dbe' );
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 3 );

        // 1. ID-based updateOne({ _id: id1 }) evicts both 'dto' and 'dbe' variants for id1, keeps id2
        await users.updateOne({ _id: id1 }, { name: 'Alice Updated' });
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 3 ); // id2 still cached!

        await users.get( id1, 'dto' );
        await users.get( id1, 'dbe' );
        expect( aggregate ).toHaveBeenCalledTimes( 5 ); // both id1 variants refetched!

        // 2. Non-ID updateOne({ status: 'draft' }) keeps both id1 and id2 in cache
        await users.updateOne({ status: 'draft' }, { status: 'published' });
        await users.get( id1, 'dto' );
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 5 );

        // 3. Non-ID updateMany({ status: 'published' }) keeps cache
        await users.updateMany({ status: 'published' }, { status: 'archived' });
        await users.get( id1, 'dto' );
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 5 );

        // 4. ID-filtered deleteMany({ _id: { $in: [id1] } }) evicts id1, keeps id2
        const deleted = await users.deleteMany({ _id: { $in: [ id1 ] } });

        expect( deleted ).toBe( 1 );
        await users.get( id2, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 5 ); // id2 still cached!

        await users.get( id1, 'dto' );
        expect( aggregate ).toHaveBeenCalledTimes( 6 ); // id1 was evicted!
    });

    test( 'PropertyModel.updateOne, updateMany(filter), and deleteMany(idsOrFilter) work with ID-scoped cache invalidation', async() =>
    {
        const s1 = new ObjectId();
        const s2 = new ObjectId();
        const stageDocs = new Map<string, StageItemDBE>(
        [
            [ s1.toString(), { id: s1, label: 'First', status: 'draft' }],
            [ s2.toString(), { id: s2, label: 'Second', status: 'draft' }]
        ]);

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => Array.from( stageDocs.values())
        }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const collection = { collectionName: 'users', aggregate, updateOne, updateMany };

        class ItemPropertyModel extends AbstractPropertyModel<UserDBE, StageItemDBE, StageItemDTO, any>
        {
            constructor()
            {
                super( new TestModels(), collection as any, 'stages[].items[]',
                {
                    cache: true,
                    converters:
                    {
                        dto : { converter: dbe => ({ id: this.dtoID( dbe.id ), label: dbe.label, status: dbe.status }) },
                        dbe : { converter: dbe => dbe }
                    }
                });
            }
        }

        const items = new ItemPropertyModel();

        // Populate cache for s1 and s2
        await items.get( s1, 'dto' );
        await items.get( s2, 'dto' );
        const callsAfterSeed = aggregate.mock.calls.length;

        // PropertyModel.updateOne with non-ID filter resolves first matching subdoc (s1), updates it, and evicts s1 while keeping s2
        const updOneRes = await items.updateOne({ status: 'draft' }, { status: 'published' });

        expect( updOneRes ).toEqual({ matchedCount: 1, modifiedCount: 1 });
        expect( updOneRes.matchedRootCount ).toBe( 1 );

        const callsBeforeCacheCheck = aggregate.mock.calls.length;

        await items.get( s2, 'dto' );
        expect( aggregate.mock.calls.length ).toBe( callsBeforeCacheCheck ); // s2 still cached!

        await items.get( s1, 'dto' );
        expect( aggregate.mock.calls.length ).toBe( callsBeforeCacheCheck + 1 ); // s1 was evicted!

        // PropertyModel.updateMany with filter
        const updManyRes = await items.updateMany({ status: 'draft' }, { status: 'archived' });

        expect( updManyRes ).toEqual({ matchedRootCount: 1, modifiedRootCount: 1 });

        // PropertyModel.deleteMany with ID filter evicts s2
        const delCount = await items.deleteMany({ id: { $in: [ s2 ] } });

        expect( delCount ).toBe( 1 );

        const callsBeforeS2 = aggregate.mock.calls.length;

        await items.get( s2, 'dto' );
        expect( aggregate.mock.calls.length ).toBe( callsBeforeS2 + 1 ); // s2 was evicted!

        void callsAfterSeed;
    });

    test( 'defineModel and definePropertyModel forward cache, observability, and converters.from', async() =>
    {
        const id1 = new ObjectId();
        const aggregate = vi.fn(() => ({ toArray: async() => [{ _id: id1, name: 'Defined', status: 'active' }] }));
        const insertOne = vi.fn( async( doc: any ) => ({ insertedId: doc._id }));
        const collection = { collectionName: 'users', aggregate, insertOne };
        const events: string[] = [];
        const models = new TestModels();

        const userModel = defineModel<UserDBE, UserDTO>( models, collection as any,
        {
            cache: true,
            observability:
            {
                logger: ( ev ) => { events.push( `${ev.type}:${ev.operation}` ) }
            },
            converters:
            {
                from:
                {
                    webhook: ( d: { externalName: string }) => ({ name: d.externalName, status: 'active' })
                },
                dto: 'auto'
            }
        });

        const createdId = await userModel.createFrom({ externalName: 'ViaDefineModel' }, 'webhook' );

        expect( ObjectId.isValid( createdId )).toBe( true );

        await userModel.get( id1 );
        await userModel.get( id1 ); // second call hits cache!

        expect( aggregate ).toHaveBeenCalledOnce();
        expect( events ).toContain( 'cache:hit' );

        const propAggregate = vi.fn(() => ({ toArray: async() => [{ id: id1, title: 'StageA' }] }));
        const propCollection = { collectionName: 'users', aggregate: propAggregate };
        const stageModel = definePropertyModel<UserDBE, StageDBE, StageDTO>( models, propCollection as any,
        {
            path  : 'stages[]',
            cache : true,
            observability:
            {
                logger: ( ev ) => { events.push( `prop:${ev.type}:${ev.operation}` ) }
            }
        });

        await stageModel.get( id1 );
        await stageModel.get( id1 );

        expect( propAggregate ).toHaveBeenCalledOnce();
        expect( events ).toContain( 'prop:cache:hit' );
    });
});
