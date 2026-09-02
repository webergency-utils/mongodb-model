import { describe, expect, test, vi } from 'vitest';
import { definePropertyModel, PropertyModel } from '../define-property-model.js';
import { AbstractModels } from '../models.js';
import { REGISTER_MODEL } from '../symbols.js';
import type { MongoPropertyDocument, MongoRootDocument } from '../types/external.js';

type JobDBE = MongoRootDocument & { _id: string, title: string };
type ApplicationDBE = MongoPropertyDocument & { id: string, status: string };
type ApplicationDTO = { id: string, status: string };

class TestModels extends AbstractModels
{
    public registered: Array<{ collection: string, path?: string }> = [];

    constructor()
    {
        super( 'mongodb://localhost/test-define-property-model' );
    }

    [REGISTER_MODEL]( instance: unknown, collection: string, path?: string )
    {
        AbstractModels.prototype[REGISTER_MODEL].call( this, instance as any, collection, path );
        this.registered.push({ collection, path });
    }
}

const tick = () => new Promise<void>( resolve => setTimeout( resolve, 0 ));

describe( 'definePropertyModel', () =>
{
    test( 'registers with path prefix and converts embedded documents', async() =>
    {
        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { id: 'app-1', status: 'submitted' } ]
        }));

        const collection =
        {
            collectionName  : 'jobs',
            aggregate
        };

        const models = new TestModels();
        const applications = definePropertyModel<JobDBE, ApplicationDBE, ApplicationDTO>(
            models,
            collection as any,
            { path: 'engagements[].applications[]' }
        );

        expect( models.registered ).toContainEqual(
        {
            collection  : 'jobs',
            path        : 'engagements.applications'
        });

        const dto = await applications.get( 'app-1' );

        await tick();

        expect( dto ).toEqual({ id: 'app-1', status: 'submitted' });
    });
});

describe( 'PropertyModel factory', () =>
{
    test( 'subclass supports domain methods', async() =>
    {
        class ApplicationModel extends PropertyModel<JobDBE, ApplicationDBE, ApplicationDTO>(
        {
            path        : 'engagements[].applications[]',
            converters  :
            {
                basicDTO: { pick: [ 'id', 'status' ] }
            }
        })
        {
            public async load( id: string )
            {
                return this.get( id, { as: 'basicDTO' });
            }
        }

        const aggregate = vi.fn(() =>
        ({
            toArray: async() => [ { id: 'app-1', status: 'submitted' } ]
        }));

        const collection =
        {
            collectionName  : 'jobs',
            aggregate
        };

        const models = new TestModels();
        const applications = new ApplicationModel( models, collection as any );
        const dto = await applications.load( 'app-1' );

        await tick();

        expect( dto ).toEqual({ id: 'app-1', status: 'submitted' });
    });

    test( 'instance dtoID override affects auto dto', async() =>
    {
        class ApplicationModel extends PropertyModel<JobDBE, ApplicationDBE, ApplicationDTO>(
        {
            path: 'engagements[].applications[]'
        })
        {
            public dtoID( id: string )
            {
                return `dto:${id}`;
            }
        }

        const models = new TestModels();
        const applications = new ApplicationModel( models, { collectionName: 'jobs', aggregate: vi.fn() } as any );
        const dto = await applications.converters.dto.converter({ id: 'app-1', status: 'submitted' } as ApplicationDBE );

        expect( dto ).toEqual({ id: 'dto:app-1', status: 'submitted' });
    });

    test( 'config dtoID wins over subclass override', async() =>
    {
        class ApplicationModel extends PropertyModel<JobDBE, ApplicationDBE, ApplicationDTO>(
        {
            path    : 'engagements[].applications[]',
            dtoID   : ( id ) => `cfg:${id}`
        })
        {
            public dtoID( id: string )
            {
                return `dto:${id}`;
            }
        }

        const models = new TestModels();
        const applications = new ApplicationModel( models, { collectionName: 'jobs', aggregate: vi.fn() } as any );
        const dto = await applications.converters.dto.converter({ id: 'app-1', status: 'submitted' } as ApplicationDBE );

        expect( dto ).toEqual({ id: 'cfg:app-1', status: 'submitted' });
    });
});
