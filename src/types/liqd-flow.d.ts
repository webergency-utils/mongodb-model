declare module '@liqd-js/flow'
{
    const Flow:
    {
        start   : ( callback: Function, scope: object ) => void
        get     : <T>( key: string, fallback?: T ) => T
        set     : ( key: string, value: unknown ) => void
        execute : <T>( callback: () => T | Promise<T>, scope: object, freeze?: boolean | { exit?: boolean, freeze?: boolean }) => Promise<T>
    };

    export default Flow;
}
