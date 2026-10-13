import { describe, expect, test, vi } from 'vitest';
import { ConverterManager } from '../converters.js';
import { buildListResult, convertDocuments } from '../operations.js';

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
