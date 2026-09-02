export type DtoIDFn = ( id: unknown ) => string;

export type DtoIDRef =
{
    current : DtoIDFn
}

export function createDtoIDRef( override?: DtoIDFn ): DtoIDRef
{
    return {
        current: override ?? (( id ) => String( id ))
    };
}

export function bindInstanceDtoID(
    ref: DtoIDRef,
    instance: { dtoID: ( id: any ) => any },
    configOverride?: DtoIDFn
): void
{
    if( configOverride )
    {
        return;
    }

    ref.current = ( id ) => instance.dtoID( id );
}
