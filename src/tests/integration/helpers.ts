import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from '../../index.js';
import { ExampleModels } from '../../../example/index.js';
import type { ExampleAuth } from '../../../example/types.js';

/** Load `.env.test` from the repo root without adding a dotenv dependency. */
function loadEnvTest(): void
{
    const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../..' );
    const path = resolve( root, '.env.test' );

    if( !existsSync( path ) ){ return }

    for( const raw of readFileSync( path, 'utf8' ).split( '\n' ) )
    {
        const line = raw.trim();

        if( !line || line.startsWith( '#' ) ){ continue }

        const eq = line.indexOf( '=' );

        if( eq <= 0 ){ continue }

        const key = line.slice( 0, eq ).trim();
        let value = line.slice( eq + 1 ).trim();

        if(
            ( value.startsWith( '"' ) && value.endsWith( '"' ) )
            || ( value.startsWith( "'" ) && value.endsWith( "'" ) )
        )
        {
            value = value.slice( 1, -1 );
        }

        if( process.env[key] === undefined )
        {
            process.env[key] = value;
        }
    }
}

loadEnvTest();

export const INTEGRATION_URI = process.env.MONGODB_URI;

if( !INTEGRATION_URI )
{
    throw new Error(
        'MONGODB_URI is not set. Copy .env.test.example to .env.test (or export MONGODB_URI).'
    );
}

export const INTEGRATION_DB = process.env.MONGODB_DB ?? 'webergency_mongodb_model';

export type SeedIds =
{
    acmeId          : ObjectId
    inactiveOrgId   : ObjectId
    staffJobId      : ObjectId
    platformJobId   : ObjectId
    draftJobId      : ObjectId
    otherOrgJobId   : ObjectId
}

export async function dropIntegrationDatabase( dbName: string = INTEGRATION_DB ): Promise<void>
{
    const client = new MongoClient( INTEGRATION_URI );

    try
    {
        await client.connect();
        await client.db( dbName ).dropDatabase();
    }
    finally
    {
        await client.close();
    }
}

export function createExampleModels( dbName: string = INTEGRATION_DB ): ExampleModels
{
    return new ExampleModels( INTEGRATION_URI, dbName );
}

/** Run `fn` inside a Flow scope so access defaults can read `auth`. */
export function withAuth<T>( models: ExampleModels, auth: ExampleAuth, fn: () => T | Promise<T> ): Promise<T>
{
    return models.scope.execute( fn, { auth });
}

export async function seedExampleData( models: ExampleModels ): Promise<SeedIds>
{
    const now = Date.now();
    const acmeId = new ObjectId();
    const inactiveOrgId = new ObjectId();
    const staffJobId = new ObjectId();
    const platformJobId = new ObjectId();
    const draftJobId = new ObjectId();
    const otherOrgJobId = new ObjectId();

    await models.organizations.collection.insertMany(
    [
        {
            _id     : acmeId,
            name    : 'Acme Hiring',
            slug    : 'acme',
            active  : true
        },
        {
            _id     : inactiveOrgId,
            name    : 'Closed Co',
            slug    : 'closed',
            active  : false
        }
    ]);

    await models.jobs.collection.insertMany(
    [
        {
            _id             : staffJobId,
            title           : 'Staff Engineer',
            status          : 'published',
            organizationID  : acmeId,
            tags            : [ 'typescript', 'mongodb' ],
            applications    :
            [
                {
                    id              : 'app-ada',
                    candidateName   : 'Ada Lovelace',
                    status          : 'new',
                    created         : now
                },
                {
                    id              : 'app-grace',
                    candidateName   : 'Grace Hopper',
                    status          : 'review',
                    created         : now + 1
                }
            ],
            events: { created: now, updated: now }
        },
        {
            _id             : platformJobId,
            title           : 'Platform Engineer',
            status          : 'published',
            organizationID  : acmeId,
            tags            : [ 'typescript' ],
            applications    : [],
            events: { created: now + 10, updated: now + 10 }
        },
        {
            _id             : draftJobId,
            title           : 'Intern (draft)',
            status          : 'draft',
            organizationID  : acmeId,
            tags            : [ 'internship' ],
            applications    : [],
            events: { created: now + 20, updated: now + 20 }
        },
        {
            _id             : otherOrgJobId,
            title           : 'Other Org Role',
            status          : 'published',
            organizationID  : inactiveOrgId,
            tags            : [ 'other' ],
            applications    :
            [
                {
                    id              : 'app-other',
                    candidateName   : 'Other Candidate',
                    status          : 'new',
                    created         : now + 30
                }
            ],
            events: { created: now + 30, updated: now + 30 }
        }
    ]);

    return { acmeId, inactiveOrgId, staffJobId, platformJobId, draftJobId, otherOrgJobId };
}
