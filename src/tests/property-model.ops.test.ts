import { describe, expect, test, vi } from 'vitest';
import { ModelError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
import type { MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type RootDBE = MongoRootDocument & { _id: string, items: ItemDBE[] };
type ItemDBE = MongoPropertyDocument & { id: string, orgId: string, label: string };
type ItemDTO = { id: string, orgId: string, label: string };
type RootDTO = { id: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-property-ops' );
    }
}

function makeItemModel( collection: any, access?: any )
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
                access
            });
        }
    }

    return new ItemModel( new TestModels(), collection );
}

describe( 'AbstractPropertyModel remaining ops', () =>
{
    test( 'create throws when parent model missing', async() =>
    {
        const updateOne = vi.fn();
        const model = makeItemModel({ collectionName: 'roots', updateOne, aggregate: vi.fn() });

        await expect( model.create( 'parent-1', { orgId: '1', label: 'x' } as any )).rejects.toMatchObject(
        {
            code: 'MODEL_PARENT_NOT_FOUND'
        });
        await expect( model.create( 'parent-1', { orgId: '1', label: 'x' } as any )).rejects.toBeInstanceOf( ModelError );
        expect( updateOne ).not.toHaveBeenCalled();
    });

    test( 'create throws when parent document missing', async() =>
    {
        const models = new TestModels();
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));
        const updateOne = vi.fn();
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

        await expect( items.create( 'missing', { orgId: '1', label: 'x' } as any )).rejects.toMatchObject(
        {
            code: 'MODEL_PARENT_NOT_FOUND'
        });
        expect( updateOne ).not.toHaveBeenCalled();
    });

    test( 'updateMany updates matching property ids', async() =>
    {
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const model = makeItemModel({ collectionName: 'roots', updateMany, aggregate: vi.fn() });

        const res = await model.updateMany([ 'a', 'b' ], { label: 'z' });

        expect( res ).toEqual({ matchedRootCount: 1, modifiedRootCount: 1 });
        expect( updateMany ).toHaveBeenCalledOnce();

        const [ match, update, options ] = updateMany.mock.calls[0];

        expect( match ).toEqual({ 'items.id': { $in: [ 'a', 'b' ] } });
        expect( update ).toEqual({ $set: { 'items.$[entry].label': 'z' } });
        expect( options.arrayFilters ).toEqual([{ 'entry.id': { $in: [ 'a', 'b' ] } }]);
    });

    test( 'updateMany returns zeros when access denies', async() =>
    {
        const updateMany = vi.fn();
        const model = makeItemModel(
            { collectionName: 'roots', updateMany, aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { update: 'deny' }
            }
        );

        const res = await model.updateMany([ 'a' ], { label: 'z' });

        expect( res ).toEqual({ matchedRootCount: 0, modifiedRootCount: 0 });
        expect( updateMany ).not.toHaveBeenCalled();
    });

    test( 'find returns converted document', async() =>
    {
        const aggregate = vi.fn(() => ({
            toArray: async() => [{ id: '1', orgId: 'o', label: 'L' }]
        }));
        const model = makeItemModel({ collectionName: 'roots', aggregate });

        const found = await model.find({ filter: { label: 'L' } });

        expect( found ).toEqual({ id: '1', orgId: 'o', label: 'L' });
        expect( aggregate ).toHaveBeenCalledOnce();
    });

    test( 'find returns null when empty', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));
        const model = makeItemModel({ collectionName: 'roots', aggregate });

        expect( await model.find({ filter: {} })).toBeNull();
    });

    test( 'count returns aggregation count', async() =>
    {
        const aggregate = vi.fn()
            .mockImplementationOnce(() => ({ toArray: async() => [{ count: 4 }] }))
            .mockImplementationOnce(() => ({ toArray: async() => [] }));
        const model = makeItemModel({ collectionName: 'roots', aggregate });

        expect( await model.count([{ $match: { 'items.label': 'x' } }])).toBe( 4 );
        expect( await model.count([])).toBe( 0 );
    });

    test( 'list access deny returns empty result', async() =>
    {
        const aggregate = vi.fn();
        const model = makeItemModel(
            { collectionName: 'roots', aggregate },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        const result = await model.list({ count: true });

        expect( Array.isArray( result ) ).toBe( true );
        expect({ items: [ ...result.items ], total: result.total, cursors: result.cursors }).toEqual({ items: [], total: 0, cursors: {} });
        expect( aggregate ).not.toHaveBeenCalled();
    });

    test( 'stream access deny yields nothing', async() =>
    {
        const aggregate = vi.fn();
        const model = makeItemModel(
            { collectionName: 'roots', aggregate },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        const items: ItemDTO[] = [];

        for await( const item of model.stream({}) )
        {
            items.push( item );
        }

        expect( items ).toEqual([]);
        expect( aggregate ).not.toHaveBeenCalled();
    });

    test( 'list returns items with count', async() =>
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
        const model = makeItemModel({ collectionName: 'roots', aggregate });

        const result = await model.list({ count: true });

        expect( result.items ).toEqual([{ id: '1', orgId: 'o', label: 'A' }]);
        expect( result.total ).toBe( 1 );
        expect( result.cursors.prev ).toBeDefined();
        expect( result.cursors.next ).toBeDefined();
    });

    test( 'updateMany and deleteMany with non-ID filter invalidate resolved targetIds in cache and emit them in mutation events (R8)', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ id: 'sub1', orgId: 'o', label: 'old' }] }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));

        class CachedItemModel extends AbstractPropertyModel<RootDBE, ItemDBE, ItemDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c, 'items[]',
                {
                    cache       : true,
                    converters  :
                    {
                        dto : { converter: ( dbe: ItemDBE ) => ({ id: dbe.id, orgId: dbe.orgId, label: dbe.label }) },
                        dbe : { converter: ( dbe: ItemDBE ) => dbe }
                    }
                });
            }
        }

        const model = new CachedItemModel( new TestModels(), { collectionName: 'roots', aggregate, updateMany });
        const mutationSpy = vi.fn();
        const cacheSpy = vi.fn();

        model.on( 'mutation', mutationSpy );
        model.on( 'cache', cacheSpy );

        // Populate cache for sub1
        await model.get( 'sub1' );
        expect( cacheSpy ).toHaveBeenCalledWith( expect.objectContaining({ operation: 'set', ids: [ 'sub1' ] }));

        cacheSpy.mockClear();

        // Mutate using non-ID filter
        await model.updateMany({ label: 'old' }, { label: 'new' });

        expect( mutationSpy ).toHaveBeenCalledWith( expect.objectContaining(
        {
            operation   : 'updateMany',
            ids         : [ 'sub1' ]
        }));
        expect( cacheSpy ).toHaveBeenCalledWith( expect.objectContaining(
        {
            operation   : 'invalidate',
            ids         : [ 'sub1' ]
        }));
    });
});
