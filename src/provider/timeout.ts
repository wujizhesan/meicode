// 流式读取空闲超时：ms 内无数据则抛错（防 API 挂起永久卡住）
export async function withIdleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`流式读取超时（${ms / 1000}s 无数据）`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// 整体请求超时：真实 abort 底层 fetch（race 只拒绝 Promise，连接会继续跑）
// controller 由调用方创建（便于外部 signal 也 abort 它）
export async function withRequestTimeout<T>(promise: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(new Error(`请求超时（${ms / 1000}s 无响应）`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
