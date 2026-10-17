import { Collection, Document } from 'mongodb';
import { compileConverters } from './converter-recipes.js';
import { bindInstanceDtoID, createDtoIDRef } from './dto-id-bind.js';
import { AbstractModel } from './model.js';
import { AbstractModels } from './models.js';
import { ModelExtensions, MongoRootDocument } from './types/external.js';
import { DefineModelConfig } from './types/definition.js';

function buildExtensions<DBE extends MongoRootDocument>(
    config: DefineModelConfig<DBE>,
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
        observability       : config.observability
    };
}

export function defineModel
<
    DBE extends MongoRootDocument,
    DTO extends Document = Document
>(
    models: AbstractModels,
    collection: Collection<DBE>,
    config: DefineModelConfig<DBE> = {}
): AbstractModel<DBE, DTO, any>
{
    const dtoIDOverride = config.dtoID;
    const dtoIDRef = createDtoIDRef( dtoIDOverride );
    const extensions = buildExtensions( config, ( id ) => dtoIDRef.current( id ));

    class DefinedRootModel extends AbstractModel<DBE, DTO, any>
    {
        constructor( m: AbstractModels, c: Collection<DBE> )
        {
            super( m, c, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    }

    return new DefinedRootModel( models, collection );
}

export function Model
<
    DBE extends MongoRootDocument,
    DTO extends Document = Document
>(
    config: DefineModelConfig<DBE> = {}
): new ( models: AbstractModels, collection: Collection<DBE> ) => AbstractModel<DBE, DTO, any>
{
    const dtoIDOverride = config.dtoID;
    const dtoIDRef = createDtoIDRef( dtoIDOverride );
    const extensions = buildExtensions( config, ( id ) => dtoIDRef.current( id ));

    return class ModelBase extends AbstractModel<DBE, DTO, any>
    {
        constructor( models: AbstractModels, collection: Collection<DBE> )
        {
            super( models, collection, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    };
}

export type { DefineModelConfig, RootModelDefinition, ConverterRecipe, ConverterRecipeMap } from './types/definition.js';
