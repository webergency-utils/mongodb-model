import { describe, expect, test, vi } from 'vitest';
import { ModelAccessConfigError, ModelAccessDeniedError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type DocDBE = MongoRootDocument & { _id: string, orgId: string, name: string };
type DocDTO = { id: string, orgId: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-access' );
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
    }>
    {
        constructor( models: AbstractModels, c: any )
        {
            super( models, c,
            {
                converters:
                {
                    dto : { converter: ( dbe ) => ({ id: dbe._id, orgId: dbe.orgId, name: dbe.name }) },
                    dbe : { converter: ( dbe ) => dbe }
                },
                access
            });
        }
    }

    return new DocModel( new TestModels(), collection );
}

describe( 'AbstractModel named access', () =>
{
    test( 'list applies read default filter', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));

        const model = makeModel(
            { collectionName: 'docs', aggregate },
            {
                filters  : { 'org-read': async() => ({ orgId: '1' }) },
                defaults : { read: 'org-read' }
            }
        );

        await model.list({ count: false });

        const pipeline = aggregate.mock.calls[0][0] as any[];
        const match = pipeline.find(( s: any ) => s.$match );

        expect( match.$match ).toEqual( expect.objectContaining({ orgId: '1' }));
    });

    test( 'update uses update default not read', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 0, modifiedCount: 0 }));

        const model = makeModel(
            { collectionName: 'docs', updateOne, aggregate: vi.fn() },
            {
                filters:
                {
                    'org-read'   : async() => ({ orgId: '1' }),
                    'org-update' : async() => ({ orgId: '1', role: 'editor' })
                },
                defaults: { read: 'org-read', update: 'org-update' }
            }
        );

        await model.update( 'x', { name: 'n' });

        expect( updateOne ).toHaveBeenCalledWith(
            { $and: [{ _id: 'x' }, { orgId: '1', role: 'editor' }] },
            { $set: { name: 'n' } }
        );
    });

    test( 'per-call access override wins on get', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ _id: '1', orgId: '2', name: 'A' }] }));

        const model = makeModel(
            { collectionName: 'docs', aggregate },
            {
                filters:
                {
                    a: async() => ({ orgId: '1' }),
                    b: async() => ({ orgId: '2' })
                },
                defaults: { read: 'a' }
            }
        );

        await model.get( '1', { access: 'b' });

        const pipeline = aggregate.mock.calls[0][0] as any[];
        const match = pipeline.find(( s: any ) => s.$match );

        expect( JSON.stringify( match )).toContain( '"orgId":"2"' );
    });

    test( 'create denies on false without insert', async() =>
    {
        const insertOne = vi.fn();

        const model = makeModel(
            { collectionName: 'docs', insertOne },
            {
                filters  : { 'no-create': async() => false },
                defaults : { create: 'no-create' }
            }
        );

        await expect( model.create({ orgId: '1', name: 'x' } as any )).rejects.toBeInstanceOf( ModelAccessDeniedError );
        expect( insertOne ).not.toHaveBeenCalled();
    });

    test( 'bare aggregate applies access', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));

        const model = makeModel(
            { collectionName: 'docs', aggregate },
            {
                filters  : { 'org-read': async() => ({ orgId: '1' }) },
                defaults : { read: 'org-read' }
            }
        );

        await model.aggregate([{ $project: { name: 1 } }]);

        const pipeline = aggregate.mock.calls[0][0] as any[];

        expect( pipeline[0] ).toEqual({ $match: { orgId: '1' } });
    });

    test( 'unknown policy throws on list', async() =>
    {
        const model = makeModel(
            { collectionName: 'docs', aggregate: vi.fn() },
            {
                filters  : { 'org-read': async() => ({ orgId: '1' }) },
                defaults : { read: 'missing' }
            }
        );

        await expect( model.list({})).rejects.toBeInstanceOf( ModelAccessConfigError );
    });

    test( 'no access config stays unrestricted on aggregate', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ count: 1 }] }));
        const model = makeModel({ collectionName: 'docs', aggregate });

        await model.aggregate([{ $count: 'count' }]);

        expect( aggregate.mock.calls[0][0] ).toEqual([{ $count: 'count' }]);
    });
});
