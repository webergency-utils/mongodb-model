const { FuzzedDataProvider } = require( '@jazzer.js/core' );
const
{
    objectHash,
    objectFlatten,
    objectHashID,
    deleteNullishProperties,
    compileConverters,
    createDefaultConverters,
    ModelCache,
    extractTargetIdsFromFilter,
    AccessControl,
    PipelineBuilder,
    ModelAccessDeniedError,
    ModelEventEmitter,
    compileOperationFilter,
    resolveObservabilityOptions,
    isOperationObserved,
    resolveObservabilityContext,
    dispatchObservabilityEvent
} = require( './dist/index.js' );
const
{
    addPrefixToFilter,
    addPrefixToPipeline,
    addPrefixToUpdate,
    collectAddedFields,
    getUsedFields,
    isExclusionProjection,
    optimizeMatch,
    projectionToProject,
    projectionToReplace,
    resolveBSONObject,
    toUpdateOperations
} = require( './dist/helpers/mongo.js' );
const
{
    normalizeExistsOptions,
    normalizeFindMatch
} = require( './dist/operations.js' );

function createFuzzedInput( provider, depth = 0, maxDepth = 3 )
{
    if( depth >= maxDepth )
    {
        const pick = provider.consumeIntegralInRange( 0, 5 );

        if( pick === 0 ){ return null }
        if( pick === 1 ){ return undefined }
        if( pick === 2 ){ return provider.consumeNumber() }
        if( pick === 3 ){ return provider.consumeBoolean() }
        if( pick === 4 ){ return provider.consumeString( 24 ) }

        return [ provider.consumeString( 8 ), provider.consumeNumber() ];
    }

    const kind = provider.consumeIntegralInRange( 0, 3 );

    if( kind === 0 )
    {
        const len = provider.consumeIntegralInRange( 0, 4 );
        const arr = [];

        for( let i = 0; i < len; i++ )
        {
            arr.push( createFuzzedInput( provider, depth + 1, maxDepth ));
        }

        return arr;
    }

    if( kind === 1 )
    {
        const keys = provider.consumeIntegralInRange( 0, 4 );
        const obj = {};

        for( let i = 0; i < keys; i++ )
        {
            obj[provider.consumeString( 8 ) || ( 'k' + i )] = createFuzzedInput( provider, depth + 1, maxDepth );
        }

        return obj;
    }

    if( kind === 2 ){ return { name: provider.consumeString( 16 ), status: provider.pickValue([ 'a', 'b', 'c' ]) } }

    return provider.consumeString( 32 );
}

module.exports.fuzz = function( data )
{
    try
    {
        const provider = new FuzzedDataProvider( data );
        const input = createFuzzedInput( provider );
        const obj = typeof input === 'object' && input && !Array.isArray( input ) ? input : { v: input };

        objectHash( input, { sort: provider.consumeBoolean(), alg: provider.pickValue([ 'plain', 'sha1', 'sha256' ]) });
        objectFlatten( obj );
        objectHashID( obj, { sort: true, alg: 'sha1' });
        deleteNullishProperties( obj );

        createDefaultConverters({ dtoID: ( id ) => String( id ) });
        compileConverters({ basic: { pick: [ 'name' ] } }, { dtoID: ( id ) => String( id ) });

        optimizeMatch( obj );
        collectAddedFields([{ $addFields: obj }]);
        getUsedFields([{ $match: obj }]);

        resolveBSONObject( obj );
        toUpdateOperations( obj );
        addPrefixToFilter( obj, 'items' );
        addPrefixToPipeline([{ $match: obj }], 'items' );
        addPrefixToUpdate( obj, 'items' );

        try
        {
            isExclusionProjection( obj );
        }
        catch
        {
            // Expected on mixed inclusion/exclusion fuzzed inputs
        }

        projectionToProject({ name: 1, status: 1 }, 'items' );
        projectionToReplace({ name: 1, status: 1 }, 'items' );

        normalizeFindMatch( obj, { access: 'open', context: obj, traceID: 'tr-1' });
        normalizeExistsOptions( input, '_id', id => String( id ), { access: 'open', context: obj });
        extractTargetIdsFromFilter( obj, '_id', id => String( id ));

        compileOperationFilter([ provider.pickValue([ 'query', 'mutation', 'create', 'update', 'delete', 'cache', 'error', 'slowQuery', 'internal', 'find', 'list' ]) ]);
        compileOperationFilter({ mutation: provider.consumeBoolean(), delete: provider.consumeBoolean(), internal: provider.consumeBoolean() });
        const obsOptions = resolveObservabilityOptions(
        {
            enabled     : provider.consumeBoolean(),
            slowQueryMs : provider.consumeIntegralInRange( 0, 100 ),
            operations  : { mutation: true, delete: provider.consumeBoolean() },
            context     : () => obj
        });
        isOperationObserved( obsOptions, provider.pickValue([ 'query', 'mutation', 'cache', 'error', 'slowQuery' ]), 'update', { internal: provider.consumeBoolean(), parentOperation: 'update' });
        resolveObservabilityContext(() => obj, obj );

        const emitter = new ModelEventEmitter();
        const handler = () => {};
        emitter.on( 'mutation', handler );
        dispatchObservabilityEvent( emitter, obsOptions, 'mutation',
        {
            collection  : 'users',
            operation   : 'update',
            duration    : provider.consumeIntegralInRange( 0, 200 ),
            filter      : obj,
            context     : obj
        });
        emitter.off( 'mutation', handler );

        const cache = new ModelCache({ maxSize: 8, ttl: 1000 });
        cache.set( 'k', obj );
        cache.get( 'k' );

        const access = new AccessControl(
        {
            model           : {},
            config          :
            {
                filters     : { open: async() => ({}) },
                defaults    : { read: 'open' }
            },
            invokeFilter    : async() => ({})
        });

        void access.resolve({ operation: 'read', method: 'list' });

        const builder = new PipelineBuilder();

        void builder.pipeline(
        {
            filter  : obj,
            sort    : { _id: 1 },
            limit   : provider.consumeIntegralInRange( 1, 20 )
        });
    }
    catch( e )
    {
        if( e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError )
        {
            return;
        }

        if( e instanceof ModelAccessDeniedError )
        {
            return;
        }

        if( e && typeof e === 'object' && typeof e.code === 'string' && String( e.code ).startsWith( 'MODEL_' ) )
        {
            return;
        }

        throw e;
    }
};
