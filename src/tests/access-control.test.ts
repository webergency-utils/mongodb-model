import { describe, expect, test } from 'vitest';
import { AccessControl } from '../access-control.js';
import { ModelAccessDeniedError } from '../errors.js';

describe( 'AccessControl', () =>
{
    test( 'resolve throws on deny-fast false', async() =>
    {
        const access = new AccessControl({}, async() => false );

        await expect( access.resolve() ).rejects.toBeInstanceOf( ModelAccessDeniedError );
    });

    test( 'resolveOrDeny returns denied without throwing', async() =>
    {
        const access = new AccessControl({}, async() => false );
        const result = await access.resolveOrDeny();

        expect( result ).toEqual({ denied: true });
    });

    test( 'match merges access filter into base', async() =>
    {
        const access = new AccessControl({}, async() => ({ orgId: '1' }));
        const match = await access.match({ _id: 'x' } as any );

        expect( match ).toEqual({ $and: [{ _id: 'x' }, { orgId: '1' }] });
    });

    test( 'match returns null when denied', async() =>
    {
        const access = new AccessControl({}, async() => false );
        const match = await access.match({ _id: 'x' } as any );

        expect( match ).toBeNull();
    });
});
