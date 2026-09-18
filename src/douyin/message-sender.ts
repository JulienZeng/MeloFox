import type { DouyinBridge } from './bridge.js';
import type { DouyinSendMessageInput, DouyinSendMessageResult } from './types.js';

export function sendDouyinMessage(bridge: DouyinBridge, input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
  return bridge.sendMessage(input);
}
