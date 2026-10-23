import { Document, FindOptions } from 'mongodb';
import
{
    AbstractModelConverter,
    AbstractModelConverters,
    AbstractModelProperties,
    AbstractModelSmartFilters,
    ModelAccessConfig,
    ModelCacheConfig,
    ModelExtensions,
    ModelHooksConfig,
    ModelIdConfig,
    ModelIndexDefinition,
    ModelRelationsConfig,
    ModelSoftDeleteConfig,
    ModelTimestampsConfig,
    ModelValidatorConfig,
    ModelVersioningConfig,
    MongoPropertyDocument,
    MongoRootDocument,
    ObservabilityConfig,
    OptimizerConfig,
    PropertyModelExtensions
}
from './external.js';
import { AbstractModelFromConverter, ComputedPropertiesParam } from './internal.js';

export type CompileConverterContext =
{
    dtoID : ( id: unknown ) => string
}

export type ConverterRecipeMetadata =
{
    projection?         : FindOptions['projection']
    computedProperties? : ComputedPropertiesParam<any>
}

export type CustomConverterRecipe<DBE extends Document> =
    ConverterRecipeMetadata &
    {
        custom : ( dbe: DBE ) => unknown | Promise<unknown>
    }

export type RawConverterRecipe<DBE extends Document> =
    ConverterRecipeMetadata &
    {
        converter : AbstractModelConverter<DBE>
    }

export type PickConverterRecipe<DBE extends Document> =
    ConverterRecipeMetadata &
    {
        pick : readonly ( keyof DBE & string )[]
    }

export type OmitConverterRecipe<DBE extends Document> =
    ConverterRecipeMetadata &
    {
        omit : readonly ( keyof DBE & string )[]
    }

export type ExtendsConverterRecipe =
    ConverterRecipeMetadata &
    {
        extends : string
        pick?   : readonly string[]
        omit?   : readonly string[]
    }

export type RenameConverterRecipe =
    ConverterRecipeMetadata &
    {
        rename : Record<string, keyof Document & string | '_id' | 'id'>
        pick?  : readonly string[]
    }

export type ConverterRecipe<DBE extends Document> =
    | 'auto'
    | PickConverterRecipe<DBE>
    | OmitConverterRecipe<DBE>
    | ExtendsConverterRecipe
    | RenameConverterRecipe
    | CustomConverterRecipe<DBE>
    | RawConverterRecipe<DBE>

export type ConverterRecipeMap<DBE extends Document> =
{
    from? : { [key: string]: AbstractModelFromConverter<DBE, any> } | ConverterRecipe<DBE>
}
&
{
    [name: string] : ConverterRecipe<DBE> | { [key: string]: AbstractModelFromConverter<DBE, any> } | undefined
}

export type RootModelDefinition
<
    DBE extends MongoRootDocument,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>
=
{
    cache?               : ModelCacheConfig
    converters?          : Recipes
    smartFilters?        : SmartFilters
    computedProperties?  : ComputedProperties
    access?              : ModelAccessConfig<DBE>
    optimizer?           : OptimizerConfig
    observability?       : ObservabilityConfig
    validate?            : ModelValidatorConfig<DBE>
    indexes?             : ModelIndexDefinition[]
    timestamps?          : ModelTimestampsConfig
    softDelete?          : ModelSoftDeleteConfig
    versioning?          : ModelVersioningConfig
    relations?           : ModelRelationsConfig<DBE>
    hooks?               : ModelHooksConfig<DBE>
    id?                  : ModelIdConfig
    dtoID?               : ( id: unknown ) => string
    dbeID?               : ( id: any ) => any
}

export type PropertyModelDefinition
<
    DBE extends MongoPropertyDocument,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>
=
{
    path                 : string
    cache?               : ModelCacheConfig
    converters?          : Recipes
    smartFilters?        : SmartFilters
    computedProperties?  : ComputedProperties
    access?              : ModelAccessConfig<DBE>
    optimizer?           : OptimizerConfig
    observability?       : ObservabilityConfig
    validate?            : ModelValidatorConfig<DBE>
    indexes?             : ModelIndexDefinition[]
    timestamps?          : ModelTimestampsConfig
    softDelete?          : ModelSoftDeleteConfig
    versioning?          : ModelVersioningConfig
    relations?           : ModelRelationsConfig<DBE>
    hooks?               : ModelHooksConfig<DBE>
    id?                  : ModelIdConfig
    dtoID?               : ( id: unknown ) => string
    dbeID?               : ( id: any ) => any
}

export type InferCustomConverterReturn<T> =
    T extends { custom: ( ...args: never[] ) => infer R }
        ? Awaited<R>
        : never

export type InferRecipeConverterReturn<DBE extends Document, T> =
    T extends CustomConverterRecipe<DBE>
        ? InferCustomConverterReturn<T>
        : T extends RawConverterRecipe<DBE>
            ? Awaited<ReturnType<T['converter']>>
            : T extends PickConverterRecipe<DBE>
                ? { id: string } & Pick<DBE, T['pick'][number]>
                : T extends OmitConverterRecipe<DBE>
                    ? Omit<DBE, T['omit'][number]> & { id: string }
                    : T extends RenameConverterRecipe
                        ? { [K in keyof T['rename']]: string }
                        : Document

export type InferConverterMapFromRecipes<DBE extends Document, T extends ConverterRecipeMap<DBE> | undefined> =
    T extends ConverterRecipeMap<DBE>
        ? {
            [K in keyof T]: { converter: ( dbe: DBE ) => InferRecipeConverterReturn<DBE, T[K]> | Promise<InferRecipeConverterReturn<DBE, T[K]>> }
        }
        : Record<string, never>

export type DefinedModelConverters<DBE extends Document, DTO extends Document = DBE, Recipes extends ConverterRecipeMap<DBE> | undefined = undefined> =
{
    dto : { converter: ( dbe: DBE ) => DTO | Promise<DTO> }
    dbe : { converter: ( dbe: DBE ) => DBE | Promise<DBE> }
}
& AbstractModelConverters<DBE>
& InferConverterMapFromRecipes<DBE, Recipes>

export type InferredModelExtensions
<
    DBE extends MongoRootDocument,
    DTO extends Document = DBE,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = undefined
>
= Omit<ModelExtensions<DBE, AbstractModelSmartFilters<SmartFilters>, AbstractModelProperties<ComputedProperties>>, 'converters'> &
{
    converters: DefinedModelConverters<DBE, DTO, Recipes>
}

export type InferredPropertyModelExtensions
<
    DBE extends MongoPropertyDocument,
    DTO extends Document = DBE,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = undefined
>
= Omit<
    PropertyModelExtensions<
        DBE,
        [ SmartFilters ] extends [ never ] ? undefined : [ AbstractModelSmartFilters<SmartFilters>, AbstractModelSmartFilters<SmartFilters> ],
        [ ComputedProperties ] extends [ never ] ? undefined : [ AbstractModelProperties<ComputedProperties>, AbstractModelProperties<ComputedProperties> ]
    >,
    'converters'
> &
{
    converters: DefinedModelConverters<DBE, DTO, Recipes>
}

export type DefineModelConfig
<
    DBE extends MongoRootDocument,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>
= RootModelDefinition<DBE, SmartFilters, ComputedProperties, Recipes>

export type DefinePropertyModelConfig
<
    DBE extends MongoPropertyDocument,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>
= PropertyModelDefinition<DBE, SmartFilters, ComputedProperties, Recipes>
