import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 写入并 fsync。普通 writeFile 只保证数据进入系统缓存，
 * 断电 / 蓝屏 / 强杀后，NTFS 可能出现“文件长度已更新但内容为空洞(NUL)”的情况。
 */
export async function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const handle = await open(path, 'w', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 尽力同步目录项（Windows 不支持打开目录，失败直接忽略）。 */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch { /* Windows 或不支持的文件系统：忽略 */ }
}

/** 先写 `<path>.tmp` 并 fsync，再 rename 覆盖目标文件。 */
export async function writeFileAtomicDurable(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const temporary = `${path}.tmp`
  try {
    await writeFileDurable(temporary, data, mode)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await syncDirectory(dirname(path))
}
