import type { ClientSession } from 'mongodb';
import Flow from '@liqd-js/flow';

export const TRANSACTION_SESSION_KEY = '__mongodb_model_session__';
export const TRANSACTION_POST_COMMIT_KEY = '__mongodb_model_tx_post_commit__';

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

export function getActiveSession( explicitSession?: ClientSession ): ClientSession | undefined
{
    return explicitSession ?? flowGet<ClientSession | undefined>( TRANSACTION_SESSION_KEY );
}

export function registerTransactionPostCommit( callback: () => void | Promise<void> ): boolean
{
    const set = flowGet<Set<() => void | Promise<void>> | undefined>( TRANSACTION_POST_COMMIT_KEY );

    if( !set )
    {
        return false;
    }

    set.add( callback );

    return true;
}
