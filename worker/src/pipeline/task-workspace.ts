import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { RetrievalResult } from '../ai/schemas.js'
import type { RepositoryName } from '../git/repositories.js'
import { isInside, PathPolicyError, resolveSafePath } from '../security/path-policy.js'
import { TOOL_LIMITS } from '../tools/types.js'
import type { PreparedRepoRef } from './process-story-task.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A task may have at most 12 distinct candidate files, each bounded to 1 MiB. */
export const MAX_TASK_WORKSPACE_BYTES = 12 * TOOL_LIMITS.maxFileBytes

export interface TaskWorkspaceInput {
  workspaceRoot: string
  jobId: string
  taskId: string
  storyCode: string
  workerId: string
  retrievalAttempt: number
  analysisAttempt: number
  retrieval: RetrievalResult
  repositories: PreparedRepoRef[]
}

export interface TaskWorkspaceFile {
  repository: RepositoryName
  commitSha: string
  filePath: string
  size: number
  sha256: string
}

export interface TaskWorkspaceManifest {
  version: 1
  jobId: string
  taskId: string
  storyCode: string
  workerId: string
  retrievalAttempt: number
  analysisAttempt: number
  createdAt: string
  files: TaskWorkspaceFile[]
  totalBytes: number
}

export interface PreparedTaskWorkspace {
  root: string
  manifestPath: string
  repositories: PreparedRepoRef[]
  files: TaskWorkspaceFile[]
  totalBytes: number
  /** Internal cleanup identity; callers must not construct this value. */
  cleanup: {
    workspaceRoot: string
    jobId: string
    taskId: string
    attemptName: string
  }
}

/**
 * Materialize complete candidate files into an isolated claim-attempt directory.
 * No links are created: every candidate is copied and hashed before the temp
 * directory is atomically renamed into its published location.
 */
export function prepareTaskWorkspace(input: TaskWorkspaceInput): PreparedTaskWorkspace {
  assertUuid(input.jobId, 'jobId')
  assertUuid(input.taskId, 'taskId')
  assertAttempt(input.retrievalAttempt, 'retrievalAttempt')
  assertAttempt(input.analysisAttempt, 'analysisAttempt')
  if (input.workerId.trim() === '') throw new Error('workerId is required')

  const workspaceRoot = prepareWorkspaceRoot(input.workspaceRoot)
  const attemptName = buildAttemptName(
    input.retrievalAttempt,
    input.analysisAttempt,
    input.workerId,
  )
  const tempName = `${attemptName}.tmp-${randomUUID()}`
  const { jobDir, tasksDir, taskDir, tempRoot } = createTemporaryAttemptRoot(
    workspaceRoot,
    input.jobId,
    input.taskId,
    tempName,
  )
  const attemptRoot = safeChild(taskDir, attemptName)

  try {
    const codeRoot = ensureOwnedDirectory(tempRoot, 'code')
    const repoByName = new Map(input.repositories.map((repo) => [repo.name, repo]))
    const candidateKeys = new Set<string>()
    const files: TaskWorkspaceFile[] = []
    let totalBytes = 0

    for (const candidate of input.retrieval.candidates) {
      const key = `${candidate.repository}::${candidate.filePath}`
      if (candidateKeys.has(key)) continue
      candidateKeys.add(key)

      const repo = repoByName.get(candidate.repository)
      if (!repo) {
        throw new Error(`candidate repository not prepared: ${candidate.repository}`)
      }

      let source: ReturnType<typeof openCandidateFile> | null = null
      try {
        source = openCandidateFile(repo.path, candidate.filePath)
        if (source.size > TOOL_LIMITS.maxFileBytes) {
          throw new CandidateUnavailableError(
            `candidate file exceeds ${TOOL_LIMITS.maxFileBytes} bytes: ${candidate.repository}/${candidate.filePath}`,
          )
        }
        if (totalBytes + source.size > MAX_TASK_WORKSPACE_BYTES) {
          throw new Error(
            `task workspace exceeds ${MAX_TASK_WORKSPACE_BYTES} bytes`,
          )
        }

        const content = readFileSync(source.fd)
        if (content.byteLength !== source.size) {
          throw new Error(
            `candidate file changed while copying: ${candidate.repository}/${candidate.filePath}`,
          )
        }

        const repoRoot = ensureOwnedDirectory(codeRoot, candidate.repository)
        const destination = createDestinationPath(repoRoot, candidate.filePath)
        writeFileSync(destination, content, { flag: 'wx', mode: 0o400 })

        totalBytes += content.byteLength
        files.push({
          repository: candidate.repository,
          commitSha: repo.commitSha,
          filePath: candidate.filePath,
          size: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
        })
      } catch (error) {
        if (!(error instanceof CandidateUnavailableError)) throw error
      } finally {
        source?.close()
      }
    }

    const manifest: TaskWorkspaceManifest = {
      version: 1,
      jobId: input.jobId,
      taskId: input.taskId,
      storyCode: input.storyCode,
      workerId: input.workerId,
      retrievalAttempt: input.retrievalAttempt,
      analysisAttempt: input.analysisAttempt,
      createdAt: new Date().toISOString(),
      files,
      totalBytes,
    }
    const tempManifest = safeChild(tempRoot, 'manifest.json')
    writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o400,
    })

    renameSync(tempRoot, attemptRoot)

    const candidateRepositories = new Set(files.map((file) => file.repository))
    const repositories = input.repositories
      .filter((repo) => candidateRepositories.has(repo.name))
      .map((repo) => ({
        ...repo,
        path: safeChild(safeChild(attemptRoot, 'code'), repo.name),
      }))

    return {
      root: attemptRoot,
      manifestPath: safeChild(attemptRoot, 'manifest.json'),
      repositories,
      files,
      totalBytes,
      cleanup: {
        workspaceRoot,
        jobId: input.jobId,
        taskId: input.taskId,
        attemptName,
      },
    }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    removeEmptyParents(taskDir, tasksDir, jobDir)
    throw error
  }
}

/** Remove only this claim's attempt directory, then prune empty parents. */
export function cleanupTaskWorkspace(workspace: PreparedTaskWorkspace): void {
  const { workspaceRoot, jobId, taskId, attemptName } = workspace.cleanup
  assertUuid(jobId, 'jobId')
  assertUuid(taskId, 'taskId')
  if (!/^r\d+-a\d+-w[0-9a-f]{16}$/.test(attemptName)) {
    throw new Error('invalid task workspace attempt name')
  }

  const root = resolve(workspaceRoot)
  const jobDir = safeChild(root, jobId)
  const tasksDir = safeChild(jobDir, 'tasks')
  const taskDir = safeChild(tasksDir, taskId)
  const attemptRoot = safeChild(taskDir, attemptName)
  if (attemptRoot !== workspace.root) {
    throw new Error('task workspace cleanup identity mismatch')
  }

  rmSync(attemptRoot, { recursive: true, force: true })
  removeEmptyParents(taskDir, tasksDir, jobDir)
}

function prepareWorkspaceRoot(workspaceRoot: string): string {
  const root = resolve(workspaceRoot)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('WORKSPACE_ROOT must be a real directory')
  }
  return realpathSync(root)
}

/**
 * Create the private temp leaf while shared ancestors are present. An older
 * claim may non-recursively prune an empty ancestor between these operations;
 * retrying ENOENT closes that safe-but-racy window without sharing a lock.
 */
function createTemporaryAttemptRoot(
  workspaceRoot: string,
  jobId: string,
  taskId: string,
  tempName: string,
): { jobDir: string; tasksDir: string; taskDir: string; tempRoot: string } {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const jobDir = ensureOwnedDirectory(workspaceRoot, jobId)
      const tasksDir = ensureOwnedDirectory(jobDir, 'tasks')
      const taskDir = ensureOwnedDirectory(tasksDir, taskId)
      const tempRoot = safeChild(taskDir, tempName)
      mkdirSync(tempRoot, { mode: 0o700 })
      return { jobDir, tasksDir, taskDir, tempRoot }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw lastError ?? new Error('unable to create task workspace')
}

function ensureOwnedDirectory(parent: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid workspace directory segment: ${name}`)
  }
  const child = safeChild(parent, name)
  try {
    mkdirSync(child, { mode: 0o700 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
  }
  const stat = lstatSync(child)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`workspace path is not a real directory: ${name}`)
  }
  return child
}

function createDestinationPath(repoRoot: string, filePath: string): string {
  const segments = filePath.split('/')
  const fileName = segments.pop()
  if (!fileName) throw new Error(`invalid candidate path: ${filePath}`)

  let parent = repoRoot
  for (const segment of segments) {
    parent = ensureOwnedDirectory(parent, segment)
  }
  const destination = safeChild(parent, fileName)
  if (relative(repoRoot, destination).split(sep).includes('..')) {
    throw new Error(`candidate destination escapes repository: ${filePath}`)
  }
  return destination
}

class CandidateUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CandidateUnavailableError'
  }
}

function isUnavailableCandidateFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
}

function openCandidateFile(
  repoRoot: string,
  filePath: string,
): { fd: number; size: number; close: () => void } {
  try {
    resolveSafePath(repoRoot, filePath)
  } catch (error) {
    if (error instanceof PathPolicyError) {
      throw new CandidateUnavailableError(error.message)
    }
    throw error
  }

  const root = realpathSync(repoRoot)
  const lexicalPath = resolve(root, filePath)
  if (!isInside(root, lexicalPath) || lexicalPath === root) {
    throw new CandidateUnavailableError(`candidate path escapes repository: ${filePath}`)
  }

  let current = root
  for (const segment of filePath.split('/')) {
    current = safeChild(current, segment)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new CandidateUnavailableError(
          `candidate path contains a symbolic link: ${filePath}`,
        )
      }
      if (current === lexicalPath && !stat.isFile()) {
        throw new CandidateUnavailableError(
          `candidate is not a regular file: ${filePath}`,
        )
      }
    } catch (error) {
      if (error instanceof CandidateUnavailableError) throw error
      if (isUnavailableCandidateFsError(error)) {
        throw new CandidateUnavailableError(
          `candidate file is unavailable: ${filePath}`,
        )
      }
      throw error
    }
  }

  let fd: number
  try {
    fd = openSync(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isUnavailableCandidateFsError(error)) {
      throw new CandidateUnavailableError(`candidate file is unavailable: ${filePath}`)
    }
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new Error(`candidate file type changed while copying: ${filePath}`)
    }
    return {
      fd,
      size: stat.size,
      close: () => closeSync(fd),
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function safeChild(parent: string, name: string): string {
  const child = resolve(join(parent, name))
  if (!isInside(parent, child) || child === parent) {
    throw new Error(`workspace path escapes parent: ${name}`)
  }
  return child
}

function buildAttemptName(
  retrievalAttempt: number,
  analysisAttempt: number,
  workerId: string,
): string {
  const workerHash = createHash('sha256').update(workerId).digest('hex').slice(0, 16)
  return `r${retrievalAttempt}-a${analysisAttempt}-w${workerHash}`
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${field} must be a UUID`)
}

function assertAttempt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
}

function removeEmptyParents(taskDir: string, tasksDir: string, jobDir: string): void {
  for (const directory of [taskDir, tasksDir, jobDir]) {
    try {
      rmdirSync(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
    }
  }
}
