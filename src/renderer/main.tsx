import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import type { RelayApi } from '../shared/types'

declare global {
  interface Window {
    relay: RelayApi
  }
}

createRoot(document.getElementById('root')!).render(<App />)
