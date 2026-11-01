export type OneBotPostType = 'message' | 'notice' | 'request' | 'meta_event';
export type OneBotMessageType = 'private' | 'group';

export interface OneBotMessageSegment {
  type: 'text' | 'image' | 'record' | 'video' | 'at' | 'reply' | string;
  data: Record<string, string | number | boolean | undefined>;
}

export interface OneBotEvent {
  time: number;
  self_id: string;
  post_type: OneBotPostType;
  [key: string]: unknown;
}

export interface OneBotActionRequest<TParams = Record<string, unknown>> {
  action: string;
  params?: TParams;
  echo?: unknown;
}

export interface OneBotActionResponse<TData = unknown> {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: TData | null;
  message?: string;
  wording?: string;
  echo?: unknown;
}

export interface OneBotStatus {
  online: boolean;
  good: boolean;
}
