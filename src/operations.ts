import { Document } from 'mongodb';
import { getCursor } from './helpers/mongo.js';
import { ConverterManager } from './converters.js';
import { ListResult, WithTotal } from './types/external.js';

export function attachListMetadata<T>(
    items: T[],
    total: number | undefined,
    cursors: { prev?: string, next?: string }
): WithTotal<T[]>
{
    Object.defineProperties( items,
    {
        items   : { value: items, enumerable: false, writable: false, configurable: true },
        total   : { value: total, enumerable: false, writable: false, configurable: true },
        cursors : { value: cursors, enumerable: false, writable: false, configurable: true }
    });

    return items as WithTotal<T[]>;
}

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
