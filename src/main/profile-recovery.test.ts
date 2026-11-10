import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { buildLaunchArgs } from './launch-args'
import { defaultFingerprint } from '../shared/defaults'
import { effectiveFingerprintSeed } from '../shared/hardware-profiles'
import { hintsFromLaunchArgs, rebuildProfile, RECOVERED_TAG } from './profile-recovery'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function vault(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'prism-recovery-'))
  temporaryPaths.push(path)
  return path
}

async function destroyAllMetadata(repository: ProfileStore): Promise<void> {
  const nulls = '\0'.repeat(2048)
  await writeFile(repository.profilesPath, nulls, 'utf8')
  await writeFile(repository.backupPath, nulls, 'utf8')
  await writeFile(repository.previousBackupPath, nulls, 'utf8')
  for (const name of await readdir(repository.snapshotsPath)) {
    await writeFile(join(repository.snapshotsPath, name), nulls, 'utf8')
  }
}

function flag(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))
}

describe('rebuilding profiles from disk', () => {
  it('rebuilds an environment with the same fingerprint identity when all metadata is destroyed', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const draft = defaultProfileDraft()
    draft.name = '店铺 A'
    draft.startUrls = ['https://example.com/login']
    draft.fingerprint = { ...draft.fingerprint, timezone: 'America/New_York', language: 'en-US', acceptLanguages: 'en-US,en', screenWidth: 1920, screenHeight: 1080, hardwareConcurrency: 12 }
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'u', password: 'secret' }
    const original = await repository.create(draft)

    // 模拟浏览器上次启动：记录参数，并在浏览器数据里留下登录状态
    const originalArgs = buildLaunchArgs(original, { userDataDir: repository.profileDataPath(original.id), proxyUrl: 'http://127.0.0.1:9999' })
    await writeFile(join(repository.profileRuntimePath(original.id), 'last-launch.json'), JSON.stringify({ args: originalArgs, launchedAt: '2026-11-01T08:00:00.000Z' }))
    await writeFile(join(repository.profileDataPath(original.id), 'Cookies'), 'session-data')

    await destroyAllMetadata(repository)
    const recovered = new ProfileStore(path)
    await recovered.initialize()

    expect(recovered.list()).toHaveLength(1)
    const rebuilt = recovered.get(original.id)
    const rebuiltArgs = buildLaunchArgs(rebuilt, { userDataDir: recovered.profileDataPath(rebuilt.id) })
    for (const name of ['fingerprint', 'fingerprint-platform', 'fingerprint-brand', 'fingerprint-hardware-concurrency', 'fingerprint-screen-width', 'fingerprint-screen-height', 'timezone', 'lang', 'window-name', 'window-size']) {
      expect(flag(rebuiltArgs, name), name).toBe(flag(originalArgs, name))
    }
    expect(rebuilt.name).toBe('店铺 A')
    expect(rebuilt.serialNumber).toBe(original.serialNumber)
    expect(rebuilt.startUrls).toEqual(['https://example.com/login'])
    expect(rebuilt.lastOpenedAt).toBe('2026-11-01T08:00:00.000Z')
    // 浏览器数据完全保留
    await expect(readFile(join(recovered.profileDataPath(original.id), 'Cookies'), 'utf8')).resolves.toBe('session-data')
    // 代理无法恢复：不会静默直连，必须由用户重新配置
    expect(rebuilt.proxy.protocol).toBe('direct')
    expect(rebuilt.status).toBe('error')
    expect(rebuilt.lastError).toContain('代理')
    expect(rebuilt.tags).toContain(RECOVERED_TAG)
    expect(rebuilt.note).toContain('代理')
    expect(recovered.storageHealth().recoveryMessage).toContain('重建 1 个环境')
    expect(recovered.storageHealth().corruptFilePath).toContain('profiles.corrupt-')

    // 下一次启动是普通启动，重建结果已持久化
    const reopened = new ProfileStore(path)
    await reopened.initialize()
    expect(reopened.get(original.id).name).toBe('店铺 A')
    expect(reopened.storageHealth().recoveredFromBackup).toBe(false)
  })

  it('rebuilds a never-launched environment with safe defaults', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const profile = await repository.create(defaultProfileDraft())
    await destroyAllMetadata(repository)

    const recovered = new ProfileStore(path)
    await recovered.initialize()

    expect(recovered.get(profile.id).name).toContain('恢复的环境')
    expect(recovered.get(profile.id).proxy.protocol).toBe('direct')
  })

  it('starts with an empty list when metadata is destroyed and there is nothing on disk to rebuild', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    await destroyAllMetadata(repository)

    const recovered = new ProfileStore(path)
    await recovered.initialize()

    expect(recovered.list()).toEqual([])
    expect(recovered.storageHealth().recoveryMessage).toContain('空列表')
  })

  it('re-adopts environments created after the snapshot we had to fall back to', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const profile = await repository.create(defaultProfileDraft())
    // 只有初始化时（还没有任何环境）的快照是好的，其余全部损坏
    const nulls = '\0'.repeat(1024)
    await writeFile(repository.profilesPath, nulls, 'utf8')
    await writeFile(repository.backupPath, nulls, 'utf8')
    await writeFile(repository.previousBackupPath, nulls, 'utf8')

    const recovered = new ProfileStore(path)
    await recovered.initialize()

    expect(recovered.get(profile.id).tags).toContain(RECOVERED_TAG)
    expect(recovered.storageHealth().recoveryMessage).toContain('历史快照')
    expect(recovered.storageHealth().recoveryMessage).toContain('重建了 1 个')
  })

  it('does not adopt a directory whose owner marker points to another environment', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const profile = await repository.create(defaultProfileDraft())
    await writeFile(repository.profileOwnerPath(profile.id), JSON.stringify({ schemaVersion: 1, profileId: 'someone-else' }))
    await destroyAllMetadata(repository)

    const recovered = new ProfileStore(path)
    await recovered.initialize()

    expect(recovered.list()).toEqual([])
    expect(recovered.storageHealth().issues?.join('\n')).toContain('身份标记指向其他环境')
  })
})

describe('startup resilience', () => {
  it('repairs a zero-filled owner marker instead of failing to start', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const profile = await repository.create(defaultProfileDraft())
    await writeFile(repository.profileOwnerPath(profile.id), '\0'.repeat(64), 'utf8')

    const reopened = new ProfileStore(path)
    await reopened.initialize()

    expect(reopened.get(profile.id).status).toBe('closed')
    expect(JSON.parse(await readFile(reopened.profileOwnerPath(profile.id), 'utf8'))).toEqual({ schemaVersion: 1, profileId: profile.id })
    await expect(reopened.assertProfileDataIdentity(profile.id)).resolves.toBeUndefined()
  })

  it('isolates one environment with a mismatched data directory without blocking the others', async () => {
    const path = await vault()
    const repository = new ProfileStore(path)
    await repository.initialize()
    const [good, bad] = await repository.createMany([defaultProfileDraft(), defaultProfileDraft()])
    await writeFile(repository.profileOwnerPath(bad.id), JSON.stringify({ schemaVersion: 1, profileId: good.id }))

    const reopened = new ProfileStore(path)
    await reopened.initialize()

    expect(reopened.get(good.id).status).toBe('closed')
    expect(reopened.get(bad.id).status).toBe('error')
    expect(reopened.storageHealth().issues).toHaveLength(1)
    await expect(reopened.assertProfileDataIdentity(bad.id)).rejects.toThrow('不匹配')
  })

  it('falls back to default settings and keeps the file when settings.json is corrupted', async () => {
    const path = await vault()
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'settings.json'), '\0'.repeat(128), 'utf8')

    const settings = new SettingsStore(path)
    await settings.initialize()

    expect(settings.get().enginePreference).toBe('auto')
    expect(settings.recoveryMessage()).toContain('默认设置')
    const names = await readdir(path)
    expect(names.some((name) => name.startsWith('settings.corrupt-'))).toBe(true)
    await settings.update({ recycleRetentionDays: 30 })
    expect(JSON.parse(await readFile(join(path, 'settings.json'), 'utf8')).recycleRetentionDays).toBe(30)
  })

  it('treats a settings.json that is not an object as corrupted', async () => {
    const path = await vault()
    await writeFile(join(path, 'settings.json'), 'null', 'utf8')
    const settings = new SettingsStore(path)
    await settings.initialize()
    expect(settings.recoveryMessage()).toBeDefined()
  })
})

describe('hintsFromLaunchArgs', () => {
  it('ignores malformed or out-of-range values', () => {
    const hints = hintsFromLaunchArgs([
      '--fingerprint=99999999999', '--fingerprint-platform=linux', '--fingerprint-hardware-concurrency=0',
      '--timezone=' + 'x'.repeat(100), '--window-name=garbage', 'not-a-flag', 42
    ])
    expect(hints.seed).toBeUndefined()
    expect(hints.fingerprint).toEqual({})
    expect(hints.name).toBeUndefined()
    expect(hints.startUrls).toEqual([])
  })
})

describe('rebuildProfile seed identity', () => {
  it('keeps the effective fingerprint seed stable for seeded GPU profiles', () => {
    for (let index = 1; index <= 300; index += 1) {
      const original = defaultFingerprint(index * 7919)
      const effective = effectiveFingerprintSeed(original)
      const hints = hintsFromLaunchArgs([`--fingerprint=${effective}`])
      const rebuilt = rebuildProfile({ id: `profile-${index}`, hints }, 1)
      expect(effectiveFingerprintSeed(rebuilt.fingerprint)).toBe(effective)
    }
  })
})
