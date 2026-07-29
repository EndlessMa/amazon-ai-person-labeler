import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path'
import type {
  ErrorCode,
  InputSelection,
  SourceType
} from '../shared/contracts'
import type {
  InputPreparer,
  PreparedCandidate,
  PrepareInputsOptions
} from './core/batch-service'
import {
  prepareInputs as scanInputs,
  type PreparationIssue
} from './core/scanner'

function issueSourceType(
  input: InputSelection | undefined
): SourceType {
  if (input?.kind === 'folder') return 'folder'
  if (input?.kind === 'archive') {
    return extname(input.path).toLocaleLowerCase('en-US') === '.zip'
      ? 'zip'
      : 'rar'
  }
  return 'direct-file'
}

function safeIssueRelativePath(
  issue: PreparationIssue,
  input: InputSelection | undefined
): string {
  if (input?.kind === 'folder') {
    const candidate = relative(resolve(input.path), resolve(issue.sourcePath))
    if (
      candidate &&
      candidate !== '..' &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate)
    ) {
      return candidate
    }
  }
  return basename(issue.sourcePath) || `输入错误-${issue.sourceId}`
}

function issueCandidate(
  issue: PreparationIssue,
  input: InputSelection | undefined
): PreparedCandidate {
  return {
    sourceId: issue.sourceId,
    sourceType: issueSourceType(input),
    sourcePath: issue.sourcePath,
    canonicalPath: resolve(issue.sourcePath),
    displayName: basename(issue.sourcePath) || '输入错误',
    relativePath: safeIssueRelativePath(issue, input),
    bytes: 0,
    modifiedMs: 0,
    errorCode: issue.errorCode as ErrorCode,
    errorMessage: issue.errorMessage
  }
}

export const prepareInputsForBatch: InputPreparer = async (
  inputs: readonly InputSelection[],
  options: PrepareInputsOptions
) => {
  const prepared = await scanInputs(inputs, {
    recursive: options.recursive,
    ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })
  const inputById = new Map(inputs.map((input) => [input.id, input]))
  const reportedIssueKeys = new Set(
    prepared.candidates
      .filter((candidate) => candidate.errorCode !== undefined)
      .map(
        (candidate) =>
          `${candidate.sourceId}\0${candidate.sourcePath}\0${candidate.errorCode}`
      )
  )
  const issueCandidates = prepared.issues
    .filter(
      (issue) =>
        !reportedIssueKeys.has(
          `${issue.sourceId}\0${issue.sourcePath}\0${issue.errorCode}`
        )
    )
    .map((issue) => issueCandidate(issue, inputById.get(issue.sourceId)))

  return {
    candidates: [...prepared.candidates, ...issueCandidates],
    totalScannedEntries: prepared.totalScannedEntries,
    totalUncompressedBytes: prepared.totalUncompressedBytes,
    warnings: prepared.warnings,
    temporaryPaths: prepared.temporaryPaths,
    cleanup: prepared.cleanup
  }
}
