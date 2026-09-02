import { describe, expect, test } from 'vitest';
import { compileConverters, ConverterRecipeError } from '../converter-recipes.js';
import { createDefaultConverters } from '../default-converters.js';
import type { MongoRootDocument } from '../types/external.js';

type TagDBE = MongoRootDocument & { _id: string, name: string, type: string };

describe( 'default converters', () =>
{
    test( 'dto maps _id to id and omits _id', async() =>
    {
        const { dto } = createDefaultConverters<TagDBE>({ dtoID: ( id ) => String( id ) });
        const dbe: TagDBE = { _id: 'abc', name: 'TypeScript', type: 'skill' };
        const result = await dto.converter( dbe ) as Record<string, unknown>;

        expect( result ).toEqual({ id: 'abc', name: 'TypeScript', type: 'skill' });
        expect( result._id ).toBeUndefined();
    });

    test( 'dbe returns document unchanged', async() =>
    {
        const converters = createDefaultConverters<TagDBE>({ dtoID: ( id ) => String( id ) });
        const document: TagDBE = { _id: 'abc', name: 'TypeScript', type: 'skill' };

        expect( await converters.dbe.converter( document )).toBe( document );
    });
});

describe( 'compileConverters recipes', () =>
{
    test( 'pick selects fields and maps _id to id', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            basicDTO: { pick: [ 'name', '_id' ] }
        });

        const result = await converters.basicDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ id: '1', name: 'Tag' });
    });

    test( 'omit removes fields from default dto', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            basicDTO: { omit: [ 'type' ] }
        });

        const result = await converters.basicDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ id: '1', name: 'Tag' });
    });

    test( 'pure extends composes in either declaration order', async() =>
    {
        const forward = compileConverters<TagDBE>(
        {
            suggestDTO  : { rename: { id: '_id', label: 'name' } },
            listItemDTO : { extends: 'suggestDTO' }
        });

        const reverse = compileConverters<TagDBE>(
        {
            listItemDTO : { extends: 'suggestDTO' },
            suggestDTO  : { rename: { id: '_id', label: 'name' } }
        });

        const dbe = { _id: '1', name: 'Tag', type: 'x' };

        expect( await forward.listItemDTO.converter( dbe )).toEqual({ id: '1', label: 'Tag' });
        expect( await reverse.listItemDTO.converter( dbe )).toEqual({ id: '1', label: 'Tag' });
    });

    test( 'extends with pick applies to parent output', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            listItemDTO : { extends: 'suggestDTO', pick: [ 'label' ] },
            suggestDTO  : { rename: { id: '_id', label: 'name' } }
        });

        const result = await converters.listItemDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ label: 'Tag' });
    });

    test( 'extends with omit applies to parent output', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            listItemDTO : { extends: 'suggestDTO', omit: [ 'label' ] },
            suggestDTO  : { rename: { id: '_id', label: 'name' } }
        });

        const result = await converters.listItemDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ id: '1' });
    });

    test( 'rename maps id and label fields', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            suggestDTO: { rename: { id: '_id', label: 'name' } }
        });

        const result = await converters.suggestDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ id: '1', label: 'Tag' });
    });

    test( 'rename with pick filters renamed keys', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            suggestDTO: { rename: { id: '_id', label: 'name' }, pick: [ 'label' ] }
        });

        const result = await converters.suggestDTO.converter({ _id: '1', name: 'Tag', type: 'x' }) as Record<string, unknown>;

        expect( result ).toEqual({ label: 'Tag' });
    });

    test( 'custom converter is passed through', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            adminDTO:
            {
                custom: async( dbe ) => ({ id: dbe._id, admin: true, name: dbe.name })
            }
        });

        const result = await converters.adminDTO.converter({ _id: '1', name: 'Tag', type: 'x' });

        expect( result ).toEqual({ id: '1', admin: true, name: 'Tag' });
    });

    test( 'projection and computedProperties attach to compiled converters', async() =>
    {
        const converters = compileConverters<TagDBE>(
        {
            basicDTO:
            {
                pick                : [ 'name' ],
                projection          : { name: 1 },
                computedProperties  : [ 'normalizedName' ]
            },
            adminDTO:
            {
                converter           : async( dbe ) => ({ id: dbe._id, name: dbe.name }),
                projection          : { title: 1 },
                computedProperties  : [ 'normalizedSalary' ]
            },
            customDTO:
            {
                custom              : async( dbe ) => ({ id: dbe._id }),
                projection          : { _id: 1 },
                computedProperties  : [ 'score' ]
            }
        });

        expect( converters.basicDTO.projection ).toEqual({ name: 1 });
        expect( converters.basicDTO.computedProperties ).toEqual([ 'normalizedName' ]);
        expect( converters.adminDTO.projection ).toEqual({ title: 1 });
        expect( converters.adminDTO.computedProperties ).toEqual([ 'normalizedSalary' ]);
        expect( converters.customDTO.projection ).toEqual({ _id: 1 });
        expect( converters.customDTO.computedProperties ).toEqual([ 'score' ]);
        expect( await converters.adminDTO.converter({ _id: '1', name: 'Tag', type: 'x' })).toEqual({ id: '1', name: 'Tag' });
    });

    test( 'circular extends throws cycle path', () =>
    {
        expect(() => compileConverters<TagDBE>(
        {
            a: { extends: 'b' },
            b: { extends: 'a' }
        })).toThrow( /Circular converter recipe: (a -> b -> a|b -> a -> b)/ );
    });
});
