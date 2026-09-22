import type { OneBotMessageSegment } from './types.js';

export function textSegment(text: string): OneBotMessageSegment {
  return {
    type: 'text',
    data: { text }
  };
}

export function imageSegment(file: string): OneBotMessageSegment {
  return {
    type: 'image',
    data: { file }
  };
}

export function recordSegment(file: string): OneBotMessageSegment {
  return {
    type: 'record',
    data: { file }
  };
}

export function videoSegment(file: string): OneBotMessageSegment {
  return {
    type: 'video',
    data: { file }
  };
}

export function atSegment(userId: string, name?: string): OneBotMessageSegment {
  return {
    type: 'at',
    data: {
      qq: userId,
      name
    }
  };
}

export function replySegment(messageId: string): OneBotMessageSegment {
  return {
    type: 'reply',
    data: {
      id: messageId
    }
  };
}

export function extractPlainText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }

  if (!Array.isArray(message)) {
    return '';
  }

  return message
    .filter((segment): segment is OneBotMessageSegment => {
      return typeof segment === 'object' && segment !== null && typeof (segment as OneBotMessageSegment).type === 'string';
    })
    .map(segment => {
      if (segment.type === 'text') {
        return String(segment.data.text ?? '');
      }
      if (segment.type === 'at') {
        return `@${segment.data.name ?? segment.data.qq ?? ''}`;
      }
      return '';
    })
    .join('');
}
