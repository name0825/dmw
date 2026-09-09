import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable x.y.z agent version is required')
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
if (tag && tag !== `agent-v${version}`) throw new Error('Release tag must match agent/package.json version')
const files = { 'package.json': JSON.stringify(pkg, null, 2) + '\n' }
const collect = (directory) => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relative}`)
    if (entry.isDirectory()) collect(relative)
    else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      files[relative] = fs.readFileSync(path.join(root, relative), 'utf8')
    }
  }
}
collect('src')
const output = path.resolve(process.argv[2] || path.join(root, 'release'))
fs.mkdirSync(output, { recursive: true })
const name = `dmw-agent-${version}.json`
const contents = JSON.stringify({ version, files })
fs.writeFileSync(path.join(output, name), contents)
fs.writeFileSync(path.join(output, `${name}.sha256`), `${createHash('sha256').update(contents).digest('hex')}  ${name}\n`)
console.log(path.join(output, name))
