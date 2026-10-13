import { afterEach, describe, expect, test, vi } from 'vitest';
import { appendFile } from 'fs/promises';
import { Log } from '../helpers/log.js';

vi.mock( 'fs/promises', () => ({
    appendFile: vi.fn( async() => undefined )
}));

describe( 'Log', () =>
{
    afterEach(() =>
    {
        vi.clearAllMocks();
    });

    test( 'append writes sequentially and clears queue', async() =>
    {
        const mocked = vi.mocked( appendFile );

        await Promise.all(
        [
            Log.append( '/tmp/a.txt', 'one\n' ),
            Log.append( '/tmp/a.txt', 'two\n' )
        ]);

        expect( mocked ).toHaveBeenCalledTimes( 2 );
        expect( mocked.mock.calls[0] ).toEqual([ '/tmp/a.txt', 'one\n' ]);
        expect( mocked.mock.calls[1] ).toEqual([ '/tmp/a.txt', 'two\n' ]);
    });

    test( 'append swallows write errors', async() =>
    {
        const mocked = vi.mocked( appendFile );
        const errSpy = vi.spyOn( console, 'error' ).mockImplementation(() => undefined );

        mocked.mockRejectedValueOnce( new Error( 'disk' ));

        await expect( Log.append( '/tmp/b.txt', 'x' )).resolves.toBeUndefined();
        expect( errSpy ).toHaveBeenCalled();
    });
});
