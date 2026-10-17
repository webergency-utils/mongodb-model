import { Document, FindOptions } from 'mongodb';
import
{
    AbstractModelConverter,
    AbstractModelConverters,
    ModelAccessConfig,
    ModelCacheConfig,
    MongoPropertyDocument,
    MongoRootDocument,
    ObservabilityConfig,
    OptimizerConfig
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
    ComputedProperties = never
>
=
{
    cache?               : ModelCacheConfig
    converters?          : ConverterRecipeMap<DBE>
    smartFilters?        : SmartFilters
    computedProperties?  : ComputedProperties
    access?              : ModelAccessConfig<DBE>
    optimizer?           : OptimizerConfig
    observability?       : ObservabilityConfig
    dtoID?               : ( id: unknown ) => string
}

export type PropertyModelDefinition
<
    DBE extends MongoPropertyDocument,
    SmartFilters = never,
    ComputedProperties = never
>
=
{
    path                 : string
    cache?               : ModelCacheConfig
    converters?          : ConverterRecipeMap<DBE>
    smartFilters?        : SmartFilters
    computedProperties?  : ComputedProperties
    access?              : ModelAccessConfig<DBE>
    optimizer?           : OptimizerConfig
    observability?       : ObservabilityConfig
    dtoID?               : ( id: unknown ) => string
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

export type DefinedModelConverters<DBE extends Document, Recipes extends ConverterRecipeMap<DBE> | undefined> =
    AbstractModelConverters<DBE> & InferConverterMapFromRecipes<DBE, Recipes>

export type DefineModelConfig
<
    DBE extends MongoRootDocument,
    SmartFilters = never,
    ComputedProperties = never
>
= RootModelDefinition<DBE, SmartFilters, ComputedProperties>

export type DefinePropertyModelConfig
<
    DBE extends MongoPropertyDocument,
    SmartFilters = never,
    ComputedProperties = never
>
= PropertyModelDefinition<DBE, SmartFilters, ComputedProperties>
