import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const port = Number(process.env.PORT ?? '8080')
const distRoot = resolve(process.env.DIST_DIR ?? join(import.meta.dirname, 'dist'))
const indexFile = join(distRoot, 'index.html')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function sendFile(response, filePath, { immutable = false } = {}) {
  const extension = extname(filePath).toLowerCase()
  response.writeHead(200, {
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(filePath).pipe(response)
}

function assetPath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const candidate = resolve(distRoot, `.${normalize(decoded)}`)
  return candidate === distRoot || candidate.startsWith(`${distRoot}${sep}`) ? candidate : null
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (pathname === '/__health') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('ok')
    return
  }

  const requested = assetPath(pathname)
  if (requested && existsSync(requested) && statSync(requested).isFile()) {
    sendFile(response, requested, { immutable: pathname.startsWith('/assets/') })
    return
  }

  // A real file request should not silently become the SPA entry point. Deep
  // links such as /batches/<id>/ai-result have no extension and get index.html.
  if (extname(pathname)) {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  sendFile(response, indexFile)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`web server listening on ${port}`)
})
