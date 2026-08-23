import { describe, expect, it } from 'vitest'
import type { BrowserProfileView } from '../../shared/types'
import { profileTableSorters } from './profile-table-sort'

function profile(serialNumber: number, overrides: Partial<BrowserProfileView> = {}): BrowserProfileView {
  const base: BrowserProfileView = {
    id: `profile-${serialNumber}`, serialNumber, name: `环境 ${serialNumber}`, note: '', group: '', tags: [],
    extensionIds: [], color: '#5566dd', startUrls: [], window: { mode: 'auto', x: 0, y: 0, width: 1280, height: 800 },
    favorite: false, status: 'closed', proxy: { protocol: 'direct', host: '', username: '', password: '', passwordStored: false },
    fingerprint: {
      seed: serialNumber, hardwareProfileId: 'windows-host', platform: 'windows', platformVersion: '10.0.0',
      brand: 'Chrome', brandVersion: '144.0.7559.132', hardwareConcurrency: 8, language: 'zh-CN',
      acceptLanguages: 'zh-CN,zh,en-US,en', timezone: 'Asia/Tokyo', webrtcPolicy: 'proxy_only',
      networkIdentityMode: 'manual', proxyExitPolicy: 'warn', screenWidth: 1920, screenHeight: 1080, disabledSpoofing: []
    },
    kernelVersion: '144.0.7559.132', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }
  return { ...base, ...overrides }
}

describe('profile table column sorting', () => {
  it('sorts the environment column by permanent display number', () => {
    expect([profile(20), profile(3), profile(11)].sort(profileTableSorters.environment).map((item) => item.serialNumber))
      .toEqual([3, 11, 20])
  })

  it('sorts group, status, proxy and seed columns deterministically', () => {
    const items = [
      profile(3, { group: '商店 B', status: 'running', proxy: { protocol: 'http', host: 'z.example', port: 9, username: '', password: '', passwordStored: false }, fingerprint: { ...profile(3).fingerprint, seed: 30 } }),
      profile(2, { group: '商店 A', status: 'closed', proxy: { protocol: 'http', host: 'a.example', port: 9, username: '', password: '', passwordStored: false }, fingerprint: { ...profile(2).fingerprint, seed: 20 } }),
      profile(1, { group: '商店 A', status: 'closed', proxy: { protocol: 'http', host: 'a.example', port: 9, username: '', password: '', passwordStored: false }, fingerprint: { ...profile(1).fingerprint, seed: 10 } })
    ]
    expect([...items].sort(profileTableSorters.classification).map((item) => item.serialNumber)).toEqual([1, 2, 3])
    expect([...items].sort(profileTableSorters.status).map((item) => item.serialNumber)).toEqual([1, 2, 3])
    expect([...items].sort(profileTableSorters.proxy).map((item) => item.serialNumber)).toEqual([1, 2, 3])
    expect([...items].sort(profileTableSorters.seed).map((item) => item.fingerprint.seed)).toEqual([10, 20, 30])
  })
})
