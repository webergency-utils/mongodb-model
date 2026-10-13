import { describe, expect, test } from 'vitest';
import { flowExecute, flowGet, flowSet, flowStart } from '../flow.js';

describe( 'flow helpers', () =>
{
    test( 'flowExecute provides scoped get/set', async() =>
    {
        const value = await flowExecute( async() =>
        {
            expect( flowGet( 'missing', 'fallback' )).toBe( 'fallback' );
            flowSet( 'flag', true );

            return flowGet( 'flag' );
        },
        { seed: 1 });

        expect( value ).toBe( true );
    });

    test( 'flowStart runs callback with scope', async() =>
    {
        const seen: unknown[] = [];

        await new Promise<void>(( resolve, reject ) =>
        {
            flowStart( async() =>
            {
                try
                {
                    seen.push( flowGet( 'x' ));
                    flowSet( 'y', 2 );
                    seen.push( flowGet( 'y' ));
                    resolve();
                }
                catch( e )
                {
                    reject( e );
                }
            },
            { x: 1 });
        });

        expect( seen ).toEqual([ 1, 2 ]);
    });
});
