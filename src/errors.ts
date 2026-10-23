export class ModelError extends Error
{
    public readonly code: string;

    constructor( model: object, message: string, cause?: Error );
    constructor( code: string, model: object, message: string, cause?: Error );
    constructor( codeOrModel: string | object, modelOrMessage: object | string, messageOrCause?: string | Error, maybeCause?: Error )
    {
        const hasCode = typeof codeOrModel === 'string';
        const code = hasCode ? codeOrModel : 'MODEL_INTERNAL_ERROR';
        const model = ( hasCode ? modelOrMessage : codeOrModel ) as object;
        const message = ( hasCode ? messageOrCause : modelOrMessage ) as string;
        const cause = ( hasCode ? maybeCause : messageOrCause ) as Error | undefined;

        super( `[${code}] ${model.constructor.name}: ${message}`, { cause });

        this.code = code;

        Error.captureStackTrace( this, cause ? cause.constructor : this.constructor );
    }
}

export class ModelQueryError extends ModelError
{
    constructor( model: object, message: string, cause?: Error )
    {
        super( 'MODEL_QUERY_ERROR', model, message, cause );

        Error.captureStackTrace( this, cause ? cause.constructor : this.constructor );
    }
}

export class ModelConverterError extends ModelError
{
    constructor( model: object, conversion: string, id: unknown, cause?: Error )
    {
        super( 'MODEL_CONVERTER_ERROR', model, `${conversion} converter failed for ${String( id )}`, cause );

        Error.captureStackTrace( this, cause ? cause.constructor : this.constructor );
    }
}

export class ModelAccessDeniedError extends ModelError
{
    constructor( model: object, message: string = 'Access denied' )
    {
        super( 'MODEL_ACCESS_DENIED', model, message );

        Error.captureStackTrace( this, this.constructor );
    }
}

export type ModelValidationIssue =
{
    message : string
    path?   : ReadonlyArray<string | number | symbol>
};

export class ModelValidationError extends ModelError
{
    public readonly issues: ReadonlyArray<ModelValidationIssue>;

    constructor( model: object, message: string, issues: ReadonlyArray<ModelValidationIssue> = [], cause?: Error )
    {
        super( 'MODEL_VALIDATION_ERROR', model, message, cause );

        this.issues = issues;

        Error.captureStackTrace( this, cause ? cause.constructor : this.constructor );
    }
}

export class ModelAccessConfigError extends ModelError
{
    constructor( model: object, message: string )
    {
        super( 'MODEL_ACCESS_CONFIG', model, message );

        Error.captureStackTrace( this, this.constructor );
    }
}

export class ModelVersionConflictError extends ModelError
{
    public readonly id?: unknown;
    public readonly expectedVersion?: number;

    constructor( model: object, id?: unknown, expectedVersion?: number, message?: string )
    {
        super(
            'MODEL_VERSION_CONFLICT',
            model,
            message ?? `Version conflict${id !== undefined ? ` for ${String( id )}` : ''}${expectedVersion !== undefined ? ` (expected version ${expectedVersion})` : ''}`
        );

        this.id = id;
        this.expectedVersion = expectedVersion;

        Error.captureStackTrace( this, this.constructor );
    }
}

export class ModelIdCollisionError extends ModelError
{
    public readonly id?: unknown;
    public readonly attempts: number;

    constructor( model: object, id: unknown, attempts: number, message?: string, cause?: Error )
    {
        super(
            'MODEL_ID_COLLISION',
            model,
            message ?? `ID collision after ${attempts} attempt${attempts === 1 ? '' : 's'}${id !== undefined ? ` (last candidate: ${String( id )})` : ''}`,
            cause
        );

        this.id = id;
        this.attempts = attempts;

        Error.captureStackTrace( this, cause ? cause.constructor : this.constructor );
    }
}
