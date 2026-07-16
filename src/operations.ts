import { Document } from 'mongodb';
import { getCursor } from './helpers/mongo.js';
import { ConverterManager } from './converters.js';
import { ListResult } from './types/external.js';

export function buildListResult<T extends Document>(
    items: T[],
    sort: Document,
    options?: { total?: number, reversed?: boolean }
): ListResult<T>
{
    const ordered = options?.reversed ? [ ...items ].reverse() : items;
    const first = ordered[0];
    const last = ordered[ordered.length - 1];

    return {
        items   : ordered,
        total   : options?.total,
        cursors :
        {
            prev    : first ? getCursor( first, sort ) : undefined,
            next    : last ? getCursor( last, sort ) : undefined
        }
    };
}

export async function convertDocuments
<
    DBE extends Document,
    K extends string | number | symbol
>(
    converters: ConverterManager<DBE>,
    documents: Array<DBE | null>,
    conversion: K,
    filtered: boolean = false
)
{
    let entries = await converters.convertMany( documents, conversion as any );

    if( filtered )
    {
        entries = entries.filter( Boolean );
    }

    return entries;
}
