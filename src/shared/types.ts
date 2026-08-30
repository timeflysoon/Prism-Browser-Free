export type BrowserPlatform = 'windows' | 'macos'
export type BrowserBrand = 'Chrome' | 'Edge'
export type HardwareProfileId =
  | 'legacy-custom'
  | 'macos-host'
  | 'macos-seeded-apple'
  | 'macos-m1'
  | 'macos-m3-pro'
  | 'macos-m4-pro'
  | 'windows-host'
  | 'windows-seeded-nvidia'
  | 'windows-10-rtx3060'
  | 'windows-11-rtx4060'
  | 'windows-11-rtx4070'
export type ProxyProtocol = 'direct' | 'http' | 'https' | 'socks5'
export type WebRtcPolicy = 'proxy_only' | 'public_only' | 'default'
export type NetworkIdentityMode = 'manual' | 'proxy'
export type ProxyExitPolicy = 'warn' | 'block'
export type ProfileStatus = 'closed' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'error'
export interface ProfileLaunchOptions {
  allowGeoConflict?: boolean
}
export type EnginePreference = 'auto' | 'bundled' | 'system'

export interface ProfileWindowConfig {
  mode: 'auto' | 'custom'
  x: number
  y: number
  width: number
  height: number
}

export interface ProxyConfig {
  protocol: ProxyProtocol
  host: string
  port?: number
  username: string
  password: string
  passwordStored?: boolean
}

export interface FingerprintConfig {
  seed: number
  hardwareProfileId: HardwareProfileId
  /** Kernel GPU catalogue bucket pinned for profile-lifetime stability. */
  gpuBucket?: number
  /** Version of the render identity allocation contract. */
  renderIdentityVersion?: 1 | 2 | 3 | 4
  platform: BrowserPlatform
  platformVersion: string
  brand: BrowserBrand
  brandVersion: string
  hardwareConcurrency: number
  language: string
  acceptLanguages: string
  timezone: string
  webrtcPolicy: WebRtcPolicy
  networkIdentityMode: NetworkIdentityMode
  proxyExitPolicy: ProxyExitPolicy
  screenWidth: number
  screenHeight: number
  disabledSpoofing: Array<'font' | 'audio' | 'canvas' | 'clientrects' | 'gpu'>
}

export interface BrowserProfile {
  id: string
  /** Permanent, user-facing environment number. Never reused after deletion. */
  serialNumber: number
  name: string
  note: string
  group: string
  tags: string[]
  extensionIds: string[]
  color: string
  startUrls: string[]
  /** Empty means follow the globally selected/default engine. */
  kernelVersion: string
  window: ProfileWindowConfig
  favorite: boolean
  proxy: ProxyConfig
  fingerprint: FingerprintConfig
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
  proxyCheck?: ProxyCheckSummary
  status: ProfileStatus
  lastError?: string
}

export interface PublicProxyConfig extends Omit<ProxyConfig, 'password' | 'passwordStored'> {
  password: ''
  passwordStored: boolean
}

export type BrowserProfileView = Omit<BrowserProfile, 'proxy'> & { proxy: PublicProxyConfig }

export type ProfileDraft = Pick<
  BrowserProfile,
  'name' | 'note' | 'group' | 'tags' | 'extensionIds' | 'color' | 'startUrls' | 'kernelVersion' | 'window' | 'proxy' | 'fingerprint'
>

export interface ProfileBatchClassification {
  group?: string
  addTags?: string[]
}

export interface BrowserExtension {
  id: string
  name: string
  version: string
  description: string
  manifestVersion: 2 | 3
  installedAt: string
  path: string
  /** Loads this extension in every profile in addition to profile-specific selections. */
  globalEnabled: boolean
}

export interface AppSettings {
  browserExecutable: string
  fingerprintKernel: boolean
  enginePreference: EnginePreference
  recycleRetentionDays: 0 | 7 | 30 | 90
}

export interface EngineStatus {
  executable: string | null
  source: 'configured' | 'profile' | 'bundled' | 'system' | 'missing'
  fingerprintKernel: boolean
  label: string
  version?: string
}

export interface KernelRelease {
  version: string
  publishedAt: string
  assetName: string
  downloadUrl: string
  size: number
  sha256: string
  installed: boolean
  remoteAvailable: boolean
  origin?: 'release' | 'local-build' | 'bundled'
  executable?: string
}

export type KernelInstallStage = 'downloading' | 'verifying' | 'installing' | 'ready' | 'cancelled' | 'error'

export interface KernelInstallProgress {
  version: string
  stage: KernelInstallStage
  receivedBytes: number
  totalBytes: number
  percent: number
  message: string
}

export interface KernelHealth {
  version: string
  status: 'healthy' | 'unverified' | 'corrupt'
  message: string
  checkedAt: string
}

export type UpdateChannel = 'stable' | 'beta'
export type UpdateDistributionMode = 'signed' | 'internal-unsigned'
export type AppUpdateStage = 'disabled' | 'current' | 'available' | 'downloading' | 'ready' | 'error'

export interface AppUpdateArtifact {
  url: string
  size: number
  sha256: string
  kind: 'dmg' | 'exe'
}

export interface AppUpdateManifest {
  schemaVersion: 1
  channel: UpdateChannel
  distributionMode: UpdateDistributionMode
  version: string
  publishedAt: string
  notes: string
  artifacts: Record<string, AppUpdateArtifact>
  signature: string
}

export interface AppUpdateStatus {
  stage: AppUpdateStage
  currentVersion: string
  channel: UpdateChannel | null
  distributionMode: UpdateDistributionMode | null
  latestVersion?: string
  message: string
  notes?: string
  progress?: number
  downloadedPath?: string
}

export interface ProxyTestResult {
  ok: boolean
  ip?: string
  latencyMs: number
  error?: string
  warning?: string
  degraded?: boolean
  country?: string
  countryCode?: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  ipVersion?: 4 | 6
  region?: string
  city?: string
  timezone?: string
  asn?: number
  organization?: string
  isp?: string
  networkRisk?: 'tor' | 'vpn' | 'proxy' | 'hosting'
  geoConfidence?: 'consensus' | 'single-source' | 'conflict'
  geoSources?: string[]
  geoConflict?: string
  failureKind?: 'authentication' | 'timeout' | 'connection' | 'unknown'
  retried?: boolean
  exitChanged?: boolean
  previousIp?: string
}

export interface ProxyCheckSummary extends ProxyTestResult {
  checkedAt: string
}

export interface ProfileStorageInfo {
  path: string
  totalBytes: number
  cacheBytes: number
}

export interface StorageOverview {
  profilesBytes: number
  cacheBytes: number
  recycleBytes: number
  kernelsBytes: number
  downloadsBytes: number
  extensionsBytes: number
  totalBytes: number
}

export interface ProfileBackupResult {
  path: string
  totalBytes: number
  fileCount: number
}

export interface WorkspaceMigrationResult {
  path: string
  profileCount: number
  importedCount: number
  skippedCount: number
  renamedCount: number
  extensionCount: number
  totalBytes: number
  fileCount: number
}

export interface DeletedProfileSummary {
  trashId: string
  profileId: string
  serialNumber?: number
  name: string
  deletedAt: string
  sizeBytes: number
}

export interface CookieTransferResult {
  count: number
  filePath: string
}

export interface ProfileStoreHealth {
  recoveredFromBackup: boolean
  recoveryMessage?: string
  corruptFilePath?: string
  backupHealthy: boolean
  backupError?: string
}

export type LaunchDiagnosticStatus = 'pass' | 'warning' | 'error'

export interface LaunchDiagnosticCheck {
  key: string
  label: string
  status: LaunchDiagnosticStatus
  message: string
}

export interface LaunchDiagnosticReport {
  profileId: string
  checkedAt: string
  ready: boolean
  checks: LaunchDiagnosticCheck[]
}

export interface AppRecoveryStatus {
  previousUnclean: boolean
  previousStartedAt?: string
  markerCorrupt: boolean
  uncleanSessionCount: number
}

export interface BrowserCrashRecord {
  occurredAt: string
  pid?: number
  code: number | null
  signal: NodeJS.Signals | null
  phase: 'starting' | 'running'
}

export interface BrowserApi {
  profiles: {
    list: () => Promise<BrowserProfileView[]>
    create: (draft: ProfileDraft) => Promise<BrowserProfileView>
    update: (id: string, draft: ProfileDraft) => Promise<BrowserProfileView>
    duplicate: (id: string) => Promise<BrowserProfileView>
    exportConfig: (id: string) => Promise<string | null>
    importConfig: () => Promise<BrowserProfileView | null>
    importBatchCsv: () => Promise<BrowserProfileView[] | null>
    exportBatchTemplate: () => Promise<string | null>
    storageHealth: () => Promise<ProfileStoreHealth>
    storageInfo: (id: string) => Promise<ProfileStorageInfo>
    storageOverview: () => Promise<StorageOverview>
    openDataFolder: (id: string) => Promise<void>
    clearCache: (id: string) => Promise<ProfileStorageInfo>
    exportBackup: (id: string) => Promise<ProfileBackupResult | null>
    importBackup: () => Promise<{ profile: BrowserProfileView; result: ProfileBackupResult } | null>
    exportWorkspace: (password: string) => Promise<WorkspaceMigrationResult | null>
    importWorkspace: (password: string, conflictPolicy: 'rename' | 'skip') => Promise<WorkspaceMigrationResult | null>
    trash: () => Promise<DeletedProfileSummary[]>
    restore: (trashId: string) => Promise<BrowserProfileView>
    purgeTrash: (trashId: string) => Promise<void>
    emptyTrash: () => Promise<number>
    recycleRetention: () => Promise<AppSettings['recycleRetentionDays']>
    setRecycleRetention: (days: AppSettings['recycleRetentionDays']) => Promise<AppSettings['recycleRetentionDays']>
    exportCookies: (id: string) => Promise<CookieTransferResult | null>
    importCookies: (id: string) => Promise<CookieTransferResult | null>
    remove: (id: string) => Promise<void>
    launch: (id: string, options?: ProfileLaunchOptions) => Promise<BrowserProfileView>
    close: (id: string) => Promise<BrowserProfileView>
    closeAll: () => Promise<void>
    testProxy: (id: string) => Promise<BrowserProfileView>
    diagnose: (id: string) => Promise<LaunchDiagnosticReport>
    crashHistory: (id: string) => Promise<BrowserCrashRecord[]>
    setFavorite: (id: string, favorite: boolean) => Promise<BrowserProfileView>
    classifyMany: (ids: string[], patch: ProfileBatchClassification) => Promise<BrowserProfileView[]>
    removeMany: (ids: string[]) => Promise<void>
    onChanged: (listener: (profile: BrowserProfileView) => void) => () => void
  }
  engine: {
    status: () => Promise<EngineStatus>
    bundled: () => Promise<EngineStatus | null>
    activateBundled: () => Promise<EngineStatus>
    select: () => Promise<EngineStatus>
    importLocal: () => Promise<EngineStatus>
    useSystem: () => Promise<EngineStatus>
    installed: () => Promise<KernelRelease[]>
    activate: (version: string) => Promise<EngineStatus>
    rollbackAvailable: () => Promise<boolean>
    rollback: () => Promise<EngineStatus>
    remove: (version: string) => Promise<void>
    verify: (version: string) => Promise<KernelHealth>
  }
  updates: {
    status: () => Promise<AppUpdateStatus>
    check: () => Promise<AppUpdateStatus>
    download: () => Promise<AppUpdateStatus>
    openInstaller: () => Promise<void>
    onChanged: (listener: (status: AppUpdateStatus) => void) => () => void
  }
  proxy: {
    test: (config: ProxyConfig, profileId?: string) => Promise<ProxyTestResult>
  }
  diagnostics: {
    sessionHealth: () => Promise<AppRecoveryStatus>
    e2eQuit: () => Promise<void>
  }
  extensions: {
    list: () => Promise<BrowserExtension[]>
    importDirectory: () => Promise<BrowserExtension | null>
    // ---- 修改点 12：从 Chrome 应用商店安装。network 为 'direct'（本机直连）、'system'（跟随系统代理）或某个环境的 id（复用该环境代理下载） ----
    installFromStore: (extensionId: string, network: string) => Promise<BrowserExtension>
    openSourceFolder: (id: string) => Promise<string>
    setGlobalEnabled: (id: string, enabled: boolean) => Promise<BrowserExtension>
    remove: (id: string) => Promise<void>
  }
}
