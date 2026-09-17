import { AppError } from './errors'

/** Bounds the entire wait, including work queued before a subprocess starts. */
export async function waitForOperation<T>(
  start: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
  interrupt?: () => void
): Promise<T> {
  if (signal?.aborted) throw new AppError('CANCELLED', '操作已取消')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = (error: AppError): void => {
        interrupt?.()
        reject(error)
      }
      onAbort = () => fail(new AppError('CANCELLED', '操作已取消'))
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => fail(new AppError('INTERNAL_ERROR', timeoutMessage)),
        timeoutMs
      )
      // Attach both handlers even after interruption so late failures are consumed.
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new AppError('CANCELLED', '操作已取消')
        return start()
      }).then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
