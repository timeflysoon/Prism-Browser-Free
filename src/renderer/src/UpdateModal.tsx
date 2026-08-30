import { Alert, Button, Modal, Progress, Space, Tag, Typography, message } from 'antd'
import { useState } from 'react'
import type { AppUpdateStatus } from '../../shared/types'

interface UpdateModalProps {
  open: boolean
  appStatus: AppUpdateStatus | null
  onClose: () => void
  onUpdateChanged: (status: AppUpdateStatus) => void
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function UpdateModal({
  open,
  appStatus,
  onClose,
  onUpdateChanged
}: UpdateModalProps) {
  const [busy, setBusy] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  async function check(): Promise<void> {
    setBusy(true)
    try {
      onUpdateChanged(await window.browserApi.updates.check())
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function download(): Promise<void> {
    setBusy(true)
    try {
      onUpdateChanged(await window.browserApi.updates.download())
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openInstaller(): Promise<void> {
    setBusy(true)
    try {
      await window.browserApi.updates.openInstaller()
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const stage = appStatus?.stage
  const isAvailable = stage === 'available'
  const isDownloading = stage === 'downloading'
  const isReady = stage === 'ready'
  const isCurrent = stage === 'current'
  const alertType = stage === 'error'
    ? 'error'
    : isAvailable || isReady ? 'info' : isCurrent ? 'success' : 'warning'

  return (
    <Modal open={open} title="应用更新" footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Prism Browser {appStatus?.currentVersion ?? ''}
          </Typography.Title>
          <Space wrap>
            <Tag>当前版本 {appStatus?.currentVersion ?? '未知'}</Tag>
            {appStatus?.latestVersion && <Tag color={isAvailable || isDownloading || isReady ? 'blue' : 'green'}>最新版本 {appStatus.latestVersion}</Tag>}
          </Space>
        </div>
        <Alert
          showIcon
          type={alertType}
          title={busy && !appStatus ? '正在检查更新…' : appStatus?.message ?? '正在读取更新状态…'}
          description={appStatus?.notes}
        />
        {isDownloading && (
          <Progress percent={appStatus?.progress ?? 0} status="active" />
        )}
        <Space wrap>
          <Button loading={busy} onClick={() => void check()}>重新检查</Button>
          {isAvailable && (
            <Button type="primary" loading={busy} onClick={() => void download()}>下载更新</Button>
          )}
          {isReady && (
            <Button type="primary" loading={busy} onClick={() => void openInstaller()}>打开安装程序</Button>
          )}
        </Space>
      </Space>
    </Modal>
  )
}
