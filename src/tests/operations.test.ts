import { ObjectId } from 'mongodb';
import { describe, expect, test } from 'vitest';
import { ConverterManager } from '../converters.js';
import
{
    attachCursorToItem,
    attachListMetadata,
    attachPropertyUpdateMetadata,
    buildListResult,
    buildPropertyDeleteOperation,
    convertDocuments,
    isCreateOptionsObject,
    isFindOptionsObject,
    normalizeExistsOptions,
    normalizeFindMatch,
    normalizeGetManyOptions,
    normalizeGetOptions,
    resolveCreateFromArgs
}
from '../operations.js';

class SampleModel {}

describe( 'operations', () =>
{
    test( 'buildListResult returns cursors and optional reverse', () =>
    {
        const items =
        [
            { _id: '1', name: 'a' },
            { _id: '2', name: 'b' }
        ];
        const sort = { _id: 1 as const };

        const forward = buildListResult( items, sort, { total: 2 });
        const reversed = buildListResult( items, sort, { reversed: true });
        const empty = buildListResult([], sort );

        expect( forward.items ).toEqual( items );
        expect( forward.total ).toBe( 2 );
        expect( forward.cursors.prev ).toBeDefined();
        expect( forward.cursors.next ).toBeDefined();
        expect( reversed.items.map( i => i._id )).toEqual([ '2', '1' ]);
        expect( empty.cursors.prev ).toBeUndefined();
        expect( empty.cursors.next ).toBeUndefined();
    });

    test( 'attachListMetadata and attachCursorToItem attach non-enumerable properties', () =>
    {
        const item = attachCursorToItem({ id: '1' }, { _id: '1' }, { _id: 1 });
        const primitive = attachCursorToItem( 'raw' as any, { _id: '1' }, { _id: 1 });
        const list = attachListMetadata([ item ], 5, { next: 'n1' });

        expect( item.$cursor ).toBeDefined();
        expect( Object.keys( item )).toEqual([ 'id' ]);
        expect( primitive ).toBe( 'raw' );
        expect( list.items ).toBe( list );
        expect( list.total ).toBe( 5 );
        expect( list.cursors.next ).toBe( 'n1' );
        expect( Object.keys( list )).toEqual([ '0' ]);
    });

    test( 'isCreateOptionsObject and resolveCreateFromArgs disambiguate overloads', () =>
    {
        expect( isCreateOptionsObject({ duplicateIgnore: true })).toBe( true );
        expect( isCreateOptionsObject({ access: 'admin' })).toBe( true );
        expect( isCreateOptionsObject( new ObjectId() )).toBe( false );
        expect( isCreateOptionsObject({ name: 'Alice' })).toBe( false );
        expect( isCreateOptionsObject( null )).toBe( false );

        const fromMap = { default: () => ({}), csv: () => ({}) };
        const singleMap = { csv: () => ({}) };
        const validHex = new ObjectId().toHexString();

        expect( resolveCreateFromArgs( fromMap, { access: 'admin' })).toEqual({ resolvedOptions: { access: 'admin' } });
        expect( resolveCreateFromArgs( fromMap, 'csv', { duplicateIgnore: true })).toEqual(
        {
            fromKey         : 'csv',
            resolvedOptions : { duplicateIgnore: true }
        });
        expect( resolveCreateFromArgs( fromMap, 'csv', validHex, { access: 'admin' })).toEqual(
        {
            fromKey         : 'csv',
            explicitId      : validHex,
            resolvedOptions : { access: 'admin' }
        });
        expect( resolveCreateFromArgs( fromMap, validHex, { duplicateIgnore: true })).toEqual(
        {
            explicitId      : validHex,
            resolvedOptions : { duplicateIgnore: true }
        });
        expect( resolveCreateFromArgs( singleMap, validHex )).toEqual(
        {
            explicitId      : validHex,
            resolvedOptions : undefined
        });
        expect( resolveCreateFromArgs( singleMap, 'unknownKey' )).toEqual(
        {
            fromKey         : 'unknownKey',
            explicitId      : undefined,
            resolvedOptions : undefined
        });
        expect( resolveCreateFromArgs( undefined, 'anyKey', { access: 'admin' })).toEqual(
        {
            fromKey         : 'anyKey',
            resolvedOptions : { access: 'admin' }
        });
    });

    test( 'isFindOptionsObject, normalizeFindMatch, and normalizeExistsOptions handle all input shapes', () =>
    {
        expect( isFindOptionsObject({ filter: { name: 'a' } })).toBe( true );
        expect( isFindOptionsObject({ smartFilter: { search: 'a' } })).toBe( true );
        expect( isFindOptionsObject({ access: 'admin' })).toBe( true );
        expect( isFindOptionsObject({ access: 'admin', name: 'a' })).toBe( false );
        expect( isFindOptionsObject( new ObjectId() )).toBe( false );

        expect( normalizeFindMatch({ filter: { x: 1 }, access: 'user' }, 'admin' )).toEqual(
        {
            filter      : { x: 1 },
            smartFilter : undefined,
            access      : 'admin'
        });
        expect( normalizeFindMatch({ smartFilter: { q: 'hi' }, access: 'user' })).toEqual(
        {
            filter      : {},
            smartFilter : { q: 'hi' },
            access      : 'user'
        });
        expect( normalizeFindMatch( undefined as any, 'guest' )).toEqual(
        {
            filter : {},
            access : 'guest'
        });

        expect( normalizeExistsOptions( undefined, '_id', id => id, 'admin' )).toEqual({ filter: {}, access: 'admin' });
        expect( normalizeExistsOptions( '123', '_id', id => `dbe:${id}` )).toEqual({ filter: { _id: 'dbe:123' }, access: undefined });
        expect( normalizeExistsOptions( 42, 'id', id => id )).toEqual({ filter: { id: 42 }, access: undefined });
        expect( normalizeExistsOptions({ filter: { active: true } }, '_id', id => id )).toEqual(
        {
            filter      : { active: true },
            smartFilter : undefined,
            access      : undefined
        });
        expect( normalizeExistsOptions({ active: true }, '_id', id => id )).toEqual(
        {
            filter : { active: true },
            access : undefined
        });
    });

    test( 'normalizeGetOptions and normalizeGetManyOptions normalize string and object forms', () =>
    {
        expect( normalizeGetOptions() ).toEqual({});
        expect( normalizeGetOptions( 'dbe' )).toEqual({ as: 'dbe' });
        expect( normalizeGetOptions({ as: 'dbe', access: 'admin' })).toEqual({ as: 'dbe', access: 'admin' });

        expect( normalizeGetManyOptions() ).toEqual({});
        expect( normalizeGetManyOptions( 'dbe', true )).toEqual({ as: 'dbe', filter: true });
        expect( normalizeGetManyOptions({ as: 'dbe' }, false )).toEqual({ as: 'dbe', filter: false });
    });

    test( 'attachPropertyUpdateMetadata and buildPropertyDeleteOperation build expected structures', () =>
    {
        const meta = attachPropertyUpdateMetadata(
        {
            matchedCount    : 2,
            modifiedCount   : 1,
            documentBefore  : { id: 1 },
            documentAfter   : { id: 1, name: 'x' }
        });

        expect( meta.matchedCount ).toBe( 2 );
        expect( meta.modifiedCount ).toBe( 1 );
        expect( meta.matchedRootCount ).toBe( 2 );
        expect( meta.modifiedRootCount ).toBe( 1 );
        expect( meta.documentBefore ).toEqual({ id: 1 });
        expect( meta.documentAfter ).toEqual({ id: 1, name: 'x' });
        expect( Object.keys( meta )).toEqual([ 'matchedCount', 'modifiedCount', 'documentBefore', 'documentAfter' ]);

        const arrayLeaf = buildPropertyDeleteOperation(
            [{ path: 'groups', array: true }, { path: 'items', array: true }],
            'item-1'
        );
        expect( arrayLeaf.operations ).toEqual({ $pull: { 'groups.$[].items': { id: 'item-1' } } });
        expect( arrayLeaf.updateOptions ).toEqual({});

        const objectLeafWithArrayParent = buildPropertyDeleteOperation(
            [{ path: 'groups', array: true }, { path: 'meta', array: false }],
            'meta-1'
        );
        expect( objectLeafWithArrayParent.operations ).toEqual({ $unset: { 'groups.$[entry].meta': '' } });
        expect( objectLeafWithArrayParent.updateOptions ).toEqual({ arrayFilters: [{ 'entry.meta.id': 'meta-1' }] });

        const singleObjectLeaf = buildPropertyDeleteOperation(
            [{ path: 'profile', array: false }],
            'prof-1'
        );
        expect( singleObjectLeaf.operations ).toEqual({ $unset: { profile: '' } });
        expect( singleObjectLeaf.updateOptions ).toEqual({});
    });

    test( 'convertDocuments converts and optionally filters nulls', async() =>
    {
        const converters = new ConverterManager( new SampleModel(), {
            dto: { converter: async( dbe: any ) => ({ id: dbe._id }) }
        });

        const documents = [{ _id: '1' }, null, { _id: '2' }] as any[];

        const all = await convertDocuments( converters, documents, 'dto' );
        const filtered = await convertDocuments( converters, documents, 'dto', true );

        expect( all ).toEqual([{ id: '1' }, null, { id: '2' }]);
        expect( filtered ).toEqual([{ id: '1' }, { id: '2' }]);
    });
});

