export class ModelError extends Error
{
    constructor( model: object, message: string, err?: Error )
    {
        super( `${model.constructor.name} ${message}`, { cause: err });

        Error.captureStackTrace( this, err ? err.constructor : this.constructor );
    }
}

export class ModelQueryError extends ModelError
{
    constructor( model: object, message: string, err?: Error )
    {
        super( model, message, err );

        Error.captureStackTrace( this, err ? err.constructor : this.constructor );
    }
}

export class ModelConverterError extends ModelError
{
    constructor( model: object, conversion: string, id: any, err?: Error )
    {
        super( model, conversion + ' converter failed for ' + id.toString(), err );

        Error.captureStackTrace( this, err ? err.constructor : this.constructor );
    }
}