import { Document } from 'mongodb';
import { AbstractModelConverters } from './types/external.js';
import { CompileConverterContext } from './types/definition.js';

export function createDefaultConverters<DBE extends Document>(
    ctx: CompileConverterContext
): Pick<AbstractModelConverters<DBE>, 'dto' | 'dbe'>
{
    return {
        dto:
        {
            converter: ( dbe: DBE ) =>
            {
                if( '_id' in dbe && ( dbe as { _id?: unknown })._id !== undefined )
                {
                    const { _id, ...rest } = dbe as DBE & { _id: unknown };

                    return { ...rest, id: ctx.dtoID( _id ) };
                }

                const copy = { ...( dbe as Record<string, unknown> ) };

                if( 'id' in copy && copy.id !== undefined )
                {
                    copy.id = ctx.dtoID( copy.id );
                }

                return copy;
            }
        },
        dbe:
        {
            converter: ( dbe: DBE ) => dbe
        }
    };
}
