import { MongoRootDocument } from '../../types';
import { Document, Filter, Sort } from 'mongodb';
import { collectAddedFields, generateCursorCondition, isSet, optimizeMatch, resolveBSONObject, reverseSort } from './mongo';

export type ListParams<DBE extends MongoRootDocument> =
{
    accessFilter?: Filter<DBE>
    computedProperties?: { fields: Document | null, pipeline: Document[] | null }
    filter?: Filter<DBE>
    smartFilter?: {filter?: Filter<DBE>, pipeline?: Document[]},
    pipeline?: Document[]
    projection?: Document,
    skip?: number,
    sort?: Sort
    limit?: number
    sample?: number
    cursor?: string
    countLimit?: number
}

const COUNT_IGNORE_STAGES = [ '$limit', '$skip', '$sample', '$sort', '$project', '$addFields', '$set', '$unset' ];

export class QueryBuilder<DBE extends MongoRootDocument>
{
    async pipeline( params: ListParams<DBE> )
    {
        const { fields: computedFields, pipeline: computedPipeline } = params.computedProperties || {}

        const options = resolveBSONObject( params );
        const accessFilter = options.accessFilter
        let filter = {$and: [
            options.filter,
            options.smartFilter?.filter,
            accessFilter,
            // TODO rozdelit options.cursor ? generateCursorCondition( options.cursor, options.sort || {} ) : undefined
        ]};

        let prev = options.cursor?.startsWith('prev:')

        // TODO: optimalizácia - vyhodiť zo smart filter pipeliny duplikátny lookup - ak sa v computedProperties niečo pridá a potom sa to používa aj v smart filtri

        const addedFieldsComputedProperties = new Set(collectAddedFields( [
            ...( computedFields && Object.keys(computedFields).length ? [{ $addFields: computedFields }] : [] ),
            ...( computedPipeline?.length && computedPipeline || [] )
        ]))
        const addedFieldsSmartFilterAll = new Set(collectAddedFields( options.smartFilter?.pipeline || [] ))
        const addedFieldsPipeline = collectAddedFields( options.pipeline || [] )

        // only unset ones that are not in computed properties
        const addedFieldsSmartFilter = [...addedFieldsSmartFilterAll].filter(x => !addedFieldsComputedProperties.has(x));

        return resolveBSONObject([
            ...( isSet(filter) ? [{ $match: optimizeMatch( filter ) }] : []),
            ...( computedPipeline || [] ),
            ...( computedFields ? [{ $addFields: computedFields }] : [] ),
            ...( options.smartFilter?.pipeline || [] ),
            ...( addedFieldsSmartFilter.length ? [{ $unset: addedFieldsSmartFilter }] : []),
            ...( options.projection ? [{ $project: {...options.projection, ...computedFields }}] : []),
            ...( options.pipeline || [] ),
            ...( addedFieldsPipeline.length ? [{ $unset: addedFieldsPipeline }] : []),
            ...( options.cursor ? [{ $match: generateCursorCondition( options.cursor, options.sort || {})}] : []),
            ...( options.sort ? [{ $sort: prev ? reverseSort( options.sort ) : options.sort }] : []),
            ...( options.skip ? [{ $skip: options.skip }] : []),
            ...( options.limit ? [{ $limit: options.limit }] : []),
            ...( options.sample ? [{ $sample: { size: options.sample }}] : []),
        ]) as Document[];
    }

    async count( params: ListParams<DBE> )
    {
        const { cursor, computedProperties, countLimit, ...options } = params;
        return this.buildCountPipeline(await this.pipeline({
            ...options,
        }), countLimit);
    }

    /**
     * Removes stages from the end of the pipeline that don't affect the count, adds $count stage
     */
    buildCountPipeline( pipeline: Document[], countLimit?: number )
    {
        while ( pipeline.length > 0 && COUNT_IGNORE_STAGES.includes( Object.keys( pipeline[pipeline.length - 1] )[0] ))
        {
            pipeline = pipeline.slice( 0, -1 );
        }

        if ( countLimit )
        {
            pipeline.push({ $limit: countLimit + 1 });
        }

        pipeline.push({ $count: 'count' })

        return pipeline;
    }
}