import { Document, FindOptions } from 'mongodb';
import { AbstractModelConverter, AbstractModelProperties, AbstractModelSmartFilters } from './external.js';

export type FirstParameter<T> = T extends ( arg: infer P ) => any ? P : never;
export type PublicMethodNames<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];

export type AsyncSmartFilterMethod = ( params: any ) => Promise<{ pipeline: Document[] | null, filter: Document | null }>
export type SyncSmartFilterMethod = ( params: any ) => { pipeline: Document[] | null, filter: Document | null }
export type SmartFilterMethod = AsyncSmartFilterMethod | SyncSmartFilterMethod;

export type AsyncComputedPropertyMethod = ( params: any ) => Promise<{ fields: Document | null, pipeline: Document[] | null }>;
export type SyncComputedPropertyMethod = ( params: any ) => { fields: Document | null, pipeline: Document[] | null };
export type ComputedPropertyMethod = AsyncComputedPropertyMethod | SyncComputedPropertyMethod;

export type AbstractModelFromConverter
<
    DBE extends Document,
    T
>
=
( data: T ) => ( Omit<DBE, '_id'> & { _id?: DBE['_id'] }) | ( Promise<Omit<DBE, '_id'> & { _id?: DBE['_id'] }> );

export type AbstractConverterOptions
<
    DBE extends Document,
    ComputedProperties extends AbstractModelProperties<any> = never
>
=
{
    converter           : AbstractModelConverter<DBE>
    projection?         : FindOptions['projection']
    computedProperties? : ComputedPropertiesParam<ComputedProperties>
}

export type ComputedPropertiesParam<T extends AbstractModelProperties<any>> =
    ( keyof T )[]
    | ( ( ...args: any ) => ( keyof T )[] )
    | { [K in keyof T]?: FirstParameter<T[K]> }

export type TypeMap<T extends any[]> = T extends [ infer U, ...infer Rest ]
    ? [ AbstractModelSmartFilters<U>, ...TypeMap<Rest> ]
    : [];

type FilterUndefined<T> = T extends undefined ? never : T;

export type ExpandPaths<T, Prefix extends string = ''> = FilterUndefined<T extends import( 'mongodb' ).ObjectId
    ? Prefix extends `${infer P}.`
        ? P
        : Prefix
    : T extends ( infer U )[]
        ? `${Prefix}${number}` | ExpandPaths<U, `${Prefix}${number}.`>
        : T extends object
            ? {
                [K in keyof T]:
                K extends string
                    ? T[K] extends object
                    ? `${Prefix}${K}` | ExpandPaths<T[K], `${Prefix}${K}.`>
                    : `${Prefix}${K}`
                    : never
            }[keyof T]
            : never>;

export type PathValue<T, Path extends string> = Path extends `${infer P}.${infer Rest}`
    ? P extends `${number}`
        ? T extends ( infer U )[]
            ? PathValue<U, Rest>
            : never
        : P extends keyof T
            ? T[P] extends ( infer U )[]
                ? Rest extends `${number}.${infer R}`
                    ? PathValue<U, R>
                    : Rest extends `${number}`
                        ? U
                        : PathValue<T[P], Rest>
                : PathValue<T[P], Rest>
            : never
    : Path extends `${number}`
        ? T extends ( infer U )[]
            ? U
            : never
        : Path extends keyof T
            ? T[Path]
            : never;
