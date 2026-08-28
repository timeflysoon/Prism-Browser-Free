import { app, BrowserWindow, dialog, shell } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { BrowserLauncher } from './browser-launcher'
import { registerIpc } from './ipc'
import { ProfileStore } from './profile-store'
import { ElectronSecretCodec } from './secret-codec'
import { SettingsStore } from './settings-store'
import { KernelManager } from './kernel-manager'
import { AppLogger } from './app-logger'
import { ExtensionStore } from './extension-store'
import { CookieManager } from './cookie-manager'
import { publicProfile } from './profile-secrets'
import { ProfileBackupManager } from './profile-backup'
import { AppSessionTracker } from './app-session'
import { UpdateManager } from './update-manager'
import { migrateMacLegacyKernelSelection } from './browser-locator'
import { WorkspaceMigrationManager } from './workspace-migration'
import { AnnouncementManager } from './announcement-manager'

let mainWindow: BrowserWindow | null = null
let launcher: BrowserLauncher | null = null
let logger: AppLogger | null = null
let appSession: AppSessionTracker | null = null

if (process.platform === 'win32') app.setAppUserModelId('com.prismbrowser.desktop')

if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_USER_DATA && isAbsolute(process.env.PRISM_E2E_USER_DATA)) {
  app.setPath('userData', process.env.PRISM_E2E_USER_DATA)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'Prism Browser',
    backgroundColor: '#f3f5f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') logger?.error('Renderer console error', event.message)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger?.error('Renderer load failed', { code, description, url })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.whenReady().then(async () => {
  const vaultPath = join(app.getPath('userData'), 'vault')
  logger = new AppLogger(vaultPath)
  appSession = new AppSessionTracker(vaultPath)
  const profiles = new ProfileStore(vaultPath, new ElectronSecretCodec())
  const settings = new SettingsStore(vaultPath)
  const extensions = new ExtensionStore(vaultPath, logger)
  await logger.initialize()
  const appSessionSnapshot = await appSession.begin(app.getVersion())
  if (appSessionSnapshot.previousUnclean) {
    logger.error('检测到上次 Prism Browser 未正常退出', appSessionSnapshot.previousUnclean)
  }
  await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
  const kernelMigration = await migrateMacLegacyKernelSelection(settings, vaultPath)
  if (kernelMigration.migrated) {
    logger.info('已将 macOS 旧版托管内核切换为应用内置新版内核', {
      previousVersion: kernelMigration.previousVersion,
      bundledVersion: kernelMigration.bundledVersion
    })
  }
  const purgedTrashCount = await profiles.purgeTrashOlderThan(settings.get().recycleRetentionDays)
  if (purgedTrashCount) logger.info('已按保留策略自动清理环境回收站', { count: purgedTrashCount })
  const profileStorageHealth = profiles.storageHealth()
  if (profileStorageHealth.recoveredFromBackup) logger.error('环境元数据已从备份恢复', profileStorageHealth)
  if (!profileStorageHealth.backupHealthy) logger.error('环境元数据备份不可用', profileStorageHealth.backupError)
  logger.info('Prism Browser 已启动', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  launcher = new BrowserLauncher(profiles, settings, (profile) => {
    mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  }, extensions, logger)
  await launcher.initialize()
  const kernels = new KernelManager(vaultPath, settings, () => undefined, logger, (version) => profiles.kernelUsers(version))
  const cookies = new CookieManager(profiles, settings, logger)
  const backups = new ProfileBackupManager(profiles, app.getVersion(), logger)
  const workspaceMigration = new WorkspaceMigrationManager(profiles, extensions, app.getVersion(), logger)
  const updater = new UpdateManager(vaultPath, app.getVersion(), process.resourcesPath, (status) => {
    mainWindow?.webContents.send('updates:changed', status)
  }, logger)
  const announcements = new AnnouncementManager(process.resourcesPath, app.getVersion(), logger)
  await updater.initialize()
  registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, updater, announcements })
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}).catch(async (error) => {
  logger?.error('Prism Browser 启动失败', error)
  await logger?.flush()
  dialog.showErrorBox(
    'Prism Browser 无法启动',
    '应用启动失败，但现有环境数据没有被修改。请重新启动；如仍然失败，请查看日志文件。'
  )
  app.quit()
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('before-quit', (event) => {
  if (!launcher) return
  event.preventDefault()
  const current = launcher
  launcher = null
  void current.closeAll().finally(async () => {
    logger?.info('Prism Browser 已退出')
    await appSession?.complete().catch((error) => logger?.error('清理应用会话标记失败', error))
    await logger?.flush()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function writeCrashFallback(tag: string, error: unknown): void {
  // 不依赖 AppLogger 内部的缓冲/异步写入——uncaughtExceptionMonitor 之后进程会被 Node 立刻终止，
  // 只有同步写入才能保证在进程死掉之前真正落盘
  try {
    const dir = join(app.getPath('userData'), 'vault')
    mkdirSync(dir, { recursive: true })
    const text = `[${new Date().toISOString()}] ${tag}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`
    appendFileSync(join(dir, 'crash-fallback.log'), text)
  } catch { /* 这里已经是最后一道兜底，失败了也不能再抛 */ }
}

process.on('uncaughtExceptionMonitor', (error) => {
  logger?.error('主进程未捕获异常', error)
  writeCrashFallback('uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  logger?.error('主进程未处理 Promise 拒绝', reason)
  writeCrashFallback('unhandledRejection', reason)
  console.error(reason)
})

app.on('render-process-gone', (_event, _webContents, details) => {
  logger?.error('渲染进程异常退出', details)
  writeCrashFallback('render-process-gone', details)
})

app.on('child-process-gone', (_event, details) => {
  logger?.error('子进程异常退出', details)
  writeCrashFallback('child-process-gone', details)
})
