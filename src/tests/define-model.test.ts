import { describe, expect, test, vi } from 'vitest';
import { defineModel, Model } from '../define-model.js';
import { AbstractModels } from '../models.js';
import { GET_OPTIMIZER_OPTIONS } from '../symbols.js';
import type { ModelsOptions, MongoRootDocument } from '../types/external.js';

type SkillDBE = MongoRootDocument & { _id: string, name: string };
type SkillDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor( options?: ModelsOptions )
    {
        super( 'mongodb://localhost/test-define-model', options );
    }
}

const tick = () => new Promise<void>( resolve => setTimeout( resolve, 0 ));

describe( 'defineModel', () =>
{
    test( 'uses auto dto and dbe converters', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { _id: '1', name: 'TypeScript' } ]
        }));

        const collection =
        {
            collectionName  : 'skills',
            aggregate
        };

        const models = new TestModels();
        const skills = defineModel<SkillDBE, SkillDTO>( models, collection as any );

        const dto = await skills.get( '1' );
        const dbe = await skills.get( '1', { as: 'dbe' });

        await tick();

        expect( dto ).toEqual({ id: '1', name: 'TypeScript' });
        expect( dbe ).toEqual({ _id: '1', name: 'TypeScript' });
    });
});

describe( 'Model factory', () =>
{
    test( 'subclass supports domain methods and converters', async() =>
    {
        class SkillModel extends Model<SkillDBE, SkillDTO>(
        {
            converters:
            {
                suggestDTO: { rename: { id: '_id', label: 'name' } }
            }
        })
        {
            public labelFor( id: string )
            {
                return this.get( id, { as: 'suggestDTO' });
            }
        }

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { _id: '1', name: 'TypeScript' } ]
        }));

        const collection =
        {
            collectionName  : 'skills',
            aggregate
        };

        const models = new TestModels();
        const skills = new SkillModel( models, collection as any );
        const suggest = await skills.labelFor( '1' );

        await tick();

        expect( suggest ).toEqual({ id: '1', label: 'TypeScript' });
    });

    test( 'instance dtoID override affects auto dto', async() =>
    {
        class SkillModel extends Model<SkillDBE, SkillDTO>()
        {
            public dtoID( id: string )
            {
                return `dto:${id}`;
            }
        }

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { _id: '1', name: 'TypeScript' } ]
        }));

        const models = new TestModels();
        const skills = new SkillModel( models, { collectionName: 'skills', aggregate } as any );
        const dto = await skills.get( '1' );

        await tick();

        expect( dto ).toEqual({ id: 'dto:1', name: 'TypeScript' });
    });

    test( 'config dtoID wins over subclass override', async() =>
    {
        class SkillModel extends Model<SkillDBE, SkillDTO>(
        {
            dtoID: ( id ) => `cfg:${id}`
        })
        {
            public dtoID( id: string )
            {
                return `dto:${id}`;
            }
        }

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { _id: '1', name: 'TypeScript' } ]
        }));

        const models = new TestModels();
        const skills = new SkillModel( models, { collectionName: 'skills', aggregate } as any );
        const dto = await skills.get( '1' );

        await tick();

        expect( dto ).toEqual({ id: 'cfg:1', name: 'TypeScript' });
    });

    test( 'access filters and defaults apply on list', async() =>
    {
        const aggregate = vi.fn(() => ({ toArray: async() => [] }));

        class SkillModel extends Model<SkillDBE, SkillDTO>(
        {
            access:
            {
                filters  : { 'org-read': async() => ({ name: 'TypeScript' }) },
                defaults : { read: 'org-read' }
            }
        })
        {}

        const models = new TestModels();
        const skills = new SkillModel( models, { collectionName: 'skills', aggregate } as any );

        await skills.list({ count: false });

        const pipeline = aggregate.mock.calls[0][0] as any[];
        const serialized = JSON.stringify( pipeline );

        expect( serialized ).toContain( '"name":"TypeScript"' );
    });

    test( 'inherits optimizer from AbstractModels when omitted and overrides wholesale when configured', () =>
    {
        const collection = { collectionName: 'skills', aggregate: vi.fn() } as any;
        const models = new TestModels({ optimizer: { strictErrors: true } });

        const inherited = defineModel<SkillDBE, SkillDTO>( models, collection );
        const overridden = defineModel<SkillDBE, SkillDTO>( models, collection, { optimizer: { strictFieldOrder: true } });
        const disabledClass = Model<SkillDBE, SkillDTO>({ optimizer: false });
        const disabled = new disabledClass( models, collection );
        const enabledClass = Model<SkillDBE, SkillDTO>({ optimizer: true });
        const enabled = new enabledClass( new TestModels({ optimizer: false }), collection );

        expect(( inherited as any )[GET_OPTIMIZER_OPTIONS]()).toEqual({ strictErrors: true });
        expect(( overridden as any )[GET_OPTIMIZER_OPTIONS]()).toEqual({ strictFieldOrder: true });
        expect(( disabled as any )[GET_OPTIMIZER_OPTIONS]()).toBeUndefined();
        expect(( enabled as any )[GET_OPTIMIZER_OPTIONS]()).toEqual({});
    });

    test( 'isolates dtoIDRef and extensions across multiple instances of the same Model factory class (R13)', async() =>
    {
        class BaseSkillModel extends Model<SkillDBE, SkillDTO>() {}

        class InstanceOne extends BaseSkillModel
        {
            public override dtoID( id: string )
            {
                return `one:${id}`;
            }
        }

        class InstanceTwo extends BaseSkillModel
        {
            public override dtoID( id: string )
            {
                return `two:${id}`;
            }
        }

        const models = new TestModels();
        const collection = { collectionName: 'skills', aggregate: vi.fn() } as any;
        const m1 = new InstanceOne( models, collection );
        const m2 = new InstanceTwo( models, collection );

        const dto1 = await m1.converters.dto.converter({ _id: '1', name: 'TS' });
        const dto2 = await m2.converters.dto.converter({ _id: '1', name: 'TS' });

        expect( dto1 ).toEqual({ id: 'one:1', name: 'TS' });
        expect( dto2 ).toEqual({ id: 'two:1', name: 'TS' });
    });
});
