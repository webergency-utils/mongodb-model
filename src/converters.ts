import { Document } from 'mongodb';
import { ModelConverterError, ModelError } from './errors.js';
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

    async convertFrom( data: unknown, fromKey?: string ): Promise<Omit<DBE, '_id'> & { _id?: DBE['_id'], id?: any }>
    {
        const fromMap = this.#converters.from;

        if( !fromMap || typeof fromMap !== 'object' )
        {
            throw new ModelError( 'MODEL_CONFIG_ERROR', this.#model, 'Converter fromKey not found' );
        }

        let resolvedKey = fromKey;

        if( !resolvedKey )
        {
            const keys = Object.keys( fromMap );

            if( 'default' in fromMap )
            {
                resolvedKey = 'default';
            }
            else if( keys.length === 1 )
            {
                resolvedKey = keys[0];
            }
        }

        const fn = resolvedKey ? fromMap[resolvedKey] : undefined;

        if( typeof fn !== 'function' )
        {
            throw new ModelError( 'MODEL_CONFIG_ERROR', this.#model, `Converter fromKey "${String( resolvedKey ?? 'default' )}" not found` );
        }

        try
        {
            return await fn( data ) as Omit<DBE, '_id'> & { _id?: DBE['_id'], id?: any };
        }
        catch( e )
        {
            throw new ModelConverterError( this.#model, `from:${resolvedKey}`, ( data as any )?.id ?? ( data as any )?._id, e as Error );
        }
    }
}
