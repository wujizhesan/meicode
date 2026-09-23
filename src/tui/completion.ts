export interface CompletionRequest {
  value: string
}

export function moveCompletionIndex(index: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0
  return (index + direction + count) % count
}

export function selectedCompletion(candidates: readonly string[], index: number): CompletionRequest | null {
  const candidate = candidates[index]
  return candidate ? { value: `${candidate} ` } : null
}
