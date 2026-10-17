import { Document } from 'mongodb';
import { AbstractModelConverters } from './types/external.js';
import
{
    CompileConverterContext,
    ConverterRecipe,
    ConverterRecipeMap,
    ConverterRecipeMetadata,
    CustomConverterRecipe,
    ExtendsConverterRecipe,
    OmitConverterRecipe,
    PickConverterRecipe,
    RawConverterRecipe,
    RenameConverterRecipe
}
from './types/definition.js';
import { createDefaultConverters } from './default-converters.js';

type CompiledConverter<DBE extends Document> = AbstractModelConverters<DBE>[string]

export class ConverterRecipeError extends Error
{
    constructor( message: string )
    {
        super( message );
        this.name = 'ConverterRecipeError';
    }
}

function isObjectRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is Exclude<ConverterRecipe<DBE>, 'auto'>
{
    return typeof recipe === 'object' && recipe !== null;
}

function isRawRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is RawConverterRecipe<DBE>
{
    return isObjectRecipe( recipe ) && 'converter' in recipe && typeof ( recipe as RawConverterRecipe<DBE> ).converter === 'function';
}

function isCustomRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is CustomConverterRecipe<DBE>
{
    return isObjectRecipe( recipe ) && 'custom' in recipe;
}

function isExtendsRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is ExtendsConverterRecipe
{
    return isObjectRecipe( recipe ) && 'extends' in recipe;
}

function isRenameRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is RenameConverterRecipe
{
    return isObjectRecipe( recipe ) && 'rename' in recipe;
}

function isPickRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is PickConverterRecipe<DBE>
{
    return isObjectRecipe( recipe ) && 'pick' in recipe;
}

function isOmitRecipe<DBE extends Document>( recipe: ConverterRecipe<DBE> ): recipe is OmitConverterRecipe<DBE>
{
    return isObjectRecipe( recipe ) && 'omit' in recipe;
}

function applyPick<DBE extends Document>( dbe: DBE, pick: readonly string[], ctx: CompileConverterContext ): Record<string, unknown>
{
    const result: Record<string, unknown> = {};

    for( const key of pick )
    {
        if( key === '_id' )
        {
            if( '_id' in dbe && ( dbe as { _id?: unknown })._id !== undefined )
            {
                result.id = ctx.dtoID(( dbe as unknown as { _id: unknown })._id );
            }

            continue;
        }

        if( key in dbe )
        {
            const value = ( dbe as Record<string, unknown>)[key];

            result[key] = key === 'id' ? ctx.dtoID( value ) : value;
        }
    }

    if( !('id' in result ) && '_id' in dbe && ( dbe as { _id?: unknown })._id !== undefined )
    {
        result.id = ctx.dtoID(( dbe as unknown as { _id: unknown })._id );
    }

    return result;
}

function applyOmit( value: Record<string, unknown>, omit: readonly string[] ): Record<string, unknown>
{
    const result = { ...value };

    for( const key of omit )
    {
        delete result[key];
    }

    return result;
}

function applyOutputPick( value: Record<string, unknown>, pick: readonly string[] ): Record<string, unknown>
{
    const picked: Record<string, unknown> = {};

    for( const key of pick )
    {
        if( key in value )
        {
            picked[key] = value[key];
        }
    }

    return picked;
}

function attachMetadata<DBE extends Document>(
    compiled: CompiledConverter<DBE>,
    recipe: ConverterRecipeMetadata
): CompiledConverter<DBE>
{
    if( recipe.projection !== undefined )
    {
        compiled.projection = recipe.projection;
    }

    if( recipe.computedProperties !== undefined )
    {
        ( compiled as { computedProperties?: unknown }).computedProperties = recipe.computedProperties;
    }

    return compiled;
}

function compileRename<DBE extends Document>(
    recipe: RenameConverterRecipe,
    ctx: CompileConverterContext
): CompiledConverter<DBE>
{
    return {
        converter: ( dbe: DBE ) =>
        {
            const result: Record<string, unknown> = {};

            for( const [ outField, sourceField ] of Object.entries( recipe.rename ))
            {
                const source = sourceField === '_id'
                    ? ( dbe as unknown as { _id?: unknown })._id
                    : ( dbe as Record<string, unknown>)[sourceField as string];

                if( sourceField === '_id' || outField === 'id' )
                {
                    result[outField] = ctx.dtoID( source );
                }
                else
                {
                    result[outField] = source;
                }
            }

            if( recipe.pick )
            {
                return applyOutputPick( result, recipe.pick );
            }

            return result;
        }
    };
}

function compileRecipeBody<DBE extends Document>(
    name: string,
    recipe: ConverterRecipe<DBE>,
    compiled: Record<string, CompiledConverter<DBE>>,
    ctx: CompileConverterContext
): CompiledConverter<DBE>
{
    if( recipe === 'auto' )
    {
        return createDefaultConverters<DBE>( ctx ).dto;
    }

    if( isRawRecipe( recipe ))
    {
        return { converter: recipe.converter };
    }

    if( isCustomRecipe( recipe ))
    {
        return { converter: recipe.custom };
    }

    if( isExtendsRecipe( recipe ))
    {
        const parentName = recipe.extends;
        const parent = compiled[parentName];

        if( !parent )
        {
            throw new ConverterRecipeError( `Converter recipe "${name}" extends unknown converter "${parentName}"` );
        }

        return {
            converter: async( dbe: DBE ) =>
            {
                let value = await parent.converter( dbe ) as Record<string, unknown>;

                if( recipe.pick )
                {
                    value = applyOutputPick( value, recipe.pick );
                }

                if( recipe.omit )
                {
                    value = applyOmit( value, recipe.omit );
                }

                return value;
            }
        };
    }

    if( isRenameRecipe( recipe ))
    {
        return compileRename( recipe, ctx );
    }

    if( isPickRecipe( recipe ))
    {
        return {
            converter: ( dbe: DBE ) => applyPick( dbe, recipe.pick as readonly string[], ctx )
        };
    }

    if( isOmitRecipe( recipe ))
    {
        const defaults = createDefaultConverters<DBE>( ctx ).dto;

        return {
            converter: async( dbe: DBE ) =>
            {
                const value = await defaults.converter( dbe ) as Record<string, unknown>;

                return applyOmit( value, recipe.omit as readonly string[] );
            }
        };
    }

    throw new ConverterRecipeError( `Unsupported converter recipe for "${name}"` );
}

function extendsParent( recipe: ConverterRecipe<Document> ): string | undefined
{
    if( isExtendsRecipe( recipe ))
    {
        return recipe.extends;
    }

    return undefined;
}

function topoSortRecipes<DBE extends Document>( recipes: ConverterRecipeMap<DBE> ): string[]
{
    const names = Object.keys( recipes );
    const indegree: Record<string, number> = {};
    const dependents: Record<string, string[]> = {};

    for( const name of names )
    {
        indegree[name] = 0;
        dependents[name] = [];
    }

    for( const name of names )
    {
        const parent = extendsParent( recipes[name] as ConverterRecipe<Document> );

        if( !parent )
        {
            continue;
        }

        if( parent === 'dto' || parent === 'dbe' )
        {
            continue;
        }

        if( !( parent in recipes ))
        {
            throw new ConverterRecipeError( `Converter recipe "${name}" extends unknown converter "${parent}"` );
        }

        indegree[name]! += 1;
        dependents[parent]!.push( name );
    }

    const queue = names.filter( name => indegree[name] === 0 );
    const ordered: string[] = [];

    while( queue.length > 0 )
    {
        const name = queue.shift()!;
        ordered.push( name );

        for( const child of dependents[name] ?? [] )
        {
            indegree[child]! -= 1;

            if( indegree[child] === 0 )
            {
                queue.push( child );
            }
        }
    }

    if( ordered.length !== names.length )
    {
        const remaining = names.filter( name => !ordered.includes( name ));
        const cycle: string[] = [];
        let current = remaining[0]!;

        while( !cycle.includes( current ))
        {
            cycle.push( current );
            current = extendsParent( recipes[current] as ConverterRecipe<Document> ) ?? current;
        }

        const start = cycle.indexOf( current );
        const path = [ ...cycle.slice( start ), current ];

        throw new ConverterRecipeError( `Circular converter recipe: ${path.join( ' -> ' )}` );
    }

    return ordered;
}

export function compileConverters<DBE extends Document>(
    recipes: ConverterRecipeMap<DBE> | undefined,
    ctx: CompileConverterContext = { dtoID: ( id ) => String( id ) }
): AbstractModelConverters<DBE>
{
    const defaults = createDefaultConverters<DBE>( ctx );
    const compiled: Record<string, CompiledConverter<DBE>> =
    {
        dto : defaults.dto,
        dbe : defaults.dbe
    };

    if( !recipes )
    {
        return compiled as AbstractModelConverters<DBE>;
    }

    for( const name of topoSortRecipes( recipes ))
    {
        const recipe = recipes[name]!;

        if( name === 'from' && typeof recipe === 'object' && recipe !== null && !isRawRecipe( recipe as ConverterRecipe<DBE> ) && !isCustomRecipe( recipe as ConverterRecipe<DBE> ) && !isExtendsRecipe( recipe as ConverterRecipe<DBE> ) && !isRenameRecipe( recipe as ConverterRecipe<DBE> ) && !isPickRecipe( recipe as ConverterRecipe<DBE> ) && !isOmitRecipe( recipe as ConverterRecipe<DBE> ))
        {
            ( compiled as unknown as AbstractModelConverters<DBE> ).from = recipe as AbstractModelConverters<DBE>['from'];
            continue;
        }

        if( recipe === 'auto' && ( name === 'dto' || name === 'dbe' ))
        {
            compiled[name] = defaults[name as 'dto' | 'dbe'];
            continue;
        }

        let body = compileRecipeBody( name, recipe as ConverterRecipe<DBE>, compiled, ctx );

        if( isObjectRecipe( recipe as ConverterRecipe<DBE> ))
        {
            body = attachMetadata( body, recipe as ConverterRecipeMetadata );
        }

        compiled[name] = body;
    }

    return compiled as AbstractModelConverters<DBE>;
}
