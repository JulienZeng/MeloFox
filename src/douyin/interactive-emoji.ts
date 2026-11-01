import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { NativeMessageContent } from './native-message.js';

const http = z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; });
export function buildInteractiveEmoji(config: any, kind: 'dice' | 'rps', choose = randomInt): NativeMessageContent {
  if (config?.status_code !== 0) throw new Error('Interactive emoji catalog unavailable');
  const decision = config.decision_trees?.interactive_resources;
  let selected: string | undefined, count = 0;
  const visit = (node: any, depth = 0) => {
    if (!node || depth > 20 || ++count > 200) throw new Error('Invalid interactive emoji decision tree');
    if (node.node_attribute === 'default' || (node.node_type === 'hit_node' && node.node_value === 'true')) {
      if (Array.isArray(node.sub_node)) node.sub_node.forEach((child: any) => visit(child, depth + 1));
      else selected = node.config_name;
    }
  };
  if (decision?.root) visit(decision.root);
  selected ||= decision?.default_config_name;
  const name = kind === 'dice' ? '摇骰子' : '猜拳', outcomes = kind === 'dice' ? 6 : 3;
  const list = config.interactive_resource_config?.[selected ?? '']?.interactive_resources;
  if (!Array.isArray(list) || list.length > 200) throw new Error('Interactive emoji catalog is missing');
  const item = z.object({ display_name: z.literal(name), id: z.union([z.string(), z.number().safe().int(), z.bigint()]).transform(String),
    animate_url: http, resource_type: z.number().int(), static_url_list: z.array(z.object({ static_url: http })).length(outcomes)
  }).parse(list.find((entry: any) => entry?.display_name === name));
  const index = choose(outcomes);
  if (!Number.isInteger(index) || index < 0 || index >= outcomes) throw new Error('Invalid interactive emoji choice');
  const urlModel = (id: string, url: string, type: string) => ({ id, static_type: type, static_url: {
    url_key: null, data_size: 0, height: 0, player_access_key: null, url_list: [url], file_hash: null, width: 0, file_cs: null, uri: null } });
  const content = { light_url: '', url: { uri: '', url_list: [item.static_url_list[index].static_url] }, image_type: 'webp', light_id: '',
    sticker_type: 12, resource_type: item.resource_type, version: 0, image_id: 0, package_id: 339757, show_notice: false,
    emoji_type: 'lite_emoji', id: 0, emoji_from: 'little', author_id: '', from_emoji_id: '', light_icon: '', height: 100,
    aweType: 507, width: 100, enter_method: 'select', display_name: name, sticker_id: '',
    animate_url: urlModel(item.id, item.animate_url, 'webp'), potential_static_url_list: item.static_url_list.map(url => urlModel('0', url.static_url, 'png')) };
  return { messageType: 5, content: JSON.stringify(content), text: `[${name}]` };
}

export function interactiveEmojiSegment(content: string | undefined): { type: string; data: Record<string, never> } | undefined {
  try {
    const value = JSON.parse(content ?? '');
    if (value.aweType !== 507 || value.sticker_type !== 12) return;
    if (value.display_name === '摇骰子') return { type: 'dice', data: {} };
    if (value.display_name === '猜拳') return { type: 'rps', data: {} };
  } catch { return; }
}

export function validateInteractiveEmoji(content: string): void {
  const value = z.object({ aweType: z.literal(507), sticker_type: z.literal(12),
    display_name: z.enum(['摇骰子', '猜拳']), package_id: z.literal(339757), resource_type: z.number().int(),
    url: z.object({ url_list: z.array(http).length(1) }),
    animate_url: z.object({ id: z.string().min(1), static_url: z.object({ url_list: z.array(http).length(1) }) }),
    potential_static_url_list: z.array(z.object({ static_url: z.object({ url_list: z.array(http).length(1) }) })).max(6)
  }).parse(JSON.parse(content));
  const outcomes = value.potential_static_url_list;
  if (outcomes.length !== (value.display_name === '摇骰子' ? 6 : 3) || !outcomes.some(item => item.static_url.url_list[0] === value.url.url_list[0])) {
    throw new Error('Interactive emoji result does not belong to the official resource set');
  }
}
