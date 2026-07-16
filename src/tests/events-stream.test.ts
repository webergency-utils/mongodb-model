import { describe, expect, test, vi } from 'vitest';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';
import type { ModelQueryEvent } from '../events.js';

type UserDBE = MongoRootDocument & { _id: string, name: string };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-stream' );
    }
}

class UserModel extends AbstractModel<UserDBE, UserDTO,
{
    converters:
    {
        dto : { converter: ( dbe: UserDBE ) => UserDTO }
        dbe : { converter: ( dbe: UserDBE ) => UserDBE }
    }
}>
{
    constructor( models: AbstractModels, collection: any )
    {
        super( models, collection,
        {
            converters:
            {
                dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name }) },
                dbe : { converter: ( dbe ) => dbe }
            }
        });
    }
}

describe( 'events + stream', () =>
{
    test( 'stream yields converted documents and emits query', async() =>
    {
        const docs =
        [
            { _id: '1', name: 'Ada' },
            { _id: '2', name: 'Bob' }
        ];

        async function *gen()
        {
            for( const doc of docs )
            {
                yield doc;
            }
        }

        const aggregate = vi.fn(() => gen());
        const collection = { collectionName: 'users', aggregate };
        const models = new TestModels();
        const model = new UserModel( models, collection );

        const queries: ModelQueryEvent[] = [];
        model.on( 'query', ( event ) => queries.push( event ));

        const items: UserDTO[] = [];

        for await( const item of model.stream({ filter: { name: { $exists: true } } }) )
        {
            items.push( item );
        }

        expect( items ).toEqual(
        [
            { id: '1', name: 'Ada' },
            { id: '2', name: 'Bob' }
        ]);
        expect( aggregate ).toHaveBeenCalledOnce();
        expect( queries ).toHaveLength( 1 );
        expect( queries[0].operation ).toBe( 'stream' );
        expect( queries[0].collection ).toBe( 'users' );
        expect( Array.isArray( queries[0].pipeline )).toBe( true );
    });

    test( 'on returns unsubscribe that removes handler', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: '1', name: 'Ada' }],
            [Symbol.asyncIterator]: async function *(){ yield { _id: '1', name: 'Ada' } }
        }));

        const collection = { collectionName: 'users', aggregate };
        const models = new TestModels();
        const model = new UserModel( models, collection );
        const handler = vi.fn();
        const off = model.on( 'query', handler );

        await model.get( '1' );
        expect( handler ).toHaveBeenCalledTimes( 1 );

        off();
        await model.get( '1' );
        expect( handler ).toHaveBeenCalledTimes( 1 );
    });

    test( 'list emits query event', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: '1', name: 'Ada' }]
        }));

        const collection = { collectionName: 'users', aggregate };
        const models = new TestModels();
        const model = new UserModel( models, collection );
        const handler = vi.fn();

        model.on( 'query', handler );

        const result = await model.list({});

        expect( result.items ).toEqual([{ id: '1', name: 'Ada' }]);
        expect( handler ).toHaveBeenCalledWith( expect.objectContaining({ operation: 'list', collection: 'users' }));
    });
});
