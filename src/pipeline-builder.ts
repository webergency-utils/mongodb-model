import { Document, Filter, Sort } from 'mongodb';
import { collectAddedFields, generateCursorCondition, isSet, optimizeMatch, resolveBSONObject, reverseSort } from './helpers/mongo.js';
import { MongoRootDocument } from './types/external.js';

export type PipelineParams<DBE extends MongoRootDocument> =
{
    accessFilter?       : Filter<DBE>
    computedProperties? : { fields: Document | null, pipeline: Document[] | null }
    filter?             : Filter<DBE>
    smartFilter?        : { filter?: Filter<DBE>, pipeline?: Document[] }
    pipeline?           : Document[]
    projection?         : Document
    skip?               : number
    sort?               : Sort
    limit?              : number
    sample?             : number
    cursor?             : string
    countLimit?         : number
}

const COUNT_IGNORE_STAGES = [ '$limit', '$skip', '$sample', '$sort', '$project', '$addFields', '$set', '$unset', '$replaceWith', '$replaceRoot' ];

export class PipelineBuilder<DBE extends MongoRootDocument = MongoRootDocument>
{
    async pipeline( params: PipelineParams<DBE> )
    {
        const { fields: computedFields, pipeline: computedPipeline } = params.computedProperties || {};

        const options = resolveBSONObject( params );
        const accessFilter = options.accessFilter;
        const filter =
        {
            $and:
            [
                options.filter,
                options.smartFilter?.filter,
                accessFilter
            ]
        };

        const prev = options.cursor?.startsWith( 'prev:' );
        const addedFieldsSmartFilterAll = options.smartFilter?.pipeline?.length
            ? new Set( collectAddedFields( options.smartFilter.pipeline ))
            : undefined;
        let addedFieldsSmartFilter: string[] = [];

        if( addedFieldsSmartFilterAll && addedFieldsSmartFilterAll.size > 0 )
        {
            const addedFieldsComputedProperties = new Set( collectAddedFields(
            [
                ...( computedFields && Object.keys( computedFields ).length ? [{ $addFields: computedFields }] : [] ),
                ...( computedPipeline?.length && computedPipeline || [] )
            ]));

            addedFieldsSmartFilter = [ ...addedFieldsSmartFilterAll ].filter( x => !addedFieldsComputedProperties.has( x ));
        }

        return resolveBSONObject(
        [
            ...( isSet( filter ) ? [{ $match: optimizeMatch( filter ) }] : [] ),
            ...( computedPipeline || [] ),
            ...( computedFields ? [{ $addFields: computedFields }] : [] ),
            ...( options.smartFilter?.pipeline || [] ),
            ...( addedFieldsSmartFilter.length ? [{ $unset: addedFieldsSmartFilter }] : [] ),
            ...( options.projection ? [{ $project: { ...options.projection, ...computedFields }}] : [] ),
            ...( options.pipeline || [] ),
            ...( options.cursor ? [{ $match: generateCursorCondition( options.cursor, options.sort || {} )}] : [] ),
            ...( options.sort ? [{ $sort: prev ? reverseSort( options.sort ) : options.sort }] : [] ),
            ...( options.skip ? [{ $skip: options.skip }] : [] ),
            ...( options.limit ? [{ $limit: options.limit }] : [] ),
            ...( options.sample ? [{ $sample: { size: options.sample }}] : [] )
        ]) as Document[];
    }

    async count( params: PipelineParams<DBE> )
    {
        const { cursor: _cursor, computedProperties: _computedProperties, countLimit, ...options } = params;

        return this.buildCountPipeline( await this.pipeline({ ...options }), countLimit );
    }

    buildCountPipeline( pipeline: Document[], countLimit?: number )
    {
        const countPipeline = [ ...pipeline ];

        while( countPipeline.length > 0 && COUNT_IGNORE_STAGES.includes( Object.keys( countPipeline[countPipeline.length - 1] )[0] ) )
        {
            countPipeline.pop();
        }

        if( countLimit )
        {
            countPipeline.push({ $limit: countLimit + 1 });
        }

        countPipeline.push({ $count: 'count' });

        return countPipeline;
    }
}
