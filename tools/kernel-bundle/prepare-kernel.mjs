#!/usr/bin/env node
// 把解压后的 Chromium 内核复制到目标目录，并生成 Prism 需要的 manifest.json。
// 算法与 src/main/kernel-integrity.ts 保持一致（Windows：chrome.exe + 关键文件）。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CRITICAL_NAMES = [
  'chrome.dll',
  'chrome_elf.dll',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'snapshot_blob.bin'
]

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 --${name}`)
  return process.argv[index + 1]
}

async function findChromeDir(root, depth = 3) {
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'chrome.exe')) return root
  if (depth === 0) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findChromeDir(join(root, entry.name), depth - 1)
    if (found) return found
  }
  return null
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const source = arg('source')
const dest = arg('dest')
const version = arg('version')
if (!/^\d+(?:\.\d+){3}$/.test(version)) throw new Error(`版本号无效：${version}`)

const chromeDir = await findChromeDir(source)
if (!chromeDir) throw new Error('解压目录中没有找到 chrome.exe')
const versionMarker = await stat(join(chromeDir, `${version}.manifest`)).catch(() => null)
if (!versionMarker) console.warn(`警告：没有找到 ${version}.manifest，请确认压缩包版本是否正确`)

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(chromeDir, dest, { recursive: true })

const criticalFiles = []
for (const name of ['chrome.exe', ...CRITICAL_NAMES]) {
  const path = join(dest, name)
  const info = await stat(path).catch(() => null)
  if (info?.isFile() && info.size > 0) {
    criticalFiles.push({ path: name, size: info.size, sha256: await hashFile(path) })
  }
}
if (!criticalFiles.some((file) => file.path === 'chrome.exe')) throw new Error('复制后缺少 chrome.exe')
criticalFiles.sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0))

const aggregate = createHash('sha256')
for (const file of criticalFiles) aggregate.update(`${file.path}\0${file.size}\0${file.sha256}\n`)

const manifest = {
  schemaVersion: 2,
  version,
  executableRelative: 'chrome.exe',
  target: 'win32-x64',
  criticalFiles,
  criticalFilesSha256: aggregate.digest('hex')
}
await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`内核 ${version} 已准备完成：${dest}（关键文件 ${criticalFiles.length} 个）`)
