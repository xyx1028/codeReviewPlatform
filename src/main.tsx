import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import 'antd/dist/reset.css'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#5364ff',
          colorInfo: '#5364ff',
          colorBgLayout: '#f6f6f8',
          colorBgContainer: '#ffffff',
          colorBorder: '#e8e8ed',
          colorBorderSecondary: '#eeeeF2',
          colorText: '#24242b',
          colorTextSecondary: '#85858e',
          borderRadius: 12,
          controlHeight: 36,
          fontSize: 14,
        },
        components: {
          Button: { primaryShadow: 'none', borderRadius: 10 },
          Card: { headerBg: 'transparent', paddingLG: 20 },
          Menu: {
            itemBg: 'transparent',
            itemHoverBg: '#ececef',
            itemSelectedBg: '#e2e2e7',
            itemSelectedColor: '#24242b',
            itemBorderRadius: 10,
            itemHeight: 38,
          },
          Tabs: { itemSelectedColor: '#5364ff', inkBarColor: '#5364ff' },
          Table: { headerBg: '#f7f7f9', headerColor: '#565660' },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
)
