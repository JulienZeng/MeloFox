'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  authenticated: false,
  data: null,
  view: 'overview',
  filter: 'all',
  editing: null,
  deleting: null,
  refreshBusy: false,
  loginBusy: false,
  login: null,
  loginError: '',
  pollStopped: false
};
const titles = {
  overview: [
    '概览',
    '连接，从这里开始。',
    '管理你的抖音账号与 OneBot 通道，让每一次连接清晰可见。'
  ],
  account: [
    '账号登录',
    '你的账号，连接起点。',
    '登录抖音账号，为消息搭起第一座桥。'
  ],
  channels: [
    '连接通道',
    '每个通道，都是一种可能。',
    '连接 AstrBot 或其他 OneBot 应用，按你的方式收发消息。'
  ],
  activity: [
    '运行记录',
    '连接的每一步，都有迹可循。',
    '查看本次运行中的会话恢复与通道变更记录。'
  ]
};
const types = {
  http: 'HTTP',
  'forward-ws': '正向 WebSocket',
  'reverse-ws': '反向 WebSocket',
  'reverse-http': '反向 HTTP'
};
const statuses = {
  disabled: '已停用',
  waiting: '等待会话',
  error: '启动失败',
  listening: '监听中',
  connected: '已连接',
  connecting: '连接中'
};
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );
let toastTimer;
function toast(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4000);
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (
    typeof options.body === 'string' &&
    options.body.length > 0 &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') showLogin();
    throw Object.assign(new Error(body.message || '请求失败，请稍后重试'), {
      code: body.code,
      status: response.status
    });
  }
  return body;
}
async function busy(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function clearLogin() {
  state.login = null;
  state.loginError = '';
  $('#login-qrcode').removeAttribute('src');
  $('#login-qrcode').hidden = true;
  $('#qr-placeholder').hidden = false;
}
function showLogin() {
  state.authenticated = false;
  state.data = null;
  clearLogin();
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  $$('dialog[open]').forEach((d) => d.close());
}
function showApp() {
  state.authenticated = true;
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
}
function setView(view) {
  state.view = view;
  $$('.view').forEach((el) => {
    el.hidden = el.id !== `${view}-view`;
  });
  $$('.nav-item[data-view]').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === view)
  );
  $('#breadcrumb-title').textContent = titles[view][0];
  $('#page-title').textContent = titles[view][1].slice(0, -1);
  const period = document.createElement('span');
  period.className = 'accent';
  period.textContent = '。';
  $('#page-title').append(period);
  $('#page-description').textContent = titles[view][2];
  if (view === 'account') renderLogin();
}
function statusPill(channel) {
  const key = channel.status.state;
  return `<span class="status-pill ${['connected', 'listening'].includes(key) ? '' : 'offline'}">${escapeHtml(statuses[key] || key)}</span>`;
}
function endpoint(channel) {
  if (channel.type.startsWith('reverse-')) {
    try {
      const u = new URL(channel.url);
      u.search = '';
      return u.toString();
    } catch {
      return channel.url;
    }
  }
  const host = channel.host.includes(':') ? `[${channel.host}]` : channel.host;
  return `${channel.type === 'http' ? 'http' : 'ws'}://${host}:${channel.port}`;
}
function elapsed(start) {
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  return minutes < 60
    ? `${minutes} 分钟`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
      : `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 时`;
}
function render() {
  const data = state.data;
  if (!data) return;
  const { account, channels } = data;
  const enabled = channels.filter((c) => c.enabled).length;
  const healthy = channels.filter((c) =>
    ['listening', 'connected'].includes(c.status.state)
  ).length;
  $('#top-status').textContent = account.online
    ? '消息连接在线'
    : account.loggedIn
      ? '账号已登录'
      : '等待账号登录';
  $('#top-status').classList.toggle('offline', !account.online);
  $('#stat-account').textContent = account.loggedIn ? '已登录' : '等待登录';
  $('#stat-account-note').textContent = account.loggedIn
    ? `账号 ${account.id}`
    : '登录后即可收发消息';
  $('#stat-channels').innerHTML = `${channels.length} <small>个</small>`;
  $('#stat-channels-note').textContent = channels.length
    ? `${enabled} 个启用 · ${healthy} 个已就绪`
    : '创建你的第一个连接';
  $('#stat-uptime').textContent = elapsed(data.startedAt);
  $('#nav-channel-count').textContent = channels.length;
  $('#summary-account').textContent = account.loggedIn
    ? '抖音账号已登录'
    : '还没有登录账号';
  $('#summary-account-note').textContent = account.loggedIn
    ? `ID ${account.id}`
    : '扫码登录，开始你的第一条连接';
  $('#account-step').classList.toggle('done', account.loggedIn);
  $('#account-step .step-number').textContent = account.loggedIn ? '✓' : '02';
  $('#account-step .text-button').textContent = account.loggedIn
    ? '管理账号 ↗'
    : '前往登录 ↗';
  $('#channel-step').classList.toggle('done', channels.length > 0);
  $('#channel-step .step-number').textContent = channels.length ? '✓' : '03';
  $('#setup-progress').textContent =
    `${1 + Number(account.loggedIn) + Number(channels.length > 0)} / 3 已完成`;
  $('#overview-channels').innerHTML = channels.length
    ? channels
        .slice(0, 2)
        .map(
          (c) =>
            `<div class="mini-channel"><span>⇄</span><div>${escapeHtml(c.name)}<small>${types[c.type]}</small></div>${statusPill(c)}</div>`
        )
        .join('')
    : '<div class="empty-mini"><span>⇄</span><p>这里还没有连接通道</p><button class="text-button new-channel">创建你的第一个通道 ↗</button></div>';
  $('#server-error').hidden = !data.error;
  $('#server-error').textContent = data.error || '';
  $('#account-status').textContent = account.loggedIn
    ? account.online
      ? '在线'
      : '已登录 · 等待消息连接'
    : data.browser === 'ready'
      ? '等待扫码'
      : '浏览器启动中';
  $('#logged-in').hidden = !account.loggedIn;
  $('#login-panel').hidden = account.loggedIn && !['verifying', 'choose_trust'].includes(data.login?.state);
  $('#account-id').textContent = `抖音账号 ID · ${account.id || ''}`;
  if (data.login) {
    if (state.login?.id !== data.login.id) {
      state.pollStopped = false;
      state.loginError = '';
    }
    state.login = data.login;
  }
  renderLogin();
  const filtered = channels.filter(
    (c) => state.filter === 'all' || c.enabled === (state.filter === 'enabled')
  );
  $('#channel-list').innerHTML = filtered.length
    ? filtered
        .map(
          (c) =>
            `<article class="channel-card"><div class="channel-card-header"><span class="channel-icon">${c.type === 'http' ? '⌘' : '⇄'}</span><div><h3>${escapeHtml(c.name)}</h3><div class="tiny-label">${types[c.type]}</div></div><button class="switch" role="switch" aria-checked="${c.enabled}" aria-label="${c.enabled ? '停用' : '启用'}${escapeHtml(c.name)}" data-toggle="${c.id}"></button></div><div class="channel-endpoint">${escapeHtml(endpoint(c))}</div><div class="channel-meta">${statusPill(c)}<span>${c.accessToken ? '已配置令牌' : '未设置令牌'}${c.status.clients !== undefined ? ` · ${c.status.clients} 个连接` : ''}</span></div>${c.status.error ? `<p class="channel-error">${escapeHtml(c.status.error)}</p>` : ''}<div class="channel-card-footer"><span>ONEBOT 11</span><button data-edit="${c.id}">编辑配置</button><button class="delete-channel" data-delete="${c.id}">删除</button></div></article>`
        )
        .join('')
    : `<div class="empty-state"><span>⇄</span><h2>${channels.length ? '没有符合条件的通道' : '准备好第一条连接'}</h2><p>${channels.length ? '切换筛选条件，查看其他通道。' : '选择连接方式，将抖音消息接入你的机器人。'}</p><button class="primary new-channel">＋ 创建通道</button></div>`;
  $('#activity-list').innerHTML = data.activity.length
    ? data.activity
        .map(
          (item) =>
            `<div class="activity-row"><span class="dot"></span><time>${escapeHtml(new Date(item.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time><span>${escapeHtml(item.message)}</span></div>`
        )
        .join('')
    : '<div class="empty-mini"><p>暂无运行记录</p></div>';
}
async function refresh(silent = false) {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  try {
    state.data = await api('/api/status');
    showApp();
    render();
  } catch (error) {
    if (!silent && state.authenticated) toast(error.message, true);
  } finally {
    state.refreshBusy = false;
  }
}
function renderLogin() {
  const login = state.login;
  const titles = {
    waiting: '等待扫码',
    scanned: '已扫码，等待手机确认',
    confirmed: '正在确认登录',
    verifying: '需要身份验证',
    choose_trust: '选择保存方式',
    saved: '登录配置已保存',
    expired: '二维码已过期',
    refused: '已取消登录',
    error: '登录未完成'
  };
  $('#qr-state-title').textContent = login
    ? titles[login.state] || '等待登录'
    : '等待获取二维码';
  $('#qr-state-message').textContent =
    login?.message || '二维码由抖音官方登录接口提供。';
  $('#douyin-login-error').textContent = state.loginError;
  const showQr = login && ['waiting', 'scanned'].includes(login.state);
  $('#login-qrcode').hidden = !showQr;
  $('#qr-placeholder').hidden = !!showQr;
  $('.qr-code-wrap').hidden = ['verifying', 'choose_trust', 'confirmed', 'saved'].includes(login?.state);
  if (showQr) {
    const path = `/api/douyin/login/${login.id}/qr`;
    if ($('#login-qrcode').getAttribute('src') !== path)
      $('#login-qrcode').src = path;
  } else $('#login-qrcode').removeAttribute('src');
  $('#qr-expiry').textContent = showQr
    ? `二维码有效期至 ${new Date(login.expiresAt).toLocaleTimeString('zh-CN')}`
    : '';
  $('#open-douyin').textContent = login ? '刷新登录二维码' : '获取登录二维码';
  const verifying = login?.state === 'verifying' && login.verification?.smsAvailable;
  $('#verify-form').hidden = !verifying;
  if (!verifying) $('#verify-code').value = '';
  const seconds = Math.max(0, Math.ceil(((login?.verification?.resendAt ?? 0) - Date.now()) / 1000));
  $('#send-verify-code').disabled = state.loginBusy || seconds > 0;
  $('#send-verify-code').textContent = seconds ? `${seconds} 秒后可重发` : '发送短信验证码';
  $('#submit-verify-code').disabled = state.loginBusy;
  $('#trust-choice').hidden = login?.state !== 'choose_trust';
  $('#trust-save').disabled = $('#trust-skip').disabled = state.loginBusy;
  $('#check-login').hidden =
    !login || !['waiting', 'scanned', 'confirmed'].includes(login.state);
}
async function pollLogin(manual = false) {
  if (
    !state.authenticated ||
    !state.login ||
    state.loginBusy ||
    (!manual &&
      (state.pollStopped || document.hidden || state.view !== 'account')) ||
    !['waiting', 'scanned', 'confirmed'].includes(state.login.state)
  )
    return;
  state.loginBusy = true;
  try {
    state.login = await api(`/api/douyin/login/${state.login.id}`);
    state.loginError = '';
    if (state.login.state === 'saved') {
      toast(state.login.message);
      await refresh();
    }
  } catch (error) {
    state.loginError = error.message;
    if (error.code || [404, 410].includes(error.status))
      state.pollStopped = true;
  } finally {
    state.loginBusy = false;
    renderLogin();
  }
}
function channelInput(channel) {
  return Object.fromEntries(
    [
      'name',
      'type',
      'enabled',
      'host',
      'port',
      'url',
      'accessToken',
      'secret',
      'timeoutMs',
      'publicBaseUrl'
    ].map((key) => [key, channel[key]])
  );
}
function typeFields() {
  const type = $('#channel-type').value;
  $('#url-fields').hidden = !type.startsWith('reverse-');
  $('#channel-url').required = type.startsWith('reverse-');
  $('#channel-url').disabled = !type.startsWith('reverse-');
  $('#listener-fields').hidden = type.startsWith('reverse-');
  $('#channel-host').disabled = $('#channel-port').disabled =
    type.startsWith('reverse-');
  $('#http-push-fields').hidden = type !== 'reverse-http';
  $('#channel-token-fields').hidden = type === 'reverse-http';
  $('#channel-url').placeholder = type === 'reverse-http' ? 'http://127.0.0.1:5701' : 'ws://127.0.0.1:6700/onebot/v11/ws';
  $('#media-fields').hidden = type !== 'http';
  $('#channel-public-url').disabled = type !== 'http';
  $('#type-hint').textContent = {
    http: '提供 OneBot HTTP API 和媒体下载服务。',
    'forward-ws': '本服务监听端口，机器人应用主动连入。',
    'reverse-ws': '本服务主动连接应用；适用于 AstrBot 的反向 WebSocket 接入。',
    'reverse-http': '向应用上报事件，支持签名、离线重试和快速回复。媒体下载需另配 HTTP 通道。'
  }[type];
}
function openChannel(id) {
  const channel = state.data?.channels.find((c) => c.id === id);
  state.editing = channel?.id || null;
  $('#channel-form').reset();
  $('#channel-error').textContent = '';
  if (channel)
    for (const [key, value] of Object.entries(channelInput(channel))) {
      const el = $('#channel-form').elements.namedItem(key);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
  else {
    $('#channel-name').value = '';
    $('#channel-type').value = 'reverse-ws';
    $('#channel-url').value = 'ws://127.0.0.1:6700/onebot/v11/ws';
  }
  $('#dialog-title').textContent = channel ? '编辑连接通道' : '创建连接通道';
  $('#save-channel').textContent = channel ? '保存配置 →' : '创建通道 →';
  typeFields();
  $('#channel-dialog').showModal();
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  await busy(event.submitter, async () => {
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ token: $('#login-token').value })
      });
      $('#login-token').value = '';
      await refresh();
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  });
});
$('#show-login-token').addEventListener('click', () => {
  const el = $('#login-token');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('#show-login-token').setAttribute(
    'aria-label',
    el.type === 'password' ? '显示管理令牌' : '隐藏管理令牌'
  );
});
for (const button of [$('#logout'), $('#mobile-logout')])
  button.addEventListener('click', (event) =>
    busy(event.currentTarget, async () => {
      await api('/api/auth/logout', { method: 'POST' });
      showLogin();
    })
  );
$('#refresh').addEventListener('click', (event) =>
  busy(event.currentTarget, () => refresh())
);
$('#channel-type').addEventListener('change', () => {
  const t = $('#channel-type').value;
  const url = $('#channel-url');
  if (t === 'reverse-http' && url.value === 'ws://127.0.0.1:6700/onebot/v11/ws') url.value = 'http://127.0.0.1:5701';
  else if (t === 'reverse-ws' && url.value === 'http://127.0.0.1:5701') url.value = 'ws://127.0.0.1:6700/onebot/v11/ws';
  if (!state.editing) $('#channel-port').value = t === 'http' ? '3001' : '3002';
  typeFields();
});
$('#close-dialog').addEventListener('click', () =>
  $('#channel-dialog').close()
);
$('#cancel-dialog').addEventListener('click', () =>
  $('#channel-dialog').close()
);
$('#channel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#channel-error').textContent = '';
  await busy(event.submitter, async () => {
    const form = $('#channel-form');
    const value = (name) => form.elements.namedItem(name).value;
    const channel = {
      name: value('name'),
      type: value('type'),
      url: value('type').startsWith('reverse-') ? value('url') : '',
      host: value('host'),
      port: Number(value('port')),
      accessToken: value('accessToken'),
      secret: value('secret'),
      timeoutMs: Number(value('timeoutMs')),
      publicBaseUrl: value('type') === 'http' ? value('publicBaseUrl') : '',
      enabled: form.elements.namedItem('enabled').checked
    };
    try {
      await api(`/api/channels${state.editing ? `/${state.editing}` : ''}`, {
        method: state.editing ? 'PUT' : 'POST',
        body: JSON.stringify(channel)
      });
      $('#channel-dialog').close();
      setView('channels');
      await refresh();
      toast('通道配置已保存');
    } catch (error) {
      $('#channel-error').textContent = error.message;
    }
  });
});
$('#cancel-delete').addEventListener('click', () =>
  $('#delete-dialog').close()
);
$('#confirm-delete').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    await api(`/api/channels/${state.deleting}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    state.deleting = null;
    await refresh();
    toast('通道已删除');
  })
);
document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) setView(viewButton.dataset.view);
  const create = event.target.closest('.new-channel');
  if (create) openChannel();
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    $$('[data-filter]').forEach((el) =>
      el.classList.toggle('active', el === filter)
    );
    render();
  }
  const edit = event.target.closest('[data-edit]');
  if (edit) openChannel(edit.dataset.edit);
  const remove = event.target.closest('[data-delete]');
  if (remove) {
    state.deleting = remove.dataset.delete;
    $('#delete-dialog').showModal();
  }
  const toggle = event.target.closest('[data-toggle]');
  if (toggle)
    void busy(toggle, async () => {
      const c = state.data.channels.find((c) => c.id === toggle.dataset.toggle);
      await api(`/api/channels/${c.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...channelInput(c), enabled: !c.enabled })
      });
      await refresh();
      toast(c.enabled ? '通道已停用' : '通道已启用');
    });
});
$('#open-douyin').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    state.loginError = '';
    try {
      state.login = await api('/api/douyin/login', { method: 'POST' });
      state.pollStopped = false;
    } catch (error) {
      state.loginError = error.message;
    }
    renderLogin();
  })
);
$('#check-login').addEventListener('click', (event) =>
  busy(event.currentTarget, () => pollLogin(true))
);
$('#douyin-logout').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    await api('/api/douyin/logout', { method: 'POST' });
    state.login = undefined;
    state.pollStopped = true;
    toast('已清除抖音登录状态');
    await refresh();
  })
);
$('#reconnect').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    await api('/api/douyin/reconnect', { method: 'POST' });
    toast('正在重建会话');
    await refresh();
  })
);
setInterval(() => {
  if (state.authenticated && !document.hidden) void refresh(true);
}, 4000);
setInterval(() => {
  void pollLogin();
}, 2500);
void refresh(true);

function refreshAssist() { $('#assist-image').src = `/api/douyin/assist/image?t=${Date.now()}`; }
$('#login-assist').addEventListener('click', event => busy(event.currentTarget, async () => {
  await api('/api/douyin/assist', { method: 'POST' });
  state.pollStopped = true; $('#assist-dialog').showModal(); refreshAssist();
}));
async function assistInput(input) {
  await api('/api/douyin/assist/input', { method: 'POST', body: JSON.stringify(input) }); refreshAssist();
}
let assistPointer;
const assistCoordinates = event => {
  const rect = $('#assist-image').getBoundingClientRect();
  return { x: Math.max(0, Math.min(999, (event.clientX - rect.left) * 1000 / rect.width)),
    y: Math.max(0, Math.min(759, (event.clientY - rect.top) * 760 / rect.height)) };
};
$('#assist-image').addEventListener('pointerdown', event => { assistPointer = assistCoordinates(event); event.currentTarget.setPointerCapture(event.pointerId); });
$('#assist-image').addEventListener('pointerup', event => {
  if (!assistPointer) return; const start = assistPointer, end = assistCoordinates(event); assistPointer = undefined;
  const input = Math.hypot(start.x - end.x, start.y - end.y) > 8 ? { type: 'drag', ...start, toX: end.x, toY: end.y } : { type: 'click', ...end };
  void assistInput(input).catch(error => toast(error.message));
});
$('#assist-type').addEventListener('click', event => busy(event.currentTarget, async () => {
  const text = $('#assist-text').value; $('#assist-text').value = ''; await assistInput({ type: 'text', text });
}));
for (const [id, key] of [['assist-enter', 'Enter'], ['assist-backspace', 'Backspace']])
  $(`#${id}`).addEventListener('click', event => busy(event.currentTarget, () => assistInput({ type: 'key', key })));
$('#assist-refresh').addEventListener('click', refreshAssist);
$('#assist-complete').addEventListener('click', event => busy(event.currentTarget, async () => {
  await api('/api/douyin/assist/complete', { method: 'POST' }); $('#assist-dialog').close(); toast('已保存登录，正在重连'); await refresh();
}));
$('#assist-close').addEventListener('click', () => $('#assist-dialog').close());
$('#assist-dialog').addEventListener('close', () => { $('#assist-text').value = ''; $('#assist-image').removeAttribute('src'); void api('/api/douyin/assist', { method: 'DELETE' }).catch(() => undefined); });

async function loginStep(step, body) {
  if (!state.login || state.loginBusy) return;
  state.loginBusy = true; state.loginError = ''; renderLogin();
  try {
    state.login = await api(`/api/douyin/login/${state.login.id}/${step}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (state.login.state === 'saved') { toast(state.login.message); await refresh(); }
  } catch (error) { state.loginError = error.message; await refresh().catch(() => {}); }
  finally { state.loginBusy = false; renderLogin(); }
}
$('#send-verify-code').addEventListener('click', () => loginStep('sms'));
$('#verify-form').addEventListener('submit', event => { event.preventDefault(); const code = $('#verify-code').value; $('#verify-code').value = ''; loginStep('verify', { code }); });
$('#trust-save').addEventListener('click', () => loginStep('trust', { save: true }));
$('#trust-skip').addEventListener('click', () => loginStep('trust', { save: false }));
setInterval(() => { if (state.authenticated && state.login?.state === 'verifying' && !document.hidden) renderLogin(); }, 1000);
