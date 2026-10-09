/// <reference types="vite/client" />
import type { OrbitBridge } from '../../shared/rpc'

declare global {
  interface Window {
    orbit: OrbitBridge
  }
}
