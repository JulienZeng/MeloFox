# MeloFox · OneBot 11 接入指南

[返回 README](../README.md)

MeloFox（音狐）支持 **OneBot 11**，将抖音群聊和已有私聊接入机器人应用。`get_version_info` 返回 `app_name: "melofox"`、`protocol_version: "11"`。标准动作之外的 `get_douyin_*` 等接口是本项目扩展，用于表达抖音特有能力。

适配以双方存在对应能力为前提。无法映射的动作、参数和消息段明确返回失败；QQ 好友关系、专属互动或资料字段不套用到抖音。私聊仅使用已有会话，不创建陌生人会话。ID 可能超过 JavaScript 安全整数范围，应始终使用十进制字符串。

下表的“已接通”表示代码及自动化路径已实现。群管理、审批、部分卡片等仍需真实账号权限及手机端验收，具体见[验证状态](verification.md)。

## 标准公开 API 对账

核对依据：[OneBot 11 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。共 38 个接口逐项列出；“已接通”不代表所有可选参数或 QQ 专属语义都适用于抖音。

| API | 当前实现及边界 |
| --- | --- |
| `send_private_msg` | 已接通；只向已有私聊发送，具体消息段见下表 |
| `send_group_msg` | 已接通；抖音实际权限及风控决定是否成功 |
| `send_msg` | 已接通；按 message_type 或目标字段路由 |
| `delete_msg` | 已接通；只撤回当前账号自己发送的消息 |
| `get_msg` | 已接通；缓存优先，缺失时利用已接收消息的引用或本账号发送记录定位会话并查询原消息；也支持显式指定已有会话。消息中已知的发送者群名片/角色随缓存持久化、重启恢复 |
| `get_forward_msg` | 已接通；标准 `message` 为 node 数组，同时保留插件兼容 `messages`；可读取内联/加密转发记录 |
| `send_like` | 无已确认的同义能力；QQ 好友赞不映射成作品点赞或表情回应 |
| `set_group_kick` | 已接通，cmd 651；`reject_add_request=false`。true 无永久拒绝入群映射，操作前拒绝 |
| `set_group_ban` | 已接通，cmd 2019；duration 秒，默认 1800，0 解除，最大 2592000；真实账号尚待验收 |
| `set_group_anonymous_ban` | QQ 匿名成员功能，无对应映射 |
| `set_group_whole_ban` | 已接通，cmd 2020；限制普通成员，enable=false 解除 |
| `set_group_admin` | 已接通，cmd 655；只按真实 role=2 映射管理员，普通成员 role=0；未知角色不猜管理员 |
| `set_group_anonymous` | QQ 匿名聊天开关，无对应映射 |
| `set_group_card` | 已接通，cmd 655；空 card 清除，显式 is_alias_set；服务端决定是否可修改目标成员 |
| `set_group_name` | 已接通，cmd 902；验证最终名称及群标识 |
| `set_group_leave` | 已接通；普通退群 cmd 652，群主解散 cmd 614。群主必须显式 is_dismiss=true，非群主不能解散 |
| `set_group_special_title` | QQ 专属头衔，无对应映射 |
| `set_friend_add_request` | 不把关注/互关等同于 QQ 加好友；现有会话范围没有对应请求审批 |
| `set_group_add_request` | 已接通；已有管理群的 add 申请，cmd 2025，操作前重读申请；invite 入新群超出范围，非空拒绝 reason 无已验证字段 |
| `get_login_info` | 已接通，实际登录账号 |
| `get_stranger_info` | 已接通已有身份线索的资料查询；不因此新建会话 |
| `get_friend_list` | 已接通为已有私聊联系人；不是完整好友/关注关系 |
| `get_group_info` | 已接通，群名称、人数、容量等平台字段 |
| `get_group_list` | 已接通已有群列表 |
| `get_group_member_info` | 已接通；no_cache 同时刷新成员列表和可解析身份的昵称，不再复用旧昵称；强制查询失败不冒充成功。角色来自实际元数据；返回标准完整字段集合 |
| `get_group_member_list` | 已接通；成员分页，标准字段集合与单成员接口一致 |
| `get_group_honor_info` | QQ 龙王、群荣誉无同义映射 |
| `get_cookies` | QQ 接口，无兼容输出；不借此导出抖音会话凭据 |
| `get_csrf_token` | QQ bkn/CSRF 无同义映射 |
| `get_credentials` | QQ 凭据，无对应映射 |
| `get_record` | 已接通；有效语音缓存转换，格式依赖本机 ffmpeg |
| `get_image` | 已接通；有效图片缓存读取 |
| `can_send_image` | 已接通，返回 true，仍受登录态和发送权限约束 |
| `can_send_record` | 已接通，诚实返回 false，语音发送仍未打通 |
| `get_status` | 已接通；会话、实时处理和连接健康状态 |
| `get_version_info` | 已接通 |
| `set_restart` | 已接通；返回 async/retcode=1，延迟重建整个网关会话、浏览器及 OneBot 通道。持久管理台及 Node 进程继续运行，不重载配置文件；重复请求合并，停机取消尚未开始的任务 |
| `clean_cache` | 已接通；清理媒体缓存及已支持的发送下载缓存 |

群成员性别、年龄、地域、入群/发言时间、QQ 等级/头衔等缺少可靠数据时使用 unknown、0、空串等兼容值；`card_changeable=false` 是未知权限的保守值，不用于拒绝 `set_group_card`。这些值不是平台事实断言。抖音 UID、群 ID、消息 ID 可能超过 JavaScript 安全整数，接口统一用十进制字符串保真；不冒充 QQ 的 int32 消息 ID。

## 消息段

依据：[OneBot 消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)。发送支持字符串/CQ、消息段数组和单个消息段对象。

| 类型 | 当前实现及边界 |
| --- | --- |
| text / face | 文本及已核对同名小表情映射；普通 reply+face 是引用消息，表情回应须显式 mode=reaction 或对应 API |
| image | 普通图片接收/发送；URL、允许目录内本地文件、base64、已注册图片缓存名/路径/本站媒体 URL；缓存复用无需启动媒体 HTTP 监听或放宽文件目录白名单；支持 cache/proxy/timeout。flash 尚无可靠发送映射，明确拒绝 |
| record | 普通 type 17 接收、下载、转换；发送暂缓；加密 109/501 当前不支持，接收时明确提示，协议/样本待确认 |
| video | 接收/发送及必要转码；支持已注册视频缓存名/路径/本站媒体 URL 复用，URL 下载同样支持 cache/proxy/timeout |
| at | 指定成员及已支持 all；群全体使用原生 infoType=4/mention_label=1 和 mentioned_users=0；私聊 @all 在整批发送前拒绝 |
| rps / dice | 已接通收发，参数为空；读取官方 interactive_resources 配置构造 aweType=507 原生消息，不自造资源 URL 或指定结果 |
| shake / poke | 未找到与 QQ 戳一戳等价且可验证的抖音消息协议；不映射成其他互动 |
| anonymous | 无对应匿名发送能力 |
| share | 网页/作品/图集/用户卡接收、结构化发送及缓存复用；部分真实成功路径仍待手机验收 |
| contact | 已知用户 type=qq/douyin → 原生 25；新增 type=group → 原生 58，来源必须是已有群且资料可验证；收到 58 输出群 contact，收到 25 保留既有 share 输出 |
| location | 原生 502 收发 |
| music | 仅缓存的原生抖音 22 复用；QQ/163/xm 音乐 ID 或任意自定义音频不具有已验证原生映射 |
| reply | 已接通；引用当前账号可访问的原消息 |
| forward / node | 原生 136；已有消息 ID、服务端预校验、授权记录读取；自定义作者/内容的 QQ 合并节点不支持 |
| xml / json | 只转换已知链接卡及 share/location/contact/music 封装；拒绝任意协议注入及 QQ 专属 ARK/XML |
| file（扩展） | 接收及下载已接通；发送上传成功但最终业务 10502，默认关闭 |

URL 下载默认使用缓存和环境 HTTP(S)_PROXY/NO_PROXY，proxy=0 直连；cache=0 跳过并移除该 URL 的缓存。timeout 单位秒，与整个发送动作的截止时间共同生效。缓存每账号最多 64 MiB、10 分钟，注销/切换账号/clean_cache 清除，正在下载的旧任务不能回填已清空缓存。并行首次请求不承诺只下载一次。

接收侧注册媒体的复用另受 `media.cache` 的大小、TTL 和清理规则约束；拒绝过期、缺失、类型不匹配或被替换为符号链接的文件。普通远程 URL 保留原下载参数语义。带反向代理路径前缀的本站 URL 也可查询和复用。混合发送各条之间及缓存准备后检查账号，账号改变时停止余下发送；已有回执仍按 partial 返回。

## 事件与调用方式

依据：[OneBot 通知](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md)、[API 调用方式](https://github.com/botuniverse/onebot-11/blob/master/api/README.md)、[HTTP 通信](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)。

- message.private/group、heartbeat/lifecycle、自己和他人的撤回通知保持已有实现。
- 内置 `#dy` 文本命令在 OneBot 消息事件分发前消费，直接回复原群/已有私聊的版本、平台和进程运行时间；自身命令及回复回显不触发循环。命令不进入下游事件队列，回复失败不转发或自动重发；持久化开启时，处理标记在保留期限内跨重启去重。
- 群消息增加 `anonymous=null`；新收到的群消息从有效本地成员缓存补充 sender.card / role，不为每条消息发起资料查询；没有可靠角色时省略 role。性别/年龄缺少数据时为 unknown/0。群角色不是跨时间的权限授权凭证。
- 支持 `group_upload`：文件元数据有效即可上报，另保留 file 消息扩展；busid 无平台同义值，使用 0。下游若同时处理两种事件需按消息 ID 避免重复业务处理。
- 支持 `group_increase`、`group_decrease`：只转换明确的邀请/审批/踢人/退群业务类型。泛型成员删除命令没有操作者和原因时只失效群缓存，不能猜为主动退群或被踢。
- 支持 `group_admin/set`；unset 依据 command_type=7 的 modified_participant 加“已知管理员→最新普通成员”进行核对。缺失旧角色、未知新角色、仅收到成员移除或启动前变更时不伪造 unset；角色核对不是历史全量审计。
- 支持 `group_ban`，个体/全群及解除。SDK 命令未给操作者时为 operator_id="0"，附 douyin_operator_unknown=true；未给个体禁言时长则不生成错误时长。
- 支持 `request/group/add`：每分钟（或更长的会话检查间隔）读取已有管理群的待处理申请，不清除抖音未读；flag 绑定账号/群/申请 ID，重复记录去重，审批前再次读取是否仍有效。
- 群申请并发轮询共享同一次读取和投递；去重状态持久化失败时撤销内存标记，后续轮询可以重试。仍按至少一次交付处理重复 flag。
- `.handle_quick_operation` 支持回复、自身撤回、踢人、禁言和群申请批准/拒绝。踢人/禁言要求与缓存原消息的群、发送者匹配；多操作非原子，失败不自动重做。
- `*_async`、`*_rate_limited` 返回 async/retcode=1；队列按桥接账号共享，最多 128 个待执行动作，限速默认 500 ms，可配置 onebot.rateLimitIntervalMs。最终失败只记动作名及 retcode，无最终结果回调；该内存动作队列不持久化、不自动重试，停机取消待执行项，账号变化取消旧账号动作。重要业务应使用同步动作获取最终结果。
- 通知标记和下游持久 outbox 保留去重 ID，交付仍是至少一次；下游应按 message_id/event_id/flag 去重。
- HTTP 支持 `/:action/` 尾斜杠、GET/表单中的消息段对象，以及转发 messages、快速操作 context/operation 的 JSON 字符串；大整数保真，auto_escape=true 保留字符串原文。缺令牌/错误令牌分别为 401/403，不支持的 Content-Type 为 406，格式错误为 400，未实现动作（含 async/限速变体）为 404；已支持动作的参数或业务失败仍为 HTTP 200 + failed。根路径动作信封继续保留 echo，并采用同一参数解析。

## 不支持范围与待确认能力（不计功能缺失）

- 非空群申请拒绝理由、踢人后永久拒绝再入群没有已验证映射，请求明确失败；普通审批和踢人已接通。QQ 专属能力及其他无对应映射的动作、参数、消息段同样按不支持处理。
- 闪照当前不支持并明确拒绝。原生一次性图片/视频（SDK 91/92）仅有类型定义，缺少可验证的上传、发送、消费状态及权限契约，列为协议待确认，不列为必做功能。
- 加密语音 109/501 当前不支持，收到时输出明确提示；缺少可靠密钥/资源样本和解密链路，列为协议待确认。普通 type 17 接收已支持。
- 群通知原始数据缺少原因、操作者、禁言时长或旧角色时，保留未知或不生成无法确定的通知，不伪造字段；这是事件来源的映射边界，不按缺失整个通知功能统计。
- 完整好友关系、新建陌生人会话、群头像/非标准权限开关、多账号同时在线不纳入当前范围。

## 已实现待验收与明确暂缓

- 已实现待实机验收：群管理、审批、原生群名片、全体提及、骰子/猜拳的真实业务回执及手机显示，以及尚未验证的组合场景。以上为验收待办，不等同于代码未实现。
- 明确暂缓：普通文件和语音发送仍被最终业务回执 10502 拒绝。Docker 部署及验证范围见[部署指南](deployment.md)和[验证状态](verification.md)。

## 内置命令 `#dy`

在已有私聊或群聊收到以 `#dy` 开头的文本时，网关直接向原会话回复版本、运行平台和进程运行时间。功能参照 [NapCat 的内置 `#napcat` 命令](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-plugin-builtin/index.ts#L303-L375)，版本号与 `get_version_info` 一起读取 `package.json`。

命令在 OneBot 事件分发前消费，不进入 HTTP/WS 上报或离线事件队列；自身回复回显也不向下游上报。回复失败仍消费命令，不转交机器人、不自动重发；需要时重新发送一条 `#dy`。沿用自身消息过滤规则，网关登录账号从其他设备发送的命令不会触发回复。匹配区分大小写，普通正文中间的 `#dy`、卡片标题、引用内容和前置 @ 不触发。

命令处理标记按账号保留，并在发送前写入消息缓存；启用消息缓存持久化时，在保留期限内重启也不会对同一消息重复回复。关闭持久化时仅保证当前会话内去重。先记录再发送意味着进程在两者之间退出时该条可能没有回复，重新发送新命令即可。

## 媒体接收与发送凭据

私聊发送仅使用已有会话的用户映射，找不到会话时返回错误，不主动创建陌生人会话。业务消息通过 OneBot 统一收发；内置 `#dy` 命令由网关本地处理。

- 普通语音（抖音 `type=17`）下载并通过音频格式及 ffmpeg 解码校验后，以 OneBot `record` 消息段输出；详情缺失时等待补齐，资源不可用时显示「语音暂不可用」。`get_msg` 可重新下载缓存过期的语音，旧下载地址失效时重新查询该会话的消息详情，不重放消息事件。
- 加密语音（`type=109/501`）输出「加密语音暂不支持」。语音发送尚未打通，`can_send_record` 仍返回 `false`。
- 图文分享（`type=77` / `awemeType=68`）输出包含标题、封面和作品链接的 OneBot `share`，`RUNTIME_SHARE_AS_TEXT=true` 时转换为文本；旧消息缓存查询也使用此解析。
- 发送消息前，在现有抖音浏览器登录态中请求官方身份安全凭据，最多缓存 4 分钟，并在账号或登录 Cookie 变化时重新获取。获取失败时返回错误，不自动重发消息。凭据仅保存在内存中。

以上协议适配参考 [DouYin_Spider](https://github.com/cv-cat/DouYin_Spider/tree/fc8b9c2490a9561265425c26058290f01c064eda) 的私信消息结构与身份安全接口。2026-10-28 已用授权私聊的手机语音验证下载、解码、OneBot `record`、媒体 HTTP 回读及 WAV/MP3 转码；原生语音内容回发和普通文件发送仍被服务端返回 `10502`。当前验收状态见[验证状态](verification.md)。

## 分享卡片与原生大表情示例

通过 `send_private_msg` / `send_msg` 发送单个消息段，`user_id` 必须能映射到已有私聊。数组和 CQ 字符串均可使用。分享、大表情各自独立发送；可以与文字、图片、视频按输入顺序拆条发送，引用附到各条消息；消息表情回应不参与混合发送。成功响应中的 `message_id` 来自服务端有效回执，可继续用于 `get_msg`、引用和撤回。外层响应 `OK` 但业务检查失败时返回失败，不自动重试。

标准网页分享发送为抖音 `type=26`，自动补齐 PC 渲染需要的 `pc_iframe_src`；URL 与封面支持不带账号密码的 HTTP(S) 地址：

```json
{
  "action": "send_private_msg",
  "params": {
    "user_id": "已有会话的用户ID",
    "message": [{"type": "share", "data": {
      "url": "https://example.com/article", "title": "标题",
      "content": "可选摘要", "image": "https://example.com/cover.jpg"
    }}]
  }
}
```

也可在 `share.data` 指定抖音原生类型；不指定时为网页分享：

| `douyin_share_type` | 抖音类型 | 必填字段 | 可选元数据 |
| --- | --- | --- | --- |
| `web` | 26 | `url`、`title` | `content`、`image` |
| `aweme` | 8 | `https://www.douyin.com/video/作品ID` 格式的 `url`、`title` | `image`、作者的 `douyin_user_id`、`douyin_sec_uid`、`douyin_author_name` |
| `photos` | 77 | `https://www.douyin.com/note/作品ID` 格式的 `url`、`title` | 同上，另可传实际张数 `douyin_image_count`（默认 1） |
| `user` | 25 | `https://www.douyin.com/user/secUID` 格式的 `url`、`title`、`douyin_user_id` | 头像 `image`、抖音号 `content` |

ID 推荐始终使用字符串。作品短链接可通过 `resolve_douyin_share` 配合已有会话查询，或发送 `{"type":"share","data":{"url":"https://v.douyin.com/.../","douyin_resolve":true}}` 自动解析并补齐标题、封面、作者。用户资料卡仍需提供明确的 UID/secUID。新建卡片的真实客户端展示与送达仍需账号联调。

复用已接收的卡片时，发送 `{"type":"share","data":{"douyin_source_message_id":"原消息ID"}}`。非文本模式的事件和 `get_msg` 输出会附带 `douyin_source_message_id`，可直接把该 `share` 段再次发送。带来源 ID 时使用缓存原文，其他展示字段不作为修改指令；作品和用户名片保留完整原始字段及精确大整数，网页卡片会补齐 PC 所需链接参数。

原生大表情发送为抖音 `type=5`，复用当前账号缓存中带原生资源信息的表情消息：

```json
{"type":"sticker","data":{"douyin_source_message_id":"原表情消息ID"}}
```

对应 CQ 为 `[CQ:sticker,douyin_source_message_id=原表情消息ID]`。`RUNTIME_STICKER_AS_TEXT=false` 时，接收的 `image` 表情段也附带来源 ID，可以直接复用；默认文本展示模式下可使用事件外层的 `message_id` 构造上述 `sticker` 段。发送复用原生 CDN 元数据，无需重新上传图片。普通 `face` / `emoji` 的文本表情及回应语义不变。

来源消息必须存在于当前账号的有效缓存中，且类型正确、内容完整、未被撤回或拒绝；过期、缺失、账号变化时返回失败。也可通过 `get_douyin_sticker_list` 获取热门目录或指定 `keyword`、已有会话进行搜索，直接发送返回的 `segment`；目录标识绑定账号，1 小时内有效，重建浏览器会话后需重新查询。仅有图片 URL 或 `douyin_image_id` 不能冒充原生大表情。客户端渲染和平台风控只能通过真实账号进一步验证，当前自动化测试使用拦截网络的浏览器环境。

## 查询接口与可靠性

文本、图片、分享、贴纸、视频的有效发送回执立即进入消息缓存。混合消息返回最后一个 `message_id` 和完整 `message_ids`；部分成功时失败响应保留 `partial: true` 与已确认的 ID。发送结果不确定时返回 `client_message_id` 和 `delivery_status: "unknown"`，调用 `get_douyin_send_result` 核对，禁止整批盲目重发。

消息/通知先写入各 OneBot 通道的磁盘队列。反向 HTTP 收到 2xx、WebSocket 完成写入后才删除队列项；这是至少一次传输，接收端应按消息/事件 ID 去重。正向 WS 的离线积压由下一批连上的客户端接收，不提供独立订阅者游标。HTTP 快速操作失败不会触发事件重投或自动重发消息。停用的通道不接收新事件。反向 HTTP 的心跳只保留最新状态，不写入消息积压；生命周期启用可重试，停用通知最多等待 1 秒，元事件响应不执行快速操作。

抖音补偿使用账号绑定的分页游标；整页送入下游队列后才保存进度。首次登录从初始化快照开始，主动历史查询不变成新消息事件。平台保留期限、首次初始化前的消息、缓存 TTL 和容量仍构成边界，不能宣称零丢失。

| API | 主要参数与行为 |
| --- | --- |
| `get_group_msg_history` / `get_friend_msg_history` / `get_private_msg_history` | 群用 `group_id`，私聊用 `user_id`；`message_seq` 是服务端消息 ID，默认从最新开始；`count` 默认 20、最多 100；`reverse_order=true` 或 `reverseOrder=true` 从锚点向更新消息查询，返回时间升序列表。使用 `next_message_seq` 续查，不能把抖音内部 `next_cursor` 当消息 ID |
| `send_group_forward_msg` / `send_private_forward_msg` | `messages` 为 `node` 数组，仅支持 `data.id` 引用当前账号缓存中的已有消息；服务端预校验后发送 type 136；返回 `message_id` / `forward_id` |
| `get_forward_msg` | `id` 为当前账号缓存中的合并转发卡消息 ID；标准 `message` 为 node 数组，同时保留兼容 `messages`；含内联或经认证解密的记录，不把转发内记录作为新消息入库或上报 |
| `get_douyin_history` | `user_id` 或 `conversation_id`（已有会话），`cursor` 默认 `"0"`、`count` 1–100、`direction` 1/2/3；返回 `next_cursor`、`has_more` |
| `search_douyin_messages` | 同上，加 `keyword`；在当前返回页匹配文本，继续翻页由调用方决定 |
| `get_msg` | 优先缓存；仅传 `message_id` 时，可利用内存中已接收消息的引用或本账号发送记录补查原消息；没有会话线索时需补 `user_id`/`group_id`/`conversation_id`。查询不重放消息事件，也不延长原消息的本地保留期限；媒体缓存过期可修复 |
| `get_douyin_read_state` | 已有会话，返回自己的已读索引、参与者索引和未读数；未知未读数返回 `null` |
| `mark_douyin_read` | 显式标记已有会话已读；收消息和历史查询不会自动标记 |
| `get_douyin_send_result` | `client_message_id`，返回 `sent`、`rejected` 或 `unknown`；未知不会自动重发 |
| `get_record` | `file` 为本网关有效语音缓存 URL/ID，`out_format` 为 wav/mp3/ogg/flac/spx/amr/wma/m4a；取决于本机 ffmpeg 编解码器 |
| `get_douyin_sticker_list` | 热门目录；搜索时加 `keyword`（1–19 字）、已有会话；可分页 |
| `resolve_douyin_share` | `url` 和已有会话；返回可发送的作品/图集 `share` 段 |

插件历史接口接受 `disable_get_url` 和 `parse_mult_msg` 布尔参数。默认补齐媒体 URL，并在 `forward.data.content` 展开聊天记录（每次历史请求总计最多 100 条）；无法展开时保留卡片 ID 并返回 `douyin_forward_unavailable: true`，可单独调用 `get_forward_msg`。`quick_reply=true` 的 QQ 专用模式仍明确不支持。

## 其他消息段示例

以下消息段通过同一 OneBot 11 发送动作使用：

```json
{"type":"location","data":{"lat":39.9,"lon":116.4,"title":"测试位置","content":"位置说明"}}
{"type":"contact","data":{"type":"qq","id":"已有抖音用户UID"}}
{"type":"contact","data":{"type":"group","id":"已有抖音群ID"}}
{"type":"at","data":{"qq":"all"}}
{"type":"dice","data":{}}
{"type":"rps","data":{}}
{"type":"node","data":{"id":"当前账号缓存中的原消息ID"}}
{"type":"forward","data":{"id":"缓存中的合并转发卡ID"}}
{"type":"music","data":{"type":"douyin","douyin_source_message_id":"缓存中的原生音乐卡ID"}}
{"type":"json","data":{"data":"{\"type\":\"share\",\"data\":{\"url\":\"https://example.com\",\"title\":\"链接\"}}"}}
```

位置映射 type 502；`contact` 的 `qq` 兼容字段在本网关仍填写抖音 UID，只有已知姓名/secUID 的用户才能生成 type 25 名片，不创建陌生会话。已有用户名片接收仍保留原来的 `share` 输出。音乐目前只复用缓存 type 22，QQ/网易云 ID、自定义音频 URL 没有可靠原生映射。

`node` 只用于同一原会话的 1–100 条已有消息，不能自造作者、时间或内容；`forward` 复用也重新经过服务端校验。发送时按官方规则限制嵌套层数；查询展开一层嵌套子卡，并复用现有媒体校验/下载链路。跨层合计最多 100 条记录、10 个资源分片与 4 MiB 记录下载；更深嵌套、无权限或资源不可用时明确标记不可用。转发内子记录不能直接用于本账号撤回、回应或再次发送；需要原会话权限和真实消息缓存。

JSON 支持上述 `share/location/contact/music` 消息段封装及 `com.tencent.structmsg` 的 `meta.news` 链接卡；XML 支持 `serviceID="1"` 的单个链接卡（`msg.url`、`item.title/summary/picture.cover`）。只提取已知字段并重新构建抖音卡片，拒绝 DTD/实体声明、任意 IM 协议 JSON、其他 ARK/XML 模板。不宣称支持 QQ 专有交互。新增卡片发送尚待真实手机显示、跳转及业务回执验收。

## HTTP 与缓存兼容细节

图片和视频可以通过已注册的缓存文件名、缓存路径（包括 `file://`）或本站媒体 URL 再发送；图片缓存名可从 `get_image` 的 `filename` 取得。缓存复用不要求本地媒体 HTTP 端口在线，也不要求把媒体缓存目录加入 `RUNTIME_FILE_SEND_ALLOWED_DIRS`。缓存失效或类型错误会失败；普通本地文件继续受目录白名单约束，普通远程 URL 继续使用 cache/proxy/timeout。`media.publicBaseUrl` 带反向代理路径前缀时也支持媒体查询与复用。

新收到的群消息会在有效本地成员资料可用时输出 `sender.card` 和 `sender.role`，没有可靠角色时省略；消息缓存保留这些字段供 `get_msg` 和重启恢复使用。`get_group_member_info(no_cache=true)` 同时刷新成员资料和可查询的昵称，资料查询失败不回传旧昵称冒充成功。

HTTP 支持动作路径尾斜杠，表单/GET 支持单个消息段对象及转发、快速操作所需的结构化 JSON 参数。未携带令牌为 401，错误令牌为 403，正文/结构参数格式错误为 400，不支持的 Content-Type 为 406，不存在的动作及其 async/限速变体为 404；已支持动作的业务失败仍返回 HTTP 200 与 OneBot failed。`auto_escape=true` 保留字符串内容，根路径动作信封保留 echo。

群申请轮询会合并并发任务，去重记录持久化失败可在下轮重试。接收方仍按 flag 去重。混合发送在缓存准备后和每条发送前核对账号，账号改变时停止余下发送，并保留已经确认的回执。
