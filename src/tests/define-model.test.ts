import { describe, expect, test, vi } from 'vitest';
import { defineModel, Model } from '../define-model.js';
import { AbstractModels } from '../models.js';
import type { MongoRootDocument } from '../types/external.js';

type SkillDBE = MongoRootDocument & { _id: string, name: string };
type SkillDTO = { id: string, name: string };

class TestModels extends AbstractModels
{
    constructor()
    {
        super( 'mongodb://localhost/test-define-model' );
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
});
