import { createRoot } from 'react-dom/client'
import { setupTheme } from '../app/theme.js'
import { AdminApp } from './AdminApp.js'
// 与主站共用一套设计令牌与全局样式：颜色、间距、字体全部来自这里
import '../app/theme.css'
import '../app/global.css'

setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<AdminApp />)
