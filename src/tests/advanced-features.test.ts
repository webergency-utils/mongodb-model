import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import
{
    AbstractModels,
    ModelConverterError,
    ModelError,
    ModelExternalCacheStore,
    ModelIdCollisionError,
    ModelVersionConflictError,
    ObjectId,
    computeAuditDiff,
    createIdGenerator,
    defineModel,
    definePropertyModel,
    estimateIdCollisionRisk,
    executeWithTransientRetry,
    extractExplainSummary,
    generateRandomId,
    isIdDuplicateKeyError,
    isTransientMongoError,
    normalizePopulateSpecs,
    redactSensitiveData,
    resolveAuditConfig,
    resolveCollationOption,
    resolveIdConfig,
    resolveRetryConfig,
    resolveVersioningConfig
}
from '../index.js';
import { applyCreateVersioning, applyUpdateVersioning } from '../operations.js';

type OrgDBE =
{
    _id     : string
    name    : string
};

type OrgDTO =
{
    id      : string
    name    : string
};

type AuthorDBE =
{
    _id     : string
    name    : string
    orgId?  : string
    slug?   : string
};

type AuthorDTO =
{
    id              : string
    name            : string
    orgId?          : string
    slug?           : string
    organization?   : OrgDTO | null
};

type PostDBE =
{
    _id         : string
    title       : string
    authorId?   : string
    authorSlug? : string
    tagIds?     : string[]
    version?    : number
    deleted?    : boolean
    deletedAt?  : Date | null
    comments?   : CommentDBE[]
};

type PostDTO =
{
    id          : string
    title       : string
    authorId?   : string
    authorSlug? : string
    tagIds?     : string[]
    version?    : number
    author?     : AuthorDTO | null
    tags?       : OrgDTO[]
    comments?   : CommentDTO[]
};

type CommentDBE =
{
    id          : string
    text        : string
    authorId?   : string
    version?    : number
    deleted?    : boolean
    deletedAt?  : Date | null
};

type CommentDTO =
{
    id          : string
    text        : string
    authorId?   : string
    version?    : number
    author?     : AuthorDTO | null
};

function createFakeChangeStream()
{
    const emitter = new EventEmitter();
    const queue: any[] = [];
    let resolveNext: ( ( res: IteratorResult<any> ) => void ) | null = null;
    let isClosed = false;

    const stream: any =
    {
        on( event: string, listener: ( ...args: any[] ) => void )
        {
            emitter.on( event, listener );

            return stream;
        },
        emitChange( doc: any )
        {
            if( resolveNext )
            {
                const r = resolveNext;
                resolveNext = null;
                r({ value: doc, done: false });
            }
            else
            {
                queue.push( doc );
            }

            emitter.emit( 'change', doc );
        },
        emitError( err: Error )
        {
            emitter.emit( 'error', err );
        },
        close : vi.fn().mockImplementation( async() =>
        {
            isClosed = true;

            if( resolveNext )
            {
                const r = resolveNext;
                resolveNext = null;
                r({ value: undefined, done: true });
            }
        }),
        [Symbol.asyncIterator]()
        {
            return {
                next()
                {
                    if( queue.length > 0 )
                    {
                        return Promise.resolve({ value: queue.shift(), done: false });
                    }

                    if( isClosed )
                    {
                        return Promise.resolve({ value: undefined, done: true });
                    }

                    return new Promise<IteratorResult<any>>( resolve =>
                    {
                        resolveNext = resolve;
                    });
                }
            };
        }
    };

    return stream;
}

function createRichCollectionMock( collectionName: string, initialDocs: any[] = [] )
{
    let docs = [ ...initialDocs ];
    let lastChangeStream = createFakeChangeStream();

    const makeCursor = ( items: any[], explainPlan?: any ) => (
    {
        toArray : vi.fn().mockResolvedValue( items ),
        explain : vi.fn().mockResolvedValue( explainPlan ?? {
            queryPlanner:
            {
                winningPlan:
                {
                    stage       : 'FETCH',
                    inputStage  : { stage: 'IXSCAN', indexName: 'title_1' }
                }
            },
            executionStats:
            {
                totalDocsExamined   : items.length,
                totalKeysExamined   : items.length,
                executionTimeMillis : 2,
                nReturned           : items.length
            }
        }),
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

    const aggregate = vi.fn().mockImplementation(() => makeCursor( docs ));
    const insertOne = vi.fn().mockImplementation( async( doc: any ) =>
    {
        docs.push( doc );

        return { acknowledged: true, insertedId: doc._id };
    });
    const insertMany = vi.fn().mockImplementation( async( items: any[] ) =>
    {
        docs.push( ...items );

        return { acknowledged: true };
    });
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const findOne = vi.fn().mockImplementation( async() => docs[0] ?? null );
    const findOneAndUpdate = vi.fn().mockImplementation( async( _filter: any, update: any ) =>
    {
        if( !docs[0] ){ return null }

        const next = { ...docs[0], ...( update?.$set ?? {} ) };

        if( update?.$inc )
        {
            for( const [ k, v ] of Object.entries( update.$inc ) )
            {
                next[k] = ( ( next as any )[k] ?? 0 ) + Number( v );
            }
        }

        docs[0] = next;

        return next;
    });
    const findOneAndDelete = vi.fn().mockImplementation( async() =>
    {
        return docs.shift() ?? null;
    });
    const bulkWrite = vi.fn().mockResolvedValue({
        insertedCount   : 1,
        matchedCount    : 1,
        modifiedCount   : 1,
        deletedCount    : 0,
        upsertedCount   : 0,
        upsertedIds     : {}
    });
    const watch = vi.fn().mockImplementation(() =>
    {
        lastChangeStream = createFakeChangeStream();

        return lastChangeStream;
    });

    return {
        collection:
        {
            collectionName,
            aggregate,
            insertOne,
            insertMany,
            updateOne,
            updateMany,
            deleteOne,
            deleteMany,
            findOne,
            findOneAndUpdate,
            findOneAndDelete,
            bulkWrite,
            watch
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
            findOneAndDelete,
            bulkWrite,
            watch
        },
        get lastChangeStream()
        {
            return lastChangeStream;
        },
        makeCursor,
        setDocs( nextDocs: any[] )
        {
            docs = [ ...nextDocs ];
        }
    };
}

class TestModels extends AbstractModels
{
    public commandSpy = vi.fn().mockResolvedValue({ ok: 1 });

    constructor( config?: any )
    {
        super( 'mongodb://localhost/test-advanced', config );
        ( this as any ).client = {
            db              : () => ({ command: this.commandSpy }),
            startSession    : vi.fn(() => ({
                withTransaction : vi.fn( async( fn: any ) => await fn( {} )),
                endSession      : vi.fn().mockResolvedValue( undefined )
            })),
            close           : vi.fn().mockResolvedValue( undefined )
        };
    }
}

describe( 'Advanced Next-Gen Features', () =>
{
    describe( '1. Operations helpers & ModelVersionConflictError', () =>
    {
        it( 'resolves versioning configs, applies create/update versioning, normalizes populate specs, and parses explain plans', () =>
        {
            expect( resolveVersioningConfig( undefined ) ).toBeUndefined();
            expect( resolveVersioningConfig( false ) ).toBeUndefined();
            expect( resolveVersioningConfig( true ) ).toEqual({ field: 'version', initialVersion: 1 });
            expect( resolveVersioningConfig( 'rev' ) ).toEqual({ field: 'rev', initialVersion: 1 });
            expect( resolveVersioningConfig({ field: '__v', initialVersion: 0 }) ).toEqual({ field: '__v', initialVersion: 0 });

            const vCfg = resolveVersioningConfig( true )!;

            expect( applyCreateVersioning({ title: 'A' }, undefined ) ).toEqual({ title: 'A' });
            expect( applyCreateVersioning({ title: 'A' }, vCfg ) ).toEqual({ title: 'A', version: 1 });
            expect( applyCreateVersioning({ title: 'A', version: 5 }, vCfg ) ).toEqual({ title: 'A', version: 5 });

            expect( applyUpdateVersioning({ title: 'B' }, undefined ) ).toEqual({ title: 'B' });
            expect( applyUpdateVersioning({ title: 'B', Drop: undefined }, vCfg ) ).toEqual({
                $set    : { title: 'B' },
                $unset  : { Drop: 1 },
                $inc    : { version: 1 }
            });
            expect( applyUpdateVersioning({ title: 'B', version: 10 }, vCfg ) ).toEqual({ title: 'B', version: 10 });
            expect( applyUpdateVersioning({ $set: { title: 'B' } }, vCfg ) ).toEqual({
                $set    : { title: 'B' },
                $inc    : { version: 1 }
            });
            expect( applyUpdateVersioning({ $set: { version: 9 } }, vCfg ) ).toEqual({
                $set    : { version: 9 }
            });

            expect( normalizePopulateSpecs( undefined ) ).toEqual([]);
            expect( normalizePopulateSpecs( 'author' ) ).toEqual([{ path: 'author' }]);
            expect( normalizePopulateSpecs([
                'author',
                'author.organization',
                'author.profile',
                { path: 'author', as: 'summary', includeDeleted: true, populate: 'roles' },
                { path: 'tags', as: 'summary' }
            ]) ).toEqual([
                {
                    path            : 'author',
                    as              : 'summary',
                    includeDeleted  : true,
                    populate        : [{ path: 'organization' }, { path: 'profile' }, 'roles' ]
                },
                { path: 'tags', as: 'summary' }
            ]);

            const collScanSummary = extractExplainSummary({
                stages:
                [
                    {
                        $cursor:
                        {
                            queryPlanner:
                            {
                                winningPlan: { stage: 'COLLSCAN' }
                            },
                            executionStats:
                            {
                                totalDocsExamined   : 50,
                                totalKeysExamined   : 0,
                                executionTimeMillis : 12,
                                nReturned           : 5
                            }
                        }
                    }
                ]
            });

            expect( collScanSummary.isCollectionScan ).toBe( true );
            expect( collScanSummary.indexUsed ).toBeUndefined();
            expect( collScanSummary.totalDocsExamined ).toBe( 50 );
            expect( collScanSummary.nReturned ).toBe( 5 );

            const multiIdxSummary = extractExplainSummary({
                shards:
                {
                    shard1:
                    {
                        queryPlanner:
                        {
                            winningPlan:
                            {
                                stage       : 'SUBPLAN',
                                inputStages :
                                [
                                    { stage: 'IXSCAN', indexName: 'idx_a' },
                                    { stage: 'IXSCAN', indexName: 'idx_b' }
                                ]
                            }
                        }
                    }
                }
            });

            expect( multiIdxSummary.isCollectionScan ).toBe( false );
            expect( multiIdxSummary.indexUsed ).toEqual([ 'idx_a', 'idx_b' ]);
        });

        it( 'constructs ModelVersionConflictError with id, expectedVersion, and custom message', () =>
        {
            const err1 = new ModelVersionConflictError( 'Posts', 'p1', 3 );

            expect( err1.code ).toBe( 'MODEL_VERSION_CONFLICT' );
            expect( err1.id ).toBe( 'p1' );
            expect( err1.expectedVersion ).toBe( 3 );
            expect( err1.message ).toContain( 'expected version 3' );

            const err2 = new ModelVersionConflictError( 'Posts', undefined, undefined, 'Custom conflict' );

            expect( err2.message ).toContain( 'Custom conflict' );
        });
    });

    describe( '2. Optimistic Concurrency Control (versioning & expectedVersion)', () =>
    {
        it( 'initializes version on create/createMany and enforces expectedVersion on AbstractModel updates', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [{ _id: 'p1', title: 'Hello', version: 1 }]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                versioning  : true,
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, version: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, version: dbe.version })
                    }
                }
            });

            await posts.create({ title: 'New Post' }, 'p2' );
            expect( mock.spies.insertOne ).toHaveBeenCalledWith( expect.objectContaining({ _id: 'p2', title: 'New Post', version: 1 }));

            await posts.createMany([{ title: 'Batch 1' }], [ 'p3' ]);
            expect( mock.spies.insertMany ).toHaveBeenCalledWith([ expect.objectContaining({ _id: 'p3', title: 'Batch 1', version: 1 }) ]);

            await posts.update( 'p1', { title: 'Updated' }, { expectedVersion: 1 });
            expect( mock.spies.updateOne ).toHaveBeenCalledWith(
                { $and: [{ _id: 'p1' }, { version: 1 }] },
                expect.objectContaining({ $set: { title: 'Updated' }, $inc: { version: 1 } })
            );

            // Simulate version mismatch (matchedCount: 0 while doc still exists)
            mock.spies.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
            mock.spies.findOne.mockResolvedValueOnce({ _id: 'p1', version: 2 });

            await expect( posts.update( 'p1', { title: 'Stale' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // updateOne with expectedVersion conflict
            mock.spies.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
            mock.spies.findOne.mockResolvedValueOnce({ _id: 'p1', version: 2 });

            await expect( posts.updateOne({ _id: 'p1' }, { title: 'Stale' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // updateMany by ID array and by filter with expectedVersion conflict
            mock.spies.updateMany.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
            mock.spies.findOne.mockResolvedValueOnce({ _id: 'p1', version: 2 });

            await expect( posts.updateMany([ 'p1' ], { title: 'Stale' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            mock.spies.updateMany.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
            mock.spies.findOne.mockResolvedValueOnce({ _id: 'p1', version: 2 });

            await expect( posts.updateMany({ title: 'Hello' }, { title: 'Stale' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // upsert duplicate key 11000 with expectedVersion converts to ModelVersionConflictError
            const dupErr = Object.assign( new Error( 'E11000 duplicate key' ), { code: 11000 });
            mock.spies.updateOne.mockRejectedValueOnce( dupErr );

            await expect( posts.upsert({ _id: 'p1' }, { title: 'Conflict' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // bulkWrite with expectedVersion conflict
            mock.spies.bulkWrite.mockResolvedValueOnce({
                insertedCount   : 0,
                matchedCount    : 0,
                modifiedCount   : 0,
                deletedCount    : 0,
                upsertedCount   : 0,
                upsertedIds     : {}
            });

            await expect( posts.bulkWrite([
                { update: { id: 'p1', update: { title: 'Bulk Stale' }, expectedVersion: 1 } }
            ]) ).rejects.toThrow( ModelVersionConflictError );
        });

        it( 'enforces versioning and expectedVersion on AbstractPropertyModel', async() =>
        {
            const models = new TestModels();
            const rootDoc = {
                _id         : 'p1',
                title       : 'Post 1',
                comments    : [{ id: 'c1', text: 'First', version: 1 }]
            };
            const mock = createRichCollectionMock( 'posts', [ rootDoc ]);

            defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });
            const comments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path        : 'comments[]',
                versioning  : true,
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1, version: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text, version: dbe.version })
                    }
                }
            });

            mock.spies.aggregate.mockImplementationOnce(() => mock.makeCursor([{ _id: 'p1', title: 'Post 1' }]));
            await comments.create( 'p1', { text: 'New comment' }, 'c2' );

            expect( mock.spies.updateOne ).toHaveBeenCalledWith(
                { _id: 'p1' },
                { $push: { comments: expect.objectContaining({ id: 'c2', text: 'New comment', version: 1 }) } },
                expect.anything()
            );

            // Successful update with matching expectedVersion
            mock.spies.aggregate.mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]));
            await comments.update( 'c1', { text: 'Edited' }, { expectedVersion: 1 });

            // Failed update when expectedVersion does not match
            mock.spies.aggregate.mockImplementationOnce(() => mock.makeCursor([]));
            await expect( comments.update( 'c1', { text: 'Stale' }, { expectedVersion: 99 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // Failed updateMany when expectedVersion does not match
            mock.spies.aggregate.mockImplementationOnce(() => mock.makeCursor([]));
            await expect( comments.updateMany([ 'c1' ], { text: 'Stale' }, { expectedVersion: 99 }) )
                .rejects.toThrow( ModelVersionConflictError );
        });
    });

    describe( '3. Atomic findOneAndUpdate & findOneAndDelete (Root & PropertyModel)', () =>
    {
        it( 'executes findOneAndUpdate and findOneAndDelete on AbstractModel with DTO conversion, sort, upsert, and softDelete', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [{ _id: 'p1', title: 'Initial', version: 1 }]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                versioning  : true,
                softDelete  : true,
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, version: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, version: dbe.version })
                    }
                }
            });

            const updated = await posts.findOneAndUpdate( 'p1', { title: 'Atomic' }, { sort: { title: 1 } });

            expect( updated ).toEqual({ id: 'p1', title: 'Atomic', version: 2 });
            expect( mock.spies.findOneAndUpdate ).toHaveBeenCalled();

            // Upsert with findOneAndUpdate
            mock.spies.findOneAndUpdate.mockResolvedValueOnce({ _id: 'p-up', title: 'Upserted', version: 1 });
            const upserted = await posts.findOneAndUpdate(
                { title: 'Missing' },
                { title: 'Upserted' },
                { upsert: true, id: 'p-up' }
            );

            expect( upserted ).toEqual({ id: 'p-up', title: 'Upserted', version: 1 });

            // Soft delete via findOneAndDelete
            mock.spies.findOneAndUpdate.mockResolvedValueOnce({ _id: 'p1', title: 'Atomic', version: 2 });
            const softDeleted = await posts.findOneAndDelete( 'p1' );

            expect( softDeleted ).toEqual({ id: 'p1', title: 'Atomic', version: 2 });

            // Hard delete via findOneAndDelete
            mock.spies.findOneAndDelete.mockResolvedValueOnce({ _id: 'p1', title: 'Atomic', version: 2 });
            const hardDeleted = await posts.findOneAndDelete({ _id: 'p1' }, { hard: true, sort: { title: -1 } });

            expect( hardDeleted ).toEqual({ id: 'p1', title: 'Atomic', version: 2 });
            expect( mock.spies.findOneAndDelete ).toHaveBeenCalled();

            // Conversion string shorthand & returnDocument: 'before'
            mock.spies.findOneAndUpdate.mockResolvedValueOnce({ value: { _id: 'p1', title: 'BeforeVal', version: 2 } });
            const asShorthand = await posts.findOneAndUpdate( 'p1', { title: 'AfterVal' }, 'dto' );
            expect( asShorthand ).toEqual({ id: 'p1', title: 'BeforeVal', version: 2 });

            mock.spies.findOneAndUpdate.mockResolvedValueOnce({ value: { _id: 'p1', title: ' DeletedShorthand', version: 2 } });
            const delShorthand = await posts.findOneAndDelete( 'p1', 'dto' );
            expect( delShorthand?.id ).toBe( 'p1' );

            // Fallback when collection lacks findOneAndUpdate / findOneAndDelete
            const fallbackColl: any = {
                collectionName  : 'posts_fallback',
                aggregate       : mock.spies.aggregate,
                findOne         : vi.fn().mockResolvedValue({ _id: 'p1', title: 'FallbackDoc', version: 1 }),
                updateOne       : vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
                deleteOne       : vi.fn().mockResolvedValue({ deletedCount: 1 })
            };
            const fallbackPosts = defineModel<PostDBE, PostDTO>( models, fallbackColl,
            {
                versioning  : true,
                softDelete  : true,
                access      : { defaults: () => 'allow', filters: { deny: () => false, allow: () => true } },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, version: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, version: dbe.version })
                    }
                }
            });

            expect( await fallbackPosts.findOneAndUpdate( 'p1', { title: 'Denied' }, { access: 'deny' }) ).toBeNull();
            expect( await fallbackPosts.findOneAndDelete( 'p1', { access: 'deny' }) ).toBeNull();

            const fbBefore = await fallbackPosts.findOneAndUpdate( 'p1', { title: 'Next' }, { returnDocument: 'before', sort: { title: 1 } });
            expect( fbBefore?.title ).toBe( 'FallbackDoc' );

            const fbAfter = await fallbackPosts.findOneAndUpdate({ title: 'FallbackDoc' }, { title: 'Next' }, { returnDocument: 'after' });
            expect( fbAfter?.title ).toBe( 'FallbackDoc' );

            const fbSoftDel = await fallbackPosts.findOneAndDelete( 'p1', { sort: { title: 1 } });
            expect( fbSoftDel?.id ).toBe( 'p1' );

            const fbHardDel = await fallbackPosts.findOneAndDelete( 'p1', { hard: true, sort: { title: 1 } });
            expect( fbHardDel?.id ).toBe( 'p1' );

            // Version conflict in findOneAndUpdate (null result + existing doc, and 11000 duplicate key)
            mock.spies.findOneAndUpdate.mockResolvedValueOnce( null );
            mock.spies.findOne.mockResolvedValueOnce({ _id: 'p1', version: 5 });
            await expect( posts.findOneAndUpdate( 'p1', { title: 'Stale' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );

            mock.spies.findOneAndUpdate.mockRejectedValueOnce( Object.assign( new Error( 'dup' ), { code: 11000 }));
            await expect( posts.findOneAndUpdate( 'p1', { title: 'Dup' }, { expectedVersion: 1 }) )
                .rejects.toThrow( ModelVersionConflictError );
        });

        it( 'executes findOneAndUpdate and findOneAndDelete on AbstractPropertyModel', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', []);
            defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });
            const comments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path                : 'comments[]',
                computedProperties  :
                {
                    badge: () => ({ fields: { badge: 'vip' } })
                },
                converters          :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text })
                    },
                    withBadge:
                    {
                        projection          : { id: 1, text: 1 },
                        computedProperties  : [ 'badge' ],
                        converter           : dbe => ({ id: dbe.id, text: dbe.text })
                    }
                }
            });

            // Match existing subdoc c1 and return updated DTO
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1', text: 'Updated Subdoc' }]));

            const updated = await comments.findOneAndUpdate( 'c1', { text: 'Updated Subdoc' });

            expect( updated ).toEqual({ id: 'c1', text: 'Updated Subdoc' });

            // ReturnDocument: 'before' with computedProperties converter
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1', text: 'Before Computed' }]));

            const updatedBefore = await comments.findOneAndUpdate(
                { text: 'Before Computed' },
                { text: 'After Computed' },
                { as: 'withBadge', returnDocument: 'before', sort: { text: 1 } }
            );
            expect( updatedBefore ).toEqual({ id: 'c1', text: 'Before Computed' });

            // ReturnDocument: 'after' with computedProperties converter
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1', text: 'After Computed' }]));

            const updatedAfter = await comments.findOneAndUpdate(
                'c1',
                { text: 'After Computed' },
                'withBadge'
            );
            expect( updatedAfter ).toEqual({ id: 'c1', text: 'After Computed' });

            // Upsert when no subdoc matches
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([]))
                .mockImplementationOnce(() => mock.makeCursor([]))
                .mockImplementationOnce(() => mock.makeCursor([{ _id: 'p1', title: 'Parent' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c-new', text: 'Upserted Sub' }]));

            const upsertedSub = await comments.findOneAndUpdate(
                { id: 'c-new' },
                { text: 'Upserted Sub' },
                { upsert: true, parentID: 'p1' }
            );
            expect( upsertedSub ).toEqual({ id: 'c-new', text: 'Upserted Sub' });

            // ExpectedVersion conflict when no subdoc matches
            mock.spies.aggregate.mockImplementationOnce(() => mock.makeCursor([]));
            await expect( comments.findOneAndUpdate( 'c1', { text: 'Stale' }, { expectedVersion: 5 }) )
                .rejects.toThrow( ModelVersionConflictError );

            // Delete existing subdoc c1 and return deleted DTO
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1', text: 'Updated Subdoc' }]));

            const deleted = await comments.findOneAndDelete( 'c1' );

            expect( deleted ).toEqual({ id: 'c1', text: 'Updated Subdoc' });

            // Delete with computedProperties converter
            mock.spies.aggregate
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1' }]))
                .mockImplementationOnce(() => mock.makeCursor([{ id: 'c1', text: 'WithBadgeDel' }]));

            const deletedWithBadge = await comments.findOneAndDelete( 'c1', 'withBadge' );
            expect( deletedWithBadge ).toEqual({ id: 'c1', text: 'WithBadgeDel' });
        });
    });

    describe( '4. Application-Level Relation Hydration (relations & populate)', () =>
    {
        it( 'hydrates one-to-one, many-to-one, custom foreignField, and nested relations with batched queries', async() =>
        {
            const models = new TestModels();
            const orgMock = createRichCollectionMock( 'orgs', [
                { _id: 'o1', name: 'Acme' },
                { _id: 't1', name: 'TypeScript' },
                { _id: 't2', name: 'MongoDB' }
            ]);
            const authorMock = createRichCollectionMock( 'authors', [
                { _id: 'a1', name: 'Alice', orgId: 'o1', slug: 'alice' }
            ]);
            const postMock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'Post 1', authorId: 'a1', authorSlug: 'alice', tagIds: [ 't1', 't2' ] }
            ]);
            const commentMock = createRichCollectionMock( 'comments', [
                { _id: 'cm1', text: 'Nice post', postId: 'p1' },
                { _id: 'cm2', text: 'Great read', postId: 'p1' }
            ]);

            const orgs = defineModel<OrgDBE, OrgDTO>( models, orgMock.collection,
            {
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, name: 1 },
                        converter   : dbe => ({ id: dbe._id, name: dbe.name })
                    }
                }
            });

            const authors = defineModel<AuthorDBE, AuthorDTO>( models, authorMock.collection,
            {
                relations   :
                {
                    organization:
                    {
                        model       : 'orgs',
                        localField  : 'orgId',
                        type        : 'one'
                    }
                },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, name: 1, orgId: 1, slug: 1 },
                        converter   : dbe => ({ id: dbe._id, name: dbe.name, orgId: dbe.orgId, slug: dbe.slug })
                    }
                }
            });

            const rootComments = defineModel<{ _id: string, text: string, postId: string }, { id: string, text: string, postId: string }>( models, commentMock.collection,
            {
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, text: 1, postId: 1 },
                        converter   : dbe => ({ id: dbe._id, text: dbe.text, postId: dbe.postId })
                    }
                }
            });

            const posts = defineModel<PostDBE, PostDTO>( models, postMock.collection,
            {
                relations   :
                {
                    author:
                    {
                        model       : () => authors,
                        localField  : 'authorId',
                        type        : 'one'
                    },
                    authorBySlug:
                    {
                        model           : authors,
                        localField      : 'authorSlug',
                        foreignField    : 'slug',
                        type            : 'one'
                    },
                    tags:
                    {
                        model       : orgs,
                        localField  : 'tagIds',
                        type        : 'many'
                    },
                    postComments:
                    {
                        model           : rootComments,
                        localField      : 'id',
                        foreignField    : 'postId',
                        type            : 'many'
                    }
                },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, authorId: 1, authorSlug: 1, tagIds: 1 },
                        converter   : dbe => ({
                            id          : dbe._id,
                            title       : dbe.title,
                            authorId    : dbe.authorId,
                            authorSlug  : dbe.authorSlug,
                            tagIds      : dbe.tagIds
                        })
                    }
                }
            });

            expect( models.getModel( 'orgs' ) ).toBe( orgs );

            orgMock.spies.aggregate.mockImplementation(( pipeline: any[] ) =>
            {
                const matchStr = JSON.stringify( pipeline );

                if( matchStr.includes( 'o1' ) )
                {
                    return orgMock.makeCursor([{ _id: 'o1', name: 'Acme' }]);
                }

                return orgMock.makeCursor([
                    { _id: 't1', name: 'TypeScript' },
                    { _id: 't2', name: 'MongoDB' }
                ]);
            });

            const hydrated = await posts.get( 'p1', {
                populate:
                [
                    { path: 'author', populate: 'organization' },
                    'authorBySlug',
                    'tags',
                    'postComments'
                ]
            });

            expect( hydrated ).toMatchObject({
                id              : 'p1',
                title           : 'Post 1',
                author          :
                {
                    id              : 'a1',
                    name            : 'Alice',
                    organization    : { id: 'o1', name: 'Acme' }
                },
                authorBySlug    : { id: 'a1', name: 'Alice' },
                tags            :
                [
                    { id: 't1', name: 'TypeScript' },
                    { id: 't2', name: 'MongoDB' }
                ],
                postComments    :
                [
                    { id: 'cm1', text: 'Nice post', postId: 'p1' },
                    { id: 'cm2', text: 'Great read', postId: 'p1' }
                ]
            });

            const listed = await posts.list({ populate: 'author' });

            expect( listed[0]?.author ).toMatchObject({ id: 'a1', name: 'Alice' });

            const found = await posts.find({ filter: { title: 'Post 1' }, populate: 'author' });

            expect( found?.author ).toMatchObject({ id: 'a1', name: 'Alice' });

            const manyHydrated = await posts.getMany([ 'p1' ], { populate: 'author' });

            expect( manyHydrated[0]?.author ).toMatchObject({ id: 'a1', name: 'Alice' });

            // Implicit localField conventions (authorId, tagIds) & null/empty handling
            const implicitPosts = defineModel<PostDBE, PostDTO>( models, postMock.collection,
            {
                relations:
                {
                    author      : { model: authors },
                    tag         : { model: orgs },
                    missingRel  : { model: 'nonExistentModel' }
                },
                converters:
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, authorId: 1, tagIds: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, authorId: dbe.authorId, tagIds: dbe.tagIds })
                    }
                }
            });

            postMock.setDocs([{ _id: 'p-empty', title: 'Empty FKs' }]);
            const emptyHydrated = await implicitPosts.get( 'p-empty', {
                populate: [ 'author', 'tag', 'missingRel', 'unknownRel' ]
            });

            expect( emptyHydrated ).toMatchObject({
                id      : 'p-empty',
                author  : null,
                tag     : null
            });

            // findOneAndUpdate & findOneAndDelete with populate
            postMock.spies.findOneAndUpdate.mockResolvedValueOnce({ _id: 'p1', title: 'UpdPop', authorId: 'a1' });
            const updPop = await implicitPosts.findOneAndUpdate( 'p1', { title: 'UpdPop' }, { populate: 'author' }) as any;
            expect( updPop?.author ).toMatchObject({ id: 'a1', name: 'Alice', orgId: 'o1' });

            postMock.spies.findOneAndDelete.mockResolvedValueOnce({ _id: 'p1', title: 'DelPop', authorId: 'a1' });
            const delPop = await implicitPosts.findOneAndDelete( 'p1', { populate: 'author' }) as any;
            expect( delPop?.author ).toMatchObject({ id: 'a1', name: 'Alice', orgId: 'o1' });
        });
    });

    describe( '5. Query Plan Inspection & Diagnostics (explain, ping, healthCheck, cacheStats)', () =>
    {
        it( 'runs model.explain(), models.ping(), models.healthCheck(), and model.cacheStats()', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [{ _id: 'p1', title: 'Post 1' }]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                cache       : true,
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });
            const comments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path        : 'comments[]',
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text })
                    }
                }
            });

            expect( comments.cacheStats().enabled ).toBe( false );

            const propPlan = await comments.explain([{ $match: { text: 'hi' } }]);
            expect( propPlan.collection ).toBe( 'posts.comments' );

            const plan1 = await posts.explain({ filter: { title: 'Post 1' } });

            expect( plan1.collection ).toBe( 'posts' );
            expect( plan1.indexUsed ).toBe( 'title_1' );
            expect( plan1.isCollectionScan ).toBe( false );
            expect( plan1.totalDocsExamined ).toBe( 1 );

            const plan2 = await posts.explain([{ $match: { title: 'Post 1' } }], 'queryPlanner' );

            expect( plan2.pipeline ).toEqual([{ $match: { title: 'Post 1' } }]);

            // Fallback to db.command when cursor.explain is absent
            mock.spies.aggregate.mockImplementationOnce(() => ({
                toArray : vi.fn().mockResolvedValue([])
            }));
            models.commandSpy.mockResolvedValueOnce({
                queryPlanner: { winningPlan: { stage: 'COLLSCAN' } }
            });

            const plan3 = await posts.explain({ filter: { title: 'Fallback' } });

            expect( plan3.isCollectionScan ).toBe( true );

            // ping & healthCheck
            const pingRes = await models.ping();

            expect( pingRes.ok ).toBe( true );
            expect( pingRes.latencyMs ).toBeGreaterThanOrEqual( 0 );

            const health = await models.healthCheck();

            expect( health.ok ).toBe( true );
            expect( health.modelsCount ).toBeGreaterThanOrEqual( 1 );
            expect( health.collectionsCount ).toBeGreaterThanOrEqual( 1 );
            expect( health.closed ).toBe( false );

            // Unhealthy ping
            models.commandSpy.mockRejectedValueOnce( new Error( 'Connection refused' ));
            const unhealthy = await models.healthCheck();

            expect( unhealthy.ok ).toBe( false );
            expect( unhealthy.error ).toContain( 'Connection refused' );

            // cacheStats
            expect( posts.cacheStats().enabled ).toBe( true );
            await posts.get( 'p1' );
            await posts.get( 'p1' );

            const stats = posts.cacheStats();

            expect( stats.hits ).toBe( 1 );
            expect( stats.misses ).toBe( 1 );
            expect( stats.sets ).toBe( 1 );
            expect( stats.size ).toBe( 1 );
            expect( stats.hitRate ).toBe( 0.5 );

            // Closed models healthCheck
            await models.shutdown();
            const closedHealth = await models.healthCheck();

            expect( closedHealth.ok ).toBe( false );
            expect( closedHealth.closed ).toBe( true );
        });
    });

    describe( '6. Change Streams & Cross-Instance Cache Invalidation (model.watch & models.watch)', () =>
    {
        it( 'watches collection and database change streams, converts DTOs, and invalidates caches', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [{ _id: 'p1', title: 'Cached Title' }]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                cache       : true,
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            // Prime cache
            await posts.get( 'p1' );
            expect( posts.cacheStats().size ).toBe( 1 );

            const received: any[] = [];
            const stream = posts.watch({
                operations  : [ 'update', 'insert' ],
                onChange    : ev => { received.push( ev ); }
            });

            const nextPromise = ( async() =>
            {
                for await ( const ev of stream )
                {
                    return ev;
                }

                return null;
            })();

            mock.lastChangeStream.emitChange({
                operationType       : 'update',
                documentKey         : { _id: 'p1' },
                fullDocument        : { _id: 'p1', title: 'Updated via ChangeStream' },
                updateDescription   : { updatedFields: { title: 'Updated via ChangeStream' }, removedFields: [] },
                _id                 : { _data: 'token1' }
            });

            const firstEvent = await nextPromise;

            expect( firstEvent ).toMatchObject({
                operationType   : 'update',
                collection      : 'posts',
                id              : 'p1',
                dto             : { id: 'p1', title: 'Updated via ChangeStream' }
            });
            expect( received ).toHaveLength( 1 );
            expect( posts.cacheStats().size ).toBe( 0 );

            await stream.close();
            expect( stream.closed ).toBe( true );

            // Database-level models.watch() cross-instance cache invalidation
            await posts.primeCache( 'p1', { id: 'p1', title: 'Primed' });
            expect( posts.cacheStats().size ).toBe( 1 );

            const dbEvents: any[] = [];
            const errEvents: Error[] = [];
            const dbStream = models.watch({
                onChange: ev => { dbEvents.push( ev ); },
                onError : err => { errEvents.push( err ); }
            });
            dbStream.on( 'error', err => { errEvents.push( err ); });

            mock.lastChangeStream.emitError( new Error( 'Stream broken' ));
            expect( errEvents ).toHaveLength( 2 );

            const dbNextPromise = ( async() =>
            {
                for await ( const ev of dbStream )
                {
                    return ev;
                }

                return null;
            })();

            mock.lastChangeStream.emitChange({
                operationType   : 'delete',
                ns              : { coll: 'posts' },
                documentKey     : { _id: 'p1' }
            });

            const dbEv = await dbNextPromise;

            expect( dbEv?.operationType ).toBe( 'delete' );
            expect( dbEv?.collection ).toBe( 'posts' );
            expect( posts.cacheStats().size ).toBe( 0 );

            await dbStream.close();

            // Watch with AsyncIterable collection.watch (without .on) + full options
            mock.spies.watch.mockImplementationOnce(() => ({
                close   : vi.fn(),
                async *[Symbol.asyncIterator]()
                {
                    yield {
                        operationType   : 'insert',
                        documentKey     : { _id: 'p2' },
                        fullDocument    : { _id: 'p2', title: 'AsyncIterDoc' }
                    };
                }
            }));

            const iterStream = posts.watch({
                filter          : { 'fullDocument.title': 'AsyncIterDoc' },
                pipeline        : [{ $match: {} }],
                fullDocument    : 'updateLookup',
                resumeAfter     : { _data: 'tok1' },
                startAfter      : { _data: 'tok2' },
                batchSize       : 10,
                maxAwaitTimeMS  : 1000
            });

            for await ( const ev of iterStream )
            {
                expect( ev.id ).toBe( 'p2' );
                expect( ev.dto ).toEqual({ id: 'p2', title: 'AsyncIterDoc' });
                break;
            }
        });
    });

    describe( '7. Async / Distributed Cache Adapter & Manual Cache Control', () =>
    {
        it( 'supports external async cache stores (L1 + L2) and manual primeCache / invalidateCache', async() =>
        {
            const l2Map = new Map<string, unknown>();
            const externalStore: ModelExternalCacheStore =
            {
                get             : vi.fn( async( key: string ) => l2Map.get( key )),
                set             : vi.fn( async( key: string, value: unknown ) => { l2Map.set( key, value ); }),
                delete          : vi.fn( async( key: string | string[] ) =>
                {
                    for( const k of Array.isArray( key ) ? key : [ key ] )
                    {
                        l2Map.delete( k );
                    }
                }),
                invalidateIds   : vi.fn( async( ids: string[] ) =>
                {
                    const evicted: string[] = [];

                    for( const k of [ ...l2Map.keys() ] )
                    {
                        if( ids.some( id => k.includes( id )) )
                        {
                            l2Map.delete( k );
                            evicted.push( k );
                        }
                    }

                    return evicted;
                }),
                clear           : vi.fn( async() => { l2Map.clear(); })
            };

            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'Post 1' },
                { _id: 'p2', title: 'Post 2' }
            ]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                cache       : { ttl: 60000, store: externalStore },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            // First get: L1 miss -> L2 miss -> DB query -> populates L1 and L2
            const dto1 = await posts.get( 'p1' );

            expect( dto1 ).toEqual({ id: 'p1', title: 'Post 1' });
            expect( externalStore.get ).toHaveBeenCalledTimes( 1 );
            expect( externalStore.set ).toHaveBeenCalledTimes( 1 );

            // Clear only L1 to simulate another instance or L1 eviction, verify L2 hit!
            ( posts as any )._cache.clear();
            // Restore L2 entry since clear() also cleared L2 synchronously
            l2Map.set( 'dto:p1', { id: 'p1', title: 'From L2' });

            const fromL2 = await posts.get( 'p1' );

            expect( fromL2 ).toEqual({ id: 'p1', title: 'From L2' });
            expect( mock.spies.aggregate ).toHaveBeenCalledTimes( 1 );

            // getMany with L2 store: p1 in L1, p2 miss in L1 & L2 -> fetched from DB & setAsync into L2
            const manyFromDb = await posts.getMany([ 'p1', 'p2' ]);
            expect( manyFromDb ).toEqual([
                { id: 'p1', title: 'From L2' },
                { id: 'p2', title: 'Post 2' }
            ]);

            // Clear L1, set p2 in L2, and getMany from L2
            ( posts as any )._cache.clear();
            l2Map.set( 'dto:p1', { id: 'p1', title: 'From L2' });
            l2Map.set( 'dto:p2', { id: 'p2', title: 'From L2 Many' });
            const manyRes = await posts.getMany([ 'p1', 'p2' ]);

            expect( manyRes ).toEqual([
                { id: 'p1', title: 'From L2' },
                { id: 'p2', title: 'From L2 Many' }
            ]);

            // primeCache & invalidateCache
            await posts.primeCache( 'p3', { id: 'p3', title: 'Manual Prime' });
            expect( await posts.get( 'p3' ) ).toEqual({ id: 'p3', title: 'Manual Prime' });

            await posts.invalidateCache([]);
            await posts.invalidateCache( 'p3' );
            expect( externalStore.invalidateIds ).toHaveBeenCalledWith([ 'p3' ]);

            await posts.invalidateCache();
            expect( externalStore.clear ).toHaveBeenCalled();

            // External store without invalidateIds (uses delete fallback)
            const deleteOnlyStore: ModelExternalCacheStore =
            {
                get     : vi.fn( async() => undefined ),
                set     : vi.fn( async() => {}),
                delete  : vi.fn( async() => {})
            };
            const delOnlyPosts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                cache       : { ttl: 60000, store: deleteOnlyStore },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            await delOnlyPosts.primeCache( 'p1', { id: 'p1', title: 'DelOnly' });
            await delOnlyPosts.invalidateCache( 'p1' );
            expect( deleteOnlyStore.delete ).toHaveBeenCalledWith([ 'dto:p1' ]);

            await delOnlyPosts.primeCache( 'p2', { id: 'p2', title: 'DelOnlySync' });
            ( delOnlyPosts as any )._cache.invalidateIds([ 'p2' ]);
            expect( deleteOnlyStore.delete ).toHaveBeenCalledWith([ 'dto:p2' ]);
        });
    });

    describe( '8. Safe Cryptographic ID Generation & Collision Protection / Risk Analysis', () =>
    {
        it( 'generates cryptographic IDs across all strategies and estimates birthday-paradox collision risk', () =>
        {
            const oid = generateRandomId();
            expect( oid ).toMatch( /^[0-9a-f]{24}$/ );
            expect( ObjectId.isValid( oid ) ).toBe( true );

            const shortOid = generateRandomId({ strategy: 'objectId', length: 16, prefix: 'obj_' });
            expect( shortOid ).toMatch( /^obj_[0-9a-f]{16}$/ );

            const hexId = generateRandomId({ strategy: 'cryptoHex', length: 32, prefix: 'hex_' });
            expect( hexId ).toMatch( /^hex_[0-9a-f]{32}$/ );

            const implicitHex = generateRandomId({ length: 12 });
            expect( implicitHex ).toMatch( /^[0-9a-f]{12}$/ );

            const uuid = generateRandomId( 'uuid' );
            expect( uuid ).toMatch( /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i );

            const ulid = generateRandomId( 'ulid' );
            expect( ulid ).toMatch( /^[0-9A-HJKMNP-TV-Z]{26}$/ );

            const nanoid = generateRandomId( 'nanoid' );
            expect( nanoid ).toHaveLength( 21 );

            const base62 = generateRandomId( 'base62' );
            expect( base62 ).toMatch( /^[0-9A-Za-z]{22}$/ );

            const customAlpha = generateRandomId({ alphabet: 'ABCDEF', length: 10, prefix: 'c_' });
            expect( customAlpha ).toMatch( /^c_[A-F]{10}$/ );

            expect(() => generateRandomId({ alphabet: 'A', length: 4 })).toThrow( RangeError );

            const genFn = createIdGenerator({ strategy: 'base62', length: 16, prefix: 'u_' });
            expect( genFn() ).toMatch( /^u_[0-9A-Za-z]{16}$/ );

            // Risk calculations across all risk levels
            const negRisk = estimateIdCollisionRisk({ strategy: 'uuid', expectedCount: 1000 });
            expect( negRisk.entropyBits ).toBe( 122 );
            expect( negRisk.riskLevel ).toBe( 'negligible' );

            const ulidRisk = estimateIdCollisionRisk( 'ulid' );
            expect( ulidRisk.entropyBits ).toBe( 80 );
            expect( ulidRisk.riskLevel ).toBe( 'negligible' );

            const nanoidRisk = estimateIdCollisionRisk( 'nanoid' );
            expect( nanoidRisk.entropyBits ).toBe( 126 );

            const base62Risk = estimateIdCollisionRisk( 'base62' );
            expect( base62Risk.alphabetSize ).toBe( 62 );

            const hexRisk = estimateIdCollisionRisk({ strategy: 'cryptoHex', length: 24 });
            expect( hexRisk.entropyBits ).toBe( 96 );

            const customLenOidRisk = estimateIdCollisionRisk({ strategy: 'objectId', length: 16 });
            expect( customLenOidRisk.entropyBits ).toBe( 64 );

            const lowRisk = estimateIdCollisionRisk({ entropyBits: 40, expectedCount: 1000 });
            expect( lowRisk.riskLevel ).toBe( 'low' );

            const modRisk = estimateIdCollisionRisk({ alphabet: '0123456789abcdef', length: 7, expectedCount: 500 });
            expect( modRisk.riskLevel ).toBe( 'moderate' );

            const highRisk = estimateIdCollisionRisk({ entropyBits: 20, expectedCount: 200 });
            expect( highRisk.riskLevel ).toBe( 'high' );

            const critRisk = estimateIdCollisionRisk({ entropyBits: 10, expectedCount: 50 });
            expect( critRisk.riskLevel ).toBe( 'critical' );

            const zeroCountRisk = estimateIdCollisionRisk({ entropyBits: 32, expectedCount: 1 });
            expect( zeroCountRisk.collisionProbability ).toBe( 0 );

            // Config validation errors on minEntropyBits & maxCollisionRisk
            expect(() => resolveIdConfig({ strategy: 'cryptoHex', length: 4, minEntropyBits: 64 }))
                .toThrow( ModelError );
            expect(() => resolveIdConfig({ strategy: 'cryptoHex', length: 4, expectedCount: 1000, maxCollisionRisk: 1e-6 }))
                .toThrow( ModelError );

            // Duplicate key error discriminator
            expect( isIdDuplicateKeyError( null ) ).toBe( false );
            expect( isIdDuplicateKeyError({ code: 11000 }) ).toBe( true );
            expect( isIdDuplicateKeyError({ code: 11000, keyPattern: { _id: 1 } }, '_id' ) ).toBe( true );
            expect( isIdDuplicateKeyError({ code: 11000, keyPattern: { email: 1 } }, '_id' ) ).toBe( false );
            expect( isIdDuplicateKeyError({ code: 11000, keyValue: { 'comments.id': 'c1' } }, 'id' ) ).toBe( true );
            expect( isIdDuplicateKeyError({ code: 11000, keyValue: { email: 'a@b.c' } }, '_id' ) ).toBe( false );
            expect( isIdDuplicateKeyError({ code: 11000, message: 'E11000 duplicate key error index: _id_' }, '_id' ) ).toBe( true );
            expect( isIdDuplicateKeyError({ code: 11000, message: 'E11000 duplicate key error index: email_1' }, '_id' ) ).toBe( false );
        });

        it( 'automatically retries auto-generated ID collisions on Model create, createMany, bulkWrite, and generateId', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [{ _id: 'dup1', title: 'Existing' }]);

            let seq = 0;
            const candidatePool = [ 'dup1', 'dup2', 'fresh1', 'dup_batch', 'dup_batch', 'fresh2', 'fresh3' ];
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                id          :
                {
                    generator   : () => candidatePool[seq++] ?? generateRandomId( 'ulid' ),
                    maxRetries  : 3
                },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            expect( posts.idCollisionRisk().maxCountForOneInMillion ).toBeGreaterThan( 0 );
            expect( posts.idCollisionRisk( 500_000 ).expectedCount ).toBe( 500_000 );
            expect( posts.idCollisionRisk({ strategy: 'uuid', expectedCount: 100 }).entropyBits ).toBe( 122 );

            // 1. create() retries on E11000 _id collision until insertOne succeeds with 'fresh1'
            mock.spies.insertOne
                .mockRejectedValueOnce( Object.assign( new Error( 'E11000 dup' ), { code: 11000, keyPattern: { _id: 1 } }))
                .mockRejectedValueOnce( Object.assign( new Error( 'E11000 dup' ), { code: 11000, keyPattern: { _id: 1 } }))
                .mockResolvedValueOnce({ insertedId: 'fresh1' });

            const createdId = await posts.create({ title: 'Retry Success' });
            expect( createdId ).toBe( 'fresh1' );
            expect( mock.spies.insertOne ).toHaveBeenCalledTimes( 3 );

            // 2. createMany() deduplicates intra-batch collisions ('dup_batch', 'dup_batch' -> 'dup_batch', 'fresh2')
            // and retries insertMany on E11000 _id collision
            mock.spies.insertMany
                .mockRejectedValueOnce( Object.assign( new Error( 'E11000 batch dup' ), { code: 11000, keyPattern: { _id: 1 } }))
                .mockResolvedValueOnce({ insertedCount: 2 });

            const batchIds = await posts.createMany([{ title: 'B1' }, { title: 'B2' }]);
            expect( batchIds ).toHaveLength( 2 );
            expect( new Set( batchIds ).size ).toBe( 2 );

            // 3. Exhausting maxRetries on create() throws ModelIdCollisionError
            const alwaysColliding = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                id          : () => 'always_same',
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            mock.spies.insertOne.mockRejectedValue( Object.assign( new Error( 'E11000' ), { code: 11000, keyValue: { _id: 'always_same' } }));

            let collisionErr: ModelIdCollisionError | undefined;
            try
            {
                await alwaysColliding.create({ title: 'Fail' }, undefined, { maxRetries: 2 });
            }
            catch( e )
            {
                collisionErr = e as ModelIdCollisionError;
            }

            expect( collisionErr ).toBeInstanceOf( ModelIdCollisionError );
            expect( collisionErr?.code ).toBe( 'MODEL_ID_COLLISION' );
            expect( collisionErr?.id ).toBe( 'always_same' );
            expect( collisionErr?.attempts ).toBe( 3 );

            // Exhausting maxRetries on createMany intra-batch collision throws ModelIdCollisionError
            await expect( alwaysColliding.createMany([{ title: 'A' }, { title: 'B' }], { maxRetries: 1 }) )
                .rejects.toThrow( ModelIdCollisionError );

            // Exhausting maxRetries on bulkWrite intra-batch collision throws ModelIdCollisionError
            await expect( alwaysColliding.bulkWrite([{ create: { title: 'A' } }, { create: { title: 'B' } }]) )
                .rejects.toThrow( ModelIdCollisionError );

            // Non-_id duplicate key error (e.g. unique email index) is NOT retried as an ID collision
            const nonIdErr = Object.assign( new Error( 'E11000 email' ), { code: 11000, keyPattern: { email: 1 } });
            mock.spies.insertOne.mockReset();
            mock.spies.insertOne.mockRejectedValueOnce( nonIdErr );
            await expect( posts.create({ title: 'Email Dup' }) ).rejects.toThrow( 'E11000 email' );
            expect( mock.spies.insertOne ).toHaveBeenCalledTimes( 1 );

            // generateId({ verifyUniqueness: true }) checks exists() and retries or throws ModelIdCollisionError
            vi.spyOn( posts, 'exists' )
                .mockResolvedValueOnce( true )
                .mockResolvedValueOnce( false );

            const verifiedId = await posts.generateId({ verifyUniqueness: true, maxRetries: 2 });
            expect( typeof verifiedId ).toBe( 'string' );

            vi.spyOn( alwaysColliding, 'exists' ).mockResolvedValue( true );
            await expect( alwaysColliding.generateId({ verifyUniqueness: true, maxRetries: 1 }) )
                .rejects.toThrow( ModelIdCollisionError );
            await expect( alwaysColliding.create({ title: 'VerifyFail' }, undefined, { verifyUniqueness: true, maxRetries: 1 }) )
                .rejects.toThrow( ModelIdCollisionError );
        });

        it( 'protects PropertyModel create and createMany against parent subdocument and intra-batch ID collisions', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [
                {
                    _id         : 'p1',
                    title       : 'Post 1',
                    comments    : [{ id: 'c_existing', text: 'Existing comment' }]
                }
            ]);

            defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, comments: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, comments: dbe.comments as any })
                    }
                }
            });

            let cSeq = 0;
            const cPool = [ 'c_existing', 'c_fresh1', 'c_dup', 'c_dup', 'c_fresh2', 'c_retry1', 'c_retry2' ];
            const comments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path        : 'comments[]',
                id          : () => cPool[cSeq++] ?? generateRandomId( 'base62' ),
                dbeID       : id => String( id ),
                dtoID       : id => String( id ),
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text })
                    }
                }
            });

            // 1. create() skips 'c_existing' already present on parent.comments and uses 'c_fresh1'
            const subId = await comments.create( 'p1', { text: 'New comment' });
            expect( subId ).toBe( 'c_fresh1' );

            // 2. createMany() deduplicates intra-batch 'c_dup' -> ['c_dup', 'c_fresh2'] and retries on E11000
            mock.spies.updateOne
                .mockRejectedValueOnce( Object.assign( new Error( 'E11000 subdoc' ), { code: 11000, keyValue: { 'comments.id': 'c_dup' } }))
                .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

            const subBatchIds = await comments.createMany( 'p1', [{ text: 'M1' }, { text: 'M2' }]);
            expect( subBatchIds ).toEqual([ 'c_retry1', 'c_retry2' ]);

            // 3. Exhausting maxRetries on PropertyModel create / createMany throws ModelIdCollisionError
            const stuckComments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path        : 'comments[]',
                id          : () => 'c_existing',
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text })
                    }
                }
            });

            await expect( stuckComments.create( 'p1', { text: 'Collides with parent' }, undefined, { maxRetries: 1 }) )
                .rejects.toThrow( ModelIdCollisionError );
            await expect( stuckComments.createMany( 'p1', [{ text: 'Collides 1' }], { maxRetries: 1 }) )
                .rejects.toThrow( ModelIdCollisionError );
        });
    });

    describe( '9. Batch createManyFrom on AbstractModel & AbstractPropertyModel', () =>
    {
        it( 'converts arrays of external inputs via converters.from and inserts them in a single batch', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'Parent Post', comments: [] }
            ]);

            const posts = defineModel( models, mock.collection,
            {
                id          : 'base62',
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : ( dbe: PostDBE ) => ({ id: dbe._id, title: dbe.title })
                    },
                    from:
                    {
                        default : ( raw: string ) => ({ title: raw.trim() }),
                        csv     : async( row: { headline: string } ) => ({ title: `CSV:${row.headline}` }),
                        failing : () => { throw new Error( 'Bad input row' ); }
                    }
                }
            });

            // Empty array fast-path
            expect( await posts.createManyFrom([]) ).toEqual([]);

            // Default 'from' converter
            const ids1 = await posts.createManyFrom([ '  First  ', '  Second  ' ]);
            expect( ids1 ).toHaveLength( 2 );

            // Named converter ('csv') with explicit IDs and options
            const ids2 = await posts.createManyFrom(
                'csv',
                [{ headline: 'News A' }, { headline: 'News B' }],
                [ 'custom_a', 'custom_b' ],
                { ordered: true }
            );
            expect( ids2 ).toEqual([ 'custom_a', 'custom_b' ]);

            // Default 'from' with options as second argument
            const ids3 = await posts.createManyFrom([ 'Third' ], { ordered: false });
            expect( ids3 ).toHaveLength( 1 );

            // Named 'from' with options as third argument
            const ids4 = await posts.createManyFrom( 'csv', [{ headline: 'News C' }], { ordered: true });
            expect( ids4 ).toHaveLength( 1 );

            // Converter error wraps into ModelConverterError and emits error event
            await expect( posts.createManyFrom( 'failing', [ 'bad' ]) )
                .rejects.toThrow( ModelConverterError );

            // PropertyModel createManyFrom
            const comments = definePropertyModel( models, mock.collection,
            {
                path        : 'comments[]',
                id          : 'base62',
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : ( dbe: CommentDBE ) => ({ id: dbe.id, text: dbe.text })
                    },
                    from:
                    {
                        default : ( text: string ) => ({ text }),
                        tagged  : ( input: { body: string, tag: string } ) => ({ text: `[${input.tag}] ${input.body}` }),
                        broken  : () => { throw new Error( 'Broken comment input' ); }
                    }
                }
            });

            expect( await comments.createManyFrom( 'p1', [] ) ).toEqual([]);

            const cIds1 = await comments.createManyFrom( 'p1', [ 'Hello', 'World' ]);
            expect( cIds1 ).toHaveLength( 2 );

            const cIds2 = await comments.createManyFrom(
                'p1',
                'tagged',
                [{ body: 'Nice', tag: 'vip' }],
                [ 'c_vip_1' ],
                { traceID: 'tr-c' }
            );
            expect( cIds2 ).toEqual([ 'c_vip_1' ]);

            await expect( comments.createManyFrom( 'p1', 'broken', [ 'x' ]) )
                .rejects.toThrow( ModelConverterError );
        });
    });

    describe( '10. Configurable Collation, maxTimeMS, Index Hint, & ReadPreference', () =>
    {
        it( 'resolves container-level, model-level, and per-call query execution options including collation: false and locale shorthand', async() =>
        {
            expect( resolveCollationOption( undefined ) ).toEqual({ locale: 'en' });
            expect( resolveCollationOption( undefined, undefined, false ) ).toBeUndefined();
            expect( resolveCollationOption( false ) ).toBeUndefined();
            expect( resolveCollationOption( 'cs' ) ).toEqual({ locale: 'cs' });
            expect( resolveCollationOption({ locale: 'de', strength: 2 }) ).toEqual({ locale: 'de', strength: 2 });

            const models = new TestModels({
                queryDefaults:
                {
                    collation       : 'cs',
                    maxTimeMS       : 2500,
                    readPreference  : 'secondaryPreferred'
                }
            });

            const mock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'Alpha', authorId: 'a1' }
            ]);

            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                maxTimeMS   : 1500,
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            // 1. Default inherited collation ('cs'), model maxTimeMS (1500), container readPreference ('secondaryPreferred')
            await posts.list();
            expect( mock.spies.aggregate ).toHaveBeenLastCalledWith(
                expect.any( Array ),
                expect.objectContaining({
                    collation       : { locale: 'cs' },
                    maxTimeMS       : 1500,
                    readPreference  : 'secondaryPreferred'
                })
            );

            // 2. Per-call override: collation: false (disables collation for binary index scan), custom hint & maxTimeMS
            await posts.list({
                collation   : false,
                maxTimeMS   : 500,
                hint        : 'title_1'
            });
            const lastCallOpts = mock.spies.aggregate.mock.calls.at( -1 )?.[1];
            expect( lastCallOpts.collation ).toBeUndefined();
            expect( lastCallOpts.maxTimeMS ).toBe( 500 );
            expect( lastCallOpts.hint ).toBe( 'title_1' );

            // 3. find, exists, distinct, aggregate with per-call query execution options
            await posts.find({ filter: { title: 'Alpha' }, collation: 'sk', maxTimeMS: 800, hint: { title: 1 } });
            expect( mock.spies.aggregate ).toHaveBeenLastCalledWith(
                expect.any( Array ),
                expect.objectContaining({
                    collation   : { locale: 'sk' },
                    maxTimeMS   : 800,
                    hint        : { title: 1 }
                })
            );

            await posts.exists({ title: 'Alpha' }, { collation: false, maxTimeMS: 300 });
            expect( mock.spies.aggregate.mock.calls.at( -1 )?.[1]?.collation ).toBeUndefined();
            expect( mock.spies.aggregate.mock.calls.at( -1 )?.[1]?.maxTimeMS ).toBe( 300 );

            await posts.distinct( 'authorId', { title: 'Alpha' }, { collation: 'de', maxTimeMS: 400 });
            expect( mock.spies.aggregate ).toHaveBeenLastCalledWith(
                expect.any( Array ),
                expect.objectContaining({
                    collation   : { locale: 'de' },
                    maxTimeMS   : 400
                })
            );
        });
    });

    describe( '11. Transient Error & WriteConflict Retry with Exponential Backoff', () =>
    {
        it( 'detects transient MongoDB errors and retries operations and transactions with exponential backoff', async() =>
        {
            expect( isTransientMongoError( null ) ).toBe( false );
            expect( isTransientMongoError({ code: 112 }) ).toBe( true ); // WriteConflict
            expect( isTransientMongoError({ codeName: 'PrimarySteppedDown' }) ).toBe( true );
            expect( isTransientMongoError({ errorLabels: [ 'TransientTransactionError' ] }) ).toBe( true );
            expect( isTransientMongoError({ hasErrorLabel: ( l: string ) => l === 'UnknownTransactionCommitResult' }) ).toBe( true );
            expect( isTransientMongoError( new Error( 'ECONNRESET socket hang up' )) ).toBe( true );
            expect( isTransientMongoError( new Error( 'Validation failed' )) ).toBe( false );

            expect( resolveRetryConfig( undefined ) ).toBeUndefined();
            expect( resolveRetryConfig( false ) ).toBeUndefined();
            expect( resolveRetryConfig( true )?.maxAttempts ).toBe( 3 );
            expect( resolveRetryConfig( 5 )?.maxAttempts ).toBe( 5 );

            const retryHooks: number[] = [];
            let attempts = 0;
            const res = await executeWithTransientRetry(
                async( attempt ) =>
                {
                    attempts = attempt;
                    if( attempt < 3 )
                    {
                        throw Object.assign( new Error( 'WriteConflict' ), { code: 112 });
                    }

                    return 'committed';
                },
                {
                    maxAttempts     : 4,
                    baseDelayMs     : 1,
                    maxDelayMs      : 5,
                    jitter          : false,
                    onRetry         : ( _err, attempt ) => { retryHooks.push( attempt ); }
                }
            );

            expect( res ).toBe( 'committed' );
            expect( attempts ).toBe( 3 );
            expect( retryHooks ).toEqual([ 1, 2 ]);

            // Non-transient error fails immediately without retry
            let nonTransientCalls = 0;
            await expect( executeWithTransientRetry(
                async() =>
                {
                    nonTransientCalls++;
                    throw new Error( 'Syntax error' );
                },
                { maxAttempts: 4, baseDelayMs: 1 }
            )).rejects.toThrow( 'Syntax error' );
            expect( nonTransientCalls ).toBe( 1 );

            // Model & Models withRetry + models.transaction with retry
            const models = new TestModels({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
            const mock = createRichCollectionMock( 'posts', [{ _id: 'p1', title: 'RetryDoc' }]);
            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                retry       : { maxAttempts: 3, baseDelayMs: 1 },
                converters  :
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            let modelRetryCount = 0;
            const modelVal = await posts.withRetry( async() =>
            {
                modelRetryCount++;
                if( modelRetryCount < 2 )
                {
                    throw Object.assign( new Error( 'NotWritablePrimary' ), { code: 10107 });
                }

                return await posts.get( 'p1' );
            });
            expect( modelVal ).toEqual({ id: 'p1', title: 'RetryDoc' });
            expect( modelRetryCount ).toBe( 2 );

            let txAttempts = 0;
            const txResult = await models.transaction( async() =>
            {
                txAttempts++;
                if( txAttempts < 2 )
                {
                    throw Object.assign( new Error( 'TransientTransactionError' ), {
                        errorLabels: [ 'TransientTransactionError' ]
                    });
                }

                return 'tx-ok';
            }, { retry: { maxAttempts: 3, baseDelayMs: 1 } });

            expect( txResult ).toBe( 'tx-ok' );
            expect( txAttempts ).toBe( 2 );

            // models.withRetry & custom shouldRetry + maxAttempts: 1
            expect( await models.withRetry( async() => 'direct', false ) ).toBe( 'direct' );
            let customAttempts = 0;
            const customRes = await models.withRetry( async() =>
            {
                customAttempts++;
                if( customAttempts === 1 ){ throw new Error( 'CustomTransient' ) }

                return 'custom-ok';
            }, { maxAttempts: 2, baseDelayMs: 0, jitter: true, shouldRetry: err => ( err as Error ).message === 'CustomTransient' });
            expect( customRes ).toBe( 'custom-ok' );
        });
    });

    describe( '12. Observability PII / Secret Redaction', () =>
    {
        it( 'redacts sensitive fields recursively in observability query, mutation, slowQuery, and error events', async() =>
        {
            const redacted = redactSensitiveData(
                {
                    email       : 'user@example.com',
                    password    : 'super-secret',
                    nested      : { apiKey: 'k-123', safe: 'ok' },
                    items       : [{ access_token: 'tok-abc', title: 'item1' }]
                },
                new Set([ 'password', 'apikey', 'access_token' ]),
                '***'
            );

            expect( redacted ).toEqual({
                email       : 'user@example.com',
                password    : '***',
                nested      : { apiKey: '***', safe: 'ok' },
                items       : [{ access_token: '***', title: 'item1' }]
            });

            const capturedQueries: any[] = [];
            const capturedMutations: any[] = [];
            const capturedErrors: any[] = [];

            const models = new TestModels({
                observability:
                {
                    redactFields        : [ 'password', 'secretToken', 'ssn' ],
                    redactReplacement   : '[MASKED]',
                    onQuery             : ev => { capturedQueries.push( ev ); },
                    onMutation          : ev => { capturedMutations.push( ev ); },
                    onError             : ev => { capturedErrors.push( ev ); }
                }
            });

            const mock = createRichCollectionMock( 'users', [
                { _id: 'u1', title: 'Alice' }
            ]);
            const users = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters:
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            await users.list({
                filter  : { title: 'Alice', password: 'plain-password' } as any,
                context : { secretToken: 'jwt-xyz', tenant: 't1' }
            });

            expect( capturedQueries ).toHaveLength( 1 );
            expect( JSON.stringify( capturedQueries[0].pipeline ) ).toContain( '[MASKED]' );
            expect( JSON.stringify( capturedQueries[0].pipeline ) ).not.toContain( 'plain-password' );
            expect( capturedQueries[0].query?.filter ).toEqual({ title: 'Alice', password: '[MASKED]' });
            expect( capturedQueries[0].context ).toEqual({ secretToken: '[MASKED]', tenant: 't1' });

            await users.update( 'u1', { title: 'Bob', ssn: '123-45-6789' } as any, {
                documentBefore  : true,
                documentAfter   : true
            });

            expect( capturedMutations ).toHaveLength( 1 );
            expect( ( capturedMutations[0].update as any )?.$set?.ssn ).toBe( '[MASKED]' );
            expect( ( capturedMutations[0].documentAfter as any )?.ssn ).toBe( '[MASKED]' );

            // Error event redaction with default redactFields: true
            const modelsDefaultRedact = new TestModels({
                observability:
                {
                    redactFields    : true,
                    onError         : ev => { capturedErrors.push( ev ); }
                }
            });
            const errUsers = defineModel<PostDBE, PostDTO>( modelsDefaultRedact, mock.collection,
            {
                converters:
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            mock.spies.aggregate.mockImplementationOnce(() => ({
                toArray : vi.fn().mockRejectedValue( new Error( 'DB boom' ))
            }));

            await expect( errUsers.find({ filter: { password: 'leaked-pw' } as any }) ).rejects.toThrow( 'DB boom' );
            expect( capturedErrors ).toHaveLength( 1 );
            expect( capturedErrors[0].filter ).toEqual({ password: '[REDACTED]' });
        });
    });

    describe( '13. Cursor-Paginated Batch Processor (forEachBatch) & Backfill Helper (backfill)', () =>
    {
        it( 'streams documents in batches and performs chunked bulkWrite backfills on AbstractModel and AbstractPropertyModel', async() =>
        {
            const models = new TestModels();
            const mock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'post one', comments: [{ id: 'c1', text: 'old 1' }, { id: 'c2', text: 'old 2' }] },
                { _id: 'p2', title: 'post two', comments: [] },
                { _id: 'p3', title: 'post three', comments: [] }
            ]);

            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters:
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title })
                    }
                }
            });

            // 1. forEachBatch with batchSize: 2 and early termination
            const seenBatches: string[][] = [];
            const processed = await posts.forEachBatch({ batchSize: 2 }, async( batch, meta ) =>
            {
                seenBatches.push( batch.map( p => p.id ));
                if( meta.batchIndex === 0 ){ return false }
            });

            expect( processed ).toEqual({ batches: 1, processed: 2 });
            expect( seenBatches ).toEqual([[ 'p1', 'p2' ]]);

            // 2. forEachBatch with callback as first arg and maxItems
            const allIds: string[] = [];
            await posts.forEachBatch( item => { allIds.push( ...item.map( d => d.id )); });
            expect( allIds ).toEqual([ 'p1', 'p2', 'p3' ]);

            // 3. backfill with dryRun: true (does not invoke collection.bulkWrite)
            mock.spies.bulkWrite.mockClear();
            const progressSnapshots: any[] = [];
            const dryRes = await posts.backfill(
                doc => doc._id === 'p2' ? null : { title: doc.title.toUpperCase() },
                {
                    batchSize   : 2,
                    dryRun      : true,
                    onProgress  : p => { progressSnapshots.push({ ...p }); }
                }
            );

            expect( dryRes ).toEqual({
                batches     : 2,
                scanned     : 3,
                matched     : 2,
                modified    : 2,
                skipped     : 1,
                dryRun      : true
            });
            expect( mock.spies.bulkWrite ).not.toHaveBeenCalled();
            expect( progressSnapshots ).toHaveLength( 2 );

            // 4. backfill live execution (invokes bulkWrite in chunks)
            mock.spies.bulkWrite.mockResolvedValue({
                insertedCount   : 0,
                matchedCount    : 2,
                modifiedCount   : 2,
                deletedCount    : 0,
                upsertedCount   : 0,
                upsertedIds     : {}
            });

            const liveRes = await posts.backfill(
                doc => ({ $set: { title: `${doc.title}!` } }),
                { batchSize: 2, maxItems: 2 }
            );

            expect( liveRes.scanned ).toBe( 2 );
            expect( liveRes.modified ).toBe( 2 );
            expect( mock.spies.bulkWrite ).toHaveBeenCalledTimes( 1 );

            // 5. PropertyModel backfill on subdocuments
            const comments = definePropertyModel<PostDBE, CommentDBE, CommentDTO>( models, mock.collection,
            {
                path        : 'comments[]',
                converters  :
                {
                    dto:
                    {
                        projection  : { id: 1, text: 1 },
                        converter   : dbe => ({ id: dbe.id, text: dbe.text })
                    }
                }
            });

            // Mock list on comments to return subdocs
            vi.spyOn( comments, 'list' ).mockResolvedValue([
                { id: 'c1', text: 'old 1' },
                { id: 'c2', text: 'old 2' }
            ] as any );

            const propDry = await comments.backfill(
                sub => sub.id === 'c1' ? { text: 'NEW 1' } : null,
                { dryRun: true }
            );
            expect( propDry ).toEqual({
                batches     : 1,
                scanned     : 2,
                matched     : 1,
                modified    : 1,
                skipped     : 1,
                dryRun      : true
            });

            mock.spies.updateOne.mockClear();

            const propLive = await comments.backfill(
                sub => ({ $set: { text: `${sub.text} updated` } }),
                { batchSize: 1, maxBatches: 1 }
            );
            expect( propLive.scanned ).toBe( 1 );
            expect( propLive.modified ).toBe( 1 );
            expect( mock.spies.updateOne ).toHaveBeenCalledTimes( 1 );
        });
    });

    describe( '14. Declarative Audit Trail (audit callback & MongoDB collection)', () =>
    {
        it( 'captures create, update (with automatic before/after snapshots & field-level diff), and delete audit entries with redaction', async() =>
        {
            expect( resolveAuditConfig( undefined ) ).toBeUndefined();
            expect( resolveAuditConfig( false ) ).toBeUndefined();
            expect( resolveAuditConfig({ enabled: false }) ).toBeUndefined();
            expect( resolveAuditConfig( true )?.collection ).toBe( 'audit_logs' );
            expect( resolveAuditConfig( 'custom_audit' )?.collection ).toBe( 'custom_audit' );
            const auditFn = vi.fn();
            expect( resolveAuditConfig( auditFn )?.onAudit ).toBe( auditFn );

            expect( computeAuditDiff( undefined, { a: 1 }) ).toBeUndefined();
            const oidA = new ObjectId();
            expect( computeAuditDiff({ _id: oidA }, { _id: new ObjectId( String( oidA )) }) ).toBeUndefined();

            const directDiff = computeAuditDiff(
                { _id: '1', title: 'Old', tags: [ 'a' ], secret: 's1' },
                { _id: '1', title: 'New', tags: [ 'a', 'b' ], secret: 's2' },
                new Set([ 'secret' ])
            );
            expect( directDiff ).toEqual({
                title   : { before: 'Old', after: 'New' },
                tags    : { before: [ 'a' ], after: [ 'a', 'b' ] }
            });

            const auditEntries: any[] = [];
            const auditCollMock = createRichCollectionMock( 'audit_logs', []);

            const models = new TestModels({
                audit:
                {
                    collection      : auditCollMock.collection,
                    onAudit         : entry => { auditEntries.push( entry ); },
                    redactFields    : [ 'secretNote' ]
                }
            });

            const mock = createRichCollectionMock( 'posts', [
                { _id: 'p1', title: 'Original Title', authorId: 'a1' }
            ]);

            const posts = defineModel<PostDBE, PostDTO>( models, mock.collection,
            {
                converters:
                {
                    dto:
                    {
                        projection  : { _id: 1, title: 1, authorId: 1 },
                        converter   : dbe => ({ id: dbe._id, title: dbe.title, authorId: dbe.authorId })
                    }
                }
            });

            // 1. Create records 'create' audit entry
            await posts.create({ title: 'Created Post', authorId: 'a2' }, 'p2', {
                context : { actor: 'admin' },
                traceID : 'tr-audit-1'
            });

            expect( auditEntries ).toHaveLength( 1 );
            expect( auditEntries[0] ).toMatchObject({
                collection  : 'posts',
                action      : 'create',
                method      : 'create',
                documentId  : 'p2',
                context     : { actor: 'admin' },
                traceID     : 'tr-audit-1'
            });
            expect( auditCollMock.spies.insertOne ).toHaveBeenCalledTimes( 1 );

            // 2. Update automatically fetches documentBefore & documentAfter for audit diff even when caller did not request them!
            const updateResult = await posts.update( 'p1', {
                title       : 'Updated Title',
                secretNote  : 'top-secret'
            } as any );

            // Caller did not pass documentBefore/documentAfter, so updateResult only has modifiedCount & matchedCount
            expect( updateResult ).toEqual({ modifiedCount: 1, matchedCount: 1 });

            expect( auditEntries ).toHaveLength( 2 );
            const updateAudit = auditEntries[1];
            expect( updateAudit.action ).toBe( 'update' );
            expect( updateAudit.method ).toBe( 'update' );
            expect( updateAudit.documentId ).toBe( 'p1' );
            expect( updateAudit.before ).toMatchObject({ _id: 'p1', title: 'Original Title' });
            expect( updateAudit.after ).toMatchObject({ _id: 'p1', title: 'Updated Title', secretNote: '[REDACTED]' });
            expect( updateAudit.changes ).toEqual({
                title: { before: 'Original Title', after: 'Updated Title' }
            });

            // 3. Delete records 'delete' audit entry
            await posts.delete( 'p1' );
            expect( auditEntries ).toHaveLength( 3 );
            expect( auditEntries[2] ).toMatchObject({
                action      : 'delete',
                method      : 'delete',
                documentId  : 'p1'
            });
        });
    });
});
