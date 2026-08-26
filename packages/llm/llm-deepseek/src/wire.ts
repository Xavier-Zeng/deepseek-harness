/**
 * Wire-level helpers shared with downstream wrappers (e.g. dsh-llm-agent-hint)
 * that mirror this package's transport but must not widen the package root.
 * @module @deepseek-ai/dsh-llm-deepseek/wire
 */

export { httpErrorCode } from './adapter.ts'
export { serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'
export { parseSse } from './sse.ts'
export { translate } from './translate.ts'
export type { WireChunk, WireError, WireRequest } from './types.ts'
