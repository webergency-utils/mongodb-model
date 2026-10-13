import { describe, expect, test, vi } from 'vitest';
import { flowExecute } from '../flow.js';
import { ModelAccessDeniedError, ModelError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument & { _id: string, name: string };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-model-coverage' );
    }
}

function makeModel( collection: any, access?: any, extras?: { smartFilters?: any, computedProperties?: any, converters?: any })
{
    class UserModel extends AbstractModel<UserDBE, UserDTO, any>
    {
        constructor( models: AbstractModels, c: any )
        {
            super( models, c,
            {
                converters:
                {
                    dto : {
                        converter           : ( dbe: UserDBE ) => ({ id: dbe._id, name: dbe.name }),
                        computedProperties  : extras?.converters?.dtoComputed
                    },
                    dbe : { converter: ( dbe: UserDBE ) => dbe }
                },
                access,
                smartFilters        : extras?.smartFilters,
                computedProperties  : extras?.computedProperties
            });
        }
    }

    return new UserModel( new TestModels(), collection );
}

describe( 'AbstractModel coverage branches', () =>
{
    test( 'off removes handler and get error emits ModelError', async() =>
    {
        const aggregate = vi.fn(() => { throw new Error( 'agg fail' ) });
        const model = makeModel({ collectionName: 'users', aggregate });
        const onError = vi.fn();
        const onQuery = vi.fn();

        model.on( 'error', onError );
        model.on( 'query', onQuery );
        model.off( 'query', onQuery );

        await expect( model.get( '1' )).rejects.toBeInstanceOf( ModelError );
        expect( onError ).toHaveBeenCalledOnce();
        expect( onQuery ).not.toHaveBeenCalled();
    });

    test( 'get rethrows ModelError from aggregator', async() =>
    {
        const aggregate = vi.fn(() => { throw new ModelError( 'MODEL_X', {}, 'x' ) });
        const model = makeModel({ collectionName: 'users', aggregate });

        await expect( model.get( '1' )).rejects.toMatchObject({ code: 'MODEL_X' });
    });

    test( 'create duplicateIgnore returns existing id', async() =>
    {
        const insertOne = vi.fn( async() => { throw Object.assign( new Error( 'dup' ), { code: 11000, keyValue: { name: 'Ada' } }) });
        const findOne = vi.fn( async() => ({ _id: 'existing' }));
        const model = makeModel({ collectionName: 'users', insertOne, findOne, aggregate: vi.fn() });

        const id = await model.create({ name: 'Ada' } as any, undefined, { duplicateIgnore: true });

        expect( id ).toBe( 'existing' );
        expect( findOne ).toHaveBeenCalledWith(
            { name: 'Ada' },
            expect.objectContaining({ projection: { _id: 1 } })
        );
    });

    test( 'create rethrows non-duplicate errors', async() =>
    {
        const insertOne = vi.fn( async() => { throw new Error( 'other' ) });
        const model = makeModel({ collectionName: 'users', insertOne, aggregate: vi.fn() });

        await expect( model.create({ name: 'Ada' } as any )).rejects.toThrow( 'other' );
    });

    test( 'update access deny and documentBefore path', async() =>
    {
        const updateOne = vi.fn();
        const findOneAndUpdate = vi.fn( async() => ({ _id: '1', name: 'Ada' }));
        const denyModel = makeModel(
            { collectionName: 'users', updateOne, aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { update: 'deny' }
            }
        );

        expect( await denyModel.update( '1', { name: 'X' })).toEqual({ matchedCount: 0, modifiedCount: 0 });
        expect( updateOne ).not.toHaveBeenCalled();

        const model = makeModel({ collectionName: 'users', findOneAndUpdate, aggregate: vi.fn() });
        const res = await model.update( '1', { name: 'X' }, { documentBefore: true });

        expect( res.documentBefore ).toEqual({ _id: '1', name: 'Ada' });
        expect( res.matchedCount ).toBe( 1 );
    });

    test( 'getMany access deny returns nulls or empty when filtered', async() =>
    {
        const model = makeModel(
            { collectionName: 'users', aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        expect( await model.getMany([ '1', '2' ])).toEqual([ null, null ]);
        expect( await model.getMany([ '1', '2' ], { filter: true })).toEqual([]);
    });

    test( 'list access deny and list with count + optimizer', async() =>
    {
        const denyModel = makeModel(
            { collectionName: 'users', aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        expect( await denyModel.list({ count: true })).toEqual({ items: [], total: 0, cursors: {} });

        let call = 0;
        const aggregate = vi.fn(() =>
        ({
            toArray: async() =>
            {
                call++;

                return call === 1 ? [{ _id: '1', name: 'Ada' }] : [{ count: 1 }];
            }
        }));
        const model = makeModel(
            { collectionName: 'users', aggregate },
            undefined,
            {
                computedProperties:
                {
                    full: async() => ({ fields: { full: 1 }, pipeline: [] })
                },
                converters: { dtoComputed: [ 'full' ] }
            }
        );

        await flowExecute( async() =>
        {
            const result = await model.list({ sort: { name: 1 }, count: true, countLimit: 5 });

            expect( result.items ).toEqual([{ id: '1', name: 'Ada' }]);
            expect( result.total ).toBe( 1 );
        },
        { experimentalFlags: { 'query-optimizer': true } });
    });

    test( 'stream access deny and empty stream emits query', async() =>
    {
        const denyModel = makeModel(
            { collectionName: 'users', aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        const denied: unknown[] = [];

        for await( const row of denyModel.stream({}) )
        {
            denied.push( row );
        }

        expect( denied ).toEqual([]);

        async function *empty()
        {
            // no yields
        }

        const aggregate = vi.fn(() => empty());
        const model = makeModel({ collectionName: 'users', aggregate });
        const onQuery = vi.fn();

        model.on( 'query', onQuery );

        const items: unknown[] = [];

        for await( const row of model.stream({}) )
        {
            items.push( row );
        }

        expect( items ).toEqual([]);
        expect( onQuery ).toHaveBeenCalledWith( expect.objectContaining({ operation: 'stream' }));
    });

    test( 'stream with smartFilter sort without _id and optimizer', async() =>
    {
        async function *gen()
        {
            yield { _id: '1', name: 'Ada' };
        }

        const aggregate = vi.fn(() => gen());
        const model = makeModel(
            { collectionName: 'users', aggregate },
            undefined,
            {
                smartFilters:
                {
                    byName: async( name: string ) => ({ filter: { name } })
                }
            }
        );

        const items: UserDTO[] = [];

        await flowExecute( async() =>
        {
            for await( const row of model.stream({ sort: { name: 1 }, smartFilter: { byName: 'Ada' } }) )
            {
                items.push( row );
            }
        },
        { experimentalFlags: { 'query-optimizer': true } });

        expect( items ).toEqual([{ id: '1', name: 'Ada' }]);
    });

    test( 'stream rethrows non-access errors', async() =>
    {
        const model = makeModel(
            { collectionName: 'users', aggregate: vi.fn() },
            {
                filters  : { bad: async() => { throw new TypeError( 'stream-boom' ) } },
                defaults : { read: 'bad' }
            }
        );

        await expect( model.stream({}).next()).rejects.toThrow( 'stream-boom' );
    });

    test( 'aggregate and count honor query-optimizer flag', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ count: 2 }] }));
        const model = makeModel({ collectionName: 'users', aggregate });

        await flowExecute( async() =>
        {
            expect( await model.count([{ $match: { a: 1 } }])).toBe( 2 );
            expect( await model.aggregate([{ $limit: 1 }], { filter: { a: 1 } })).toEqual([{ count: 2 }]);
        },
        { experimentalFlags: { 'query-optimizer': true } });
    });

    test( 'list rethrows non-access errors from access resolve', async() =>
    {
        const model = makeModel(
            { collectionName: 'users', aggregate: vi.fn() },
            {
                filters  : { bad: async() => { throw new TypeError( 'boom' ) } },
                defaults : { read: 'bad' }
            }
        );

        await expect( model.list({})).rejects.toThrow( 'boom' );
        await expect( model.list({})).rejects.not.toBeInstanceOf( ModelAccessDeniedError );
    });

    test( 'ensureOpen and accessFilter hooks are callable', async() =>
    {
        class HookModel extends AbstractModel<UserDBE, UserDTO, any>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c,
                {
                    converters:
                    {
                        dto : { converter: ( dbe: UserDBE ) => ({ id: dbe._id, name: dbe.name }) },
                        dbe : { converter: ( dbe: UserDBE ) => dbe }
                    }
                });
            }

            public ping()
            {
                this.ensureOpen();

                return this.accessFilter( 'default' );
            }
        }

        const model = new HookModel( new TestModels(), { collectionName: 'users', aggregate: vi.fn() });

        await expect( model.ping() ).resolves.toBeUndefined();
    });
});
