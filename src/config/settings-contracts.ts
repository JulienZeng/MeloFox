import type { AppConfig } from './schema.js';

export interface RuntimeSettings {
  app: AppConfig['app'];
  browser: Pick<AppConfig['browser'], 'douyinUrl'>;
  douyin: AppConfig['douyin'];
  onebot: Pick<AppConfig['onebot'], 'rateLimitIntervalMs'>;
  media: Omit<AppConfig['media'], 'cache'> & { cache: Omit<AppConfig['media']['cache'], 'dir'> };
  network: AppConfig['network'];
  runtime: Omit<AppConfig['runtime'], 'messageCacheDir'>;
}

export interface SettingsSnapshot {
  revision: string;
  values: RuntimeSettings;
  restartRequired: boolean;
  deployment: {
    settingsFile: string;
    webEnabled: boolean;
    webHost: string;
    webPort: number;
    consoleDirectory: string;
    browserDirectory: string;
    browserHeadless: boolean;
    mediaDirectory: string;
    messageDirectory: string;
  };
}

export interface SettingsField {
  path: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'select' | 'lines' | 'password';
  hint: string;
  min?: number;
  max?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
}
const number = (path: string, label: string, unit: string, hint: string, min = 1, max = 2147483647): SettingsField =>
  ({ path, label, kind: 'number', unit, hint, min, max });
const toggle = (path: string, label: string, hint: string): SettingsField => ({ path, label, hint, kind: 'boolean' });

/** Browser-safe form metadata; values and server validation remain separate. */
export const settingsGroups: Array<{ id: string; title: string; fields: SettingsField[] }> = [
  { id: 'messages', title: '消息与日志', fields: [
    { path: 'app.logLevel', label: '日志级别', kind: 'select', hint: '日常使用 info，排查问题时选择 debug。', options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].map(value => ({ value, label: value })) },
    { path: 'app.logFormat', label: '终端日志格式', kind: 'select', hint: '控制台日志保留统一的浏览格式。', options: [{ value: 'pretty', label: '易读文本' }, { value: 'json', label: 'JSON' }] },
    toggle('app.logMessageContent', '记录消息摘要', '在收发日志中显示简短内容；关闭后仅显示对象和消息类型。'),
    toggle('runtime.shareAsText', '分享卡片转文本', '将分享卡片输出为标题、说明和链接。'),
    toggle('runtime.stickerAsText', '贴纸转文本', '关闭后下载并输出贴纸图片或动画。'),
    number('onebot.rateLimitIntervalMs', '限速动作间隔', '毫秒', '用于 OneBot 的限速动作，0 表示不额外等待。', 0, 60000),
  ] },
  { id: 'connection', title: '连接与超时', fields: [
    number('runtime.reconnectIntervalMs', '重连间隔', '毫秒', '会话恢复失败后再次尝试的间隔。'),
    number('runtime.heartbeatIntervalMs', 'OneBot 心跳间隔', '毫秒', '向已启用的事件通道发送心跳。'),
    number('runtime.sessionCheckIntervalMs', '会话检查间隔', '毫秒', '用于登录状态检查与消息补偿，入群申请检查至少间隔 60 秒。'),
    number('runtime.imDisconnectGraceMs', 'IM 断线宽限', '毫秒', '持续断线超过此时间后重建浏览器会话。'),
    number('runtime.actionTimeoutMs', '普通动作超时', '毫秒', '超时不代表抖音端一定未执行。'),
    number('runtime.videoSendTimeoutMs', '视频发送超时', '毫秒', '包含读取、转码、封面、上传和提交。'),
  ] },
  { id: 'media-service', title: '媒体服务', fields: [
    toggle('media.enabled', '启用媒体服务', '独立提供图片、视频、语音和文件下载，不依赖 OneBot HTTP 通道。'),
    { path: 'media.host', label: '监听地址', kind: 'text', hint: 'Docker 通常使用 0.0.0.0；127.0.0.1 仅容器或本机内部可达。' },
    number('media.port', '监听端口', '', '默认 3001，不可与管理台、OneBot HTTP 或正向 WebSocket 重复；Docker 映射目标端口需同步调整。', 1, 65535),
    { path: 'media.publicBaseUrl', label: '媒体公开地址', kind: 'text', hint: '填写接收端可访问的根地址。同一 Docker 网络可用 http://melofox:3001；留空使用监听地址，0.0.0.0 会回退为 127.0.0.1。' },
    { path: 'media.signingKey', label: '下载签名密钥', kind: 'password', hint: '可选，至少 16 个字符。配置后下载链接自动携带签名，无需 OneBot 令牌；留空允许持有链接者下载。修改密钥会使旧签名失效。' },
  ] },
  { id: 'media', title: '媒体缓存', fields: [
    number('media.cache.ttlMs', '媒体保留时间', '毫秒', '默认 7 天，容量不足时会提前淘汰。', 1, Number.MAX_SAFE_INTEGER),
    number('media.cache.cleanupIntervalMs', '媒体清理间隔', '毫秒', '定期清理过期媒体文件。'),
    number('media.cache.maxBytes', '缓存总容量', '字节', '默认 1 GiB（1073741824 字节）。', 1, Number.MAX_SAFE_INTEGER),
    number('media.cache.maxFiles', '缓存文件数量', '个', '已完成媒体的数量上限。'),
    number('media.cache.maxFileBytes', '单文件大小上限', '字节', '限制下载文件和转码成品，默认 128 MiB。', 1, Number.MAX_SAFE_INTEGER),
    toggle('media.cache.transcodeVideoToH264', '自动转换视频格式', '需要时转换为 H264/AAC MP4，提升播放兼容性。'),
    { path: 'media.cache.ffmpegPath', label: 'ffmpeg 路径', kind: 'text', hint: '可填写命令名或绝对路径；Docker 默认使用 ffmpeg。' },
    { path: 'media.cache.ffprobePath', label: 'ffprobe 路径', kind: 'text', hint: '可填写命令名或绝对路径；Docker 默认使用 ffprobe。' },
  ] },
  { id: 'cache', title: '消息缓存与队列', fields: [
    toggle('runtime.messageCachePersist', '持久化消息记录', '保存消息、游标与去重记录；各通道的事件队列独立保存。'),
    number('runtime.messageCacheLimit', '内存消息数量', '条', '每类消息、回执与标记的内存缓存上限。'),
    number('runtime.messageCacheTtlMs', '消息保留时间', '毫秒', '默认 7 天，查询不会延长保留时间。', 1, Number.MAX_SAFE_INTEGER),
    number('runtime.messageCacheFlushIntervalMs', '消息保存间隔', '毫秒', '关键记录会立即保存，正常退出也会执行保存。'),
    number('runtime.realtimeQueueLimit', '实时消息队列上限', '条', '等待处理的实时消息数量上限。'),
    number('runtime.realtimeMediaConcurrency', '媒体处理并发数', '个', '媒体任务独立处理，避免阻塞后续文本消息。'),
    number('runtime.realtimeMediaDetailWaitMs', '媒体详情等待时间', '毫秒', '等待缺失的媒体详情或正文补齐。'),
    number('runtime.realtimeMediaTimeoutMs', '媒体处理超时', '毫秒', '每个实时媒体任务的总超时时间。'),
  ] },
  { id: 'network', title: '下载代理', fields: [
    { path: 'network.httpProxy', label: 'HTTP 代理', kind: 'password', hint: '用于出站媒体 URL 下载；留空直连，支持 HTTP(S) 代理地址。' },
    { path: 'network.httpsProxy', label: 'HTTPS 代理', kind: 'password', hint: '用于 HTTPS 媒体 URL；留空时沿用 HTTP 代理。' },
    { path: 'network.noProxy', label: '免代理地址', kind: 'text', hint: '逗号分隔，例如 localhost,127.0.0.1,::1。此代理不影响浏览器与 OneBot 连接。' },
  ] },
  { id: 'advanced', title: '高级设置', fields: [
    { path: 'app.selfId', label: '登录前账号占位 ID', kind: 'text', hint: '登录成功后使用真实抖音 UID。' },
    { path: 'browser.douyinUrl', label: '抖音主站地址', kind: 'text', hint: '用于浏览器初始化，通常无需修改。' },
    { path: 'douyin.messagePageUrl', label: '私信页面地址', kind: 'text', hint: '用于加载抖音网页版消息页面。' },
    { path: 'douyin.hookMode', label: '消息捕获模式', kind: 'select', hint: '正常使用 network，其他模式用于兼容调试。', options: [{ value: 'network', label: '网络捕获' }, { value: 'injection', label: '页面注入' }, { value: 'dom', label: '页面元素' }] },
    { path: 'runtime.fileSendAllowedDirs', label: '本地媒体允许目录', kind: 'lines', hint: '每行一个目录；Docker 中填写已挂载到容器的路径。媒体缓存目录已自动允许。' },
    toggle('runtime.fileSendEnabled', '实验性文件发送', '普通文件发送仍可能被抖音拒绝，默认关闭。'),
  ] },
];
