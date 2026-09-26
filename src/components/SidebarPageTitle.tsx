import type { ReactNode } from 'react'
import { Typography } from 'antd'

const { Title } = Typography

export function SidebarPageTitle({
  title,
  extra,
  className,
}: {
  title: string
  extra?: ReactNode
  className?: string
}) {
  return (
    <header className={`sidebar-page-title${className === undefined ? '' : ` ${className}`}`}>
      <Title level={2}>{title}</Title>
      {extra === undefined ? null : <div className="sidebar-page-title__extra">{extra}</div>}
    </header>
  )
}
