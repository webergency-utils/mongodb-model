import { Collection, Document } from 'mongodb';
import { compileConverters } from './converter-recipes.js';
import { bindInstanceDtoID, createDtoIDRef } from './dto-id-bind.js';
import { AbstractPropertyModel } from './property-model.js';
import { AbstractModels } from './models.js';
import
{
    ConstructorExtensions,
    MongoPropertyDocument,
    MongoRootDocument
}
from './types/external.js';
import { ConverterRecipeMap, DefinePropertyModelConfig, InferredPropertyModelExtensions } from './types/definition.js';

function buildPropertyExtensions<DBE extends MongoPropertyDocument>(
    config: Omit<DefinePropertyModelConfig<DBE, any, any, any>, 'path'>,
    dtoID: ( id: unknown ) => string
): ConstructorExtensions<any>
{
    return {
        cache               : config.cache,
        converters          : compileConverters( config.converters, { dtoID }),
        smartFilters        : config.smartFilters,
        computedProperties  : config.computedProperties,
        access              : config.access,
        optimizer           : config.optimizer,
        observability       : config.observability
    };
}

export function definePropertyModel
<
    RootDBE extends MongoRootDocument,
    DBE extends MongoPropertyDocument,
    DTO extends Document = Document,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>(
    models: AbstractModels,
    collection: Collection<RootDBE>,
    config: DefinePropertyModelConfig<DBE, SmartFilters, ComputedProperties, Recipes>
): AbstractPropertyModel<RootDBE, DBE, DTO, InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
{
    const { path, ...rest } = config;
    const dtoIDOverride = rest.dtoID;

    class DefinedPropertyModel extends AbstractPropertyModel<RootDBE, DBE, DTO, InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
    {
        constructor( m: AbstractModels, c: Collection<RootDBE>, p: string )
        {
            const dtoIDRef = createDtoIDRef( dtoIDOverride );
            const extensions = buildPropertyExtensions( rest, ( id ) => dtoIDRef.current( id )) as unknown as ConstructorExtensions<InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>;

            super( m, c, p, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    }

    return new DefinedPropertyModel( models, collection, path );
}

export function PropertyModel
<
    RootDBE extends MongoRootDocument,
    DBE extends MongoPropertyDocument,
    DTO extends Document = Document,
    SmartFilters = never,
    ComputedProperties = never,
    Recipes extends ConverterRecipeMap<DBE> | undefined = ConverterRecipeMap<DBE> | undefined
>(
    config: DefinePropertyModelConfig<DBE, SmartFilters, ComputedProperties, Recipes>
): new ( models: AbstractModels, collection: Collection<RootDBE> ) => AbstractPropertyModel<RootDBE, DBE, DTO, InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
{
    const { path, ...rest } = config;
    const dtoIDOverride = rest.dtoID;

    return class PropertyModelBase extends AbstractPropertyModel<RootDBE, DBE, DTO, InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>
    {
        constructor( models: AbstractModels, collection: Collection<RootDBE> )
        {
            const dtoIDRef = createDtoIDRef( dtoIDOverride );
            const extensions = buildPropertyExtensions( rest, ( id ) => dtoIDRef.current( id )) as unknown as ConstructorExtensions<InferredPropertyModelExtensions<DBE, DTO, SmartFilters, ComputedProperties, Recipes>>;

            super( models, collection, path, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    };
}

export type { DefinePropertyModelConfig, PropertyModelDefinition, InferredPropertyModelExtensions } from './types/definition.js';
