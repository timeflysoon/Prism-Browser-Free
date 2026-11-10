import { access, mkdir, readFile, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'
import { writeFileAtomicDurable } from './durable-file'

export class SettingsStore {
  private settings: AppSettings = { browserExecutable: '', fingerprintKernel: false, enginePreference: 'auto', recycleRetentionDays: 0 }
  private readonly path: string
  private recovery: string | undefined

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'settings.json')
  }

  async initialize(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let stored: Partial<AppSettings> | undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Partial<AppSettings>
    } catch { /* 损坏的 JSON 在下面统一处理 */ }
    if (!stored) {
      // 设置文件损坏（例如断电留下的空洞文件）：保留原文件，使用默认设置，不能阻止应用启动
      const corrupt = join(dirname(this.path), `settings.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      await rename(this.path, corrupt)
      this.recovery = `应用设置文件已损坏，已恢复为默认设置，原文件保存在 ${corrupt}`
      return
    }
    this.settings = {
      browserExecutable: typeof stored.browserExecutable === 'string' ? stored.browserExecutable : '',
      fingerprintKernel: stored.fingerprintKernel === true,
      enginePreference: stored.enginePreference === 'bundled' || stored.enginePreference === 'system' ? stored.enginePreference : 'auto',
      recycleRetentionDays: stored.recycleRetentionDays === 7 || stored.recycleRetentionDays === 30 || stored.recycleRetentionDays === 90
        ? stored.recycleRetentionDays
        : 0
    }
  }

  /** 启动时若设置文件损坏并被隔离，返回说明；否则为 undefined。 */
  recoveryMessage(): string | undefined {
    return this.recovery
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFileAtomicDurable(this.path, JSON.stringify(this.settings, null, 2))
    return this.get()
  }

  async hasConfiguredExecutable(): Promise<boolean> {
    if (!this.settings.browserExecutable) return false
    try {
      await access(this.settings.browserExecutable, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
