import { randomUUID } from 'node:crypto'
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import type { BrowserExtension } from '../shared/types'
import type { Logger } from './app-logger'
// ---- 修改点 14：新增依赖，用于下载 CRX 并解压 ----
// 需要新增 npm 依赖：yauzl（解压 zip，无原生依赖）、https-proxy-agent、socks-proxy-agent（走环境代理下载时使用）
import yauzl from 'yauzl'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

interface ChromeExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  description?: string
}

const MAX_EXTENSION_BYTES = 200 * 1024 * 1024
const MAX_EXTENSION_FILES = 20_000
const MAX_CRX_BYTES = 200 * 1024 * 1024
const STORE_EXTENSION_ID_PATTERN = /^[a-p]{32}$/

/** Windows 下 rename 可能因杀毒软件/索引服务对目标目录内文件的瞬时占用而抛 EPERM/EBUSY，重试几次通常就能绕过去。 */
async function renameWithRetry(from: string, to: string, attempts = 5, delayMs = 150): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt === attempts) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs * attempt))
    }
  }
}

/** 清理临时目录用，同样可能撞上瞬时文件占用；这里失败后果很轻（残留一个临时目录），最多重试 1 次，静默放弃不向外抛错。 */
async function rmWithRetry(target: string, attempts = 2, delayMs = 150): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt === attempts) return // 第二次仍失败也不抛出，只留下临时目录
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs * attempt))
    }
  }
}

// ---- 修改点 15：CRX 下载相关辅助函数 ----

/** 根据用户选择的下载网络，构造对应的代理 Agent；'direct' 和空值表示不使用代理。 */
function proxyAgentFor(network: { protocol: 'direct' | 'http' | 'https' | 'socks5'; host: string; port?: number; username: string; password: string } | null) {
  if (!network || network.protocol === 'direct') return undefined
  const auth = network.username ? `${encodeURIComponent(network.username)}:${encodeURIComponent(network.password)}@` : ''
  if (network.protocol === 'socks5') return new SocksProxyAgent(`socks5://${auth}${network.host}:${network.port}`)
  return new HttpsProxyAgent(`${network.protocol}://${auth}${network.host}:${network.port}`)
}

function chromeStoreDownloadUrl(extensionId: string): string {
  const params = new URLSearchParams({
    response: 'redirect',
    os: process.platform === 'darwin' ? 'mac' : 'win',
    arch: 'x64',
    os_arch: 'x86_64',
    nacl_arch: 'x86-64',
    prod: 'chromiumcrx',
    prodchannel: 'unknown',
    prodversion: '124.0.0.0',
    acceptformat: 'crx2,crx3',
    x: `id=${extensionId}&uc`
  })
  return `https://clients2.google.com/service/update2/crx?${params.toString()}`
}

/** 下载文件到内存，跟随最多 5 次重定向，遵守 MAX_CRX_BYTES 限制。 */
function downloadToBuffer(url: string, agent: ReturnType<typeof proxyAgentFor>, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url)
    const req = httpsRequest(target, { method: 'GET', agent, timeout: 30_000 }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) { reject(new Error('下载重定向次数过多')); return }
        resolvePromise(downloadToBuffer(new URL(res.headers.location, target).toString(), agent, redirectsLeft - 1))
        return
      }
      if (status !== 200) { reject(new Error(`下载失败，HTTP ${status}`)); res.resume(); return }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_CRX_BYTES) { req.destroy(); reject(new Error('扩展安装包不能超过 200 MB')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolvePromise(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 剥离 CRX2/CRX3 文件头，返回其中包含的 zip 数据。 */
function stripCrxHeader(buffer: Buffer): Buffer {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') throw new Error('下载内容不是有效的 CRX 扩展包')
  const version = buffer.readUInt32LE(4)
  if (version === 3) {
    const headerSize = buffer.readUInt32LE(8)
    const zipStart = 12 + headerSize
    if (zipStart > buffer.length) throw new Error('CRX3 文件头损坏')
    return buffer.subarray(zipStart)
  }
  if (version === 2) {
    const pubKeyLength = buffer.readUInt32LE(8)
    const signatureLength = buffer.readUInt32LE(12)
    const zipStart = 16 + pubKeyLength + signatureLength
    if (zipStart > buffer.length) throw new Error('CRX2 文件头损坏')
    return buffer.subarray(zipStart)
  }
  throw new Error(`不支持的 CRX 版本：${version}`)
}

/** 将 zip 数据解压到目标目录，拒绝路径穿越（zip slip）。 */
function extractZip(zipBuffer: Buffer, destination: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) { reject(error ?? new Error('无法读取扩展安装包')); return }
      const destinationRoot = resolve(destination)
      zipFile.readEntry()
      zipFile.on('entry', (entry) => {
        const entryPath = resolve(destinationRoot, entry.fileName)
        if (entryPath !== destinationRoot && !entryPath.startsWith(`${destinationRoot}${sep}`)) {
          reject(new Error('扩展安装包包含非法路径'))
          zipFile.close()
          return
        }
        if (/\/$/.test(entry.fileName)) {
          mkdir(entryPath, { recursive: true }).then(() => zipFile.readEntry()).catch(reject)
          return
        }
        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) { reject(streamError ?? new Error('无法读取扩展安装包条目')); return }
          mkdir(join(entryPath, '..'), { recursive: true }).then(() => {
            const chunks: Buffer[] = []
            readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
            readStream.on('end', () => {
              writeFile(entryPath, Buffer.concat(chunks)).then(() => zipFile.readEntry()).catch(reject)
            })
            readStream.on('error', reject)
          }).catch(reject)
        })
      })
      zipFile.on('end', () => resolvePromise())
      zipFile.on('error', reject)
    })
  })
}

async function inspectDirectory(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('扩展目录不能包含符号链接')
    if (!info.isDirectory()) {
      bytes += info.size
      files += 1
      if (bytes > MAX_EXTENSION_BYTES) throw new Error('扩展目录不能超过 200 MB')
      if (files > MAX_EXTENSION_FILES) throw new Error('扩展文件数量不能超过 20000 个')
      return
    }
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  await visit(root)
  return { bytes, files }
}

export class ExtensionStore {
  private readonly root: string
  private readonly extensions = new Map<string, BrowserExtension>()

  constructor(private readonly vaultPath: string, private readonly logger?: Logger) {
    this.root = join(vaultPath, 'extensions')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const metadata = JSON.parse(await readFile(join(this.root, entry.name, 'metadata.json'), 'utf8')) as BrowserExtension
        if (metadata.id !== entry.name || !/^[a-f\d-]{36}$/i.test(metadata.id)) throw new Error('扩展元数据 ID 无效')
        await access(join(this.root, entry.name, 'extension', 'manifest.json'))
        this.extensions.set(metadata.id, {
          ...metadata,
          globalEnabled: metadata.globalEnabled === true,
          path: join(this.root, entry.name, 'extension')
        })
      } catch (error) {
        this.logger?.error('忽略不完整的本地扩展', { id: entry.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  list(): BrowserExtension[] {
    return [...this.extensions.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((item) => ({ ...item }))
  }

  paths(ids: string[]): string[] {
    const resolvedIds = [...new Set([
      ...ids,
      ...this.list().filter((extension) => extension.globalEnabled).map((extension) => extension.id)
    ])]
    return resolvedIds.map((id) => {
      const extension = this.extensions.get(id)
      if (!extension) throw new Error(`环境引用的扩展 ${id.slice(0, 8)} 不存在，请编辑环境配置`)
      return extension.path
    })
  }

  sourcePath(id: string): string {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('浏览器扩展 ID 无效')
    const extension = this.extensions.get(id)
    if (!extension) throw new Error('浏览器扩展不存在')
    return extension.path
  }

  async importDirectory(sourceInput: string): Promise<BrowserExtension> {
    const source = resolve(sourceInput)
    const root = resolve(this.root)
    if (source === root || source.startsWith(`${root}${sep}`)) throw new Error('不能从扩展仓库内部重复导入')
    const manifestPath = join(source, 'manifest.json')
    let manifest: ChromeExtensionManifest
    try {
      if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('扩展 manifest.json 不能超过 1 MB')
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ChromeExtensionManifest
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('扩展 manifest.json 不是有效 JSON')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('所选目录缺少 manifest.json')
      throw error
    }
    await inspectDirectory(source)
    return this.stageAndCommit(source, manifest, basename(source))
  }

  // ---- 修改点 16：新增从 Chrome 应用商店安装 ----
  async installFromStore(
    extensionId: string,
    proxy: { protocol: 'direct' | 'http' | 'https' | 'socks5'; host: string; port?: number; username: string; password: string } | null
  ): Promise<BrowserExtension> {
    if (typeof extensionId !== 'string' || !STORE_EXTENSION_ID_PATTERN.test(extensionId)) {
      throw new Error('Chrome 应用商店扩展 ID 无效')
    }
    const agent = proxyAgentFor(proxy)
    const crxBuffer = await downloadToBuffer(chromeStoreDownloadUrl(extensionId), agent)
    const zipBuffer = stripCrxHeader(crxBuffer)

    const unpackDir = join(tmpdir(), `prism-crx-${randomUUID()}`)
    await mkdir(unpackDir, { recursive: true })
    try {
      await extractZip(zipBuffer, unpackDir)
      const manifestPath = join(unpackDir, 'manifest.json')
      let manifest: ChromeExtensionManifest
      try {
        if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('扩展 manifest.json 不能超过 1 MB')
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ChromeExtensionManifest
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('扩展 manifest.json 不是有效 JSON')
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('下载的扩展缺少 manifest.json')
        throw error
      }
      await inspectDirectory(unpackDir)
      const extension = await this.stageAndCommit(unpackDir, manifest, `chrome-store-${extensionId}`)
      this.logger?.info('浏览器扩展已从 Chrome 商店安装', { extensionId: extension.id, storeId: extensionId, name: extension.name })
      return extension
    } finally {
      await rmWithRetry(unpackDir)
    }
  }

  /** importDirectory 与 installFromStore 共用的校验+落盘逻辑。 */
  private async stageAndCommit(source: string, manifest: ChromeExtensionManifest, fallbackName: string): Promise<BrowserExtension> {
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('只支持 Manifest V2 或 V3 扩展')
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('扩展 manifest 缺少名称')
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
      throw new Error('扩展 manifest 版本号无效')
    }

    const id = randomUUID()
    const staging = join(this.root, `.import-${id}`)
    const target = join(this.root, id)
    await mkdir(staging, { recursive: true })
    try {
      await cp(source, join(staging, 'extension'), { recursive: true, errorOnExist: true })
      const extension: BrowserExtension = {
        id,
        name: manifest.name.startsWith('__MSG_') ? fallbackName : manifest.name.trim(),
        version: manifest.version,
        description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
        manifestVersion: manifest.manifest_version,
        installedAt: new Date().toISOString(),
        path: join(target, 'extension'),
        globalEnabled: false
      }
      await writeFile(join(staging, 'metadata.json'), JSON.stringify(extension, null, 2), { encoding: 'utf8', mode: 0o600 })
      await renameWithRetry(staging, target)
      this.extensions.set(id, extension)
      this.logger?.info('浏览器扩展已导入', { extensionId: id, name: extension.name, version: extension.version })
      return { ...extension }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id) || !this.extensions.has(id)) throw new Error('浏览器扩展不存在')
    const recycle = join(this.vaultPath, 'recycle-bin', 'extensions')
    await mkdir(recycle, { recursive: true })
    await renameWithRetry(join(this.root, id), join(recycle, `${id}-${Date.now()}`))
    this.extensions.delete(id)
    this.logger?.info('浏览器扩展已移入回收目录', { extensionId: id })
  }

  async setGlobalEnabled(id: string, enabled: boolean): Promise<BrowserExtension> {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('浏览器扩展 ID 无效')
    if (typeof enabled !== 'boolean') throw new Error('扩展全局启用状态无效')
    const current = this.extensions.get(id)
    if (!current) throw new Error('浏览器扩展不存在')
    const next = { ...current, globalEnabled: enabled }
    await writeFile(join(this.root, id, 'metadata.json'), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    this.extensions.set(id, next)
    this.logger?.info(enabled ? '浏览器扩展已全局启用' : '浏览器扩展已取消全局启用', { extensionId: id })
    return { ...next }
  }

  async rollbackMigrationImports(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.extensions.has(id)) continue
      this.extensions.delete(id)
      await rm(join(this.root, id), { recursive: true, force: true })
    }
  }
}
