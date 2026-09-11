export class ReviewExecutionError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ReviewExecutionError'
    this.code = code
  }
}

export class ReviewExecutionAbortedError extends ReviewExecutionError {
  constructor() {
    super('review execution aborted', 'REVIEW_EXECUTION_ABORTED')
    this.name = 'ReviewExecutionAbortedError'
  }
}
