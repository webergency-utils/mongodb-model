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

    test( 'ModelError supports legacy 2-arg and 3-arg (model, message, cause?) constructor', () =>
    {
        const cause = new Error( 'root-cause' );
        const err2 = new ( ModelError as any )( new SampleModel(), 'legacy-msg' );
        const err3 = new ( ModelError as any )( new SampleModel(), 'legacy-cause', cause );

        expect( err2.code ).toBe( 'MODEL_INTERNAL_ERROR' );
        expect( err2.message ).toContain( '[MODEL_INTERNAL_ERROR] SampleModel: legacy-msg' );
        expect( err3.code ).toBe( 'MODEL_INTERNAL_ERROR' );
        expect( err3.message ).toContain( '[MODEL_INTERNAL_ERROR] SampleModel: legacy-cause' );
        expect( err3.cause ).toBe( cause );
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
