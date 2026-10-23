import { describe, expect, test, vi } from 'vitest';
import { AbstractBaseModel } from '../base-model.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import { AbstractPropertyModel } from '../property-model.js';
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

    test( 'batches same-tick get and getMany into a single aggregate query and evaluates accessFilter once per call (AE5)', async() =>
    {
        const accessSpy = vi.fn( async() => ({ orgId: 'org-1' } as any ));
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            [
                { _id: '1', name: 'Ada' },
                { _id: '2', name: 'Bob' },
                { _id: '3', name: 'Cara' }
            ]
        }));

        class TrackedAccessUserModel extends UserModel
        {
            protected async accessFilter( name: string )
            {
                return accessSpy( name );
            }
        }

        const collection =
        {
            collectionName  : 'users',
            aggregate
        };

        const models = new TestModels();
        const model = new TrackedAccessUserModel( models, collection );

        const [ first, rest ] = await Promise.all(
        [
            model.get( '1' ),
            model.getMany([ '2', '3' ])
        ]);

        await tick();

        expect( first ).toEqual({ id: '1', name: 'Ada' });
        expect( rest ).toEqual([{ id: '2', name: 'Bob' }, { id: '3', name: 'Cara' }]);
        expect( aggregate ).toHaveBeenCalledTimes( 1 );
        expect( accessSpy ).toHaveBeenCalledTimes( 2 );
    });

    test( 'both AbstractModel and AbstractPropertyModel are instances of AbstractBaseModel (R1, R2, R3)', () =>
    {
        class SubModel extends AbstractPropertyModel<any, any, any, any>
        {
            constructor( models: AbstractModels, collection: any )
            {
                super( models, collection, 'items[]',
                {
                    converters:
                    {
                        dto : { converter: ( dbe: any ) => dbe },
                        dbe : { converter: ( dbe: any ) => dbe }
                    }
                });
            }
        }

        const models = new TestModels();
        const rootModel = new UserModel( models, { collectionName: 'users' });
        const subModel = new SubModel( models, { collectionName: 'users' });

        expect( rootModel ).toBeInstanceOf( AbstractBaseModel );
        expect( subModel ).toBeInstanceOf( AbstractBaseModel );
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
            protected async accessFilter( _name: string )
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
