export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

export interface SignedConfig {
  activationBaseUrl: string
  licensePublicKey: string
}

export function validateSignedConfig(value: unknown): SignedConfig {
  const config = value as Partial<SignedConfig>
  const activationBaseUrl = typeof config?.activationBaseUrl === 'string' ? new URL(config.activationBaseUrl) : null
  if (!config || !activationBaseUrl || activationBaseUrl.protocol !== 'https:'
    || activationBaseUrl.username || activationBaseUrl.password
    || activationBaseUrl.search || activationBaseUrl.hash
    || typeof config.licensePublicKey !== 'string') {
    throw new Error('配置文件无效')
  }
  return config as SignedConfig
}

export function activationUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const url = new URL(path.replace(/^\//, ''), normalized)
  if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:') throw new Error('服务地址无效')
  return url.toString()
}
