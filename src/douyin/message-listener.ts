import type { DouyinBridge, DouyinMessageHandler } from './bridge.js';

export function registerDouyinMessageListener(bridge: DouyinBridge, handler: DouyinMessageHandler): void {
  bridge.onMessage(handler);
}
