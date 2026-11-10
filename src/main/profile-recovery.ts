import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserPlatform, BrowserProfile, FingerprintConfig, ProfileDraft, WebRtcPolicy } from '../shared/types'
import { PROFILE_COLORS, defaultFingerprint, defaultProfileWindow, seedFromId } from '../shared/defaults'
import { validateProfileDraft } from '../shared/validation'

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/
const MAX_SERIAL = 999_999_999
const SPOOFING_KEYS = ['font', 'audio', 'canvas', 'clientrects', 'gpu'] as const

export const RECOVERED_TAG = '已恢复'
export const RECOVERED_NOTE = '【已从磁盘数据重建】原代理、分组、扩展等配置已丢失，请先重新设置代理并检测通过后再打开，否则会直连暴露本机 IP。'
export const RECOVERED_ERROR = '此环境由磁盘数据重建，代理配置已丢失，请编辑环境并重新设置代理后再打开'

export interface RecoveredProfileHints {
  seed?: number
  serialNumber?: number
  name?: string
  fingerprint: Partial<FingerprintConfig>
  startUrls: string[]
  window?: ProfileDraft['window']
  launchedAt?: string
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const found = args.find((arg) => arg.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}

function integerIn(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : undefined
}

function shortText(value: string | undefined, max = 200): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined
}

/** 从上次启动时记录的 Chromium 参数中还原环境身份（种子、平台、屏幕、语言、时区等）。 */
export function hintsFromLaunchArgs(args: unknown[], launchedAt?: unknown): RecoveredProfileHints {
  const list = args.filter((arg): arg is string => typeof arg === 'string')
  const fingerprint: Partial<FingerprintConfig> = {}
  const seed = integerIn(flag(list, 'fingerprint'), 0, 0xffffffff)
  const platform = flag(list, 'fingerprint-platform')
  if (platform === 'windows' || platform === 'macos') fingerprint.platform = platform as BrowserPlatform
  const brand = flag(list, 'fingerprint-brand')
  if (brand === 'Chrome' || brand === 'Edge') fingerprint.brand = brand
  const concurrency = integerIn(flag(list, 'fingerprint-hardware-concurrency'), 1, 256)
  if (concurrency !== undefined) fingerprint.hardwareConcurrency = concurrency
  const screenWidth = integerIn(flag(list, 'fingerprint-screen-width'), 320, 16384)
  const screenHeight = integerIn(flag(list, 'fingerprint-screen-height'), 240, 16384)
  if (screenWidth !== undefined && screenHeight !== undefined) {
    fingerprint.screenWidth = screenWidth
    fingerprint.screenHeight = screenHeight
  }
  const language = shortText(flag(list, 'fingerprint-language') ?? flag(list, 'lang'), 35)
  if (language) fingerprint.language = language
  const acceptLanguages = shortText(flag(list, 'accept-lang'))
  if (acceptLanguages) fingerprint.acceptLanguages = acceptLanguages
  const timezone = shortText(flag(list, 'timezone'), 64)
  if (timezone) fingerprint.timezone = timezone
  const platformVersion = shortText(flag(list, 'fingerprint-platform-version'), 40)
  if (platformVersion) fingerprint.platformVersion = platformVersion
  const brandVersion = shortText(flag(list, 'fingerprint-brand-version'), 40)
  if (brandVersion) fingerprint.brandVersion = brandVersion
  const webrtc = flag(list, 'webrtc-ip-handling-policy')
  const webrtcPolicy: WebRtcPolicy | undefined = webrtc === 'disable_non_proxied_udp'
    ? 'proxy_only'
    : webrtc === 'default_public_interface_only' ? 'public_only' : webrtc ? 'default' : undefined
  if (webrtcPolicy) fingerprint.webrtcPolicy = webrtcPolicy
  const disabled = flag(list, 'disable-spoofing')
  if (disabled) {
    fingerprint.disabledSpoofing = disabled.split(',').filter((key): key is typeof SPOOFING_KEYS[number] => (SPOOFING_KEYS as readonly string[]).includes(key))
  }

  const windowName = /^\[(\d{1,9})\] (.+)$/.exec(flag(list, 'window-name') ?? '')
  const size = /^(\d+),(\d+)$/.exec(flag(list, 'window-size') ?? '')
  const position = /^(-?\d+),(-?\d+)$/.exec(flag(list, 'window-position') ?? '')
  let window: ProfileDraft['window'] | undefined
  if (position && size) {
    window = { mode: 'custom', x: Number(position[1]), y: Number(position[2]), width: Number(size[1]), height: Number(size[2]) }
  }
  return {
    seed,
    serialNumber: windowName ? Number(windowName[1]) : undefined,
    name: windowName?.[2],
    fingerprint,
    startUrls: list.filter((arg) => /^https?:\/\//i.test(arg)).slice(0, 20),
    window,
    launchedAt: typeof launchedAt === 'string' && !Number.isNaN(Date.parse(launchedAt)) ? launchedAt : undefined
  }
}

export interface OrphanProfileDirectory {
  id: string
  hints?: RecoveredProfileHints
}

export interface OrphanScan {
  found: OrphanProfileDirectory[]
  issues: string[]
}

/** 扫描 vault/profiles 下没有元数据记录的环境目录。 */
export async function scanOrphanProfileDirectories(vaultPath: string, knownIds: Set<string>): Promise<OrphanScan> {
  const root = join(vaultPath, 'profiles')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: [], issues: [] }
    throw error
  }
  const found: OrphanProfileDirectory[] = []
  const issues: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !PROFILE_ID_PATTERN.test(entry.name) || knownIds.has(entry.name)) continue
    const directory = join(root, entry.name)
    const dataInfo = await lstat(join(directory, 'user-data')).catch(() => undefined)
    if (!dataInfo?.isDirectory() || dataInfo.isSymbolicLink()) continue

    // 身份标记能解析且指向别的环境：目录可能被移动过，拒绝接管以保护数据
    try {
      const marker = JSON.parse(await readFile(join(directory, 'profile-owner.json'), 'utf8')) as { profileId?: unknown }
      if (marker && typeof marker === 'object' && marker.profileId !== entry.name) {
        issues.push(`环境目录 ${entry.name} 的身份标记指向其他环境，已跳过`)
        continue
      }
    } catch { /* 标记缺失或损坏：目录名即身份，稍后会重写标记 */ }

    let hints: RecoveredProfileHints | undefined
    try {
      const last = JSON.parse(await readFile(join(directory, 'runtime', 'last-launch.json'), 'utf8')) as { args?: unknown; launchedAt?: unknown }
      if (Array.isArray(last.args)) hints = hintsFromLaunchArgs(last.args, last.launchedAt)
    } catch { /* 从未启动过，或记录文件也已损坏 */ }
    found.push({ id: entry.name, hints })
  }
  return { found, issues }
}

/** 由磁盘线索重建环境配置。代理等无法恢复的字段使用安全默认值，并标记为需要检查。 */
export function rebuildProfile(
  directory: OrphanProfileDirectory,
  serialNumber: number,
  now = new Date().toISOString()
): BrowserProfile {
  const { id, hints } = directory
  const baseSeed = hints?.seed ?? seedFromId(id)
  const fingerprint: FingerprintConfig = {
    ...defaultFingerprint(baseSeed),
    ...hints?.fingerprint,
    seed: baseSeed,
    // 代理丢失后保留原有时区和语言，避免环境身份发生变化；重新设置代理后可改回“跟随代理”
    networkIdentityMode: 'manual'
  }
  const name = (hints?.name ?? `恢复的环境 ${id.slice(0, 8)}`).slice(0, 60)
  const fallback: ProfileDraft = {
    name,
    note: RECOVERED_NOTE,
    group: '',
    tags: [RECOVERED_TAG],
    extensionIds: [],
    color: PROFILE_COLORS[(serialNumber - 1) % PROFILE_COLORS.length],
    startUrls: hints?.startUrls.length ? hints.startUrls : ['https://browserleaks.com/'],
    kernelVersion: '',
    window: hints?.window ?? defaultProfileWindow(),
    proxy: { protocol: 'direct', host: '', username: '', password: '' },
    fingerprint
  }
  let draft: ProfileDraft
  try {
    draft = validateProfileDraft(fallback)
  } catch {
    draft = validateProfileDraft({ ...fallback, startUrls: ['https://browserleaks.com/'], window: defaultProfileWindow(), fingerprint: defaultFingerprint(baseSeed) })
  }
  return {
    ...draft,
    id,
    serialNumber,
    createdAt: hints?.launchedAt ?? now,
    updatedAt: now,
    lastOpenedAt: hints?.launchedAt,
    favorite: false,
    status: 'error',
    lastError: RECOVERED_ERROR
  }
}

export function usableSerial(value: number | undefined, used: Set<number>): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_SERIAL && !used.has(value)
}
