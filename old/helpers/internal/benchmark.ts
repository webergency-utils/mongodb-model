export const formatter = new Intl.DateTimeFormat( 'en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', fractionalSecondDigits: 3, hour12: false });

export class Benchmark
{
    public start = new Date();
    public last = Date.now();
    
    public constructor( public name: string ){}

    public elapsed()
    {
        return Date.now() - this.start.getTime();
    }

    public step( label: string )
    {
        const now = Date.now(), step = now - this.last;

        this.last = now;

        console.log( `[BMARK:${formatter.format( new Date() )}] ${this.name} step ${label} in ${step}ms)` );
    }

    public get startTime()
    {
        return formatter.format( this.start );
    }

    public get time()
    {
        return formatter.format( new Date() );
    }

    public end()
    {
        console.log( `[BMARK:${formatter.format( new Date() )}] ${this.name} ended in ${this.elapsed()}ms)` );
    }
}
