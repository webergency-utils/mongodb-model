import { AbstractModels } from '@webergency-utils/mongodb-model';
import type { MongoClientOptions } from '@webergency-utils/mongodb-model';
import { OrganizationModel } from './models/organization/index.js';
import { JobModel } from './models/job/index.js';
import { ApplicationModel } from './models/application/index.js';

/**
 * Example Models registry — mirrors how a consumer app wires root + property models.
 */
export class ExampleModels extends AbstractModels
{
    public organizations    : OrganizationModel;
    public jobs             : JobModel;
    public applications     : ApplicationModel;

    constructor( connectionString: string, dbName: string = 'example', options?: MongoClientOptions )
    {
        super( connectionString, options );

        const db = this.client.db( dbName );

        this.organizations  = new OrganizationModel( this, db );
        this.jobs           = new JobModel( this, db );
        this.applications   = new ApplicationModel( this, db );
    }
}

export type { ExampleAuth, OrganizationDBE, OrganizationDTO, JobDBE, JobDTO, JobApplicationDBE, JobApplicationDTO } from './types.js';
