import { describe, expect, test, vi } from 'vitest';
import { getCursor } from '../helpers/mongo.js';
import { ModelError } from '../errors.js';
import { AbstractModel } from '../model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type UserDBE = MongoRootDocument & { _id: string, name: string, orgId?: string };
type UserDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-model-ops' );
    }
}

function makeModel( collection: any, access?: any )
{
    class UserModel extends AbstractModel<UserDBE, UserDTO,
    {
        converters:
        {
            dto : { converter: ( dbe: UserDBE ) => UserDTO }
            dbe : { converter: ( dbe: UserDBE ) => UserDBE }
        }
    }>
    {
        constructor( models: AbstractModels, c: any )
        {
            super( models, c,
            {
                converters:
                {
                    dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name }) },
                    dbe : { converter: ( dbe ) => dbe }
                },
                access
            });
        }
    }

    return new UserModel( new TestModels(), collection );
}

describe( 'AbstractModel remaining ops', () =>
{
    test( 'createFrom without from converter throws MODEL_CONFIG_ERROR and updateOne updates single doc', async() =>
    {
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const model = makeModel({ collectionName: 'users', updateOne, aggregate: vi.fn() });

        await expect( model.createFrom({})).rejects.toMatchObject({ code: 'MODEL_CONFIG_ERROR' });
        await expect( model.createFrom({})).rejects.toBeInstanceOf( ModelError );
        await expect( model.updateOne({ filter: {} }, { name: 'x' })).resolves.toEqual(
        {
            matchedCount    : 1,
            modifiedCount   : 1
        });
    });

    test( 'updateMany applies $in match and update', async() =>
    {
        const updateMany = vi.fn( async() => ({ matchedCount: 2, modifiedCount: 2 }));
        const model = makeModel({ collectionName: 'users', updateMany, aggregate: vi.fn() });

        const res = await model.updateMany([ '1', '2' ], { name: 'X' });

        expect( res ).toEqual({ matchedCount: 2, modifiedCount: 2 });
        expect( updateMany ).toHaveBeenCalledWith(
            { _id: { $in: [ '1', '2' ] } },
            { $set: { name: 'X' } }
        );
    });

    test( 'updateMany returns zeros when access denies', async() =>
    {
        const updateMany = vi.fn();
        const model = makeModel(
            { collectionName: 'users', updateMany, aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { update: 'deny' }
            }
        );

        const res = await model.updateMany([ '1' ], { name: 'X' });

        expect( res ).toEqual({ matchedCount: 0, modifiedCount: 0 });
        expect( updateMany ).not.toHaveBeenCalled();
    });

    test( 'find returns converted first document or null', async() =>
    {
        const aggregate = vi.fn()
            .mockImplementationOnce(() => ({ toArray: async() => [{ _id: '1', name: 'Ada' }] }))
            .mockImplementationOnce(() => ({ toArray: async() => [] }));
        const model = makeModel({ collectionName: 'users', aggregate });

        expect( await model.find({ filter: { name: 'Ada' } })).toEqual({ id: '1', name: 'Ada' });
        expect( await model.find({ filter: { name: 'Nope' } })).toBeNull();
    });

    test( 'count appends $count and returns total', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ count: 3 }] }));
        const model = makeModel({ collectionName: 'users', aggregate });

        const total = await model.count([{ $match: { active: true } }]);

        expect( total ).toBe( 3 );
        expect( aggregate.mock.calls[0][0] ).toEqual(
        [
            { $match: { active: true } },
            { $count: 'count' }
        ]);
    });

    test( 'count returns 0 when empty', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));
        const model = makeModel({ collectionName: 'users', aggregate });

        expect( await model.count([])).toBe( 0 );
    });

    test( 'delete returns true/false from deletedCount', async() =>
    {
        const deleteOne = vi.fn( async() => ({ deletedCount: 1 }));
        const model = makeModel({ collectionName: 'users', deleteOne, aggregate: vi.fn() });

        expect( await model.delete( '1' )).toBe( true );
        expect( deleteOne ).toHaveBeenCalledWith({ _id: '1' });

        deleteOne.mockResolvedValueOnce({ deletedCount: 0 });

        expect( await model.delete( '2' )).toBe( false );
    });

    test( 'delete returns false when access denies', async() =>
    {
        const deleteOne = vi.fn();
        const model = makeModel(
            { collectionName: 'users', deleteOne, aggregate: vi.fn() },
            {
                filters  : { deny: async() => false },
                defaults : { delete: 'deny' }
            }
        );

        expect( await model.delete( '1' )).toBe( false );
        expect( deleteOne ).not.toHaveBeenCalled();
    });

    test( 'stream prev path reverses entries', async() =>
    {
        const docs =
        [
            { _id: '1', name: 'Ada' },
            { _id: '2', name: 'Bob' }
        ];
        const sort = { _id: 1 as const };
        const cursor = 'prev:' + getCursor( docs[1], sort );
        const aggregate = vi.fn(() => ({
            toArray: async() => docs
        }));
        const model = makeModel({ collectionName: 'users', aggregate });
        const items: UserDTO[] = [];

        for await( const item of model.stream({ cursor, sort }) )
        {
            items.push( item );
        }

        expect( items.map( i => i.id )).toEqual([ '2', '1' ]);
        expect( aggregate ).toHaveBeenCalledOnce();
    });

    test( 'aggregate with options builds pipeline via model.pipeline', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [{ n: 1 }] }));
        const model = makeModel({ collectionName: 'users', aggregate });

        const res = await model.aggregate([{ $project: { name: 1 } }], { filter: { status: 'ok' } });

        expect( res ).toEqual([{ n: 1 }]);

        const pipeline = aggregate.mock.calls[0][0] as any[];

        expect( pipeline[0].$match ).toEqual( expect.objectContaining({ status: 'ok' }));
        expect( pipeline.some( s => s.$project )).toBe( true );
    });

    test( 'aggregate bare denies to empty array', async() =>
    {
        const aggregate = vi.fn();
        const model = makeModel(
            { collectionName: 'users', aggregate },
            {
                filters  : { deny: async() => false },
                defaults : { read: 'deny' }
            }
        );

        expect( await model.aggregate([{ $limit: 1 }])).toEqual([]);
        expect( aggregate ).not.toHaveBeenCalled();
    });

    test( 'list with count false and prev cursor reverses items', async() =>
    {
        const docs =
        [
            { _id: '1', name: 'Ada' },
            { _id: '2', name: 'Bob' }
        ];
        const sort = { _id: 1 as const };
        const cursor = 'prev:' + getCursor( docs[1], sort );
        const aggregate = vi.fn(() => ({ toArray: async() => docs }));
        const model = makeModel({ collectionName: 'users', aggregate });

        const result = await model.list({ cursor, sort, count: false });

        expect( result.items.map( i => i.id )).toEqual([ '2', '1' ]);
        expect( result.total ).toBeUndefined();
    });

    test( 'updateMany, updateOne, and deleteMany execute smartFilter.pipeline and scope mutations to matched _ids (AE1, R6)', async() =>
    {
        class PipelineFilters
        {
            onlyA()
            {
                return {
                    filter   : undefined,
                    pipeline : [{ $match: { _id: 'A' } }]
                };
            }
        }

        class SmartUserModel extends AbstractModel<UserDBE, UserDTO,
        {
            converters:
            {
                dto : { converter: ( dbe: UserDBE ) => UserDTO }
                dbe : { converter: ( dbe: UserDBE ) => UserDBE }
            }
            smartFilters: PipelineFilters
        }>
        {
            constructor( models: AbstractModels, c: any )
            {
                super( models, c,
                {
                    converters:
                    {
                        dto : { converter: ( dbe ) => ({ id: dbe._id, name: dbe.name }) },
                        dbe : { converter: ( dbe ) => dbe }
                    },
                    smartFilters: new PipelineFilters()
                });
            }
        }

        const aggregate = vi.fn(() => ({ toArray: async() => [{ _id: 'A' }] }));
        const updateMany = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const updateOne = vi.fn( async() => ({ matchedCount: 1, modifiedCount: 1 }));
        const deleteMany = vi.fn( async() => ({ deletedCount: 1 }));

        const model = new SmartUserModel( new TestModels(), { collectionName: 'users', aggregate, updateMany, updateOne, deleteMany });

        await model.updateMany({ smartFilter: { onlyA: true as any } }, { name: 'Archived' });
        expect( updateMany ).toHaveBeenCalledWith(
            { _id: { $in: [ 'A' ] } },
            { $set: { name: 'Archived' } }
        );

        await model.updateOne({ smartFilter: { onlyA: true as any } }, { name: 'Single' });
        expect( updateOne ).toHaveBeenCalledWith(
            { _id: 'A' },
            { $set: { name: 'Single' } }
        );

        await model.deleteMany({ smartFilter: { onlyA: true as any } });
        expect( deleteMany ).toHaveBeenCalledWith({ _id: { $in: [ 'A' ] } });
    });

    test( 'update and updateOne return both documentBefore and documentAfter when both are true (AE4, R10)', async() =>
    {
        const findOne = vi.fn( async() => ({ _id: '1', name: 'before' }));
        const findOneAndUpdate = vi.fn( async() => ({ _id: '1', name: 'after' }));
        const model = makeModel({ collectionName: 'users', findOne, findOneAndUpdate, aggregate: vi.fn() });

        const resUpdate = await model.update( '1', { name: 'after' }, { documentBefore: true, documentAfter: true });

        expect( resUpdate ).toEqual(
        {
            matchedCount    : 1,
            modifiedCount   : 1,
            documentBefore  : { _id: '1', name: 'before' },
            documentAfter   : { _id: '1', name: 'after' }
        });

        const resUpdateOne = await model.updateOne({ _id: '1' }, { name: 'after' }, { documentBefore: true, documentAfter: true });

        expect( resUpdateOne ).toEqual(
        {
            matchedCount    : 1,
            modifiedCount   : 1,
            documentBefore  : { _id: '1', name: 'before' },
            documentAfter   : { _id: '1', name: 'after' }
        });
    });
});
