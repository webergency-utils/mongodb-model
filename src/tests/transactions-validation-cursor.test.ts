import { describe, expect, it, vi } from 'vitest';
import
{
    AbstractModels,
    ModelValidationError,
    defineModel,
    definePropertyModel,
    executeModelValidator,
    getActiveSession,
    normalizeCursorOption
}
from '../index.js';

type RootDBE = { _id: string, name: string, age?: number, items?: Array<{ id: string, title: string }> };
type RootDTO = { id: string, name: string, age?: number };
type SubDBE = { id: string, title: string };
type SubDTO = { id: string, title: string };

function createCollectionMock( docs: any[] = [] )
{
    const cursor = ( items: any[] ) => (
    {
        toArray : vi.fn().mockResolvedValue( items ),
        next    : vi.fn(),
        close   : vi.fn().mockResolvedValue( undefined ),
        async *[Symbol.asyncIterator]()
        {
            for( const item of items )
            {
                yield item;
            }
        }
    });

    const aggregate = vi.fn().mockImplementation(() => cursor( docs ));
    const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
    const insertMany = vi.fn().mockResolvedValue({ acknowledged: true });
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const findOne = vi.fn().mockResolvedValue( docs[0] ?? null );
    const findOneAndUpdate = vi.fn().mockResolvedValue( docs[0] ?? null );

    return {
        collection:
        {
            collectionName  : 'users',
            aggregate,
            insertOne,
            insertMany,
            updateOne,
            updateMany,
            deleteOne,
            deleteMany,
            findOne,
            findOneAndUpdate
        } as any,
        spies: { aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, findOne, findOneAndUpdate }
    };
}

class TestModels extends AbstractModels
{
    constructor( config?: any, mockClient?: any )
    {
        super( 'mongodb://localhost/test-tx-val-cursor', config );

        if( mockClient )
        {
            ( this as any ).client = mockClient;
        }
    }
}

describe( 'Transactions, Validation & Keyset Cursor Pagination', () =>
{
    describe( 'Cursor normalization and nextCursor / prevCursor', () =>
    {
        it( 'normalizes cursor, after, and before options', () =>
        {
            expect( normalizeCursorOption() ).toBeUndefined();
            expect( normalizeCursorOption({}) ).toBeUndefined();
            expect( normalizeCursorOption({ cursor: 'next:abc' }) ).toBe( 'next:abc' );
            expect( normalizeCursorOption({ after: 'abc' }) ).toBe( 'next:abc' );
            expect( normalizeCursorOption({ after: 'next:abc' }) ).toBe( 'next:abc' );
            expect( normalizeCursorOption({ before: 'xyz' }) ).toBe( 'prev:xyz' );
            expect( normalizeCursorOption({ before: 'prev:xyz' }) ).toBe( 'prev:xyz' );
        });

        it( 'exposes nextCursor and prevCursor on list() results and supports after / before on list, stream, find, and aggregate', async() =>
        {
            const docs = [
                { _id: '1', name: 'Alice' },
                { _id: '2', name: 'Bob' }
            ];
            const { collection, spies } = createCollectionMock( docs );
            const models = new TestModels();
            const users = defineModel<RootDBE, RootDTO>( models, collection,
            {
                id          : () => 'new-id',
                dbeID       : id => String( id ),
                dtoID       : id => String( id ),
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            const page1 = await users.list({ limit: 2, sort: { _id: 1 } });

            expect( page1 ).toHaveLength( 2 );
            expect( page1.cursors?.next ).toBeDefined();
            expect( page1.cursors?.prev ).toBeDefined();
            expect( page1.nextCursor ).toBe( `next:${page1.cursors?.next}` );
            expect( page1.prevCursor ).toBe( `prev:${page1.cursors?.prev}` );

            // Use after (raw token without prefix) on list()
            const rawToken = page1.cursors!.next!;
            await users.list({ after: rawToken, limit: 2, sort: { _id: 1 } });
            const listAfterPipeline = spies.aggregate.mock.calls.at( -1 )![0];
            expect( JSON.stringify( listAfterPipeline ) ).toContain( '"2"' );

            // Use before on list() with count: true (verifies after/before stripped from count pipeline)
            spies.aggregate
                .mockImplementationOnce(() => ({ toArray: vi.fn().mockResolvedValue( docs ) }))
                .mockImplementationOnce(() => ({ toArray: vi.fn().mockResolvedValue([{ count: 10 }]) }));
            const pageBefore = await users.list({ before: page1.prevCursor!, count: true, sort: { _id: 1 } });
            expect( pageBefore.total ).toBe( 10 );

            // Use after on stream()
            const streamed: RootDTO[] = [];
            for await ( const item of users.stream({ after: rawToken, sort: { _id: 1 } }) )
            {
                streamed.push( item );
            }
            expect( streamed ).toHaveLength( 2 );

            // Use after on find() and before on aggregate()
            await users.find({ after: page1.nextCursor, sort: { _id: 1 } });
            const findAfterPipeline = spies.aggregate.mock.calls.at( -1 )![0];
            expect( JSON.stringify( findAfterPipeline ) ).toContain( '"2"' );

            await users.aggregate([], { before: page1.prevCursor, sort: { _id: 1 } });
            const aggBeforePipeline = spies.aggregate.mock.calls.at( -1 )![0];
            expect( JSON.stringify( aggBeforePipeline ) ).toContain( '"1"' );
        });

        it( 'supports after and before on PropertyModel list, stream, find, and aggregate', async() =>
        {
            const docs = [
                { id: 's1', title: 'First' },
                { id: 's2', title: 'Second' }
            ];
            const { collection, spies } = createCollectionMock( docs );
            const models = new TestModels();
            const items = definePropertyModel<RootDBE, SubDBE, SubDTO>( models, collection,
            {
                path        : 'items[]',
                dtoID       : id => String( id ),
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            const page = await items.list({ sort: { id: 1 } });
            expect( page.nextCursor ).toBeDefined();
            expect( page.prevCursor ).toBeDefined();

            await items.list({ before: page.prevCursor, sort: { id: 1 } });
            const prevPipeline = spies.aggregate.mock.calls.at( -1 )![0];
            expect( JSON.stringify( prevPipeline ) ).toContain( '"$lt":"s1"' );

            const out: SubDTO[] = [];
            for await ( const row of items.stream({ after: page.nextCursor, sort: { id: 1 } }) )
            {
                out.push( row );
            }
            expect( out ).toHaveLength( 2 );
        });
    });

    describe( 'Transaction session propagation and cache isolation', () =>
    {
        it( 'propagates active session via models.transaction(), bypasses cache inside transaction, and replays invalidations on commit', async() =>
        {
            const fakeSession = { id: 'sess-1' } as any;
            const endSession = vi.fn().mockResolvedValue( undefined );
            const withTransaction = vi.fn().mockImplementation( async( cb: () => Promise<any> ) => cb());
            const sessionObj = { ...fakeSession, withTransaction, endSession };
            const startSession = vi.fn().mockReturnValue( sessionObj );

            const docs = [{ _id: '1', name: 'Alice' }];
            const { collection, spies } = createCollectionMock( docs );
            const models = new TestModels({}, { startSession });

            const users = defineModel<RootDBE, RootDTO>( models, collection,
            {
                cache       : { maxSize: 100 },
                dtoID       : id => String( id ),
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });
            const items = definePropertyModel<RootDBE, SubDBE, SubDTO>( models, collection,
            {
                path        : 'items[]',
                cache       : { maxSize: 100 },
                dtoID       : id => String( id ),
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            // Prime cache outside transaction
            const cachedUser = await users.get( '1' );
            expect( cachedUser ).toEqual({ id: '1', name: 'Alice' });
            expect( spies.aggregate ).toHaveBeenCalledTimes( 1 );
            // Without session, options only has collation
            expect( spies.aggregate ).toHaveBeenLastCalledWith( expect.any( Array ), { collation: { locale: 'en' } });

            // Read from cache
            await users.get( '1' );
            expect( spies.aggregate ).toHaveBeenCalledTimes( 1 );

            await models.transaction( async( session ) =>
            {
                expect( getActiveSession() ).toBe( session );

                // Inside transaction, get() bypasses cache and forwards session
                await users.get( '1' );
                expect( spies.aggregate ).toHaveBeenCalledTimes( 2 );
                expect( spies.aggregate ).toHaveBeenLastCalledWith(
                    expect.any( Array ),
                    expect.objectContaining({ collation: { locale: 'en' }, session })
                );

                // getMany inside transaction bypasses cache and forwards session
                await users.getMany([ '1' ]);
                expect( spies.aggregate ).toHaveBeenCalledTimes( 3 );

                // find, list, count, exists, aggregate, stream inside transaction
                await users.find({ name: 'Alice' });
                await users.list({});
                await users.count({ name: 'Alice' });
                await users.exists( '1' );
                await users.aggregate({});
                for await ( const _ of users.stream({}) ) { /* drain */ }

                // Mutations inside transaction forward session
                await users.create({ name: 'Bob' }, '2' );
                expect( spies.insertOne ).toHaveBeenLastCalledWith(
                    { _id: '2', name: 'Bob' },
                    { session }
                );

                await users.createMany([{ name: 'Charlie', _id: '2' }]);
                expect( spies.insertMany ).toHaveBeenLastCalledWith(
                    [{ _id: '2', name: 'Charlie' }],
                    { session }
                );

                await users.update( '1', { name: 'Alice Updated' });
                expect( spies.updateOne ).toHaveBeenLastCalledWith(
                    { _id: '1' },
                    { $set: { name: 'Alice Updated' } },
                    { session }
                );

                await users.update( '1', { name: 'Alice Snap' }, { documentBefore: true, documentAfter: true });
                expect( spies.findOne ).toHaveBeenLastCalledWith(
                    { _id: '1' },
                    expect.objectContaining({ session })
                );
                expect( spies.findOneAndUpdate ).toHaveBeenLastCalledWith(
                    expect.any( Object ),
                    expect.any( Object ),
                    expect.objectContaining({ session })
                );

                await users.updateOne({ _id: '1' }, { name: 'Alice One' });
                await users.updateMany([ '1' ], { name: 'Alice Many' });
                await users.updateMany({ name: 'Alice' }, { name: 'Alice Filter' });
                await users.delete( '1' );
                expect( spies.deleteOne ).toHaveBeenLastCalledWith({ _id: '1' }, { session });

                await users.deleteMany([ '1' ]);
                await users.deleteMany({ name: 'Alice' });

                // PropertyModel operations inside transaction forward session
                await items.create( '1', { title: 'Sub 1' });
                await items.createMany( '1', [{ title: 'Sub 2' }]);
                await items.update( 'sub-1', { title: 'Sub Updated' }, { documentBefore: true });
                await items.updateOne({ id: 'sub-1' }, { title: 'Sub One' });
                await items.updateMany([ 'sub-1' ], { title: 'Sub Many' });
                await items.delete( 'sub-1' );
                await items.deleteMany([ 'sub-1' ]);
            });

            // After transaction commits, post-commit invalidation cleared '1' from cache
            const callsBeforePostTxGet = spies.aggregate.mock.calls.length;
            await users.get( '1' );
            expect( spies.aggregate.mock.calls.length ).toBe( callsBeforePostTxGet + 1 );
        });

        it( 'supports explicit per-call options.session without models.transaction()', async() =>
        {
            const explicitSession = { id: 'explicit-sess' } as any;
            const docs = [{ _id: '1', name: 'Alice' }];
            const { collection, spies } = createCollectionMock( docs );
            const models = new TestModels();

            const users = defineModel<RootDBE, RootDTO>( models, collection,
            {
                id          : () => '2',
                dbeID       : id => String( id ),
                dtoID       : id => String( id ),
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            await users.get( '1', { session: explicitSession });
            expect( spies.aggregate ).toHaveBeenLastCalledWith(
                expect.any( Array ),
                { collation: { locale: 'en' }, session: explicitSession }
            );

            await users.delete( '1', { session: explicitSession });
            expect( spies.deleteOne ).toHaveBeenLastCalledWith(
                { _id: '1' },
                { session: explicitSession }
            );
        });
    });

    describe( 'Runtime Validation Hook (validate + ModelValidationError)', () =>
    {
        it( 'supports function validators, Standard Schema v1, Zod-like safeParse/safeParseAsync/parse, and operation-specific maps in executeModelValidator', async() =>
        {
            const fakeModel = { _collectionLabel: 'users', collection: { collectionName: 'users' } };

            // Undefined validator returns data unchanged
            expect( await executeModelValidator( fakeModel, undefined, undefined, { name: 'A' }, 'create' )).toEqual({ name: 'A' });

            // Operation-specific map with missing key returns data unchanged
            expect( await executeModelValidator( fakeModel, { update: () => { throw new Error( 'nope' ); } }, undefined, { name: 'A' }, 'create' )).toEqual({ name: 'A' });

            // Function validator returning transformed value
            const transformed = await executeModelValidator(
                fakeModel,
                ( data: any ) => ({ ...data, name: data.name.trim() }),
                undefined,
                { name: '  Alice  ' },
                'create'
            );
            expect( transformed ).toEqual({ name: 'Alice' });

            // Function validator returning void keeps original data
            const unchanged = await executeModelValidator( fakeModel, () => undefined, undefined, { name: 'Alice' }, 'create' );
            expect( unchanged ).toEqual({ name: 'Alice' });

            // Function validator throwing error with issues array
            await expect( executeModelValidator(
                fakeModel,
                () => { throw { message: 'Custom bad', issues: [{ message: 'Bad field', path: [ 'name' ], code: 'invalid_string' }] }; },
                undefined,
                { name: '' },
                'create'
            )).rejects.toMatchObject({
                code    : 'MODEL_VALIDATION_ERROR',
                issues  : [{ message: 'Bad field', path: [ 'name' ], code: 'invalid_string' }]
            });

            // Standard Schema v1 (~standard.validate) success & failure
            const stdSchema =
            {
                '~standard':
                {
                    validate: async( val: any ) => val.name
                        ? { value: { ...val, validated: true } }
                        : { issues: [{ message: 'Name required', path: [{ key: 'name' }] }] }
                }
            };
            expect( await executeModelValidator( fakeModel, stdSchema as any, undefined, { name: 'Ok' }, 'create' )).toEqual({ name: 'Ok', validated: true });
            await expect( executeModelValidator( fakeModel, stdSchema as any, undefined, { name: '' }, 'create' )).rejects.toMatchObject({
                code    : 'MODEL_VALIDATION_ERROR',
                issues  : [{ message: 'Name required', path: [{ key: 'name' }] }]
            });

            // Zod-like safeParseAsync success & failure
            const asyncSchema =
            {
                safeParseAsync: async( val: any ) => val.age >= 0
                    ? { success: true, data: val }
                    : { success: false, error: { issues: [{ message: 'Age must be >= 0', path: [ 'age' ], code: 'too_small' }] } }
            };
            expect( await executeModelValidator( fakeModel, asyncSchema as any, undefined, { age: 10 }, 'create' )).toEqual({ age: 10 });
            await expect( executeModelValidator( fakeModel, asyncSchema as any, undefined, { age: -1 }, 'create' )).rejects.toMatchObject({
                code    : 'MODEL_VALIDATION_ERROR',
                issues  : [{ message: 'Age must be >= 0', path: [ 'age' ], code: 'too_small' }]
            });

            // Zod-like sync safeParse success & failure (including $set operator extraction on update)
            const syncSchema =
            {
                safeParse: ( val: any ) => val.name
                    ? { success: true, data: { ...val, trimmed: val.name.trim() } }
                    : { success: false, error: { issues: [{ message: 'Missing name', path: 'name' }] } }
            };
            expect( await executeModelValidator( fakeModel, syncSchema as any, undefined, { $set: { name: ' Bob ' } }, 'update' )).toEqual({
                $set: { name: ' Bob ', trimmed: 'Bob' }
            });
            // Update operator without $set bypasses schema object validation
            expect( await executeModelValidator( fakeModel, syncSchema as any, undefined, { $inc: { count: 1 } }, 'update' )).toEqual({
                $inc: { count: 1 }
            });
            await expect( executeModelValidator( fakeModel, syncSchema as any, undefined, { name: '' }, 'create' )).rejects.toMatchObject({
                code    : 'MODEL_VALIDATION_ERROR',
                issues  : [{ message: 'Missing name', path: 'name' }]
            });

            // parse()-only schema + methodValidator chaining
            const parseSchema =
            {
                parse: ( val: any ) =>
                {
                    if( !val.name ){ throw new Error( 'Parse failed' ) }

                    return { ...val, parsed: true };
                }
            };
            expect( await executeModelValidator(
                fakeModel,
                parseSchema as any,
                ( val: any ) => ({ ...val, methodValidated: true }),
                { name: 'Bob' },
                'create'
            )).toEqual({ name: 'Bob', parsed: true, methodValidated: true });
            await expect( executeModelValidator( fakeModel, parseSchema as any, undefined, { name: '' }, 'create' )).rejects.toMatchObject({
                code    : 'MODEL_VALIDATION_ERROR',
                issues  : [{ message: 'Parse failed' }]
            });
        });

        it( 'validates create, createMany, update, updateOne, and updateMany on Model and PropertyModel and emits error events on ModelValidationError', async() =>
        {
            const docs = [{ _id: '1', name: 'Alice', items: [{ id: 's1', title: 'Valid' }] }];
            const { collection, spies } = createCollectionMock( docs );
            const onError = vi.fn();
            const models = new TestModels({ observability: { onError } });

            const users = defineModel<RootDBE, RootDTO>( models, collection,
            {
                id          : () => '2',
                dbeID       : id => String( id ),
                dtoID       : id => String( id ),
                validate    :
                {
                    create: ( data ) =>
                    {
                        if( !data.name || data.name.length < 2 )
                        {
                            throw new Error( 'Name too short' );
                        }

                        return { ...data, name: data.name.trim() };
                    },
                    update: ( update ) =>
                    {
                        const setObj = ( update as any ).$set ?? update;
                        if( setObj.age !== undefined && setObj.age < 0 )
                        {
                            throw new Error( 'Invalid age' );
                        }
                    }
                },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name, age: dbe.age }) }
                }
            });

            const items = definePropertyModel<RootDBE, SubDBE, SubDTO>( models, collection,
            {
                path        : 'items[]',
                id          : () => 's2',
                dbeID       : id => String( id ),
                dtoID       : id => String( id ),
                validate    : ( data ) =>
                {
                    const title = ( data as any ).title ?? ( data as any ).$set?.title;
                    if( title === 'FORBIDDEN' )
                    {
                        throw new Error( 'Forbidden title' );
                    }
                },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            // Valid create trims name
            await users.create({ name: '  Bob  ' }, '2' );
            expect( spies.insertOne ).toHaveBeenLastCalledWith({ _id: '2', name: 'Bob' });

            // Invalid create throws ModelValidationError and emits onError
            let caughtErr: ModelValidationError | undefined;
            try
            {
                await users.create({ name: 'A' });
            }
            catch( e )
            {
                caughtErr = e as ModelValidationError;
            }
            expect( caughtErr ).toBeInstanceOf( ModelValidationError );
            expect( caughtErr?.code ).toBe( 'MODEL_VALIDATION_ERROR' );
            expect( caughtErr?.issues ).toEqual([{ message: 'Name too short' }]);
            expect( onError ).toHaveBeenCalledTimes( 1 );

            // Invalid createMany
            await expect( users.createMany([{ name: 'Valid' }, { name: 'X' }])).rejects.toBeInstanceOf( ModelValidationError );

            // Invalid update / updateOne / updateMany
            await expect( users.update( '1', { age: -5 })).rejects.toBeInstanceOf( ModelValidationError );
            await expect( users.updateOne({ _id: '1' }, { $set: { age: -1 } })).rejects.toBeInstanceOf( ModelValidationError );
            await expect( users.updateMany([ '1' ], { age: -2 })).rejects.toBeInstanceOf( ModelValidationError );
            await expect( users.updateMany({ name: 'Alice' }, { age: -3 })).rejects.toBeInstanceOf( ModelValidationError );

            // PropertyModel validation on create, createMany, update, updateMany
            await expect( items.create( '1', { title: 'FORBIDDEN' })).rejects.toBeInstanceOf( ModelValidationError );
            await expect( items.createMany( '1', [{ title: 'FORBIDDEN' }])).rejects.toBeInstanceOf( ModelValidationError );
            await expect( items.update( 's1', { title: 'FORBIDDEN' })).rejects.toBeInstanceOf( ModelValidationError );
            await expect( items.updateMany([ 's1' ], { title: 'FORBIDDEN' })).rejects.toBeInstanceOf( ModelValidationError );
        });
    });
});
