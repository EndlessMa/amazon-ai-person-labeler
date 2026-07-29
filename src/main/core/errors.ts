import type { ErrorCode } from '../../shared/contracts'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error) {
    return new AppError('INTERNAL_ERROR', error.message, {
      name: error.name,
      stack: error.stack
    })
  }
  return new AppError('INTERNAL_ERROR', String(error))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

