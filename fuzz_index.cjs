const { FuzzedDataProvider } = require( '@jazzer.js/core' );
const
{
    objectHash,
    objectFlatten,
    objectHashID,
    deleteNullishProperties,
    compileConverters,
    createDefaultConverters,
    collectAddedFields,
    getUsedFields,
    optimizeMatch,
    ModelCache,
    AccessControl,
    PipelineBuilder,
    ModelAccessDeniedError
} = require( './dist/index.js' );

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
