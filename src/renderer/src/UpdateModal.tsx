import { Modal, Space, Tag, Typography } from 'antd'
import type { AppUpdateStatus } from '../../shared/types'

interface UpdateModalProps {
  open: boolean
  appStatus: AppUpdateStatus | null
  onClose: () => void
}

export function UpdateModal({ open, appStatus, onClose }: UpdateModalProps) {
  return (
    <Modal open={open} title="应用更新" footer={null} onCancel={onClose} destroyOnHidden>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Prism Browser {appStatus?.currentVersion ?? ''}
          </Typography.Title>
          <Space wrap>
            <Tag>当前版本 {appStatus?.currentVersion ?? '未知'}</Tag>
          </Space>
        </div>
        <Typography.Paragraph type="secondary">
          本构建未启用自动更新检测，如需升级请手动获取新的安装包替换使用。
        </Typography.Paragraph>
      </Space>
    </Modal>
  )
}
