import { Document } from 'mongodb';
import { convert } from './helpers/mongo.js';
import { AbstractConverterOptions, AbstractModelConverters } from './types/index.js';

export class ConverterManager<DBE extends Document>
{
    #model: object;
    #converters: AbstractModelConverters<DBE>;

    constructor( model: object, converters: AbstractModelConverters<DBE> )
    {
        this.#model = model;
        this.#converters = converters;
    }

    get converters()
    {
        return this.#converters;
    }

    options<K extends keyof AbstractModelConverters<DBE>>( conversion: K ): AbstractConverterOptions<DBE>
    {
        return this.#converters[conversion];
    }

    async convert( dbe: DBE, conversion: string | number | symbol )
    {
        return convert( this.#model, this.#converters[conversion as keyof AbstractModelConverters<DBE>].converter, dbe, conversion );
    }

    async convertMany( documents: Array<DBE | null>, conversion: string | number | symbol )
    {
        return Promise.all( documents.map( dbe => dbe ? this.convert( dbe, conversion ) : null ));
    }
}
