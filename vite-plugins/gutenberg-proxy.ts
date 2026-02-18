import https from 'https'
import http from 'http'
import type { Plugin } from 'vite'

/**
 * Proxy for gutenberg.org to avoid CORS issues.
 * Follows redirects server-side (Gutenberg always 302s from /ebooks/ to /cache/).
 *
 * Usage from client: fetch('/gutenberg/ebooks/84.epub3.images')
 */
export default function gutenbergProxy(): Plugin {
  return {
    name: 'gutenberg-proxy',
    configureServer(server) {
      server.middlewares.use('/gutenberg', (req, res) => {
        const upstreamPath = req.url ?? '/'
        const upstreamUrl = `https://www.gutenberg.org${upstreamPath}`

        followRedirects(upstreamUrl, res as http.ServerResponse)
      })
    },
  }
}

function followRedirects(
  url: string,
  res: http.ServerResponse,
  depth = 0,
): void {
  if (depth > 5) {
    res.writeHead(502)
    res.end('Too many redirects')
    return
  }

  const mod = url.startsWith('https') ? https : http

  mod.get(url, (upstream) => {
    const status = upstream.statusCode ?? 200

    if (status >= 300 && status < 400 && upstream.headers.location) {
      const next = new URL(upstream.headers.location, url).href
      upstream.resume()
      followRedirects(next, res, depth + 1)
      return
    }

    res.writeHead(status, upstream.headers)
    upstream.pipe(res)
  }).on('error', (err) => {
    console.error('[gutenberg-proxy] error:', err.message)
    res.writeHead(502)
    res.end(`Gutenberg proxy error: ${err.message}`)
  })
}
