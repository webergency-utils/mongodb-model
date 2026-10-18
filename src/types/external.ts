import { Document, Filter, FindOptions, MongoClientOptions, ObjectId } from 'mongodb';
import type { OptimizerOptions } from '@webergency-utils/mongodb-query-optimizer';
import type { ModelCacheConfig } from '../cache.js';
import type { ObservabilityConfig } from '../events.js';
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

export type { OptimizerOptions } from '@webergency-utils/mongodb-query-optimizer';
export type { ModelCacheConfig, ModelCacheInstance, ModelCacheOptions } from '../cache.js';
export type { ObservabilityConfig, ObservabilityLogger, ObservabilityOptions } from '../events.js';
export type CacheOptions = ModelCacheConfig;
export type OptimizerConfig = boolean | OptimizerOptions;

export type ModelsOptions = MongoClientOptions &
{
    optimizer?      : OptimizerConfig
    observability?  : ObservabilityConfig
};

export type ModelCreateOptions = { duplicateIgnore?: boolean, access?: string };
export type ModelUpdateOptions = { documentBefore?: boolean, documentAfter?: boolean, access?: string };
export type ModelDeleteOptions = { access?: string };
export type MongoRootDocument = Document & { _id: any };
export type MongoPropertyDocument = Document & { id: any };

export type ListResult<T> =
{
    items   : T[]
    total?  : number
    cursors : { next?: string, prev?: string }
}

export type WithTotal<T> = T extends Array<infer U>
    ? Array<U> & ListResult<U>
    : T & { total?: number, cursors?: { next?: string, prev?: string } };

export type GetOptions<K extends string | number | symbol = 'dto'> =
{
    as?     : K
    access? : string
}

export type GetManyOptions<K extends string | number | symbol = 'dto'> =
{
    as?     : K
    filter? : boolean
    access? : string
}

export type ModelSmartFilter<T> = { [K in PublicMethodNames<T>]?: FirstParameter<T[K]> }

export type PropertyModelFilter<RootDBE extends Document, DBE extends Document> = Filter<DBE> & { _root?: Filter<RootDBE> };

export type ModelListOptions<DBE extends Document, Filters = never, Properties = never> = FindOptions &
{
    filter?             : Filter<DBE>
    smartFilter?        : ModelSmartFilter<Filters>
    computedProperties? : ComputedPropertiesParam<Properties extends AbstractModelProperties<any> ? Properties : any>
    cursor?             : string
    pipeline?           : Document[]
    count?              : boolean
    sample?             : number
    countLimit?         : number
    access?             : string
};

export type ModelStreamOptions<DBE extends Document, Filters = never, Properties = never> =
    Omit<ModelListOptions<DBE, Filters, Properties>, 'count' | 'countLimit'>;

export type PropertyModelListOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never,
    Properties = never
>
= Omit<FindOptions, 'projection'> &
{
    filter?             : PropertyModelFilter<RootDBE, DBE>
    smartFilter?        : ModelSmartFilter<FirstType<Filters>>
    computedProperties? : ComputedPropertiesParam<SecondType<Properties> extends AbstractModelProperties<any> ? SecondType<Properties> : any>
    cursor?             : string
    projection?         : FindOptions['projection'] & { _root?: FindOptions['projection'] }
    pipeline?           : Document[]
    count?              : boolean
    sample?             : number
    countLimit?         : number
    access?             : string
};

export type PropertyModelStreamOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never,
    Properties = never
>
= Omit<PropertyModelListOptions<RootDBE, DBE, Filters, Properties>, 'count' | 'countLimit'>;

export type ModelFindOptions<DBE extends Document, Filters = never> =
{
    filter?      : Filter<DBE>
    smartFilter? : ModelSmartFilter<Filters>
    access?      : string
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
    access?      : string
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
    limit?              : number
    skip?               : number
    pipeline?           : Document[]
    access?             : string
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
    limit?              : number
    skip?               : number
    pipeline?           : Document[]
    access?             : string
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
        cache?              : ModelCacheConfig
        smartFilters?       : FirstType<ExtractSmartFilters<E>>
        computedProperties? : FirstType<ExtractComputedProperties<E>>
        optimizer?          : OptimizerConfig
        observability?      : ObservabilityConfig
    }

export type ModelExtensions
<
    DBE extends MongoRootDocument | MongoPropertyDocument,
    SmartFilters extends AbstractModelSmartFilters<any> = never,
    ComputedProperties extends AbstractModelProperties<any> = never
>
=
{
    cache?              : ModelCacheConfig
    converters          : AbstractModelConverters<DBE>
    smartFilters?       : SmartFilters
    computedProperties? : ComputedProperties
    access?             : ModelAccessConfig<DBE>
    optimizer?          : OptimizerConfig
    observability?      : ObservabilityConfig
}

export type PropertyModelExtensions
<
    DBE extends MongoRootDocument | MongoPropertyDocument,
    SmartFilters extends AbstractPropertyModelSmartFilters<any, any> = never,
    ComputedProperties extends AbstractPropertyModelComputedProperties<any, any> = never
>
=
{
    cache?              : ModelCacheConfig
    converters          : AbstractModelConverters<DBE>
    smartFilters?       : SmartFilters
    computedProperties? : ComputedProperties
    access?             : ModelAccessConfig<DBE>
    optimizer?          : OptimizerConfig
    observability?      : ObservabilityConfig
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
