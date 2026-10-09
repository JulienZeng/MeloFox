import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import type { Page } from 'playwright';
import type { AppLogger } from '../logger/index.js';
import type { DouyinConversation, DouyinGroupMember, DouyinSendTarget, DouyinUser } from './types.js';

interface WireParticipant {
  userId: string;
  secUid?: string;
  alias?: string;
  role?: number;
}

interface ParticipantsPage {
  participants?: WireParticipant[];
  hasMore?: boolean;
  cursor?: string;
}

interface WireConversation {
  conversationId: string;
  conversationShortId: string;
  conversationType: number;
  inboxType?: number;
  participantsCount?: number;
  firstPageParticipants?: ParticipantsPage;
  conversationCoreInfo?: { name?: string; owner?: string; ext?: Record<string, string> };
}

export interface DirectoryResponse {
  cmd: number;
  statusCode: number;
  errorDesc?: string;
  reqUserId?: string;
  body?: {
    messageByInit?: { messages?: Array<{ conversations?: WireConversation }>; hasMore?: boolean; version?: string; nextInitVersion?: string };
    info?: { conversationInfoList?: WireConversation[] };
    participants?: { participantsPage?: ParticipantsPage };
  };
}

const schema = protobuf.load(resolve(process.cwd(), 'proto/douyin/Directory.proto'));

export async function encodeDirectoryPayload(type: string, value: Record<string, unknown>): Promise<Buffer> {
  const messageType = (await schema).lookupType(type);
  return Buffer.from(messageType.encode(messageType.fromObject(value)).finish());
}

export async function decodeDirectoryResponse(buffer: Buffer): Promise<DirectoryResponse> {
  const messageType = (await schema).lookupType('DirectoryResponse');
  const decoded = messageType.decode(buffer);
  if (!Object.hasOwn(decoded, 'statusCode')) {
    throw new Error('Douyin directory response has no status code');
  }
  return messageType.toObject(decoded, { longs: String }) as DirectoryResponse;
}

export function mapConversation(value: WireConversation, selfId: string): DouyinConversation {
  const core = value.conversationCoreInfo;
  const groupId = value.conversationShortId;
  const participants = (value.firstPageParticipants?.participants ?? []).map(item => mapParticipant(item, groupId, core?.owner));
  const peer = participants.find(item => item.userId !== selfId);
  return {
    id: value.conversationId,
    shortId: groupId,
    type: value.conversationType === 2 ? 'group' : 'private',
    name: core?.name || undefined,
    memberCount: value.participantsCount,
    maxMemberCount: core?.ext?.['a:s_group_member_limit'] ? Number(core.ext['a:s_group_member_limit']) : undefined,
    inboxType: value.inboxType ?? 0,
    ownerId: core?.owner,
    peerUserId: value.conversationType === 1 ? peer?.userId : undefined,
    participants
  };
}

function mapParticipant(value: WireParticipant, groupId: string, ownerId?: string): DouyinGroupMember {
  return {
    groupId,
    userId: value.userId,
    secUid: value.secUid,
    card: value.alias || undefined,
    role: value.userId === ownerId || value.role === 1 ? 'owner' : value.role === 2 ? 'admin' : 'member'
  };
}

type DirectoryRequester = (command: number, type: string, params: Record<string, unknown>, path: string, inboxType: number) => Promise<DirectoryResponse>;

export class DouyinDirectory {
  private readonly conversations = new Map<string, DouyinConversation>();
  private readonly users = new Map<string, DouyinUser>();
  private readonly memberCache = new Map<string, { time: number; members: DouyinGroupMember[] }>();
  private refreshedAt = 0;
  private refreshPromise?: Promise<void>;
  private selfId?: string;
  private authenticated = false;

  constructor(
    private readonly page: Page,
    private readonly request: DirectoryRequester,
    private readonly logger: AppLogger,
    private readonly timeoutMs = 15000
  ) {}

  get accountId(): string | undefined { return this.selfId; }
  get loggedIn(): boolean { return this.authenticated; }

  async checkSession(): Promise<void> {
    // A single authenticated init page verifies the account without replaying history or refreshing every profile.
    const response = await this.query(2043, 'InitRequest', { page: 0 }, 'v1/message/get_message_by_init', 1);
    if (!response.body?.messageByInit) throw new Error('Douyin session probe has no conversation page');
  }

  getCachedUser(userId: string): DouyinUser | undefined {
    return this.users.get(userId);
  }

  async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.loadConversations().finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  private async loadConversations(): Promise<void> {
    const found = new Map<string, DouyinConversation>();
    let version: string | undefined;
    const seenVersions = new Set<string>();
    for (let page = 0; page < 1000; page += 1) {
      // An omitted version requests the full snapshot; explicit zero requests a different sync path.
      const params: Record<string, unknown> = { page };
      if (version !== undefined) params.version = version;
      const response = await this.query(2043, 'InitRequest', params, 'v1/message/get_message_by_init', 1);
      const result = response.body?.messageByInit;
      if (!result) throw new Error('Douyin init response has no conversation page');
      for (const entry of result.messages ?? []) {
        const value = entry.conversations;
        if (!value || !['1', '2'].includes(String(value.conversationType))) continue;
        const conversation = mapConversation(value, this.selfId ?? '');
        found.set(conversation.id, conversation);
      }
      if (!result.hasMore) {
        this.conversations.clear();
        for (const [id, conversation] of found) this.conversations.set(id, conversation);
        this.refreshedAt = Date.now();
        await this.enrichConversations([...found.values()]);
        this.logger.info({ conversations: found.size }, 'loaded douyin conversations through imapi');
        return;
      }
      if (!result.nextInitVersion || seenVersions.has(result.nextInitVersion)) throw new Error('Douyin conversation pagination did not advance');
      seenVersions.add(result.nextInitVersion);
      version = result.nextInitVersion;
    }
    throw new Error('Douyin conversation pagination exceeded limit');
  }

  private async query(command: number, type: string, params: Record<string, unknown>, path: string, inboxType: number): Promise<DirectoryResponse> {
    const response = await this.request(command, type, params, path, inboxType);
    if (response.cmd !== command || response.statusCode !== 0) {
      if (command === 2043) this.authenticated = false;
      throw new Error(`Douyin ${path} failed: ${response.statusCode} ${response.errorDesc ?? ''}`);
    }
    if (response.reqUserId && /^[1-9]\d*$/.test(response.reqUserId)) {
      if (this.selfId && this.selfId !== response.reqUserId) {
        this.conversations.clear();
        this.users.clear();
        this.memberCache.clear();
        this.refreshedAt = 0;
      }
      this.selfId = response.reqUserId;
      this.authenticated = true;
    }
    return response;
  }

  async getLoginInfo(): Promise<DouyinUser> {
    await this.ensureFresh();
    if (!this.selfId || !this.authenticated) throw new Error('Douyin account is not authenticated');
    const cached = this.users.get(this.selfId);
    if (cached?.name) return cached;
    const stored = await this.page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('user_info') ?? 'null') as { uid?: string; nickname?: string; avatarUrl?: string } | null; }
      catch { return null; }
    });
    if (stored?.uid) {
      await this.loadUsers([{ userId: this.selfId, secUid: stored.uid }]);
    }
    return this.users.get(this.selfId) ?? { id: this.selfId };
  }

  async getConversations(): Promise<DouyinConversation[]> {
    await this.ensureFresh();
    return [...this.conversations.values()];
  }

  async getFriends(): Promise<DouyinUser[]> {
    const conversations = await this.getConversations();
    const friends = new Map<string, DouyinUser>();
    for (const conversation of conversations) {
      if (conversation.type !== 'private' || !conversation.peerUserId) continue;
      friends.set(conversation.peerUserId, this.users.get(conversation.peerUserId) ?? { id: conversation.peerUserId, name: conversation.name });
    }
    return [...friends.values()];
  }

  async getUser(userId: string, noCache = false): Promise<DouyinUser> {
    if (!/^[1-9]\d*$/.test(userId)) throw new Error('user_id must be a numeric Douyin user ID');
    await this.ensureFresh();
    const cached = this.users.get(userId);
    if (!noCache && cached?.name) return cached;
    const members = [...this.conversations.values()].flatMap(item => item.participants ?? [])
      .concat([...this.memberCache.values()].flatMap(item => item.members))
      .filter(item => item.userId === userId);
    let secUid = cached?.secUid ?? members.find(item => item.secUid)?.secUid;
    if (!secUid && userId === this.selfId) {
      secUid = await this.page.evaluate(() => {
        try { return (JSON.parse(localStorage.getItem('user_info') ?? 'null') as { uid?: string } | null)?.uid; }
        catch { return undefined; }
      });
    }
    if (!secUid) {
      if (!noCache && (cached || members.length || userId === this.selfId)) return cached ?? { id: userId };
      throw new Error(`Douyin user profile cannot be resolved: ${userId}; no sec_uid mapping is available`);
    }
    await this.loadUsers([{ userId, secUid }], noCache);
    const user = this.users.get(userId);
    if (!user) throw new Error(`Douyin user profile not found: ${userId}`);
    return user;
  }

  async getGroupInfo(groupId: string): Promise<DouyinConversation> {
    if (!/^[1-9]\d*$/.test(groupId)) throw new Error('group_id must be a numeric Douyin conversation ID');
    const response = await this.query(610, 'ConversationInfoRequest', {
      conversationInfoList: [{ conversationId: groupId, conversationShortId: groupId, conversationType: 2 }]
    }, 'v2/conversation/get_info_list', 0);
    const value = response.body?.info?.conversationInfoList?.find(item => item.conversationType === 2 && item.conversationShortId === groupId);
    if (!value) throw new Error(`Douyin group not found: ${groupId}`);
    const conversation = mapConversation(value, this.selfId ?? '');
    this.conversations.set(conversation.id, conversation);
    await this.enrichConversations([conversation]);
    return conversation;
  }

  async getGroupMembers(groupId: string, noCache = false): Promise<DouyinGroupMember[]> {
    const cached = this.memberCache.get(groupId);
    if (!noCache && cached && Date.now() - cached.time < 30000) return cached.members;
    const conversation = await this.getGroupInfo(groupId);
    const members = new Map<string, DouyinGroupMember>();
    let cursor = '0';
    const seenCursors = new Set<string>();
    for (let page = 0; page < 1000; page += 1) {
      const response = await this.query(605, 'ParticipantsRequest', {
        conversationId: conversation.id, conversationShortId: conversation.shortId, conversationType: 2, cursor, limit: 50
      }, 'v1/conversation/participants_list', conversation.inboxType ?? 0);
      const result = response.body?.participants?.participantsPage;
      if (!result) throw new Error('Douyin participants response has no page');
      for (const item of result.participants ?? []) members.set(item.userId, mapParticipant(item, groupId, conversation.ownerId));
      if (!result.hasMore) {
        const list = [...members.values()];
        await this.loadUsers(list);
        for (const member of list) member.nickname = this.users.get(member.userId)?.name;
        this.memberCache.set(groupId, { time: Date.now(), members: list });
        return list;
      }
      if (!result.cursor || result.cursor === cursor || seenCursors.has(result.cursor)) throw new Error('Douyin member pagination did not advance');
      seenCursors.add(cursor);
      cursor = result.cursor;
    }
    throw new Error('Douyin member pagination exceeded limit');
  }

  async resolveTarget(target: DouyinSendTarget): Promise<DouyinSendTarget> {
    if (target.type === 'group') {
      const id = target.conversationShortId ?? target.conversationId;
      if (!id) throw new Error('Missing group conversation ID');
      const conversation = await this.getGroupInfo(id);
      return { ...target, conversationId: conversation.id, conversationShortId: conversation.shortId, inboxType: conversation.inboxType };
    }
    await this.ensureFresh();
    const find = () => [...this.conversations.values()].find(item => item.type === 'private' && (
      target.conversationShortId ? item.shortId === target.conversationShortId :
      target.conversationId ? item.id === target.conversationId : item.peerUserId === target.userId
    ));
    let conversation = find();
    if (!conversation) { await this.refresh(); conversation = find(); }
    if (!conversation) throw new Error(`Private conversation not found for user ${target.userId}; no UID-to-conversation mapping is available`);
    return { ...target, conversationId: conversation.id, conversationShortId: conversation.shortId, inboxType: conversation.inboxType };
  }

  private async ensureFresh(): Promise<void> {
    if (!this.authenticated || Date.now() - this.refreshedAt > 30000) await this.refresh();
  }

  private async enrichConversations(conversations: DouyinConversation[]): Promise<void> {
    const members = conversations.flatMap(item => item.participants ?? []);
    await this.loadUsers(members);
    for (const conversation of conversations) {
      for (const member of conversation.participants ?? []) member.nickname = this.users.get(member.userId)?.name;
      if (conversation.type === 'private' && conversation.peerUserId) conversation.name = this.users.get(conversation.peerUserId)?.name ?? conversation.name;
    }
  }

  private async loadUsers(members: Array<{ userId: string; secUid?: string }>, noCache = false): Promise<void> {
    const missing = [...new Map(members.filter(item => item.secUid && (noCache || !this.users.get(item.userId)?.name)).map(item => [item.userId, item])).values()];
    for (let offset = 0; offset < missing.length; offset += 20) {
      const batch = missing.slice(offset, offset + 20);
      try {
        const result = await this.page.evaluate(async input => {
          const query = new URLSearchParams({ aid: '6383', device_platform: 'webapp', version_code: '170400', channel: 'channel_pc_web' });
          const response = await fetch(`/aweme/v1/web/im/user/info/?${query}`, {
            method: 'POST', credentials: 'include', signal: AbortSignal.timeout(input.timeoutMs),
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: new URLSearchParams({ sec_user_ids: JSON.stringify(input.ids) })
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json() as { status_code?: number; data?: Array<{ uid: string; sec_uid?: string; nickname?: string; avatar_thumb?: { url_list?: string[] } }> };
        }, { ids: batch.map(item => item.secUid), timeoutMs: this.timeoutMs });
        if (result.status_code !== 0 || !Array.isArray(result.data)) throw new Error(`User info status ${result.status_code}`);
        if (noCache && batch.some(item => !result.data?.some(user => user.uid === item.userId))) {
          throw new Error('Douyin user info response is missing a requested user');
        }
        for (const user of result.data) {
          if (!/^\d+$/.test(user.uid) || !batch.some(item => item.userId === user.uid)) continue;
          this.users.set(user.uid, { id: user.uid, secUid: user.sec_uid ?? batch.find(item => item.userId === user.uid)?.secUid, name: user.nickname, avatar: user.avatar_thumb?.url_list?.[0] });
        }
      } catch (error) {
        if (noCache) throw error;
        this.logger.warn({ error, count: batch.length }, 'could not enrich douyin user profiles; keeping real user IDs');
      }
    }
  }
}
