import { Collection, Document } from 'mongodb';
import { compileConverters } from './converter-recipes.js';
import { bindInstanceDtoID, createDtoIDRef } from './dto-id-bind.js';
import { AbstractModel } from './model.js';
import { AbstractModels } from './models.js';
import { ModelExtensions, MongoRootDocument } from './types/external.js';
import { ConverterRecipeMap, DefineModelConfig, InferredModelExtensions } from './types/definition.js';

function buildExtensions<DBE extends MongoRootDocument>(
    config: DefineModelConfig<DBE, any, any, any>,
    dtoID: ( id: unknown ) => string
): ModelExtensions<DBE, any, any>
{
    return {
        cache               : config.cache,
        converters          : compileConverters( config.converters, { dtoID }),
        smartFilters        : config.smartFilters,
        computedProperties  : config.computedProperties,
        access              : config.access,
        optimizer           : config.optimizer,
        observability       : config.observability,
        validate            : config.validate,
        indexes             : config.indexes,
        timestamps          : config.timestamps,
        softDelete          : config.softDelete,
        hooks               : config.hooks
    };
}

export function defineModel
<
    DBE extends MongoRootDocument,
    DTO extends Document = Document,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>(
    models: AbstractModels,
    collection: Collection<DBE>,
    config: DefineModelConfig<DBE, SmartFilters, ComputedProperties, Recipes> = {} as any
): AbstractModel<DBE, DTO, InferredModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
{
    const DefinedRootModel = Model<DBE, DTO, SmartFilters, ComputedProperties, Recipes>( config );

    return new DefinedRootModel( models, collection );
}

export function Model
<
    DBE extends MongoRootDocument,
    DTO extends Document = Document,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>(
    config: DefineModelConfig<DBE, SmartFilters, ComputedProperties, Recipes> = {} as any
): new ( models: AbstractModels, collection: Collection<DBE> ) => AbstractModel<DBE, DTO, InferredModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
{
    const dtoIDOverride = config.dtoID;

    return class ModelBase extends AbstractModel<DBE, DTO, InferredModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
    {
        constructor( models: AbstractModels, collection: Collection<DBE> )
        {
            const dtoIDRef = createDtoIDRef( dtoIDOverride );
            const extensions = buildExtensions( config, ( id ) => dtoIDRef.current( id )) as unknown as InferredModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>;

            super( models, collection, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    };
}

export type { DefineModelConfig, RootModelDefinition, ConverterRecipe, ConverterRecipeMap, InferredModelExtensions } from './types/definition.js';
