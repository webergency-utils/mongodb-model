import { describe, expect, test, vi } from 'vitest';
import { getCursor } from '../helpers/mongo.js';
import { AbstractPropertyModel } from '../property-model.js';
import { AbstractModels } from '../models.js';
import { ModelAccessDeniedError, ModelError } from '../errors.js';
import { GET_PARENT, REGISTER_MODEL } from '../symbols.js';
import type { MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type JobDBE = MongoRootDocument & { _id: string, title: string, applications: ApplicationDBE[] };
type ApplicationDBE = MongoPropertyDocument & { id: string, status: string, name: string };
type ApplicationDTO = { id: string, status: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-property-gaps' );
    }
}

class Filters
{
    byStatus( status: string )
    {
        return { filter: { status }, pipeline: null };
    }
}

function makePropertyModel( collection: any, access?: any, parentGet?: any )
{
    const models = new TestModels();

    class AppModel extends AbstractPropertyModel<JobDBE, ApplicationDBE, ApplicationDTO,
    {
        converters:
        {
            dto : { converter: ( dbe: ApplicationDBE ) => ApplicationDTO }
            dbe : { converter: ( dbe: ApplicationDBE ) => ApplicationDBE }
        }
        smartFilters: [ Filters, Filters ]
    }>
    {
        constructor()
        {
            super( models, collection, 'applications[]',
            {
                converters:
                {
                    dto : { converter: ( dbe ) => ({ id: dbe.id, status: dbe.status, name: dbe.name }) },
                    dbe : { converter: ( dbe ) => dbe }
                },
                smartFilters: new Filters(),
                access
            } as any );
        }
    }

    const model = new AppModel();

    if( parentGet )
    {
        const parent =
        {
            get     : parentGet,
            dbeID   : ( id: any ) => id,
            dtoID   : ( id: any ) => String( id )
        };

        ( models as any )[GET_PARENT] = () => parent;
        models[REGISTER_MODEL]( parent as any, 'jobs' );
        models[REGISTER_MODEL]( model as any, 'jobs', 'applications' );
    }

    return model;
}

describe( 'AbstractPropertyModel gaps', () =>
{
    test( 'list yields converted property docs and cursors', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ id: 'a1', status: 'new', name: 'Ada' }]
        }));
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });

        const result = await model.list({ smartFilter: { byStatus: 'new' }, count: true }, 'dto' );

        expect( result.items ).toEqual([{ id: 'a1', status: 'new', name: 'Ada' }]);
        expect( result.cursors.next ).toBeTypeOf( 'string' );
    });

    test( 'stream yields converted docs', async() =>
    {
        async function *gen()
        {
            yield { id: 'a1', status: 'new', name: 'Ada' };
        }

        const aggregate = vi.fn(() => gen());
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });
        const items: ApplicationDTO[] = [];

        for await( const item of model.stream({}))
        {
            items.push( item );
        }

        expect( items ).toEqual([{ id: 'a1', status: 'new', name: 'Ada' }]);
    });

    test( 'list access deny returns empty', async() =>
    {
        const model = makePropertyModel(
            { collectionName: 'jobs', aggregate: vi.fn() },
            { filters: { deny: async() => false }, defaults: { read: 'deny' } }
        );

        const result = await model.list({});

        expect( result ).toEqual({ items: [], total: undefined, cursors: {} });
    });

    test( 'create pushes into parent array', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const model = makePropertyModel(
            { collectionName: 'jobs', updateOne, aggregate: vi.fn() },
            undefined,
            async() => ({ id: 'job-1', title: 'X' })
        );

        const id = await model.create( 'job-1', { status: 'new', name: 'Ada' } as any, 'app-1' );

        expect( id ).toBe( 'app-1' );
        expect( updateOne ).toHaveBeenCalled();
    });

    test( 'create throws when parent missing', async() =>
    {
        const model = makePropertyModel(
            { collectionName: 'jobs', updateOne: vi.fn(), aggregate: vi.fn() },
            undefined,
            async() => null
        );

        await expect( model.create( 'missing', { status: 'new', name: 'Ada' } as any ) )
            .rejects.toBeInstanceOf( ModelError );
    });

    test( 'update prefixes array path', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const model = makePropertyModel({ collectionName: 'jobs', updateOne, aggregate: vi.fn() });

        const res = await model.update( 'a1', { status: 'hired' });

        expect( res.matchedRootCount ).toBe( 1 );
        expect( updateOne ).toHaveBeenCalled();
    });

    test( 'update access deny returns zeros', async() =>
    {
        const model = makePropertyModel(
            { collectionName: 'jobs', updateMany: vi.fn(), aggregate: vi.fn() },
            { filters: { deny: async() => false }, defaults: { update: 'deny' } }
        );

        expect( await model.update( 'a1', { status: 'x' }) ).toEqual(
        {
            matchedRootCount    : 0,
            modifiedRootCount   : 0
        });
    });

    test( 'getMany returns converted docs', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ id: 'a1', status: 'new', name: 'Ada' }]
        }));
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });

        const docs = await model.getMany([ 'a1', 'missing' ]);

        expect( docs[0] ).toEqual({ id: 'a1', status: 'new', name: 'Ada' });
    });

    test( 'find returns first match', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ id: 'a1', status: 'new', name: 'Ada' }]
        }));
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });

        expect( await model.find({ smartFilter: { byStatus: 'new' } }) ).toEqual(
        {
            id      : 'a1',
            status  : 'new',
            name    : 'Ada'
        });
    });

    test( 'count and aggregate', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ count: 3 }] }));
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });

        expect( await model.count([]) ).toBe( 3 );

        aggregate.mockImplementationOnce(() => ({ toArray: async() => [{ x: 1 }] }));
        expect( await model.aggregate([{ $count: 'x' }]) ).toEqual([{ x: 1 }]);
    });

    test( 'on emits query events from list', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });
        const handler = vi.fn();

        model.on( 'query', handler );
        await model.list({ count: false });
        expect( handler ).toHaveBeenCalled();
        model.off( 'query', handler );
    });

    test( 'create access deny throws', async() =>
    {
        const model = makePropertyModel(
            { collectionName: 'jobs', updateOne: vi.fn(), aggregate: vi.fn() },
            { filters: { deny: async() => false }, defaults: { create: 'deny' } },
            async() => ({ id: '1' })
        );

        await expect( model.create( '1', { status: 'new', name: 'Ada' } as any ) )
            .rejects.toBeInstanceOf( ModelAccessDeniedError );
    });

    test( 'list with prev cursor and count uses matching sort and strips cursor from count', async() =>
    {
        const docs =
        [
            { id: 'a1', status: 'new', name: 'Ada' },
            { id: 'a2', status: 'new', name: 'Grace' }
        ];
        const sort = { name: 1 as const, id: 1 as const };
        const cursor = `prev:${getCursor( docs[1], sort )}`;
        const pipelines: any[][] = [];
        let call = 0;
        const aggregate = vi.fn(( pipeline: any[] ) =>
        {
            pipelines.push( pipeline );

            return {
                toArray: async() =>
                {
                    call++;

                    return call === 1 ? [ docs[1] ] : [{ count: 2 }];
                }
            };
        });
        const model = makePropertyModel({ collectionName: 'jobs', aggregate });

        const result = await model.list(
        {
            sort,
            cursor,
            limit   : 1,
            count   : true
        },
        'dto' );

        expect( result.items ).toHaveLength( 1 );
        expect( result.total ).toBe( 2 );
        expect( result.cursors.prev ).toBeTypeOf( 'string' );

        // Count pipeline must not include the pagination cursor match
        const countPipeline = pipelines[1];
        const countMatches = ( countPipeline || [] ).filter( ( stage: any ) => stage.$match );

        expect( JSON.stringify( countMatches ) ).not.toContain( 'Grace' );
    });
});
