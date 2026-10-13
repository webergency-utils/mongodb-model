import { describe, expect, test, vi } from 'vitest';
import { createDtoIDRef, bindInstanceDtoID } from '../dto-id-bind.js';
import { ModelEventEmitter } from '../events.js';
import { flowExecute } from '../flow.js';
import { deleteNullishProperties, deleteUndefinedProperties } from '../helpers/object.js';
import { DUMP } from '../helpers/utils.js';
import { AbstractModels } from '../models.js';

describe( 'misc coverage gaps', () =>
{
    test( 'createDtoIDRef uses override and bindInstanceDtoID skips when configured', () =>
    {
        const overridden = createDtoIDRef( id => `x:${id}` );

        expect( overridden.current( 1 )).toBe( 'x:1' );

        const defaults = createDtoIDRef();

        expect( defaults.current( 5 )).toBe( '5' );

        bindInstanceDtoID( overridden, { dtoID: id => `i:${id}` }, id => `c:${id}` );
        expect( overridden.current( 2 )).toBe( 'x:2' );

        bindInstanceDtoID( defaults, { dtoID: id => `i:${id}` });
        expect( defaults.current( 3 )).toBe( 'i:3' );
    });

    test( 'ModelEventEmitter logs handler failures', () =>
    {
        const emitter = new ModelEventEmitter();
        const errSpy = vi.spyOn( console, 'error' ).mockImplementation(() => undefined );

        emitter.on( 'query', () => { throw new Error( 'handler boom' ) });
        emitter.emit( 'query', { collection: 'c', pipeline: [], duration: 1, operation: 'list' });

        expect( errSpy ).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    test( 'DUMP stringify returns empty for functions', () =>
    {
        const spy = vi.spyOn( console, 'log' ).mockImplementation(() => undefined );

        DUMP({ fn: () => 1 });

        expect( String( spy.mock.calls[0][0] )).toContain( '"fn": ' );
        spy.mockRestore();
    });

    test( 'object helpers cover nested array and multiI18n fallback', () =>
    {
        expect( deleteNullishProperties({ a: [ null, { b: null, c: 1 } ] })).toEqual({ a: [{ c: 1 }] });
        expect( deleteUndefinedProperties({ a: [ undefined, { b: undefined, c: 1 } ] })).toEqual({ a: [{ c: 1 }] });
    });

    test( 'models.scope.assign sets flow values', async() =>
    {
        class M extends AbstractModels
        {
            constructor()
            {
                super( 'mongodb://localhost/test-scope-assign' );
            }
        }

        const models = new M();

        await models.scope.execute( async() =>
        {
            models.scope.assign({ hello: 'world' });
            expect( models.scope.get( 'hello' )).toBe( 'world' );
        }, {});
    });

    test( 'multiI18n falls back when locale missing', async() =>
    {
        const { multiI18n } = await import( '../helpers/object.js' );

        await flowExecute( async() =>
        {
            expect( multiI18n({ de: 'hallo' }) ).toEqual({ fr: 'hallo' });
            expect( multiI18n({ en: 'hello', de: 'hallo' }) ).toEqual({ fr: 'hello' });
        }, { locales: new Set([ 'fr' ]) });
    });
});
