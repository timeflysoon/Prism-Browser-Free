import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionStore } from './extension-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ vault: string; source: string }> {
  const vault = await mkdtemp(join(tmpdir(), 'prism-extension-vault-'))
  const source = await mkdtemp(join(tmpdir(), 'prism-extension-source-'))
  temporaryPaths.push(vault, source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Test Extension',
    version: '1.2.3',
    description: 'fixture'
  }))
  await writeFile(join(source, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
  return { vault, source }
}

describe('ExtensionStore', () => {
  it('imports a validated unpacked extension and moves it to recycle on removal', async () => {
    const { vault, source } = await fixture()
    const store = new ExtensionStore(vault)
    await store.initialize()

    const extension = await store.importDirectory(source)
    expect(extension.name).toBe('Test Extension')
    expect(extension.manifestVersion).toBe(3)
    expect(extension.globalEnabled).toBe(false)
    expect(store.paths([extension.id])).toEqual([extension.path])
    expect(store.sourcePath(extension.id)).toBe(extension.path)
    expect(() => store.sourcePath('../invalid')).toThrow('ID 无效')
    await expect(access(join(extension.path, 'manifest.json'))).resolves.toBeUndefined()

    await store.remove(extension.id)
    expect(store.list()).toEqual([])
    await expect(access(extension.path)).rejects.toThrow()
  })

  it('persists global enablement and merges it with profile-specific selections', async () => {
    const { vault, source } = await fixture()
    const store = new ExtensionStore(vault)
    await store.initialize()
    const extension = await store.importDirectory(source)

    const enabled = await store.setGlobalEnabled(extension.id, true)
    expect(enabled.globalEnabled).toBe(true)
    expect(store.paths([])).toEqual([extension.path])
    expect(store.paths([extension.id])).toEqual([extension.path])

    const reloaded = new ExtensionStore(vault)
    await reloaded.initialize()
    expect(reloaded.list()[0].globalEnabled).toBe(true)
    expect(reloaded.paths([])).toEqual([extension.path])

    await reloaded.setGlobalEnabled(extension.id, false)
    expect(reloaded.paths([])).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects extension directories containing symbolic links', async () => {
    const { vault, source } = await fixture()
    const external = await mkdtemp(join(tmpdir(), 'prism-extension-external-'))
    temporaryPaths.push(external)
    await mkdir(join(external, 'data'))
    await symlink(join(external, 'data'), join(source, 'linked-data'))
    const store = new ExtensionStore(vault)
    await store.initialize()

    await expect(store.importDirectory(source)).rejects.toThrow('符号链接')
  })
})
