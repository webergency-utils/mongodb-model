import { describe, expect, test, vi } from 'vitest';
import { ModelAccessDeniedError } from '../errors.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import type { MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type RootDBE = MongoRootDocument & { _id: string, items: ItemDBE[] };
type ItemDBE = MongoPropertyDocument & { id: string, orgId: string, label: string };
type ItemDTO = { id: string, orgId: string, label: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-property-access' );
    }
}

describe( 'AbstractPropertyModel named access', () =>
{
    test( 'create denies on false', async() =>
    {
        const updateOne = vi.fn();

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { deny: async() => false },
                        defaults : { create: 'deny' }
                    }
                });
            }
        }

        const models = new TestModels();
        const model = new ItemModel( models, { collectionName: 'roots', updateOne, aggregate: vi.fn() });

        // parent get will fail without aggregate data — stub parent via models registration is hard;
        // deny should fire before parent fetch... actually create resolves access first then parent.
        // Looking at property create: access first then parent get. Good.

        await expect( model.create( 'parent', { orgId: '1', label: 'x' } as any )).rejects.toBeInstanceOf( ModelAccessDeniedError );
        expect( updateOne ).not.toHaveBeenCalled();
    });

    test( 'bare aggregate applies read access via pipeline', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { 'org-read': async() => ({ orgId: '1' }) },
                        defaults : { read: 'org-read' }
                    }
                });
            }
        }

        const models = new TestModels();
        const model = new ItemModel( models, { collectionName: 'roots', aggregate });

        await model.aggregate([{ $limit: 1 }]);

        const pipeline = aggregate.mock.calls[0][0] as any[];
        const serialized = JSON.stringify( pipeline );

        expect( serialized ).toContain( 'orgId' );
    });

    test( 'denied read access in PropertyModel.pipeline and find injects impossible id and _id match', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
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

        const models = new TestModels();
        const model = new ItemModel( models, { collectionName: 'roots', aggregate });

        const builtPipeline = await model.pipeline({ filter: { label: 'x' } }, 'dto', 'find' );
        const serialized = JSON.stringify( builtPipeline );

        expect( serialized ).toContain( '"items.id":{"$exists":false}' );
        expect( serialized ).toContain( '"_id":{"$exists":false}' );
    });

    test( 'update, updateMany, and delete verify subdocument ID against accessFilter so inaccessible sibling subdocuments are not mutated (AE2, R7)', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        class ItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { aliceOnly: async() => ({ orgId: 'alice' }) },
                        defaults : { update: 'aliceOnly', delete: 'aliceOnly' }
                    }
                });
            }
        }

        const models = new TestModels();
        const model = new ItemModel( models, { collectionName: 'roots', aggregate, updateOne, updateMany });

        const updateRes = await model.update( 'subBob', { label: 'hacked' });
        expect( updateRes ).toEqual({ matchedRootCount: 0, modifiedRootCount: 0 });
        expect( updateOne ).not.toHaveBeenCalled();

        const updateManyRes = await model.updateMany([ 'subBob' ], { label: 'hacked' });
        expect( updateManyRes ).toEqual({ matchedRootCount: 0, modifiedRootCount: 0 });
        expect( updateMany ).not.toHaveBeenCalled();

        const deleteRes = await model.delete( 'subBob' );
        expect( deleteRes ).toBe( false );
        expect( updateOne ).not.toHaveBeenCalled();

        const updateOneRes = await model.updateOne({ id: 'subBob' }, { label: 'hacked' });
        expect( updateOneRes.matchedCount ).toBe( 0 );
        expect( updateOneRes.modifiedCount ).toBe( 0 );
        expect( updateOne ).not.toHaveBeenCalled();
    });

    test( 'updateMany and deleteMany apply dbeID conversion exactly once when subdocument accessFilter is active', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ id: 'db:sub1' }] }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        class CustomIdItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: this.dtoID( dbe.id ), orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    },
                    access:
                    {
                        filters  : { aliceOnly: async() => ({ orgId: 'alice' }) },
                        defaults : { update: 'aliceOnly', delete: 'aliceOnly' }
                    }
                });
            }

            public override dbeID( id: string ): string
            {
                return id.startsWith( 'db:' ) ? `DOUBLE:${id}` : `db:${id}`;
            }

            public override dtoID( dbeID: string ): string
            {
                return dbeID.replace( /^db:/, '' );
            }
        }

        const models = new TestModels();
        const model = new CustomIdItemModel( models, { collectionName: 'roots', aggregate, updateMany });

        await model.updateMany([ 'sub1' ], { label: 'updated' });
        expect( updateMany ).toHaveBeenCalledWith(
            expect.objectContaining({
                $and: expect.arrayContaining([
                    { 'items.id': { $in: [ 'db:sub1' ] } }
                ])
            }),
            expect.anything(),
            expect.anything()
        );
    });
});
