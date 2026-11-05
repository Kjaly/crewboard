import { Ajv } from 'ajv'
import { fullFormats } from 'ajv-formats/dist/formats.js'
import { jsonBytes, MAX_RESULT_BYTES, MAX_SCHEMA_BYTES, type JsonObject } from '../model/types.js'

/** Compile locally: unresolved remote references fail without fetching anything or registering user schema ids. */
export function compileResultSchema(schema: JsonObject) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Result schema must be a JSON object')
  if (jsonBytes(schema) > MAX_SCHEMA_BYTES) throw new Error(`schema exceeds the ${MAX_SCHEMA_BYTES} byte size limit`)
  try {
    if (schema.type !== undefined && schema.type !== 'object') throw new Error('schema must describe an object result')
    if (schema.$async === true) throw new Error('asynchronous schemas are not supported')
    const validate = new Ajv({ formats: fullFormats, ownProperties: true }).compile(schema)
    return validate
  } catch (error) {
    throw new Error(`Invalid result schema: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Invalid output remains a reported result for the lead to return, with an explicit error instead of silent success. */
export function checkResult(schema: JsonObject, report: { summary: string; result?: unknown }): { result: JsonObject } | { schemaError: string } {
  try {
    // CLIs without native schemas can put a JSON object directly in the existing report block.
    const value = report.result === undefined || report.result === null
      ? JSON.parse(report.summary.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')) as unknown
      : report.result
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Result must be a JSON object')
    const result = value as JsonObject
    if (jsonBytes(result) > MAX_RESULT_BYTES) throw new Error(`Result exceeds the ${MAX_RESULT_BYTES} byte size limit`)
    const validate = compileResultSchema(schema)
    if (!validate(result)) throw new Error(`Result does not match schema: ${new Ajv().errorsText(validate.errors)}`)
    return { result }
  } catch (error) {
    return { schemaError: (error instanceof SyntaxError ? 'Missing or invalid JSON result in the report' : error instanceof Error ? error.message : String(error)).slice(0, 2000) }
  }
}
