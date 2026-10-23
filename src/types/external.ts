import { ClientSession, CreateIndexesOptions, Document, Filter, FindOptions, IndexDirection, MongoClientOptions, ObjectId, OneOrMore, UpdateFilter } from 'mongodb';
import type { OptimizerOptions } from '@webergency-utils/mongodb-query-optimizer';
import type { ModelCacheConfig } from '../cache.js';
import type { ModelValidationIssue } from '../errors.js';
import type { ModelMutationOperation, ObservabilityConfig } from '../events.js';
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
export type
{
    ModelQueryContext,
    ObservabilityConfig,
    ObservabilityContextResolver,
    ObservabilityLogger,
    ObservabilityOperationCategory,
    ObservabilityOperationFilter,
    ObservabilityOptions
}
from '../events.js';
export type CacheOptions = ModelCacheConfig;
export type OptimizerConfig = boolean | OptimizerOptions;

export type ModelsOptions = MongoClientOptions &
{
    optimizer?      : OptimizerConfig
    observability?  : ObservabilityConfig
};

export type ModelCreateOptions =
{
    duplicateIgnore?    : boolean
    access?             : string
    context?            : Record<string, unknown>
    traceID?            : string
    session?            : ClientSession
};

export type ModelUpdateOptions =
{
    documentBefore? : boolean
    documentAfter?  : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
};

export type ModelDeleteOptions =
{
    hard?       : boolean
    access?     : string
    context?    : Record<string, unknown>
    traceID?    : string
    session?    : ClientSession
};

export type ModelExistsOptions =
{
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
};

export type ModelDistinctOptions<DBE = Document, Filters = never> =
{
    filter?         : Filter<DBE>
    smartFilter?    : ModelSmartFilter<Filters>
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
};

export type PropertyModelDistinctOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never
>
=
{
    filter?         : PropertyModelFilter<RootDBE, DBE>
    smartFilter?    : ModelSmartFilter<SecondType<Filters>>
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
};

export type ModelUpsertOptions<IdType = any> = ModelUpdateOptions &
{
    id? : IdType
};

export type ModelUpsertResponse<DBE extends Document, IdType = any> =
{
    id?             : IdType
    upsertedId?     : IdType
    upserted        : boolean
    created         : boolean
    upsertedCount   : number
    matchedCount    : number
    modifiedCount   : number
    documentBefore? : DBE
    documentAfter?  : DBE
};

export type PropertyModelUpsertResponse<DBE extends Document, IdType = any> =
{
    id?                 : IdType
    upsertedId?         : IdType
    upserted            : boolean
    created             : boolean
    upsertedCount       : number
    matchedRootCount    : number
    modifiedRootCount   : number
    matchedCount        : number
    modifiedCount       : number
    documentBefore?     : DBE
    documentAfter?      : DBE
};

export type ModelBulkWriteOptions =
{
    ordered?    : boolean
    access?     : string
    context?    : Record<string, unknown>
    traceID?    : string
    session?    : ClientSession
};

export type ModelBulkWriteOperation<DBE extends Document, IdType = any, Filters = never> =
    | { create: Omit<DBE, '_id'> & { _id?: DBE['_id'] }, id?: IdType }
    | { create: { data: Omit<DBE, '_id'> & { _id?: DBE['_id'] }, id?: IdType } }
    | { insertOne: { document: Omit<DBE, '_id'> & { _id?: DBE['_id'] } } }
    | { update: { id: IdType, update: Partial<DBE> | UpdateFilter<DBE> } }
    | { updateOne: { filter: Filter<DBE> | ModelFindOptions<DBE, Filters>, update: Partial<DBE> | UpdateFilter<DBE>, upsert?: boolean, id?: IdType } }
    | { updateMany: { filter: IdType[] | Filter<DBE> | ModelFindOptions<DBE, Filters>, update: Partial<DBE> | UpdateFilter<DBE>, upsert?: boolean } }
    | { upsert: { filter: Filter<DBE> | ModelFindOptions<DBE, Filters>, update: Partial<DBE> | UpdateFilter<DBE> } }
    | { delete: { id: IdType, hard?: boolean } }
    | { deleteOne: { filter: Filter<DBE> | ModelFindOptions<DBE, Filters>, hard?: boolean } }
    | { deleteMany: { filter: IdType[] | Filter<DBE> | ModelFindOptions<DBE, Filters>, hard?: boolean } };

export type PropertyModelBulkWriteOperation
<
    RootDBE extends Document,
    DBE extends Document,
    IdType = any,
    Filters extends AbstractModelSmartFilters<any> = never
>
=
    | { create: { parentID: any, data: Omit<DBE, 'id'> & { id?: DBE['id'] }, id?: IdType } }
    | { update: { id: IdType, update: Partial<DBE> | UpdateFilter<DBE> } }
    | { updateOne: { filter: PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, Filters>, update: Partial<DBE> | UpdateFilter<DBE> } }
    | { updateMany: { filter: IdType[] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, Filters>, update: Partial<DBE> | UpdateFilter<DBE> } }
    | { delete: { id: IdType, hard?: boolean } }
    | { deleteOne: { filter: PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, Filters>, hard?: boolean } }
    | { deleteMany: { filter: IdType[] | PropertyModelFilter<RootDBE, DBE> | PropertyModelFindOptions<RootDBE, DBE, Filters>, hard?: boolean } };

export type ModelBulkWriteResult<IdType = any> =
{
    insertedCount   : number
    matchedCount    : number
    modifiedCount   : number
    deletedCount    : number
    upsertedCount   : number
    insertedIds     : IdType[]
    upsertedIds     : Record<number, IdType>
};

export type ModelIndexSpecification<DBE extends Document = Document> = Record<Extract<keyof DBE, string> | ( string & {} ), IndexDirection>;

export type ModelIndexDefinition<DBE extends Document = Document> =
    | ModelIndexSpecification<DBE>
    | ( CreateIndexesOptions & {
        key         : ModelIndexSpecification<DBE>
        options?    : CreateIndexesOptions
    })
    | ( CreateIndexesOptions & {
        keys        : ModelIndexSpecification<DBE>
        options?    : CreateIndexesOptions
    });

export type NormalizedModelIndex =
{
    key     : ModelIndexSpecification
    name    : string
    options : CreateIndexesOptions & { name: string }
};

export type ModelSyncIndexesOptions =
{
    dryRun?         : boolean
    dropObsolete?   : boolean
    background?     : boolean
    session?        : ClientSession
};

export type ModelSyncIndexesResult =
{
    collection  : string
    created     : string[]
    existing    : string[]
    unchanged   : string[]
    dropped     : string[]
};

export type ModelTimestampsOptions =
{
    createdAt?  : string | false
    updatedAt?  : string | false
};

export type ModelTimestampsConfig = boolean | ModelTimestampsOptions;

export type ModelSoftDeleteOptions =
{
    field?          : string
    deletedAtField? : string | false
};

export type ModelSoftDeleteConfig = boolean | ModelSoftDeleteOptions;

export type ModelHookContext<DBE extends Document = Document> =
{
    model?          : unknown
    collection?     : string
    operation       : 'create' | 'update' | 'delete'
    method          : ModelMutationOperation
    id?             : unknown
    ids?            : unknown[]
    parentID?       : unknown
    filter?         : Document
    smartFilter?    : Record<string, unknown>
    data?           : Partial<DBE> | UpdateFilter<DBE>
    update?         : Partial<DBE> | UpdateFilter<DBE> | Document
    items?          : Array<Partial<DBE>>
    result?         : unknown
    insertedCount?  : number
    matchedCount?   : number
    modifiedCount?  : number
    deletedCount?   : number
    upsertedCount?  : number
    documentBefore? : DBE
    documentAfter?  : DBE
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
    afterCommit     : ( callback: () => void | Promise<void> ) => void
};

export type ModelBeforeHookFn<DBE extends Document = Document> = (
    ctx: ModelHookContext<DBE>
) => void | Partial<DBE> | UpdateFilter<DBE> | Document | Promise<void | Partial<DBE> | UpdateFilter<DBE> | Document>;

export type ModelAfterHookFn<DBE extends Document = Document> = (
    ctx: ModelHookContext<DBE>
) => void | Promise<void>;

export type ModelHooksConfig<DBE extends Document = Document> =
{
    beforeCreate?   : OneOrMore<ModelBeforeHookFn<DBE>>
    afterCreate?    : OneOrMore<ModelAfterHookFn<DBE>>
    beforeUpdate?   : OneOrMore<ModelBeforeHookFn<DBE>>
    afterUpdate?    : OneOrMore<ModelAfterHookFn<DBE>>
    beforeDelete?   : OneOrMore<ModelAfterHookFn<DBE>>
    afterDelete?    : OneOrMore<ModelAfterHookFn<DBE>>
};

export type MongoRootDocument = Document & { _id: any };
export type MongoPropertyDocument = Document & { id: any };

export type ListResult<T> =
{
    items       : T[]
    total?      : number
    cursors     : { next?: string, prev?: string }
    nextCursor? : string
    prevCursor? : string
}

export type WithTotal<T> = T extends Array<infer U>
    ? Array<U> & ListResult<U>
    : T & { total?: number, cursors?: { next?: string, prev?: string }, nextCursor?: string, prevCursor?: string };

export type GetOptions<K extends string | number | symbol = 'dto'> =
{
    as?             : K
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
}

export type GetManyOptions<K extends string | number | symbol = 'dto'> =
{
    as?             : K
    filter?         : boolean
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
}

export type ModelSmartFilter<T> = { [K in PublicMethodNames<T>]?: FirstParameter<T[K]> }

export type PropertyModelFilter<RootDBE extends Document, DBE extends Document> = Filter<DBE> & { _root?: Filter<RootDBE> };

export type ModelListOptions<DBE extends Document, Filters = never, Properties = never> = FindOptions &
{
    filter?             : Filter<DBE>
    smartFilter?        : ModelSmartFilter<Filters>
    computedProperties? : ComputedPropertiesParam<Properties extends AbstractModelProperties<any> ? Properties : any>
    cursor?             : string
    after?              : string
    before?             : string
    pipeline?           : Document[]
    count?              : boolean
    sample?             : number
    countLimit?         : number
    includeDeleted?     : boolean
    access?             : string
    context?            : Record<string, unknown>
    traceID?            : string
    session?            : ClientSession
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
    after?              : string
    before?             : string
    projection?         : FindOptions['projection'] & { _root?: FindOptions['projection'] }
    pipeline?           : Document[]
    count?              : boolean
    sample?             : number
    countLimit?         : number
    includeDeleted?     : boolean
    access?             : string
    context?            : Record<string, unknown>
    traceID?            : string
    session?            : ClientSession
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
    filter?         : Filter<DBE>
    smartFilter?    : ModelSmartFilter<Filters>
    cursor?         : string
    after?          : string
    before?         : string
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
}

export type PropertyModelFindOptions
<
    RootDBE extends Document,
    DBE extends Document,
    Filters extends AbstractModelSmartFilters<any> = never
>
=
{
    filter?         : PropertyModelFilter<RootDBE, DBE>
    smartFilter?    : ModelSmartFilter<SecondType<Filters>>
    cursor?         : string
    after?          : string
    before?         : string
    includeDeleted? : boolean
    access?         : string
    context?        : Record<string, unknown>
    traceID?        : string
    session?        : ClientSession
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
    cursor?             : string
    after?              : string
    before?             : string
    sample?             : number
    pipeline?           : Document[]
    includeDeleted?     : boolean
    access?             : string
    context?            : Record<string, unknown>
    traceID?            : string
    session?            : ClientSession
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
    cursor?             : string
    after?              : string
    before?             : string
    sample?             : number
    pipeline?           : Document[]
    includeDeleted?     : boolean
    access?             : string
    context?            : Record<string, unknown>
    traceID?            : string
    session?            : ClientSession
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
        validate?           : E['validate']
        indexes?            : ModelIndexDefinition[]
        timestamps?         : ModelTimestampsConfig
        softDelete?         : ModelSoftDeleteConfig
        hooks?              : E['hooks']
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
    validate?           : ModelValidatorConfig<DBE>
    indexes?            : ModelIndexDefinition[]
    timestamps?         : ModelTimestampsConfig
    softDelete?         : ModelSoftDeleteConfig
    hooks?              : ModelHooksConfig<DBE>
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
    validate?           : ModelValidatorConfig<DBE>
    indexes?            : ModelIndexDefinition[]
    timestamps?         : ModelTimestampsConfig
    softDelete?         : ModelSoftDeleteConfig
    hooks?              : ModelHooksConfig<DBE>
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

export type ModelValidationOperation = 'create' | 'createMany' | 'update' | 'updateOne' | 'updateMany' | 'upsert' | 'bulkWrite';

export type ModelValidationContext =
{
    operation           : ModelValidationOperation
    isUpdateOperator    : boolean
};

export type ModelStandardSchemaV1<T = unknown> =
{
    '~standard' :
    {
        validate : ( value: unknown ) =>
            | { value: T, issues?: undefined }
            | { issues: ReadonlyArray<ModelValidationIssue> }
            | Promise<{ value: T, issues?: undefined } | { issues: ReadonlyArray<ModelValidationIssue> }>
    }
};

export type ModelParseSchema<T = unknown> =
    | {
        safeParse       : ( value: unknown ) => { success: boolean, data?: T, error?: { message?: string, issues?: ReadonlyArray<ModelValidationIssue> } }
        safeParseAsync? : ( value: unknown ) => Promise<{ success: boolean, data?: T, error?: { message?: string, issues?: ReadonlyArray<ModelValidationIssue> } }>
    }
    | {
        parse           : ( value: unknown ) => T | Promise<T>
    };

export type ModelValidatorFn<T = any> = (
    data: T,
    context: ModelValidationContext
) => void | boolean | T | Promise<void | boolean | T>;

export type ModelValidatorInput<T = any> =
    | ModelValidatorFn<T>
    | ModelStandardSchemaV1<T>
    | ModelParseSchema<T>;

export type ModelValidatorConfig<DBE extends Document = Document> =
    | ModelValidatorInput<Partial<DBE> | any>
    | {
        create? : ModelValidatorInput<Partial<DBE> | any>
        update? : ModelValidatorInput<Partial<DBE> | any>
    };
