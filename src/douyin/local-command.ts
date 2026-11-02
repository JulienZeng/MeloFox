import { getVersionInfo } from '../runtime/version.js';
import type { DouyinMessage } from './types.js';

export function isDyCommand(message: DouyinMessage): boolean {
  // Match a leading text prefix, like NapCat's builtin command. Card titles,
  // quoted content and CQ-looking text inside a normal message are not commands.
  if (message.messageType !== undefined && message.messageType !== 7) return false;
  if (!message.segments?.length) return message.text?.startsWith('#dy') ?? false;
  let text = '';
  for (const segment of message.segments) {
    if (segment.type !== 'text' || typeof segment.data.text !== 'string') break;
    text += segment.data.text;
    if (text.length >= 3) break;
  }
  return text.startsWith('#dy');
}

export function dyCommandReply(uptimeSeconds = process.uptime()): string {
  const seconds = Math.max(0, Math.floor(uptimeSeconds));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const uptime = days ? `${days}天 ${hours % 24}小时 ${minutes % 60}分钟`
    : hours ? `${hours}小时 ${minutes % 60}分钟`
      : minutes ? `${minutes}分钟 ${seconds % 60}秒` : `${seconds}秒`;
  return ['MeloFox（音狐）信息', `版本: ${getVersionInfo().app_version}`,
    `平台: ${process.platform} (${process.arch})`, `运行时间: ${uptime}`].join('\n');
}
