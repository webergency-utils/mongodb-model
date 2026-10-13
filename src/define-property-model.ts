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
import { DefinePropertyModelConfig } from './types/definition.js';

function buildPropertyExtensions<DBE extends MongoPropertyDocument>(
    config: Omit<DefinePropertyModelConfig<DBE>, 'path'>,
    dtoID: ( id: unknown ) => string
): ConstructorExtensions<any>
{
    return {
        converters          : compileConverters( config.converters, { dtoID }),
        smartFilters        : config.smartFilters,
        computedProperties  : config.computedProperties,
        access              : config.access,
        optimizer           : config.optimizer
    };
}

export function definePropertyModel
<
    RootDBE extends MongoRootDocument,
    DBE extends MongoPropertyDocument,
    DTO extends Document = Document
>(
    models: AbstractModels,
    collection: Collection<RootDBE>,
    config: DefinePropertyModelConfig<DBE>
): AbstractPropertyModel<RootDBE, DBE, DTO, any>
{
    const { path, ...rest } = config;
    const dtoIDOverride = rest.dtoID;
    const dtoIDRef = createDtoIDRef( dtoIDOverride );
    const extensions = buildPropertyExtensions( rest, ( id ) => dtoIDRef.current( id ));

    class DefinedPropertyModel extends AbstractPropertyModel<RootDBE, DBE, DTO, any>
    {
        constructor( m: AbstractModels, c: Collection<RootDBE>, p: string )
        {
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
    DTO extends Document = Document
>(
    config: DefinePropertyModelConfig<DBE>
): new ( models: AbstractModels, collection: Collection<RootDBE> ) => AbstractPropertyModel<RootDBE, DBE, DTO, any>
{
    const { path, ...rest } = config;
    const dtoIDOverride = rest.dtoID;
    const dtoIDRef = createDtoIDRef( dtoIDOverride );
    const extensions = buildPropertyExtensions( rest, ( id ) => dtoIDRef.current( id ));

    return class PropertyModelBase extends AbstractPropertyModel<RootDBE, DBE, DTO, any>
    {
        constructor( models: AbstractModels, collection: Collection<RootDBE> )
        {
            super( models, collection, path, extensions );
            bindInstanceDtoID( dtoIDRef, this, dtoIDOverride );
        }
    };
}

export type { DefinePropertyModelConfig, PropertyModelDefinition } from './types/definition.js';
