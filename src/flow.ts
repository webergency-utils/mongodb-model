import Flow from '@liqd-js/flow';

export function flowStart( callback: Function, scope: object )
{
    Flow.start( callback, scope );
}

export function flowGet<T>( key: string, fallback?: T ): T
{
    return Flow.get( key, fallback );
}

export function flowSet( key: string, value: unknown )
{
    Flow.set( key, value );
}

export function flowExecute<T>( callback: () => T | Promise<T>, scope: object, freeze: boolean | { exit?: boolean, freeze?: boolean } = true ): Promise<T>
{
    return Flow.execute( callback, scope, freeze );
}
