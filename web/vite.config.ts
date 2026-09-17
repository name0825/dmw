import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..')

const readDmwConfig = (): Record<string, string> => {
  const confPath = process.env.DMW_CONFIG || path.join(repoRoot, 'dmw.conf')
  const result: Record<string, string> = {}
  let content: string

  try {
    content = fs.readFileSync(confPath, 'utf-8')
  } catch {
    return result
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const value = trimmed.slice(eq + 1).replace(/\s+#.*$/, '').trim()
    result[trimmed.slice(0, eq).trim()] = value.replace(/^(['"])(.*)\1$/, '$2')
  }

  return result
}

const dmwConf = readDmwConfig()
const serverPort = Number(process.env.SERVER_PORT || dmwConf.SERVER_PORT || 3001)
const wsPort = Number(process.env.WS_PORT || dmwConf.WS_PORT || serverPort + 1)
const devPort = Number(process.env.WEB_DEV_PORT || dmwConf.WEB_DEV_PORT || 5173)
const previewPort = Number(process.env.WEB_PREVIEW_PORT || dmwConf.WEB_PREVIEW_PORT || 4173)

const proxy = {
  '/api': {
    target: `http://localhost:${serverPort}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
  '/ws': {
    target: `ws://localhost:${wsPort}`,
    ws: true,
    rewrite: (p: string) => p.replace(/^\/ws/, ''),
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: devPort,
    host: '0.0.0.0',
    proxy,
  },
  preview: {
    port: previewPort,
    host: '0.0.0.0',
    proxy,
  },
})
