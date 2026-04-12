import { zodToJsonSchema } from 'zod-to-json-schema'
import { registryEntrySchema } from './registry.js'

/**
 * JSON Schema derived from `registryEntrySchema`.
 *
 * Registry `.json` files can reference this via a `$schema` field for IDE
 * autocomplete and validation. The schema is generated from the canonical
 * Zod definition to ensure a single source of truth.
 */
export const registryEntryJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...zodToJsonSchema(registryEntrySchema),
}
