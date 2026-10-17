import { describe, expect, test, vi } from 'vitest';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { ModelError } from '../errors.js';
import type { MongoRootDocument } from '../types/external.js';

type DocDBE = MongoRootDocument & { _id: string, name: string, status: string };
type DocDTO = { id: string, name: string, status: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-model-gaps' );
    }
}

class Filters
{
    byStatus( status: string )
    {
        return { filter: { status }, pipeline: null };
    }
}

function makeModel( collection: any, access?: any )
{
    class DocModel extends AbstractModel<DocDBE, DocDTO,
    {
        converters:
        {
            dto : { converter: ( dbe: DocDBE ) => DocDTO }
            dbe : { converter: ( dbe: DocDBE ) => DocDBE }
        }
        smartFilters: Filters
    }>
    {
        constructor( models: AbstractModels, c: any )
        {
            super( models, c,
            {
                converters:
                {
                    dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name, status: dbe.status }) },
                    dbe : { converter: ( dbe ) => dbe }
                },
                smartFilters: new Filters(),
                access
            });
        }
    }

    return new DocModel( new TestModels(), collection );
}

describe( 'AbstractModel query gaps', () =>
{
    test( 'updateMany updates matching ids', async() =>
    {
        const updateMany = vi.fn( async() => ({ matchedCount: 2, modifiedCount: 2 }));
        const model = makeModel({ collectionName: 'docs', updateMany, aggregate: vi.fn() });

        const res = await model.updateMany([ '1', '2' ], { status: 'closed' });

        expect( res ).toEqual({ matchedCount: 2, modifiedCount: 2 });
        expect( updateMany ).toHaveBeenCalled();
    });

    test( 'find returns converted first document', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ _id: '1', name: 'Ada', status: 'open' }] }));
        const model = makeModel({ collectionName: 'docs', aggregate });

        const dto = await model.find({ smartFilter: { byStatus: 'open' } });

        expect( dto ).toEqual({ id: '1', name: 'Ada', status: 'open' });
    });

    test( 'count returns total', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ count: 4 }] }));
        const model = makeModel({ collectionName: 'docs', aggregate });

        expect( await model.count([]) ).toBe( 4 );
    });

    test( 'delete removes document', async() =>
    {
        const deleteOne = vi.fn( async() => ({ deletedCount: 1 }));
        const model = makeModel({ collectionName: 'docs', deleteOne, aggregate: vi.fn() });

        expect( await model.delete( '1' ) ).toBe( true );
    });

    test( 'createFrom without converter throws ModelError and updateOne updates matching document', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const model = makeModel({ collectionName: 'docs', updateOne, aggregate: vi.fn() });

        await expect( model.createFrom({}) ).rejects.toBeInstanceOf( ModelError );
        await expect( model.updateOne({}, { status: 'closed' }) ).resolves.toEqual({ matchedCount: 1, modifiedCount: 1 });
    });

    test( 'stream prev path materializes and reverses', async() =>
    {
        const docs = [{ _id: '1', name: 'A', status: 'open' }, { _id: '2', name: 'B', status: 'open' }];
        const aggregate = vi.fn(() => ({
            toArray: async() => docs,
            [Symbol.asyncIterator]: async function *(){ yield *docs }
        }));
        const model = makeModel({ collectionName: 'docs', aggregate });
        const cursor = ( await model.list({ limit: 1, count: false })).cursors.next!;
        const items: DocDTO[] = [];

        for await( const item of model.stream({ cursor: `prev:${cursor}`, limit: 2 }) )
        {
            items.push( item );
        }

        expect( items.length ).toBeGreaterThan( 0 );
    });

    test( 'aggregate returns raw docs', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ n: 1 }] }));
        const model = makeModel({ collectionName: 'docs', aggregate });

        expect( await model.aggregate([{ $count: 'n' }]) ).toEqual([{ n: 1 }]);
    });

    test( 'resolveSmartFilter and resolveComputedProperties', async() =>
    {
        const model = makeModel({ collectionName: 'docs', aggregate: vi.fn() });

        expect( await model.resolveSmartFilter({ byStatus: 'open' }) ).toEqual(
        {
            filter      : { $and: [{ status: 'open' }] },
            pipeline    : []
        });
        expect( await model.resolveComputedProperties() ).toEqual({ fields: null, pipeline: null });
    });

    test( 'update with documentAfter returns document', async() =>
    {
        const findOneAndUpdate = vi.fn( async() => ({ _id: '1', name: 'Ada', status: 'closed' }));
        const model = makeModel({ collectionName: 'docs', findOneAndUpdate, aggregate: vi.fn() });

        const res = await model.update( '1', { status: 'closed' }, { documentAfter: true });

        expect( res.documentAfter?.status ).toBe( 'closed' );
        expect( res.matchedCount ).toBe( 1 );
    });

    test( 'create with duplicateIgnore returns existing id', async() =>
    {
        const err: any = new Error( 'dup' );
        err.code = 11000;
        err.keyValue = { _id: 'existing' };

        const insertOne = vi.fn( async() => { throw err });
        const findOne = vi.fn( async() => ({ _id: 'existing' }));
        const model = makeModel({ collectionName: 'docs', insertOne, findOne, aggregate: vi.fn() });

        const id = await model.create({ name: 'x', status: 'open' } as any, undefined, { duplicateIgnore: true });

        expect( id ).toBe( 'existing' );
    });
});
