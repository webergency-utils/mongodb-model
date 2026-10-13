/**
 * Example domain types for a tiny hiring board.
 * DBE = database entity (Mongo document), DTO = API shape.
 */

import type { ObjectId, MongoPropertyDocument, MongoRootDocument } from '@webergency-utils/mongodb-model';

export type ExampleAuth =
{
    role    : 'admin' | 'employer' | 'recruiter' | 'guest'
    orgId?  : string
}

export type OrganizationDBE = MongoRootDocument &
{
    _id     : ObjectId
    name    : string
    slug    : string
    active  : boolean
}

export type OrganizationDTO =
{
    id      : string
    name    : string
    slug    : string
    active  : boolean
}

export type JobStatus = 'draft' | 'published' | 'closed'

export type JobApplicationDBE = MongoPropertyDocument &
{
    id              : string
    candidateName   : string
    status          : 'new' | 'review' | 'hired' | 'rejected'
    created         : number
}

export type JobApplicationDTO =
{
    id              : string
    candidateName   : string
    status          : JobApplicationDBE['status']
    created         : number
}

export type JobDBE = MongoRootDocument &
{
    _id             : ObjectId
    title           : string
    status          : JobStatus
    organizationID  : ObjectId
    tags            : string[]
    applications    : JobApplicationDBE[]
    events          :
    {
        created : number
        updated : number
    }
}

export type JobDTO =
{
    id              : string
    title           : string
    status          : JobStatus
    organizationID  : string
    tags            : string[]
    applicationCount: number
    events          : JobDBE['events']
}

export type JobBasicDTO =
{
    id      : string
    title   : string
    status  : JobStatus
}

export type JobSuggestDTO =
{
    id      : string
    label   : string
}

export type JobDetailDTO = JobDTO &
{
    organization? : OrganizationDTO | null
}
