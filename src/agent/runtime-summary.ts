const STRING_LIMIT = 500
const COLLECTION_LIMIT = 20
const VALUE_DEPTH = 3

export interface RuntimeValueSummary {
  value: unknown
  truncated: boolean
}

export function summarizeRuntimeValue(value: unknown, depth = 0): RuntimeValueSummary {
  if (typeof value === 'string') {
    if (value.length <= STRING_LIMIT) return { value, truncated: false }
    return {
      value: `${value.slice(0, STRING_LIMIT)}...[${value.length - STRING_LIMIT} chars omitted]`,
      truncated: true,
    }
  }
  if (value === null || typeof value !== 'object') return { value, truncated: false }
  if (depth >= VALUE_DEPTH) return { value: '[nested value omitted]', truncated: true }
  if (Array.isArray(value)) {
    const summaries = value.slice(0, COLLECTION_LIMIT).map((item) => summarizeRuntimeValue(item, depth + 1))
    return {
      value: summaries.map((summary) => summary.value),
      truncated: value.length > COLLECTION_LIMIT || summaries.some((summary) => summary.truncated),
    }
  }
  const entries = Object.entries(value)
  const selected = entries.slice(0, COLLECTION_LIMIT).map(([key, item]) => {
    const summary = summarizeRuntimeValue(item, depth + 1)
    return { key, ...summary }
  })
  return {
    value: Object.fromEntries(selected.map(({ key, value: item }) => [key, item])),
    truncated: entries.length > COLLECTION_LIMIT || selected.some((summary) => summary.truncated),
  }
}
