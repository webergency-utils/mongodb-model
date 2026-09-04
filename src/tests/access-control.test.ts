import { describe, expect, test, vi } from 'vitest';
import { AccessControl } from '../access-control.js';
import { ModelAccessConfigError, ModelAccessDeniedError } from '../errors.js';

const readCtx = { operation: 'read' as const, method: 'list' };

describe( 'AccessControl', () =>
{
    test( 'unrestricted when no config and no override', async() =>
    {
        const invoke = vi.fn( async() => ({ orgId: 'should-not-run' }));
        const access = new AccessControl(
        {
            model        : {},
            invokeFilter : invoke
        });

        await expect( access.resolve( readCtx )).resolves.toBeUndefined();
        expect( invoke ).not.toHaveBeenCalled();
    });

    test( 'legacy override uses default name when no access config', async() =>
    {
        const invoke = vi.fn( async( name: string ) =>
        {
            expect( name ).toBe( 'default' );

            return { orgId: '1' };
        });

        const access = new AccessControl(
        {
            model             : {},
            filterOverridden  : true,
            invokeFilter      : invoke
        });

        await expect( access.resolve( readCtx )).resolves.toEqual({ orgId: '1' });
        expect( invoke ).toHaveBeenCalledWith( 'default' );
    });

    test( 'configured defaults with missing name denies', async() =>
    {
        const access = new AccessControl(
        {
            model   : {},
            config  : { defaults: { read: 'org-read' }},
            invokeFilter: async() => ({})
        });

        const result = await access.resolveOrDeny({ operation: 'delete', method: 'delete' });

        expect( result ).toEqual({ denied: true });
    });

    test( 'unknown filters key throws ModelAccessConfigError', async() =>
    {
        const access = new AccessControl(
        {
            model  : {},
            config :
            {
                filters  : { 'org-read': async() => ({ orgId: '1' }) },
                defaults : { read: 'missing-policy' }
            },
            invokeFilter: async() => ({})
        });

        await expect( access.resolve( readCtx )).rejects.toBeInstanceOf( ModelAccessConfigError );
    });

    test( 'per-call access wins over defaults map', async() =>
    {
        const access = new AccessControl(
        {
            model  : {},
            config :
            {
                filters :
                {
                    a: async() => ({ policy: 'a' }),
                    b: async() => ({ policy: 'b' })
                },
                defaults: { read: 'a' }
            },
            invokeFilter: async() => ({})
        });

        await expect( access.resolve({ ...readCtx, access: 'b' })).resolves.toEqual({ policy: 'b' });
    });

    test( 'defaults function receives operation and method', async() =>
    {
        const defaults = vi.fn( async() => 'org-read' );
        const access = new AccessControl(
        {
            model  : {},
            config :
            {
                filters  : { 'org-read': async() => ({ orgId: '1' }) },
                defaults
            },
            invokeFilter: async() => ({})
        });

        await access.resolve({ operation: 'read', method: 'get' });

        expect( defaults ).toHaveBeenCalledWith({ operation: 'read', method: 'get' });
    });

    test( 'resolve throws on deny-fast false', async() =>
    {
        const access = new AccessControl(
        {
            model            : {},
            filterOverridden : true,
            invokeFilter     : async() => false
        });

        await expect( access.resolve( readCtx )).rejects.toBeInstanceOf( ModelAccessDeniedError );
    });

    test( 'resolveOrDeny returns denied without throwing', async() =>
    {
        const access = new AccessControl(
        {
            model            : {},
            filterOverridden : true,
            invokeFilter     : async() => false
        });

        const result = await access.resolveOrDeny( readCtx );

        expect( result ).toEqual({ denied: true });
    });

    test( 'match merges access filter into base', async() =>
    {
        const access = new AccessControl(
        {
            model            : {},
            filterOverridden : true,
            invokeFilter     : async() => ({ orgId: '1' })
        });

        const match = await access.match({ _id: 'x' } as any, readCtx );

        expect( match ).toEqual({ $and: [{ _id: 'x' }, { orgId: '1' }] });
    });

    test( 'match returns null when denied', async() =>
    {
        const access = new AccessControl(
        {
            model            : {},
            filterOverridden : true,
            invokeFilter     : async() => false
        });

        const match = await access.match({ _id: 'x' } as any, readCtx );

        expect( match ).toBeNull();
    });

    test( 'void filter result yields no extra filter', async() =>
    {
        const access = new AccessControl(
        {
            model            : {},
            filterOverridden : true,
            invokeFilter     : async() => undefined
        });

        await expect( access.resolve( readCtx )).resolves.toBeUndefined();
        await expect( access.match({ _id: 'x' } as any, readCtx )).resolves.toEqual({ _id: 'x' });
    });
});
