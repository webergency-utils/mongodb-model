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
});
