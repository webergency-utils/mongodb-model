import { describe, expect, it, vi } from 'vitest';
import
{
    AbstractModel,
    AbstractModels,
    AbstractPropertyModel,
    defineModel,
    definePropertyModel,
    defaultIndexName,
    normalizeModelIndexes,
    resolveTimestampsConfig,
    resolveSoftDeleteConfig
}
from '../index.js';

type UserDBE =
{
    _id         : string
    name        : string
    role?       : string
    createdAt?  : Date
    updatedAt?  : Date
    deleted?    : boolean
    deletedAt?  : Date | null
    items?      : Array<ItemDBE>
};

type UserDTO =
{
    id      : string
    name    : string
    role?   : string
};

type ItemDBE =
{
    id          : string
    title       : string
    tag?        : string
    createdAt?  : Date
    updatedAt?  : Date
    deleted?    : boolean
    deletedAt?  : Date | null
};

type ItemDTO =
{
    id      : string
    title   : string
    tag?    : string
};

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
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const findOne = vi.fn().mockResolvedValue( docs[0] ?? null );
    const findOneAndUpdate = vi.fn().mockResolvedValue( docs[0] ?? null );
    const bulkWrite = vi.fn().mockResolvedValue({
        insertedCount   : 1,
        matchedCount    : 1,
        modifiedCount   : 1,
        deletedCount    : 1,
        upsertedCount   : 0,
        upsertedIds     : {}
    });
    const indexes = vi.fn().mockResolvedValue([{ name: '_id_', key: { _id: 1 } }]);
    const createIndexes = vi.fn().mockResolvedValue([ 'idx_1' ]);
    const dropIndex = vi.fn().mockResolvedValue({ ok: 1 });

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
            findOneAndUpdate,
            bulkWrite,
            indexes,
            createIndexes,
            dropIndex
        } as any,
        spies:
        {
            aggregate,
            insertOne,
            insertMany,
            updateOne,
            updateMany,
            deleteOne,
            deleteMany,
            findOne,
            findOneAndUpdate,
            bulkWrite,
            indexes,
            createIndexes,
            dropIndex
        },
        cursor
    };
}

class TestModels extends AbstractModels
{
    constructor( config?: any, mockClient?: any )
    {
        super( 'mongodb://localhost/test-features', config );

        if( mockClient )
        {
            ( this as any ).client = mockClient;
        }
    }
}

describe( 'Timestamps, Soft Delete, Upsert, Distinct, Hooks, Indexes & BulkWrite', () =>
{
    describe( 'Helper config resolvers & index normalization', () =>
    {
        it( 'resolves timestamps and softDelete configurations and normalizes index definitions', () =>
        {
            expect( resolveTimestampsConfig( undefined ) ).toBeUndefined();
            expect( resolveTimestampsConfig( false ) ).toBeUndefined();
            expect( resolveTimestampsConfig( true ) ).toEqual({ createdAt: 'createdAt', updatedAt: 'updatedAt' });
            expect( resolveTimestampsConfig({ createdAt: 'createdOn', updatedAt: false }) ).toEqual({ createdAt: 'createdOn', updatedAt: undefined });
            expect( resolveTimestampsConfig({ createdAt: false, updatedAt: false }) ).toBeUndefined();

            expect( resolveSoftDeleteConfig( undefined ) ).toBeUndefined();
            expect( resolveSoftDeleteConfig( false ) ).toBeUndefined();
            expect( resolveSoftDeleteConfig( true ) ).toEqual({ field: 'deleted', deletedAtField: 'deletedAt' });
            expect( resolveSoftDeleteConfig({ field: 'deleted', deletedAtField: 'deletedAt' }) ).toEqual({ field: 'deleted', deletedAtField: 'deletedAt' });
            expect( resolveSoftDeleteConfig({ field: 'isDeleted', deletedAtField: false }) ).toEqual({ field: 'isDeleted', deletedAtField: undefined });

            expect( defaultIndexName({ email: 1, createdAt: -1 }) ).toBe( 'email_1_createdAt_-1' );

            const normalized = normalizeModelIndexes([
                { email: 1 },
                { key: { role: 1, name: -1 }, unique: true },
                { keys: { tag: 1 }, options: { sparse: true, name: 'custom_tag' } }
            ], 'items' );

            expect( normalized ).toEqual([
                {
                    key     : { 'items.email': 1 },
                    name    : 'items.email_1',
                    options : { name: 'items.email_1' }
                },
                {
                    key     : { 'items.role': 1, 'items.name': -1 },
                    name    : 'items.role_1_items.name_-1',
                    options : { name: 'items.role_1_items.name_-1', unique: true }
                },
                {
                    key     : { 'items.tag': 1 },
                    name    : 'custom_tag',
                    options : { name: 'custom_tag', sparse: true }
                }
            ]);
        });
    });

    describe( 'Lifecycle Timestamps', () =>
    {
        it( 'automatically sets createdAt and updatedAt on Model create, createMany, update, updateOne, updateMany, and upsert', async() =>
        {
            const { collection, spies } = createCollectionMock([{ _id: '1', name: 'Alice' }]);
            const models = new TestModels();
            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                timestamps  : true,
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            await users.create({ name: 'Alice' }, 'u-1' );
            const insertedDoc = spies.insertOne.mock.calls[0][0];

            expect( insertedDoc.createdAt ).toBeInstanceOf( Date );
            expect( insertedDoc.updatedAt ).toBeInstanceOf( Date );

            await users.createMany([{ name: 'Bob' }]);
            const insertedManyDoc = spies.insertMany.mock.calls[0][0][0];

            expect( insertedManyDoc.createdAt ).toBeInstanceOf( Date );
            expect( insertedManyDoc.updatedAt ).toBeInstanceOf( Date );

            await users.update( 'u-1', { name: 'Alice 2' });
            const updateArg = spies.updateOne.mock.calls[0][1];

            expect( updateArg.$set.name ).toBe( 'Alice 2' );
            expect( updateArg.$set.updatedAt ).toBeInstanceOf( Date );

            await users.updateOne({ name: 'Alice 2' }, { $set: { role: 'admin' } });
            const updateOneArg = spies.updateOne.mock.calls[1][1];

            expect( updateOneArg.$set.role ).toBe( 'admin' );
            expect( updateOneArg.$set.updatedAt ).toBeInstanceOf( Date );

            await users.updateMany([ 'u-1' ], { role: 'member' });
            const updateManyArg = spies.updateMany.mock.calls[0][1];

            expect( updateManyArg.$set.role ).toBe( 'member' );
            expect( updateManyArg.$set.updatedAt ).toBeInstanceOf( Date );
        });

        it( 'automatically sets createdAt and updatedAt on PropertyModel create, createMany, update, updateOne, and updateMany', async() =>
        {
            const { collection, spies } = createCollectionMock([{ _id: 'u-1', id: 'item-1', name: 'Alice', title: 'First' }]);
            const models = new TestModels();
            defineModel<UserDBE, UserDTO>( models, collection,
            {
                converters: { dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) } }
            });
            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path        : 'items[]',
                timestamps  : { createdAt: 'createdAt', updatedAt: 'updatedAt' },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            await items.create( 'u-1', { title: 'Task 1' }, 'item-1' );
            const pushCall = spies.updateOne.mock.calls[0][1];

            expect( pushCall.$push.items.createdAt ).toBeInstanceOf( Date );
            expect( pushCall.$push.items.updatedAt ).toBeInstanceOf( Date );

            await items.createMany( 'u-1', [{ title: 'Task 2' }]);
            const pushManyCall = spies.updateOne.mock.calls[1][1];

            expect( pushManyCall.$push.items.$each[0].createdAt ).toBeInstanceOf( Date );
            expect( pushManyCall.$push.items.$each[0].updatedAt ).toBeInstanceOf( Date );

            await items.update( 'item-1', { title: 'Task 1 Updated' });
            const updateCall = spies.updateOne.mock.calls[2][1];

            expect( updateCall.$set['items.$[entry].title'] ).toBe( 'Task 1 Updated' );
            expect( updateCall.$set['items.$[entry].updatedAt'] ).toBeInstanceOf( Date );
        });
    });

    describe( 'Soft Delete, Restore & Hard Delete', () =>
    {
        it( 'filters out soft-deleted records by default, supports includeDeleted, restore, restoreMany, hardDelete, and hardDeleteMany on Model', async() =>
        {
            const { collection, spies } = createCollectionMock([{ _id: 'u-1', name: 'Alice' }]);
            const models = new TestModels();
            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                timestamps  : true,
                softDelete  : { field: 'deletedAt', deletedAtField: 'deletedAt' },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            // Read queries include deletedAt: { $in: [ null, false ] } by default
            await users.list({ filter: { name: 'Alice' } });
            const listPipelineDefault = spies.aggregate.mock.calls[0][0];

            expect( JSON.stringify( listPipelineDefault ) ).toContain( '"deletedAt":{"$in":[null,false]}' );

            // includeDeleted: true omits soft-delete filter
            await users.list({ filter: { name: 'Alice' }, includeDeleted: true });
            const listPipelineWithDeleted = spies.aggregate.mock.calls[1][0];

            expect( JSON.stringify( listPipelineWithDeleted ) ).not.toContain( 'deletedAt' );

            // Soft delete(id) updates deletedAt instead of calling deleteOne
            const deleted = await users.delete( 'u-1' );

            expect( deleted ).toBe( true );
            expect( spies.deleteOne ).not.toHaveBeenCalled();
            expect( spies.updateOne ).toHaveBeenCalledTimes( 1 );
            expect( spies.updateOne.mock.calls[0][1].$set.deletedAt ).toBeInstanceOf( Date );
            expect( spies.updateOne.mock.calls[0][1].$set.updatedAt ).toBeInstanceOf( Date );

            // Soft deleteMany updates deletedAt via updateMany
            const deletedCount = await users.deleteMany([ 'u-1' ]);

            expect( deletedCount ).toBe( 1 );
            expect( spies.deleteMany ).not.toHaveBeenCalled();
            expect( spies.updateMany ).toHaveBeenCalledTimes( 1 );
            expect( spies.updateMany.mock.calls[0][1].$set.deletedAt ).toBeInstanceOf( Date );

            // restore(id) resets deletedAt to null
            const restored = await users.restore( 'u-1' );

            expect( restored ).toBe( true );
            const restoreCall = spies.updateOne.mock.calls[1];

            expect( restoreCall[1].$set.deletedAt ).toBeNull();

            // restoreMany resets deletedAt to null
            const restoredCount = await users.restoreMany([ 'u-1' ]);

            expect( restoredCount ).toBe( 1 );
            const restoreManyCall = spies.updateMany.mock.calls[1];

            expect( restoreManyCall[1].$set.deletedAt ).toBeNull();

            // hardDelete and delete(..., { hard: true }) perform physical deleteOne
            await users.hardDelete( 'u-1' );
            expect( spies.deleteOne ).toHaveBeenCalledTimes( 1 );

            await users.delete( 'u-1', { hard: true });
            expect( spies.deleteOne ).toHaveBeenCalledTimes( 2 );

            // hardDeleteMany performs physical deleteMany
            await users.hardDeleteMany([ 'u-1' ]);
            expect( spies.deleteMany ).toHaveBeenCalledTimes( 1 );
        });

        it( 'supports boolean + deletedAtField softDelete on PropertyModel with delete, restore, restoreMany, and hardDelete', async() =>
        {
            const { collection, spies } = createCollectionMock([{ id: 'item-1', title: 'Sub' }]);
            const models = new TestModels();
            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path        : 'items[]',
                softDelete  : { field: 'deleted', deletedAtField: 'deletedAt' },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            await items.list();
            expect( JSON.stringify( spies.aggregate.mock.calls[0][0] ) ).toContain( '"items.deleted":{"$in":[null,false]}' );

            await items.list({ includeDeleted: true });
            expect( JSON.stringify( spies.aggregate.mock.calls[1][0] ) ).not.toContain( 'items.deleted' );

            // Soft delete on PropertyModel sets items.$[entry].deleted = true and items.$[entry].deletedAt = Date
            const softDel = await items.delete( 'item-1' );

            expect( softDel ).toBe( true );
            expect( spies.updateOne.mock.calls[0][1].$set['items.$[entry].deleted'] ).toBe( true );
            expect( spies.updateOne.mock.calls[0][1].$set['items.$[entry].deletedAt'] ).toBeInstanceOf( Date );

            // Restore on PropertyModel sets items.$[entry].deleted = false and items.$[entry].deletedAt = null
            const restored = await items.restore( 'item-1' );

            expect( restored ).toBe( true );
            const restoreUpdate = spies.updateOne.mock.calls[1][1];

            expect( restoreUpdate.$set['items.$[entry].deleted'] ).toBe( false );
            expect( restoreUpdate.$set['items.$[entry].deletedAt'] ).toBeNull();

            // restoreMany on PropertyModel
            const restoredMany = await items.restoreMany([ 'item-1' ]);

            expect( restoredMany ).toBe( 1 );

            // hardDelete on PropertyModel uses $pull
            await items.hardDelete( 'item-1' );
            const pullUpdate = spies.updateOne.mock.calls[2][1];

            expect( pullUpdate.$pull ).toBeDefined();

            // hardDeleteMany on PropertyModel uses $pull with $in
            await items.hardDeleteMany([ 'item-1' ]);
            const pullManyUpdate = spies.updateMany.mock.calls[1][1];

            expect( pullManyUpdate.$pull ).toBeDefined();
        });
    });

    describe( 'Atomic Upsert & Distinct', () =>
    {
        it( 'supports upsert (both insert and update paths) and distinct on Model', async() =>
        {
            const { collection, spies, cursor } = createCollectionMock([{ _id: 'existing-id', name: 'Alice', role: 'admin' }]);
            const models = new TestModels();
            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                timestamps  : true,
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name, role: dbe.role }) }
                }
            });

            // 1. Upsert when existing document matches
            const updateRes = await users.upsert({ name: 'Alice' }, { role: 'superadmin' }, { documentAfter: true });

            expect( updateRes.created ).toBe( false );
            expect( updateRes.upserted ).toBe( false );
            expect( updateRes.matchedCount ).toBe( 1 );
            expect( updateRes.id ).toBe( 'existing-id' );

            // 2. Upsert when no document matches -> inserts with generated ID
            spies.updateOne.mockResolvedValueOnce({
                matchedCount    : 0,
                modifiedCount   : 0,
                upsertedCount   : 1,
                upsertedId      : 'generated-id'
            });

            const insertRes = await users.upsert({ name: 'NewUser' }, { role: 'guest' }, { id: 'generated-id' });

            expect( insertRes.created ).toBe( true );
            expect( insertRes.upserted ).toBe( true );
            expect( insertRes.upsertedCount ).toBe( 1 );
            expect( insertRes.upsertedId ).toBe( 'generated-id' );
            expect( insertRes.id ).toBe( 'generated-id' );

            const upsertArgs = spies.updateOne.mock.calls[0];

            expect( upsertArgs[2] ).toEqual({ upsert: true });
            expect( upsertArgs[1].$setOnInsert._id ).toBe( 'generated-id' );
            expect( upsertArgs[1].$setOnInsert.createdAt ).toBeInstanceOf( Date );
            expect( upsertArgs[1].$set.updatedAt ).toBeInstanceOf( Date );

            // 3. distinct() returns unique non-undefined values via aggregation pipeline
            spies.aggregate.mockImplementationOnce(() => cursor([{ _id: 'admin' }, { _id: 'guest' }]));
            const roles = await users.distinct( 'role', { name: { $exists: true } });

            expect( roles ).toEqual([ 'admin', 'guest' ]);
            const distinctPipeline = spies.aggregate.mock.calls.at( -1 )![0];

            expect( distinctPipeline.at( -1 ) ).toEqual({ $group: { _id: '$role' } });
        });

        it( 'supports upsert and distinct on PropertyModel', async() =>
        {
            const { collection, spies, cursor } = createCollectionMock([{ _id: 'u-1', id: 'item-1', name: 'Alice', title: 'Existing', tag: 'a' }]);
            const models = new TestModels();
            defineModel<UserDBE, UserDTO>( models, collection,
            {
                converters: { dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) } }
            });
            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path        : 'items[]',
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title, tag: dbe.tag }) }
                }
            });

            // 1. Upsert existing subdocument
            const updated = await items.upsert( 'u-1', { title: 'Existing' }, { tag: 'updated' });

            expect( updated.created ).toBe( false );
            expect( updated.upserted ).toBe( false );
            expect( updated.id ).toBe( 'item-1' );
            expect( updated.matchedCount ).toBe( 1 );

            // 2. Upsert missing subdocument -> calls create under parent
            spies.aggregate.mockImplementationOnce(() => cursor([]));
            const inserted = await items.upsert( 'u-1', { title: 'Fresh' }, { $set: { tag: 'new', id: 'new-item-id' }, $setOnInsert: { title: 'Fresh' } });

            expect( inserted.created ).toBe( true );
            expect( inserted.upserted ).toBe( true );
            expect( inserted.upsertedId ).toBe( 'new-item-id' );
            expect( inserted.id ).toBe( 'new-item-id' );

            // 3. distinct() on PropertyModel
            spies.aggregate.mockImplementationOnce(() => cursor([{ _id: 'a' }, { _id: 'b' }]));
            const tags = await items.distinct( 'tag' );

            expect( tags ).toEqual([ 'a', 'b' ]);
        });
    });

    describe( 'Lifecycle Hooks & Transaction Post-Commit Callbacks', () =>
    {
        it( 'executes before/after hooks, supports payload transformation, and defers afterCommit inside transactions', async() =>
        {
            const { collection } = createCollectionMock([{ _id: 'u-1', name: 'Alice' }]);
            const order: string[] = [];
            const mockSession =
            {
                withTransaction : vi.fn( async( fn: () => Promise<any> ) =>
                {
                    const res = await fn();
                    order.push( 'tx:committed' );

                    return res;
                }),
                endSession      : vi.fn().mockResolvedValue( undefined )
            };
            const models = new TestModels( undefined, { startSession: vi.fn().mockReturnValue( mockSession ) });

            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                hooks:
                {
                    beforeCreate: ( ctx ) =>
                    {
                        order.push( `beforeCreate:${ctx.method}` );
                        ctx.afterCommit(() =>
                        {
                            order.push( 'afterCommit:beforeCreate' );
                        });

                        return { ...( ctx.data as any ), role: 'hooked-role' };
                    },
                    afterCreate: ( ctx ) =>
                    {
                        order.push( `afterCreate:${ctx.id}` );
                        ctx.afterCommit(() =>
                        {
                            order.push( 'afterCommit:afterCreate' );
                        });
                    },
                    beforeUpdate: ( ctx ) =>
                    {
                        order.push( `beforeUpdate:${ctx.method}` );
                    },
                    afterUpdate: ( ctx ) =>
                    {
                        order.push( `afterUpdate:${ctx.method}:${ctx.modifiedCount}` );
                    },
                    beforeDelete: ( ctx ) =>
                    {
                        order.push( `beforeDelete:${ctx.method}` );
                    },
                    afterDelete: ( ctx ) =>
                    {
                        order.push( `afterDelete:${ctx.method}:${ctx.deletedCount}` );
                    }
                },
                converters:
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name, role: dbe.role }) }
                }
            });

            // Outside transaction: afterCommit runs immediately after the mutation
            await users.create({ name: 'Outside' }, 'u-1' );
            expect( order ).toEqual([
                'beforeCreate:create',
                'afterCreate:u-1',
                'afterCommit:beforeCreate',
                'afterCommit:afterCreate'
            ]);

            order.length = 0;

            // Inside transaction: afterCommit runs only AFTER transaction commits
            await models.transaction( async() =>
            {
                await users.create({ name: 'Inside' }, 'u-1' );
                order.push( 'tx:body-after-create' );
            });

            expect( order ).toEqual([
                'beforeCreate:create',
                'afterCreate:u-1',
                'tx:body-after-create',
                'tx:committed',
                'afterCommit:beforeCreate',
                'afterCommit:afterCreate'
            ]);

            order.length = 0;
            await users.update( 'u-1', { name: 'Updated' });
            await users.delete( 'u-1' );

            expect( order ).toEqual([
                'beforeUpdate:update',
                'afterUpdate:update:1',
                'beforeDelete:delete',
                'afterDelete:delete:1'
            ]);
        });
    });

    describe( 'Declarative Index Management & syncIndexes()', () =>
    {
        it( 'synchronizes Model and PropertyModel indexes on a shared collection and supports dryRun and dropObsolete', async() =>
        {
            const { collection, spies } = createCollectionMock();
            spies.indexes.mockResolvedValue([
                { name: '_id_', key: { _id: 1 } },
                { name: 'name_1', key: { name: 1 } },
                { name: 'obsolete_1', key: { obsolete: 1 } }
            ]);

            const models = new TestModels();
            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                indexes: [
                    { name: 1 },
                    { key: { role: 1 }, unique: true }
                ],
                converters:
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path    : 'items[]',
                indexes : [
                    { title: 1 }
                ],
                converters:
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            expect( items ).toBeDefined();

            // 1. Dry-run with dropObsolete: true calculates plan without mutating MongoDB
            const dryResult = await users.syncIndexes({ dryRun: true, dropObsolete: true });

            expect( dryResult ).toEqual({
                collection  : 'users',
                created     : [ 'role_1', 'items.title_1' ],
                existing    : [ 'name_1' ],
                unchanged   : [ 'name_1' ],
                dropped     : [ 'obsolete_1' ]
            });
            expect( spies.createIndexes ).not.toHaveBeenCalled();
            expect( spies.dropIndex ).not.toHaveBeenCalled();

            // 2. Live sync via models.syncIndexes({ dropObsolete: true })
            const allResults = await models.syncIndexes({ dropObsolete: true });

            expect( allResults ).toHaveLength( 1 );
            expect( allResults[0].created ).toEqual([ 'role_1', 'items.title_1' ]);
            expect( allResults[0].dropped ).toEqual([ 'obsolete_1' ]);
            expect( spies.createIndexes ).toHaveBeenCalledTimes( 2 );
            expect( spies.dropIndex ).toHaveBeenCalledWith( 'obsolete_1' );
        });
    });

    describe( 'Bulk Operations (bulkWrite)', () =>
    {
        it( 'executes mixed bulkWrite operations on Model with timestamps, softDelete, hooks, and cache invalidation', async() =>
        {
            const { collection, spies } = createCollectionMock([{ _id: 'u-2', name: 'Bob' }]);
            const models = new TestModels();
            const hookCalls: string[] = [];

            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                timestamps  : true,
                softDelete  : { field: 'deletedAt', deletedAtField: 'deletedAt' },
                hooks       :
                {
                    beforeCreate    : () => { hookCalls.push( 'beforeCreate' ) },
                    beforeUpdate    : () => { hookCalls.push( 'beforeUpdate' ) },
                    beforeDelete    : () => { hookCalls.push( 'beforeDelete' ) },
                    afterCreate     : () => { hookCalls.push( 'afterCreate' ) },
                    afterUpdate     : () => { hookCalls.push( 'afterUpdate' ) },
                    afterDelete     : () => { hookCalls.push( 'afterDelete' ) }
                },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            spies.bulkWrite.mockResolvedValueOnce({
                insertedCount   : 1,
                matchedCount    : 3,
                modifiedCount   : 3,
                deletedCount    : 1,
                upsertedCount   : 1,
                upsertedIds     : { 3: 'u-upserted' }
            });

            const res = await users.bulkWrite([
                { create: { name: 'NewUser' }, id: 'u-1' },
                { update: { id: 'u-2', update: { name: 'Bob Updated' } } },
                { updateMany: { filter: [ 'u-2' ], update: { role: 'user' } } },
                { upsert: { filter: { name: 'Upserted' }, update: { role: 'guest' } } },
                { delete: { id: 'u-2' } },
                { delete: { id: 'u-3', hard: true } }
            ]);

            expect( res.insertedCount ).toBe( 1 );
            expect( res.insertedIds ).toEqual([ 'u-1' ]);
            expect( res.upsertedCount ).toBe( 1 );
            expect( res.upsertedIds ).toEqual({ 3: 'u-upserted' });
            expect( spies.bulkWrite ).toHaveBeenCalledTimes( 1 );

            const rawOps = spies.bulkWrite.mock.calls[0][0];

            expect( rawOps ).toHaveLength( 6 );
            expect( rawOps[0].insertOne.document._id ).toBe( 'u-1' );
            expect( rawOps[0].insertOne.document.createdAt ).toBeInstanceOf( Date );
            expect( rawOps[1].updateOne.update.$set.name ).toBe( 'Bob Updated' );
            expect( rawOps[2].updateMany.update.$set.role ).toBe( 'user' );
            expect( rawOps[3].updateOne.upsert ).toBe( true );
            // Soft delete in op #4 becomes an updateOne setting deletedAt
            expect( rawOps[4].updateOne.update.$set.deletedAt ).toBeInstanceOf( Date );
            // Hard delete in op #5 becomes a physical deleteOne
            expect( rawOps[5].deleteOne ).toBeDefined();

            expect( hookCalls ).toContain( 'beforeCreate' );
            expect( hookCalls ).toContain( 'beforeUpdate' );
            expect( hookCalls ).toContain( 'beforeDelete' );
            expect( hookCalls ).toContain( 'afterCreate' );
            expect( hookCalls ).toContain( 'afterUpdate' );
            expect( hookCalls ).toContain( 'afterDelete' );
        });

        it( 'executes mixed bulkWrite operations on PropertyModel', async() =>
        {
            const { collection } = createCollectionMock([{ _id: 'u-1', id: 'item-1', name: 'Alice', title: 'One' }]);
            const models = new TestModels();
            defineModel<UserDBE, UserDTO>( models, collection,
            {
                converters: { dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) } }
            });
            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path        : 'items[]',
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            const res = await items.bulkWrite([
                { create: { parentID: 'u-1', data: { title: 'Created' }, id: 'item-new' } },
                { update: { id: 'item-1', update: { title: 'Updated' } } },
                { updateOne: { filter: { title: 'Updated' }, update: { tag: 'v1' } } },
                { updateMany: { filter: [ 'item-1' ], update: { tag: 'v2' } } },
                { delete: { id: 'item-1' } },
                { deleteOne: { filter: { title: 'Updated' } } },
                { deleteMany: { filter: [ 'item-1' ] } }
            ]);

            expect( res.insertedCount ).toBe( 1 );
            expect( res.insertedIds ).toEqual([ 'item-new' ]);
            expect( res.matchedCount ).toBe( 3 );
            expect( res.modifiedCount ).toBe( 3 );
            expect( res.deletedCount ).toBe( 3 );
        });
    });

    describe( 'Class-based inheritance hooks & options', () =>
    {
        it( 'supports class method hooks and constructor extensions on AbstractModel and AbstractPropertyModel subclasses', async() =>
        {
            const { collection } = createCollectionMock([{ _id: 'u-1', name: 'Alice' }]);
            const models = new TestModels();
            const events: string[] = [];

            class CustomUsersModel extends AbstractModel<UserDBE, UserDTO, { converters: { dto: { converter: ( dbe: UserDBE ) => UserDTO } } }>
            {
                constructor()
                {
                    super( models, collection,
                    {
                        timestamps  : true,
                        softDelete  : true,
                        indexes     : [{ name: 1 }],
                        converters  :
                        {
                            dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                        }
                    });
                }

                public id(){ return 'u-1' }
                public dbeID( id: string ){ return id }
                public dtoID( id: string ){ return id }

                public beforeCreate( ctx: any )
                {
                    events.push( `class:beforeCreate:${ctx.method}` );
                }

                public afterCreate( ctx: any )
                {
                    events.push( `class:afterCreate:${ctx.id}` );
                }
            }

            class CustomItemsModel extends AbstractPropertyModel<UserDBE, ItemDBE, ItemDTO, { converters: { dto: { converter: ( dbe: ItemDBE ) => ItemDTO } } }>
            {
                constructor()
                {
                    super( models, collection, 'items[]',
                    {
                        timestamps  : true,
                        softDelete  : true,
                        converters  :
                        {
                            dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                        }
                    });
                }

                public id(){ return 'item-1' }
                public dbeID( id: string ){ return id }
                public dtoID( id: string ){ return id }
            }

            const users = new CustomUsersModel();
            const items = new CustomItemsModel();

            await users.create({ name: 'Alice' });
            expect( events ).toEqual([ 'class:beforeCreate:create', 'class:afterCreate:u-1' ]);
            expect( items ).toBeDefined();
        });
    });

    describe( 'Edge cases & branch coverage', () =>
    {
        it( 'covers bulkWrite variants (insertOne, updateOne, deleteOne, deleteMany, empty ops), access denials, and error paths', async() =>
        {
            const { collection, spies, cursor } = createCollectionMock([{ _id: 'u-1', id: 'item-1', name: 'Alice', title: 'One' }]);
            const models = new TestModels();
            const users = defineModel<UserDBE, UserDTO>( models, collection,
            {
                cache       : true,
                timestamps  : true,
                softDelete  : true,
                access      :
                {
                    filters:
                    {
                        allow   : () => ({ role: 'user' }),
                        deny    : () => false
                    }
                },
                converters  :
                {
                    dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) }
                }
            });

            const items = definePropertyModel<UserDBE, ItemDBE, ItemDTO>( models, collection,
            {
                path    : 'items[]',
                access  :
                {
                    filters:
                    {
                        allow   : () => ({ tag: 'ok' }),
                        deny    : () => false
                    }
                },
                converters:
                {
                    dto: { converter: dbe => ({ id: dbe.id, title: dbe.title }) }
                }
            });

            // 1. Empty bulkWrite
            const emptyBulk = await users.bulkWrite([]);

            expect( emptyBulk.insertedCount ).toBe( 0 );

            // 2. bulkWrite with insertOne, wrapped create, updateOne, deleteOne, deleteMany (soft & hard)
            await users.bulkWrite([
                { insertOne: { document: { name: 'Inserted' } } },
                { create: { data: { name: 'Wrapped' }, id: 'u-wrapped' } },
                { updateOne: { filter: { name: 'Alice' }, update: { role: 'user' }, upsert: true } },
                { deleteOne: { filter: { name: 'Alice' } } },
                { deleteOne: { filter: { name: 'Alice' }, hard: true } },
                { deleteMany: { filter: { name: 'Alice' } } },
                { deleteMany: { filter: [ 'u-1' ], hard: true } }
            ], { ordered: false, access: 'allow' });

            // 3. Access-denied bulkWrite on update/delete skips operations and returns 0
            const deniedBulk = await users.bulkWrite([
                { update: { id: 'u-1', update: { name: 'Nope' } } },
                { updateOne: { filter: { name: 'Alice' }, update: { name: 'Nope' } } },
                { delete: { id: 'u-1' } },
                { deleteOne: { filter: { name: 'Alice' } } }
            ], { access: 'deny' });

            expect( deniedBulk.modifiedCount ).toBe( 0 );

            // Access-denied on create in bulkWrite throws
            await expect( users.bulkWrite([{ create: { name: 'Denied' } }], { access: 'deny' }) ).rejects.toThrow();

            // 4. Access-denied on upsert, restore, restoreMany, distinct
            const deniedUpsert = await users.upsert({ name: 'Alice' }, { role: 'x' }, { access: 'deny' });

            expect( deniedUpsert.matchedCount ).toBe( 0 );
            expect( await users.restore( 'u-1', { access: 'deny' }) ).toBe( false );
            expect( await users.restoreMany([ 'u-1' ], { access: 'deny' }) ).toBe( 0 );
            expect( await users.restoreMany([], { access: 'allow' }) ).toBe( 0 );
            expect( await users.restoreMany({ name: 'Alice' }, { access: 'allow' }) ).toBe( 1 );
            expect( await users.distinct( 'role', { filter: { name: 'Alice' }, access: 'deny' }) ).toEqual([]);

            const deniedPropUpsert = await items.upsert( 'u-1', { title: 'One' }, { tag: 'x' }, { access: 'deny' });

            expect( deniedPropUpsert.matchedCount ).toBe( 0 );
            expect( await items.restore( 'item-1', { access: 'deny' }) ).toBe( false );
            expect( await items.restoreMany([ 'item-1' ], { access: 'deny' }) ).toBe( 0 );

            // Missing parentID on PropertyModel upsert when no subdoc matches
            spies.aggregate.mockImplementationOnce(() => cursor([]));
            await expect( items.upsert({ title: 'NoParent' }, { tag: 'x' }, { access: 'allow' }) ).rejects.toThrow( 'Parent document ID is required' );

            // 5. Model without softDelete returns false / 0 on restore / restoreMany
            const plainUsers = defineModel<UserDBE, UserDTO>( models, collection,
            {
                converters: { dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) } }
            });

            expect( await plainUsers.restore( 'u-1' ) ).toBe( false );
            expect( await plainUsers.restoreMany([ 'u-1' ]) ).toBe( 0 );
            expect( await items.restore( 'item-1' ) ).toBe( false );
            expect( await items.restoreMany([ 'item-1' ]) ).toBe( 0 );

            // 6. syncIndexes with namespace not found (code 26) and option mismatches
            spies.indexes.mockRejectedValueOnce( Object.assign( new Error( 'ns not found' ), { code: 26 }));
            const nsRes = await users.syncIndexes();

            expect( nsRes.created ).toEqual([]);

            const indexedUsers = defineModel<UserDBE, UserDTO>( models, collection,
            {
                indexes: [
                    { key: { name: 1 }, unique: true, sparse: true, expireAfterSeconds: 60 }
                ],
                converters: { dto: { converter: dbe => ({ id: dbe._id, name: dbe.name }) } }
            });

            spies.indexes.mockResolvedValueOnce([
                { name: 'name_1', key: { name: 1 }, unique: false, sparse: false }
            ]);
            const mismatchRes = await indexedUsers.syncIndexes({ dropObsolete: true, background: true });

            expect( mismatchRes.dropped ).toContain( 'name_1' );
            expect( mismatchRes.created ).toContain( 'name_1' );
        });
    });
});
