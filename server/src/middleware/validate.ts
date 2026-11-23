import type { z } from 'zod';

/**
 * Validates untrusted input against a schema and returns the parsed, typed value.
 * A failure throws a ZodError, which the error handler turns into a 400. Schemas
 * for request bodies are strict, so unknown fields are rejected, not ignored.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data);
}
