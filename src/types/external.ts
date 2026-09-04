import { Document, Filter, FindOptions, ObjectId } from 'mongodb';
import
{
    AbstractConverterOptions,
    AbstractModelFromConverter,
    ComputedPropertyMethod,
    ComputedPropertiesParam,
    ExpandPaths,
    FirstParameter,
    PathValue,
    PublicMethodNames,
    SmartFilterMethod
}
from './internal.js';

export type ModelCreateOptions = { duplicateIgnore?: boolean };
export type ModelUpdateOptions = { documentBefore?: boolean, documentAfter?: boolean };
export type MongoRootDocument = Document & { _id: any };
export type MongoPropertyDocument = Document & { id: any };

export type ListResult<T> =
{
    items   : T[]
    total?  : number
    cursors : { next?: string, prev?: string }
}

export type GetOptions<K extends string | number | symbol = 'dto'> =
{
    as? : K
}

export type GetManyOptions<K extends string | number | symbol = 'dto'> =
{
    as?     : K
    filter? : boolean
}

export type ModelSmartFilter<T> = { [K in PublicMethodNames<T>]?: FirstParameter<T[K]> }

export type PropertyModelFilter<RootDBE extends Document, DBE extends Document> = Filter<DBE> & { _root?: Filter<RootDBE> };

export type ModelListOptions<DBE extends Document, Filters = never> = FindOptions &
{
    filter?      : Filter<DBE>
    smartFilter? : ModelSmartFilter<Filters>
    cursor?      : string
    pipeline?    : Document[]
    count?       : boolean
    sample?      : number
    countLimit?  : number
};

export type ModelStreamOptions<DBE extends Document, Filters = never> =
    Omit<ModelListOptions<DBE, Filters>, 'count' | 'countLimit'>;

export type PropertyModelListOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never
>
= Omit<FindOptions, 'projection'> &
{
    filter?      : PropertyModelFilter<RootDBE, DBE>
    smartFilter? : ModelSmartFilter<FirstType<Filters>>
    cursor?      : string
    projection?  : FindOptions['projection'] & { _root?: FindOptions['projection'] }
    pipeline?    : Document[]
    count?       : boolean
    sample?      : number
    countLimit?  : number
};

export type PropertyModelStreamOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never
>
= Omit<PropertyModelListOptions<RootDBE, DBE, Filters>, 'count' | 'countLimit'>;

export type ModelFindOptions<DBE extends Document, Filters = never> =
{
    filter?      : Filter<DBE>
    smartFilter? : ModelSmartFilter<Filters>
}

export type PropertyModelFindOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never
>
=
{
    filter?      : PropertyModelFilter<RootDBE, DBE>
    smartFilter? : ModelSmartFilter<SecondType<Filters>>
}

export type ModelAggregateOptions
<
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never,
    Properties extends AbstractModelProperties<any> = never
>
=
{
    filter?             : Filter<DBE>
    smartFilter?        : ModelSmartFilter<Filters>
    computedProperties? : ComputedPropertiesParam<Properties>
    projection?         : FindOptions['projection']
    sort?               : FindOptions['sort']
};

export type PropertyModelAggregateOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractPropertyModelSmartFilters<any, any> = never,
    Properties extends AbstractPropertyModelComputedProperties<any, any> = never
>
=
{
    filter?             : PropertyModelFilter<RootDBE, DBE>
    smartFilter?        : ModelSmartFilter<SecondType<Filters>>
    computedProperties? : ComputedPropertiesParam<SecondType<Properties>>
    projection?         : FindOptions['projection']
    sort?               : FindOptions['sort']
};

export type FirstType<T> = T extends [ infer U, ...unknown[] ] ? U : undefined;
export type SecondType<T> = T extends [ unknown, infer V, ...unknown[] ] ? V : undefined;
export type ExtractSmartFilters<T extends PropertyModelExtensions<any, any, any> | ModelExtensions<any, any, any>> = T['smartFilters'];
export type ExtractComputedProperties<T extends PropertyModelExtensions<any, any, any> | ModelExtensions<any, any, any>> = T['computedProperties'];

export type AbstractModelConverter<DBE extends Document> = ( dbe: DBE ) => unknown | Promise<unknown>;

export type AbstractModelConverters<DBE extends Document> =
{
    from? : { [key: string]: AbstractModelFromConverter<DBE, any> }
    dto   : AbstractConverterOptions<DBE>
}
&
{
    [key: string]: AbstractConverterOptions<DBE>
}

export type AbstractModelSmartFilters<T> = T extends never ? undefined : { [K in keyof T]: T[K] extends Function ? SmartFilterMethod : T[K] }
export type AbstractPropertyModelSmartFilters
<
    T extends AbstractModelSmartFilters<any>,
    P extends AbstractModelSmartFilters<any>
>
= T extends never ? undefined : [ T, P ]

export type AbstractModelProperties<T> = T extends never ? undefined : { [K in keyof T]: T[K] extends Function ? ComputedPropertyMethod : T[K] }
export type AbstractPropertyModelComputedProperties
<
    T extends AbstractModelProperties<any>,
    P extends AbstractModelProperties<any>
>
= T extends never ? undefined : [ T, P ]

export type ModelUpdateResponse<DBE extends Document> =
{
    matchedCount    : number
    modifiedCount   : number
    documentBefore? : DBE
    documentAfter?  : DBE
};

export type PropertyModelUpdateResponse<DBE extends Document> =
{
    matchedRootCount    : number
    modifiedRootCount   : number
    documentBefore?     : DBE
    documentAfter?      : DBE
};

export type ConstructorExtensions<E extends PropertyModelExtensions<any, any, any>> =
    Omit<E, 'smartFilters' | 'computedProperties'>
    &
    {
        smartFilters?       : FirstType<ExtractSmartFilters<E>>
        computedProperties? : FirstType<ExtractComputedProperties<E>>
    }

export type ModelExtensions
<
    DBE extends MongoRootDocument | MongoPropertyDocument,
    SmartFilters extends AbstractModelSmartFilters<any> = never,
    ComputedProperties extends AbstractModelProperties<any> = never
>
=
{
    converters          : AbstractModelConverters<DBE>
    smartFilters?       : SmartFilters
    computedProperties? : ComputedProperties
}

export type PropertyModelExtensions
<
    DBE extends MongoRootDocument | MongoPropertyDocument,
    SmartFilters extends AbstractPropertyModelSmartFilters<any, any> = never,
    ComputedProperties extends AbstractPropertyModelComputedProperties<any, any> = never
>
=
{
    converters          : AbstractModelConverters<DBE>
    smartFilters?       : SmartFilters
    computedProperties? : ComputedProperties
}

export type MongoBSONTypes<T> = T extends ObjectId
    ? ObjectId | { $oid: string }
    : T extends ( infer U )[]
        ? MongoBSONTypes<U>[]
        :
        {
            [K in keyof T]: T[K] extends ObjectId
                ? ObjectId | { $oid: string }
                : T[K] extends ( infer U )[]
                    ? MongoBSONTypes<U>[]
                    : T[K] extends object
                        ? MongoBSONTypes<T[K]>
                        : T[K]
        };

export type ModelUpdateDocument<T> =
{
    [P in ExpandPaths<T>]?: MongoBSONTypes<PathValue<T, P>>
};

export type AccessFilterResult<T> = Filter<T> | false | void;

export type AccessOperation = 'create' | 'read' | 'update' | 'delete';

export type AccessResolveContext =
{
    operation : AccessOperation
    method    : string
    access?   : string
}

export type AccessFilterFn<T> = ( name: string ) => Promise<AccessFilterResult<T>> | AccessFilterResult<T>;

export type AccessDefaultsMap = Partial<Record<AccessOperation, string>>;

export type AccessDefaultsFn = (
    ctx: Pick<AccessResolveContext, 'operation' | 'method'>
) => string | undefined | Promise<string | undefined>;

export type ModelAccessConfig<T = Document> =
{
    filters?  : Record<string, AccessFilterFn<T>>
    defaults? : AccessDefaultsMap | AccessDefaultsFn
}
