import { describe, expect, test, vi } from 'vitest';
import { ModelError } from '../errors.js';
import { ComputedPropertyResolver, SmartFilterResolver } from '../resolvers.js';

class DummyModel {}

describe( 'SmartFilterResolver', () =>
{
    test( 'root mode merges filters and pipelines', async() =>
    {
        const smartFilters =
        {
            byStatus: async( status: string ) => ({ filter: { status }, pipeline: [{ $match: { status } }] }),
            byOrg   : async( orgId: string ) => ({ filter: { orgId } })
        };

        const resolver = new SmartFilterResolver( new DummyModel(), smartFilters );
        const result = await resolver.resolve({ byStatus: 'active', byOrg: '1' });

        expect( result.pipeline ).toEqual([{ $match: { status: 'active' } }]);
        expect( result.filter ).toEqual(
        {
            $and:
            [
                { $and: [{ status: 'active' }] },
                { orgId: '1' }
            ]
        });
    });

    test( 'root mode throws on unsupported filter', async() =>
    {
        const resolver = new SmartFilterResolver( new DummyModel(), {
            byStatus: async() => ({ filter: { status: 'x' } })
        });

        await expect( resolver.resolve({ unknown: true })).rejects.toMatchObject(
        {
            code: 'MODEL_SMART_FILTER_UNSUPPORTED'
        });
        await expect( resolver.resolve({ unknown: true })).rejects.toBeInstanceOf( ModelError );
    });

    test( 'property mode prefixes filter and pipeline', async() =>
    {
        const smartFilters =
        {
            byLabel: async( label: string ) => ({
                filter  : { label },
                pipeline: [{ $match: { label } }]
            })
        };

        const resolver = new SmartFilterResolver( new DummyModel(), smartFilters, { prefix: 'items' });
        const result = await resolver.resolve({ byLabel: 'a' });

        expect( result.items ).toBeDefined();
        expect( result.items!.filter ).toEqual(
        {
            $and: [{ 'items.label': 'a' }]
        });
        expect( result.items!.pipeline![0].$match ).toEqual({ 'items.label': 'a' });
    });

    test( 'property mode without parentResolve throws on extras', async() =>
    {
        const resolver = new SmartFilterResolver( new DummyModel(), {}, { prefix: 'items' });

        await expect( resolver.resolve({ unknown: 1 })).rejects.toMatchObject(
        {
            code: 'MODEL_SMART_FILTER_UNSUPPORTED'
        });
    });

    test( 'property mode parentResolve merges root-shaped result', async() =>
    {
        const parentResolve = vi.fn( async() => ({
            filter  : { orgId: '1' },
            pipeline: [{ $match: { orgId: '1' } }]
        }));

        const smartFilters =
        {
            byLabel: async( label: string ) => ({ filter: { label } })
        };

        const resolver = new SmartFilterResolver( new DummyModel(), smartFilters, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve({ byLabel: 'x', parentKey: true });

        expect( parentResolve ).toHaveBeenCalledWith({ parentKey: true });
        expect( result.items!.filter ).toEqual({ $and: [{ 'items.label': 'x' }] });
        expect( result[''] ).toEqual(
        {
            filter  : { orgId: '1' },
            pipeline: [{ $match: { orgId: '1' } }]
        });
    });

    test( 'property mode parentResolve merges path-keyed result', async() =>
    {
        const parentResolve = vi.fn( async() => ({
            nested: { filter: { a: 1 }, pipeline: [] }
        }));

        const resolver = new SmartFilterResolver( new DummyModel(), {}, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve({ parentOnly: 1 });

        expect( result.nested ).toEqual({ filter: { a: 1 }, pipeline: [] });
    });

    test( 'property mode skips prefix entry when empty and parent empty', async() =>
    {
        const parentResolve = vi.fn( async() => ({}));
        const resolver = new SmartFilterResolver( new DummyModel(), {}, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve({});

        expect( result ).toEqual({});
    });
});

describe( 'ComputedPropertyResolver', () =>
{
    test( 'root mode resolves object and array properties', async() =>
    {
        const computed =
        {
            fullName: async() => ({
                fields  : { fullName: { $concat: [ '$first', ' ', '$last' ] } },
                pipeline: [{ $addFields: { x: 1 } }]
            }),
            age: async() => ({
                fields  : { age: 1 },
                pipeline: []
            })
        };

        const resolver = new ComputedPropertyResolver( new DummyModel(), computed );
        const fromObject = await resolver.resolve({ fullName: null, age: null });
        const fromArray = await resolver.resolve([ 'fullName' ]);

        expect( fromObject.fields ).toEqual(
        {
            fullName: { $concat: [ '$first', ' ', '$last' ] },
            age     : 1
        });
        expect( fromObject.pipeline ).toEqual([{ $addFields: { x: 1 } }]);
        expect( fromArray.fields ).toEqual({ fullName: { $concat: [ '$first', ' ', '$last' ] } });
        expect( fromArray.pipeline ).toEqual([{ $addFields: { x: 1 } }]);
    });

    test( 'root mode returns null fields/pipeline when empty', async() =>
    {
        const resolver = new ComputedPropertyResolver( new DummyModel(), {});
        const result = await resolver.resolve({ missing: null });

        expect( result ).toEqual({ fields: null, pipeline: null });
    });

    test( 'property mode prefixes fields and pipelines', async() =>
    {
        const computed =
        {
            label: async() => ({
                fields  : { upper: { $toUpper: '$label' } },
                pipeline: [{ $addFields: { tmp: 1 } }]
            })
        };

        const resolver = new ComputedPropertyResolver( new DummyModel(), computed, { prefix: 'items' });
        const result = await resolver.resolve({ label: null });

        expect( result.items!.fields ).toEqual({ 'items.upper': { $toUpper: '$items.label' } });
        expect( result.items!.pipeline![0] ).toEqual({ $addFields: { 'items.tmp': 1 } });
    });

    test( 'property mode throws unsupported without parentResolve', async() =>
    {
        const resolver = new ComputedPropertyResolver( new DummyModel(), {}, { prefix: 'items' });

        await expect( resolver.resolve({ unknown: null })).rejects.toMatchObject(
        {
            code: 'MODEL_COMPUTED_PROPERTY_UNSUPPORTED'
        });
    });

    test( 'property mode parentResolve merges root-shaped result', async() =>
    {
        const parentResolve = vi.fn( async() => ({
            fields  : { rootField: 1 },
            pipeline: [{ $addFields: { rootField: 1 } }]
        }));

        const computed =
        {
            label: async() => ({ fields: { label: 1 }, pipeline: [] })
        };

        const resolver = new ComputedPropertyResolver( new DummyModel(), computed, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve({ label: null, parentProp: null });

        expect( parentResolve ).toHaveBeenCalledWith({ parentProp: null });
        expect( result.items!.fields ).toEqual({ 'items.label': {} });
        expect( result[''] ).toEqual(
        {
            fields  : { rootField: 1 },
            pipeline: [{ $addFields: { rootField: 1 } }]
        });
    });

    test( 'property mode parentResolve merges path-keyed result', async() =>
    {
        const parentResolve = vi.fn( async() => ({
            nested: { fields: { a: 1 }, pipeline: [] }
        }));

        const resolver = new ComputedPropertyResolver( new DummyModel(), {}, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve({ parentOnly: null });

        expect( result.nested ).toEqual({ fields: { a: 1 }, pipeline: [] });
    });

    test( 'property mode array form and empty parent', async() =>
    {
        const computed =
        {
            label: async() => ({ fields: { label: 1 }, pipeline: [] })
        };
        const parentResolve = vi.fn( async() => ({}));
        const resolver = new ComputedPropertyResolver( new DummyModel(), computed, {
            prefix          : 'items',
            parentResolve
        });

        const result = await resolver.resolve([ 'label' ]);

        expect( result.items!.fields ).toEqual({ 'items.label': {} });
        expect( result[''] ).toBeUndefined();
    });
});
