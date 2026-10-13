import { afterEach, describe, expect, test, vi } from 'vitest';
import { Benchmark, formatter } from '../helpers/benchmark.js';

describe( 'Benchmark', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    test( 'tracks elapsed and formats times', () =>
    {
        const bm = new Benchmark( 'unit' );

        expect( bm.name ).toBe( 'unit' );
        expect( bm.elapsed()).toBeGreaterThanOrEqual( 0 );
        expect( typeof bm.startTime ).toBe( 'string' );
        expect( typeof bm.time ).toBe( 'string' );
        expect( formatter.format( new Date())).toMatch( /\d/ );
    });

    test( 'step and end log console messages', () =>
    {
        const spy = vi.spyOn( console, 'log' ).mockImplementation(() => undefined );
        const bm = new Benchmark( 'job' );

        bm.step( 'QUERY' );
        bm.end();

        expect( spy ).toHaveBeenCalledTimes( 2 );
        expect( String( spy.mock.calls[0][0] )).toContain( '[BMARK:' );
        expect( String( spy.mock.calls[0][0] )).toContain( 'job step QUERY' );
        expect( String( spy.mock.calls[1][0] )).toContain( 'job ended in' );
    });
});
