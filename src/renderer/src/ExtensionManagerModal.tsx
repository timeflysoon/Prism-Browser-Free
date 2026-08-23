import { DeleteOutlined, EditOutlined, FolderAddOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, List, Modal, Popconfirm, Space, Spin, Switch, Tag, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { BrowserExtension } from '../../shared/types'

interface ExtensionManagerModalProps {
  open: boolean
  extensions: BrowserExtension[]
  onClose: () => void
  onChanged: (extensions: BrowserExtension[]) => void
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function ExtensionManagerModal({ open, extensions, onClose, onChanged }: ExtensionManagerModalProps) {
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      onChanged(await window.browserApi.extensions.list())
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function importDirectory(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.extensions.importDirectory()
      if (!imported) return
      onChanged([...extensions.filter((item) => item.id !== imported.id), imported])
      messageApi.success(`扩展“${imported.name}”已导入`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setImporting(false)
    }
  }

  async function remove(extension: BrowserExtension): Promise<void> {
    setRemoving(extension.id)
    try {
      await window.browserApi.extensions.remove(extension.id)
      onChanged(extensions.filter((item) => item.id !== extension.id))
      messageApi.success(`扩展“${extension.name}”已移入回收目录`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRemoving(null)
    }
  }

  async function openSourceFolder(extension: BrowserExtension): Promise<void> {
    setOpening(extension.id)
    try {
      await window.browserApi.extensions.openSourceFolder(extension.id)
      messageApi.info('已定位到当前扩展的 manifest.json；修改完成后请关闭并重新打开相关环境')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setOpening(null)
    }
  }

  async function setGlobalEnabled(extension: BrowserExtension, enabled: boolean): Promise<void> {
    setToggling(extension.id)
    try {
      const updated = await window.browserApi.extensions.setGlobalEnabled(extension.id, enabled)
      onChanged(extensions.map((item) => item.id === updated.id ? updated : item))
      messageApi.success(enabled
        ? `扩展“${extension.name}”已对所有环境启用；重新打开运行中的环境后生效`
        : `扩展“${extension.name}”已取消全局启用；重新打开运行中的环境后生效`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setToggling(null)
    }
  }

  return (
    <Modal open={open} title="浏览器扩展" width={720} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        type="warning"
        showIcon
        title="扩展拥有读取和修改网页数据的能力"
        description="仅导入你信任的扩展。"
      />
      <div className="extension-toolbar">
        <Typography.Text type="secondary">导入一次后，可在不同环境中选择不同扩展组合。</Typography.Text>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Button type="primary" icon={<FolderAddOutlined />} loading={importing} onClick={() => void importDirectory()}>导入扩展目录</Button>
        </Space>
      </div>
      <Spin spinning={loading && extensions.length === 0}>
        <List
          dataSource={extensions}
          locale={{ emptyText: '尚未导入浏览器扩展' }}
          renderItem={(extension) => (
            <List.Item actions={[
              <Button
                key="edit"
                type="text"
                icon={<EditOutlined />}
                loading={opening === extension.id}
                onClick={() => void openSourceFolder(extension)}
              >编辑</Button>,
              <Popconfirm
                key="remove"
                title={`移除扩展“${extension.name}”？`}
                description="仍被环境或回收站引用时将拒绝移除。"
                okText="移除"
                cancelText="取消"
                onConfirm={() => remove(extension)}
              >
                <Button danger type="text" icon={<DeleteOutlined />} loading={removing === extension.id}>移除</Button>
              </Popconfirm>,
              <Space key="global-enabled" size={6}>
                <Typography.Text type="secondary">全局启用</Typography.Text>
                <Switch
                  size="small"
                  checked={extension.globalEnabled}
                  loading={toggling === extension.id}
                  onChange={(enabled) => void setGlobalEnabled(extension, enabled)}
                />
              </Space>
            ]}>
              <List.Item.Meta
                title={<Space><span>{extension.name}</span><Tag>v{extension.version}</Tag></Space>}
                description={
                  <div>
                    <div>{extension.description || '无描述'}</div>
                    <Typography.Text type="secondary" className="extension-path" copyable={{ text: extension.path }}>{extension.path}</Typography.Text>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </Spin>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        “全局启用”会让所有现有及以后新建的环境加载该扩展；扩展开关或源码修改需关闭并重新打开环境后生效。
      </Typography.Paragraph>
    </Modal>
  )
}
