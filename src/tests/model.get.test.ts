import { describe, expect, test, vi } from 'vitest';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument & { _id: string, name: string };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-get' );
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

const tick = () => new Promise<void>( resolve => setTimeout( resolve, 0 ));

describe( 'AbstractModel get/getMany', () =>
{
    test( 'batches getMany via aggregator', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            [
                { _id: '1', name: 'Ada' },
                { _id: '2', name: 'Bob' }
            ]
        }));

        const collection =
        {
            collectionName  : 'users',
            aggregate
        };

        const models = new TestModels();
        const model = new UserModel( models, collection );

        const [ a, b ] = await Promise.all(
        [
            model.get( '1' ),
            model.get( '2' )
        ]);

        await tick();

        expect( a ).toEqual({ id: '1', name: 'Ada' });
        expect( b ).toEqual({ id: '2', name: 'Bob' });
        expect( aggregate ).toHaveBeenCalledTimes( 1 );
    });

    test( 'getMany returns null holes unless filter is true', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [{ _id: '1', name: 'Ada' }]
        }));

        const collection =
        {
            collectionName  : 'users',
            aggregate
        };

        const models = new TestModels();
        const model = new UserModel( models, collection );

        const all = await model.getMany([ '1', 'missing' ]);
        const filtered = await model.getMany([ '1', 'missing' ], { filter: true });

        expect( all ).toEqual([{ id: '1', name: 'Ada' }, null ]);
        expect( filtered ).toEqual([{ id: '1', name: 'Ada' }]);
    });

    test( 'update embeds access filter and skips pre-get', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const aggregate = vi.fn();

        class SecureUserModel extends UserModel
        {
            protected async accessFilter()
            {
                return { orgId: 'org-1' } as any;
            }
        }

        const collection =
        {
            collectionName  : 'users',
            aggregate,
            updateOne
        };

        const models = new TestModels();
        const model = new SecureUserModel( models, collection );

        const res = await model.update( '1', { name: 'X' });

        expect( res ).toEqual({ matchedCount: 1, modifiedCount: 1 });
        expect( aggregate ).not.toHaveBeenCalled();
        expect( updateOne ).toHaveBeenCalledWith(
            { $and: [{ _id: '1' }, { orgId: 'org-1' }] },
            { $set: { name: 'X' } }
        );
    });
});
