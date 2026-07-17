#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUTPUT = path.join(ROOT, 'lib/supabase/database.types.ts')
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

function usage(message) {
  if (message) console.error(message)
  console.error(
    'Usage: node scripts/generate-database-types.mjs --database <name> (--check | --write)',
  )
  process.exit(2)
}

function parseArguments(argv) {
  let database = ''
  let mode = ''
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--database') {
      database = argv[index + 1] ?? ''
      index += 1
    } else if (value === '--check' || value === '--write') {
      if (mode) usage('Choose exactly one generation mode')
      mode = value.slice(2)
    } else {
      usage(`Unknown argument: ${value}`)
    }
  }
  if (!DATABASE_NAME_PATTERN.test(database)) usage('Database name is missing or invalid')
  if (!mode) usage('Generation mode is required')
  return { database, mode }
}

const CATALOG_QUERY = String.raw`
select jsonb_build_object(
  'relations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', relation.relname,
      'kind', relation.relkind
    ) order by relation.relname)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
  ), '[]'::jsonb),
  'columns', coalesce((
    select jsonb_agg(jsonb_build_object(
      'relation', relation.relname,
      'ordinal', attribute.attnum,
      'name', attribute.attname,
      'nullable', not attribute.attnotnull,
      'hasDefault', default_value.oid is not null,
      'identity', attribute.attidentity,
      'generated', attribute.attgenerated,
      'formattedType', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      'typeSchema', type_namespace.nspname,
      'typeName', data_type.typname,
      'typeKind', data_type.typtype,
      'typeCategory', data_type.typcategory,
      'elementTypeSchema', element_namespace.nspname,
      'elementTypeName', element_type.typname,
      'elementTypeKind', element_type.typtype,
      'elementTypeCategory', element_type.typcategory,
      'baseTypeSchema', base_namespace.nspname,
      'baseTypeName', base_type.typname,
      'baseTypeKind', base_type.typtype,
      'baseTypeCategory', base_type.typcategory
    ) order by relation.relname, attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_type as data_type on data_type.oid = attribute.atttypid
    join pg_catalog.pg_namespace as type_namespace on type_namespace.oid = data_type.typnamespace
    left join pg_catalog.pg_attrdef as default_value
      on default_value.adrelid = attribute.attrelid and default_value.adnum = attribute.attnum
    left join pg_catalog.pg_type as element_type on element_type.oid = data_type.typelem
    left join pg_catalog.pg_namespace as element_namespace on element_namespace.oid = element_type.typnamespace
    left join pg_catalog.pg_type as base_type on base_type.oid = data_type.typbasetype
    left join pg_catalog.pg_namespace as base_namespace on base_namespace.oid = base_type.typnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and attribute.attnum > 0 and not attribute.attisdropped
  ), '[]'::jsonb),
  'relationships', coalesce((
    select jsonb_agg(jsonb_build_object(
      'relation', source_relation.relname,
      'foreignKeyName', constraint_row.conname,
      'columns', (
        select jsonb_agg(source_attribute.attname order by key_column.ordinal)
        from unnest(constraint_row.conkey) with ordinality as key_column(attribute_number, ordinal)
        join pg_catalog.pg_attribute as source_attribute
          on source_attribute.attrelid = constraint_row.conrelid
         and source_attribute.attnum = key_column.attribute_number
      ),
      'referencedRelation', target_relation.relname,
      'referencedColumns', (
        select jsonb_agg(target_attribute.attname order by key_column.ordinal)
        from unnest(constraint_row.confkey) with ordinality as key_column(attribute_number, ordinal)
        join pg_catalog.pg_attribute as target_attribute
          on target_attribute.attrelid = constraint_row.confrelid
         and target_attribute.attnum = key_column.attribute_number
      )
    ) order by source_relation.relname, constraint_row.conname)
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as source_relation on source_relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as source_namespace on source_namespace.oid = source_relation.relnamespace
    join pg_catalog.pg_class as target_relation on target_relation.oid = constraint_row.confrelid
    join pg_catalog.pg_namespace as target_namespace on target_namespace.oid = target_relation.relnamespace
    where constraint_row.contype = 'f'
      and source_namespace.nspname = 'public'
      and target_namespace.nspname = 'public'
  ), '[]'::jsonb),
  'functions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'oid', function_row.oid,
      'name', function_row.proname,
      'returnsSet', function_row.proretset,
      'strict', function_row.proisstrict,
      'inputCount', function_row.pronargs,
      'defaultCount', function_row.pronargdefaults,
      'returnTypeSchema', return_namespace.nspname,
      'returnTypeName', return_type.typname,
      'returnTypeKind', return_type.typtype,
      'returnTypeCategory', return_type.typcategory,
      'returnRelation', return_relation.relname,
      'args', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ordinal', argument.ordinal,
          'name', coalesce(function_row.proargnames[argument.ordinal], ''),
          'mode', coalesce(function_row.proargmodes[argument.ordinal], 'i'),
          'typeSchema', argument_namespace.nspname,
          'typeName', argument_type.typname,
          'typeKind', argument_type.typtype,
          'typeCategory', argument_type.typcategory,
          'elementTypeSchema', element_namespace.nspname,
          'elementTypeName', element_type.typname,
          'elementTypeKind', element_type.typtype,
          'elementTypeCategory', element_type.typcategory,
          'baseTypeSchema', base_namespace.nspname,
          'baseTypeName', base_type.typname,
          'baseTypeKind', base_type.typtype,
          'baseTypeCategory', base_type.typcategory
        ) order by argument.ordinal)
        from unnest(coalesce(function_row.proallargtypes, function_row.proargtypes::oid[]))
          with ordinality as argument(type_oid, ordinal)
        join pg_catalog.pg_type as argument_type on argument_type.oid = argument.type_oid
        join pg_catalog.pg_namespace as argument_namespace on argument_namespace.oid = argument_type.typnamespace
        left join pg_catalog.pg_type as element_type on element_type.oid = argument_type.typelem
        left join pg_catalog.pg_namespace as element_namespace on element_namespace.oid = element_type.typnamespace
        left join pg_catalog.pg_type as base_type on base_type.oid = argument_type.typbasetype
        left join pg_catalog.pg_namespace as base_namespace on base_namespace.oid = base_type.typnamespace
      ), '[]'::jsonb)
    ) order by function_row.proname, pg_catalog.pg_get_function_identity_arguments(function_row.oid))
    from pg_catalog.pg_proc as function_row
    join pg_catalog.pg_namespace as namespace on namespace.oid = function_row.pronamespace
    join pg_catalog.pg_type as return_type on return_type.oid = function_row.prorettype
    join pg_catalog.pg_namespace as return_namespace on return_namespace.oid = return_type.typnamespace
    left join pg_catalog.pg_class as return_relation on return_relation.oid = return_type.typrelid
    where namespace.nspname = 'public'
      and return_type.typname not in ('trigger', 'event_trigger')
  ), '[]'::jsonb),
  'enums', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', data_type.typname,
      'values', (
        select jsonb_agg(enum_value.enumlabel order by enum_value.enumsortorder)
        from pg_catalog.pg_enum as enum_value where enum_value.enumtypid = data_type.oid
      )
    ) order by data_type.typname)
    from pg_catalog.pg_type as data_type
    join pg_catalog.pg_namespace as namespace on namespace.oid = data_type.typnamespace
    where namespace.nspname = 'public' and data_type.typtype = 'e'
  ), '[]'::jsonb),
  'composites', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', data_type.typname,
      'attributes', (
        select jsonb_agg(jsonb_build_object(
          'name', attribute.attname,
          'typeSchema', attribute_type_namespace.nspname,
          'typeName', attribute_type.typname,
          'typeKind', attribute_type.typtype,
          'typeCategory', attribute_type.typcategory,
          'elementTypeSchema', element_namespace.nspname,
          'elementTypeName', element_type.typname,
          'elementTypeKind', element_type.typtype,
          'elementTypeCategory', element_type.typcategory
        ) order by attribute.attnum)
        from pg_catalog.pg_attribute as attribute
        join pg_catalog.pg_type as attribute_type on attribute_type.oid = attribute.atttypid
        join pg_catalog.pg_namespace as attribute_type_namespace on attribute_type_namespace.oid = attribute_type.typnamespace
        left join pg_catalog.pg_type as element_type on element_type.oid = attribute_type.typelem
        left join pg_catalog.pg_namespace as element_namespace on element_namespace.oid = element_type.typnamespace
        where attribute.attrelid = data_type.typrelid
          and attribute.attnum > 0 and not attribute.attisdropped
      )
    ) order by data_type.typname)
    from pg_catalog.pg_type as data_type
    join pg_catalog.pg_namespace as namespace on namespace.oid = data_type.typnamespace
    join pg_catalog.pg_class as relation on relation.oid = data_type.typrelid
    where namespace.nspname = 'public'
      and data_type.typtype = 'c' and relation.relkind = 'c'
  ), '[]'::jsonb)
);
`

function readCatalog(database) {
  const result = spawnSync(
    'psql',
    ['-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-d', database, '-c', CATALOG_QUERY],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with ${result.status}`)
  }
  const output = result.stdout.trim()
  if (!output) throw new Error('PostgreSQL catalog query returned no data')
  return JSON.parse(output)
}

const NUMBER_TYPES = new Set([
  'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'decimal', 'money', 'oid',
])
const STRING_TYPES = new Set([
  'bit', 'bpchar', 'bytea', 'char', 'cidr', 'date', 'inet', 'interval', 'macaddr',
  'macaddr8', 'name', 'text', 'time', 'timestamp', 'timestamptz', 'timetz', 'tsquery',
  'tsvector', 'uuid', 'varchar', 'xml',
])

function baseType(type) {
  if (type.typeKind !== 'd' || !type.baseTypeName) return type
  return {
    typeSchema: type.baseTypeSchema,
    typeName: type.baseTypeName,
    typeKind: type.baseTypeKind,
    typeCategory: type.baseTypeCategory,
  }
}

function elementType(type) {
  return {
    typeSchema: type.elementTypeSchema,
    typeName: type.elementTypeName,
    typeKind: type.elementTypeKind,
    typeCategory: type.elementTypeCategory,
  }
}

function typeScriptType(input) {
  const type = baseType(input)
  if (type.typeCategory === 'A' && type.elementTypeName) {
    return `${typeScriptType(elementType(type))}[]`
  }
  if (type.typeName === 'bool') return 'boolean'
  if (NUMBER_TYPES.has(type.typeName)) return 'number'
  if (type.typeName === 'json' || type.typeName === 'jsonb') return 'Json'
  if (type.typeName === 'void') return 'undefined'
  if (STRING_TYPES.has(type.typeName)) return 'string'
  if (type.typeSchema === 'public' && type.typeKind === 'e') {
    return `Database["public"]["Enums"][${JSON.stringify(type.typeName)}]`
  }
  if (type.typeSchema === 'public' && type.typeKind === 'c') {
    return `Database["public"]["CompositeTypes"][${JSON.stringify(type.typeName)}]`
  }
  return 'unknown'
}

function nullable(type, isNullable) {
  if (!isNullable || type === 'unknown' || type === 'undefined') return type
  return `${type} | null`
}

function property(name, type, options = {}) {
  return `${JSON.stringify(name)}${options.optional ? '?' : ''}: ${nullable(type, options.nullable)}`
}

function indent(lines, spaces) {
  const prefix = ' '.repeat(spaces)
  return lines.map(line => `${prefix}${line}`)
}

function relationBlock(relation, columns, relationships) {
  const row = columns.map(column => property(
    column.name,
    typeScriptType(column),
    { nullable: column.nullable },
  ))
  const insert = columns.map(column => {
    const immutable = column.identity === 'a' || column.generated !== ''
    if (immutable) return property(column.name, 'never', { optional: true })
    return property(column.name, typeScriptType(column), {
      nullable: column.nullable,
      optional: column.nullable || column.hasDefault || column.identity !== '',
    })
  })
  const update = columns.map(column => {
    const immutable = column.identity === 'a' || column.generated !== ''
    return property(column.name, immutable ? 'never' : typeScriptType(column), {
      nullable: !immutable && column.nullable,
      optional: true,
    })
  })
  const relationshipLines = relationships.map(relationship => [
    '{',
    ...indent([
      `foreignKeyName: ${JSON.stringify(relationship.foreignKeyName)}`,
      `columns: ${JSON.stringify(relationship.columns)}`,
      'isOneToOne: false',
      `referencedRelation: ${JSON.stringify(relationship.referencedRelation)}`,
      `referencedColumns: ${JSON.stringify(relationship.referencedColumns)}`,
    ], 2),
    '},',
  ].join('\n'))
  return [
    `${JSON.stringify(relation.name)}: {`,
    ...indent(['Row: {', ...indent(row, 2), '}'], 2),
    ...indent(['Insert: {', ...indent(insert, 2), '}'], 2),
    ...indent(['Update: {', ...indent(update, 2), '}'], 2),
    ...indent([
      relationshipLines.length ? 'Relationships: [' : 'Relationships: []',
      ...indent(relationshipLines, 2),
      ...(relationshipLines.length ? [']'] : []),
    ], 2),
    '},',
  ]
}

function viewBlock(relation, columns, relationships) {
  const row = columns.map(column => property(
    column.name,
    typeScriptType(column),
    { nullable: column.nullable },
  ))
  const relationshipLines = relationships.map(relationship => [
    '{',
    ...indent([
      `foreignKeyName: ${JSON.stringify(relationship.foreignKeyName)}`,
      `columns: ${JSON.stringify(relationship.columns)}`,
      'isOneToOne: false',
      `referencedRelation: ${JSON.stringify(relationship.referencedRelation)}`,
      `referencedColumns: ${JSON.stringify(relationship.referencedColumns)}`,
    ], 2),
    '},',
  ].join('\n'))
  return [
    `${JSON.stringify(relation.name)}: {`,
    ...indent(['Row: {', ...indent(row, 2), '}'], 2),
    ...indent([
      relationshipLines.length ? 'Relationships: [' : 'Relationships: []',
      ...indent(relationshipLines, 2),
      ...(relationshipLines.length ? [']'] : []),
    ], 2),
    '}',
  ]
}

function functionReturnType(fn, relations) {
  const outputArgs = fn.args.filter(argument => argument.mode === 'o' || argument.mode === 't')
  let result
  if (outputArgs.length) {
    const fields = outputArgs.map(argument => property(argument.name, typeScriptType(argument)))
    result = `{ ${fields.join('; ')} }`
  } else if (fn.returnRelation && relations.has(fn.returnRelation)) {
    const collection = relations.get(fn.returnRelation).kind === 'v' || relations.get(fn.returnRelation).kind === 'm'
      ? 'Views'
      : 'Tables'
    result = `Database["public"]["${collection}"][${JSON.stringify(fn.returnRelation)}]["Row"]`
  } else {
    result = typeScriptType({
      typeSchema: fn.returnTypeSchema,
      typeName: fn.returnTypeName,
      typeKind: fn.returnTypeKind,
      typeCategory: fn.returnTypeCategory,
    })
  }
  return fn.returnsSet ? `${result}[]` : result
}

function functionArgumentType(argument, relations) {
  if (argument.typeSchema === 'public'
      && argument.typeKind === 'c'
      && relations.has(argument.typeName)) {
    const relation = relations.get(argument.typeName)
    const collection = relation.kind === 'v' || relation.kind === 'm' ? 'Views' : 'Tables'
    return `Database["public"]["${collection}"][${JSON.stringify(argument.typeName)}]["Row"]`
  }
  return typeScriptType(argument)
}

function functionSignature(fn, relations) {
  const inputArgs = fn.args.filter(argument => ['i', 'b', 'v'].includes(argument.mode))
  if (inputArgs.some(argument => !argument.name)) return null
  const firstOptionalIndex = fn.inputCount - fn.defaultCount
  const args = inputArgs.map((argument, index) => property(
    argument.name,
    functionArgumentType(argument, relations),
    { nullable: !fn.strict, optional: index >= firstOptionalIndex },
  ))
  return `{ Args: ${args.length ? `{ ${args.join('; ')} }` : 'never'}; Returns: ${functionReturnType(fn, relations)} }`
}

function generate(catalog) {
  const relations = new Map(catalog.relations.map(relation => [relation.name, relation]))
  const columnsByRelation = new Map()
  for (const column of catalog.columns) {
    const columns = columnsByRelation.get(column.relation) ?? []
    columns.push(column)
    columnsByRelation.set(column.relation, columns)
  }
  const relationshipsByRelation = new Map()
  for (const relationship of catalog.relationships) {
    const relationships = relationshipsByRelation.get(relationship.relation) ?? []
    relationships.push(relationship)
    relationshipsByRelation.set(relationship.relation, relationships)
  }
  const tables = catalog.relations.filter(relation => ['r', 'p', 'f'].includes(relation.kind))
  const views = catalog.relations.filter(relation => ['v', 'm'].includes(relation.kind))

  const functionsByName = new Map()
  for (const fn of catalog.functions) {
    const signature = functionSignature(fn, relations)
    if (!signature) continue
    const signatures = functionsByName.get(fn.name) ?? []
    signatures.push(signature)
    functionsByName.set(fn.name, signatures)
  }

  const lines = [
    '// Generated from the canonical PostgreSQL 16 schema.',
    '// Run `npm run database:types:generate`; do not edit this file manually.',
    '',
    'export type Json =',
    '  | string',
    '  | number',
    '  | boolean',
    '  | null',
    '  | { [key: string]: Json | undefined }',
    '  | Json[]',
    '',
    'export type Database = {',
    '  public: {',
    '    Tables: {',
  ]
  if (tables.length) {
    for (const table of tables) {
      lines.push(...indent(relationBlock(
        table,
        columnsByRelation.get(table.name) ?? [],
        relationshipsByRelation.get(table.name) ?? [],
      ), 6))
    }
  } else {
    lines.push('      [_ in never]: never')
  }
  lines.push('    }', '    Views: {')
  if (views.length) {
    for (const view of views) {
      lines.push(...indent(viewBlock(
        view,
        columnsByRelation.get(view.name) ?? [],
        relationshipsByRelation.get(view.name) ?? [],
      ), 6))
    }
  } else {
    lines.push('      [_ in never]: never')
  }
  lines.push('    }', '    Functions: {')
  if (functionsByName.size) {
    for (const [name, signatures] of [...functionsByName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`      ${JSON.stringify(name)}: ${signatures.join(' | ')}`)
    }
  } else {
    lines.push('      [_ in never]: never')
  }
  lines.push('    }', '    Enums: {')
  if (catalog.enums.length) {
    for (const enumType of catalog.enums) {
      lines.push(`      ${JSON.stringify(enumType.name)}: ${enumType.values.map(JSON.stringify).join(' | ')}`)
    }
  } else {
    lines.push('      [_ in never]: never')
  }
  lines.push('    }', '    CompositeTypes: {')
  if (catalog.composites.length) {
    for (const composite of catalog.composites) {
      lines.push(`      ${JSON.stringify(composite.name)}: {`)
      for (const attribute of composite.attributes) {
        lines.push(`        ${property(attribute.name, typeScriptType(attribute), { nullable: true })}`)
      }
      lines.push('      }')
    }
  } else {
    lines.push('      [_ in never]: never')
  }
  lines.push(
    '    }',
    '  }',
    '}',
    '',
    'type DefaultSchema = Database["public"]',
    '',
    'export type Tables<TableName extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])> =',
    '  (DefaultSchema["Tables"] & DefaultSchema["Views"])[TableName] extends { Row: infer Row }',
    '    ? Row',
    '    : never',
    '',
    'export type TablesInsert<TableName extends keyof DefaultSchema["Tables"]> =',
    '  DefaultSchema["Tables"][TableName] extends { Insert: infer Insert } ? Insert : never',
    '',
    'export type TablesUpdate<TableName extends keyof DefaultSchema["Tables"]> =',
    '  DefaultSchema["Tables"][TableName] extends { Update: infer Update } ? Update : never',
    '',
    'export type Enums<EnumName extends keyof DefaultSchema["Enums"]> =',
    '  DefaultSchema["Enums"][EnumName]',
    '',
    'export type CompositeTypes<CompositeName extends keyof DefaultSchema["CompositeTypes"]> =',
    '  DefaultSchema["CompositeTypes"][CompositeName]',
    '',
  )
  return lines.join('\n')
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const generated = generate(readCatalog(options.database))
  if (options.mode === 'write') {
    await writeFile(DEFAULT_OUTPUT, generated, 'utf8')
    console.log(`Wrote ${path.relative(ROOT, DEFAULT_OUTPUT)}`)
    return
  }
  let current
  try {
    current = await readFile(DEFAULT_OUTPUT, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('Generated database types are missing; run `npm run database:types:generate`')
    }
    throw error
  }
  if (current !== generated) {
    throw new Error('Generated database types are stale; run `npm run database:types:generate`')
  }
  console.log('Generated database types match the canonical schema')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
