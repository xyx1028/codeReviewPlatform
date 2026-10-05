import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DbClient, RpcOptions } from '../../db/client.js'

const DB_CONTAINER = process.env.LOCAL_SUPABASE_DB_CONTAINER ?? 'supabase_db_codeReviewPlatform'

export function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlValue(value: unknown, parameterName?: string): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return quoteSql(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    if (parameterName === 'p_reason_codes') {
      return `array[${value.map((item) => quoteSql(item)).join(',')}]::text[]`
    }
    if (parameterName === 'p_diff_access_ids') {
      return value.length === 0
        ? 'array[]::uuid[]'
        : `array[${value.map((item) => `${quoteSql(item)}::uuid`).join(',')}]::uuid[]`
    }
  }
  return `${quoteSql(JSON.stringify(value))}::jsonb`
}

export class TransactionPsqlDbClient implements DbClient {
  private readonly child: ChildProcessWithoutNullStreams
  private active: {
    id: string
    started: boolean
    lines: string[]
    resolve: (value: string) => void
    reject: (error: Error) => void
  } | null = null
  private queue: Promise<void> = Promise.resolve()
  private stderr = ''
  private fatalError: Error | null = null
  private sequence = 0

  constructor() {
    // The Docker image smoke test uses a temporary PostgreSQL client on the local network.
    const direct = process.env.LOCAL_SUPABASE_PSQL_DIRECT === '1'
    this.child = spawn(direct ? 'psql' : 'docker', [
      ...(direct ? [] : ['exec', '-i', DB_CONTAINER]),
      ...(direct ? [] : ['psql']),
      '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.acceptLine(line))
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8') })
    this.child.once('exit', (code) => {
      this.fatalError = new Error(`local psql exited with ${code}: ${this.stderr.slice(-2000)}`)
      if (this.active) {
        const pending = this.active
        this.active = null
        pending.reject(this.fatalError)
      }
    })
  }

  private acceptLine(line: string): void {
    const active = this.active
    if (!active) return
    if (line === `__BEGIN_${active.id}__`) {
      active.started = true
      return
    }
    if (line === `__END_${active.id}__`) {
      this.active = null
      active.resolve(active.lines.join('\n'))
      return
    }
    if (active.started) active.lines.push(line)
  }

  private request(sql: string): Promise<string> {
    let result!: Promise<string>
    const scheduled = this.queue.then(() => {
      if (this.fatalError) throw this.fatalError
      result = new Promise<string>((resolve, reject) => {
        const id = `${process.pid}_${++this.sequence}`
        this.active = { id, started: false, lines: [], resolve, reject }
        this.child.stdin.write(
          `select ${quoteSql(`__BEGIN_${id}__`)};\n${sql}\nselect ${quoteSql(`__END_${id}__`)};\n`,
        )
      })
      return result.then(() => undefined)
    })
    this.queue = scheduled.catch(() => undefined)
    return scheduled.then(() => result)
  }

  async execute(sql: string): Promise<string> {
    return this.request(sql)
  }

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>, _options?: RpcOptions): Promise<T> {
    if (!/^[a-z][a-z0-9_]*$/.test(fn)) throw new Error(`unsafe RPC name: ${fn}`)
    const args = Object.entries(params).map(([key, value]) => {
      if (!/^p_[a-z0-9_]+$/.test(key)) throw new Error(`unsafe RPC parameter: ${key}`)
      return `${key}=>${sqlValue(value, key)}`
    })
    const text = await this.request(
      `select coalesce(to_jsonb(public.${fn}(${args.join(',')}))::text,'null');`,
    )
    return JSON.parse(text || 'null') as T
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin.end('\\q\n')
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
  }
}
