import type { ExampleAuth } from '../types.js';
import type { ExampleModels } from '../index.js';
import type { AccessResolveContext } from '@webergency-utils/mongodb-model';

/** Read the request auth from Flow scope (set via `models.scope.execute(fn, { auth })`). */
export function getAuth( models: ExampleModels ): ExampleAuth | undefined
{
    return models.scope.get<ExampleAuth>( 'auth' );
}

/**
 * Pick a named access policy from Flow auth.
 * Employer vs recruiter is decided here — filter bodies live under `access.filters`.
 */
export function resolveAccessPolicy(
    models: ExampleModels,
    { operation }: Pick<AccessResolveContext, 'operation' | 'method'>,
    options?:
    {
        guestRead?      : string
        employerRead?   : string
        employerWrite?  : string
        recruiterRead?  : string
        recruiterWrite? : string
        adminRead?      : string
        adminWrite?     : string
    }
): string | undefined
{
    const auth = getAuth( models );
    const guestRead = options?.guestRead ?? 'guest-read';
    const employerRead = options?.employerRead ?? 'employer-read';
    const employerWrite = options?.employerWrite ?? 'employer-write';
    const recruiterRead = options?.recruiterRead ?? 'recruiter-read';
    const recruiterWrite = options?.recruiterWrite ?? 'recruiter-write';
    const adminRead = options?.adminRead ?? 'admin';
    const adminWrite = options?.adminWrite ?? 'admin';

    if( auth?.role === 'admin' )
    {
        return operation === 'read' ? adminRead : adminWrite;
    }

    if( auth?.role === 'employer' )
    {
        return operation === 'read' ? employerRead : employerWrite;
    }

    if( auth?.role === 'recruiter' )
    {
        return operation === 'read' ? recruiterRead : recruiterWrite;
    }

    if( operation === 'read' ){ return guestRead }

    return undefined;
}
