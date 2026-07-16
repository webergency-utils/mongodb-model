import { appendFile } from 'fs/promises';

export class Log
{
    private static queues: Map<string, Promise<void>> = new Map();

    public static append( path: string, log: string ): Promise<void>
    {
        const previousPromise = this.queues.get(path) || Promise.resolve();

        const newPromise = previousPromise.then(() => appendFile( path, log )).catch((err) => 
        {
            console.error(`Error appending log for id ${path}:`, err);
        });

        this.queues.set( path, newPromise );

        newPromise.finally(() => ( this.queues.get( path ) === newPromise ) && this.queues.delete( path ));

        return newPromise;
    }
}