import { describe, expect, test } from 'vitest';
import
{
    ModelAccessConfigError,
    ModelAccessDeniedError,
    ModelConverterError,
    ModelError,
    ModelQueryError
}
from '../errors.js';

class SampleModel {}

describe( 'errors', () =>
{
    test( 'ModelError sets code and message', () =>
    {
        const err = new ModelError( 'MODEL_X', new SampleModel(), 'boom' );

        expect( err.code ).toBe( 'MODEL_X' );
        expect( err.message ).toContain( '[MODEL_X]' );
        expect( err.message ).toContain( 'SampleModel' );
        expect( err.message ).toContain( 'boom' );
    });

    test( 'ModelError with cause uses cause constructor for stack', () =>
    {
        const cause = new TypeError( 'inner' );
        const err = new ModelError( 'MODEL_X', new SampleModel(), 'outer', cause );

        expect( err.cause ).toBe( cause );
        expect( err.stack ).toBeDefined();
    });

    test( 'ModelQueryError wraps MODEL_QUERY_ERROR', () =>
    {
        const cause = new Error( 'db' );
        const err = new ModelQueryError( new SampleModel(), 'failed', cause );

        expect( err ).toBeInstanceOf( ModelError );
        expect( err.code ).toBe( 'MODEL_QUERY_ERROR' );
        expect( err.message ).toContain( 'failed' );
        expect( err.cause ).toBe( cause );
    });

    test( 'ModelConverterError includes conversion and id', () =>
    {
        const cause = new Error( 'bad' );
        const err = new ModelConverterError( new SampleModel(), 'dto', 'abc', cause );

        expect( err.code ).toBe( 'MODEL_CONVERTER_ERROR' );
        expect( err.message ).toContain( 'dto converter failed for abc' );
        expect( err.cause ).toBe( cause );
    });

    test( 'ModelAccessDeniedError default and custom message', () =>
    {
        const def = new ModelAccessDeniedError( new SampleModel());
        const custom = new ModelAccessDeniedError( new SampleModel(), 'nope' );

        expect( def.code ).toBe( 'MODEL_ACCESS_DENIED' );
        expect( def.message ).toContain( 'Access denied' );
        expect( custom.message ).toContain( 'nope' );
    });

    test( 'ModelAccessConfigError message', () =>
    {
        const err = new ModelAccessConfigError( new SampleModel(), 'bad policy' );

        expect( err.code ).toBe( 'MODEL_ACCESS_CONFIG' );
        expect( err.message ).toContain( 'bad policy' );
    });
});
