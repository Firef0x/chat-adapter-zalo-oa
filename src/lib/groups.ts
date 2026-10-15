import { ValidationError } from "@chat-adapter/shared";
import type { Logger } from "chat";

import type {
  ZaloOaGroupAsset,
  ZaloOaGroupDetail,
  ZaloOaGroupMember,
  ZaloOaGroupPage,
  ZaloOaGroupSettings,
  ZaloOaGroupSummary,
} from "../types.js";
import type { ZaloOaApiClient } from "./api-client.js";
import { ADAPTER_NAME, decodeThreadId, encodeThreadId } from "./thread-id.js";

/** Zalo documents a default of five per page and no maximum. */
const DEFAULT_PAGE_SIZE = 5;

/** A group holds at most this many members, including the OA's admin. */
const MAX_MEMBERS = 99;

/** The settings `updateinfo` takes, and the only patch keys forwarded as they are. */
const SETTING_KEYS: ReadonlyArray<keyof ZaloOaGroupSettings> = [
  "lock_send_msg",
  "join_appr",
  "enable_msg_history",
  "enable_link_join",
];

export interface CreateGroupOptions {
  name: string;
  description?: string;
  /** A GMF package from {@link ZaloOaGroups.listAssets} with `status: "available"`. */
  assetId: string;
  /**
   * One to 99 users to add. At least one must be an admin of the OA, and
   * each must follow the OA or have interacted with it in the last 7 days.
   */
  memberUserIds: string[];
}

export interface GroupPageOptions {
  offset?: number;
  /** Defaults to 5, the size Zalo documents. */
  count?: number;
}

export interface UpdateGroupOptions extends ZaloOaGroupSettings {
  name?: string;
  description?: string;
  /** A URL. */
  avatar?: string;
}

/** The groups endpoints accept whole non-negative pages. */
function page(options: GroupPageOptions | undefined): { offset: number; count: number } {
  const offset = options?.offset ?? 0;
  const count = options?.count ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError(ADAPTER_NAME, `Invalid group page offset: ${offset}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(ADAPTER_NAME, `Invalid group page size: ${count}`);
  }
  return { offset, count };
}

function userIds(values: string[], what: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ValidationError(ADAPTER_NAME, `At least one user ID is required to ${what}.`);
  }
  const ids = values.map((value) => String(value ?? "").trim());
  if (ids.some((id) => !id)) {
    throw new ValidationError(ADAPTER_NAME, `Every user ID to ${what} must be non-empty.`);
  }
  return ids;
}

/**
 * Management of the OA's GMF group chats.
 *
 * Reached as `adapter.groups`. Every method takes or returns Chat SDK thread
 * IDs, so a host never handles a bare group ID; and every one requires the
 * app's "manage group information" permission.
 */
export class ZaloOaGroups {
  constructor(
    private readonly api: ZaloOaApiClient,
    private readonly oaId: string,
    /** Resolved on each use, since the adapter swaps its logger in initialize(). */
    private readonly logger: () => Logger,
  ) {}

  /** The group behind a thread, after checking the thread is one of this OA's groups. */
  private groupIdOf(threadId: string): string {
    const target = decodeThreadId(threadId);
    if (target.oaId !== this.oaId) {
      throw new ValidationError(
        ADAPTER_NAME,
        `This adapter is connected to a different Official Account than ${threadId}.`,
      );
    }
    if (target.type !== "group") {
      throw new ValidationError(ADAPTER_NAME, `${threadId} is not a group thread.`);
    }
    return target.id;
  }

  threadIdOf(groupId: string): string {
    return encodeThreadId({ oaId: this.oaId, type: "group", id: groupId });
  }

  /**
   * The GMF packages the OA holds, used or available.
   *
   * A group runs on a package: creating one needs an `asset_id` with
   * `status: "available"`, and renewing one needs another.
   */
  async listAssets(options?: {
    /** Whose packages: the OA's (default) or the calling app's. */
    owner?: "OA" | "APP";
    productType?: "gmf10" | "gmf50" | "gmf100";
    quotaType?: "sub_quota" | "purchase_quota" | "reward_quota";
  }): Promise<ZaloOaGroupAsset[]> {
    const data = await this.api.request<ZaloOaGroupAsset[]>({
      method: "POST",
      path: "v3.0/oa/quota/group",
      body: {
        quota_owner: options?.owner ?? "OA",
        ...(options?.productType ? { product_type: options.productType } : {}),
        ...(options?.quotaType ? { quota_type: options.quotaType } : {}),
      },
    });
    return Array.isArray(data) ? data : [];
  }

  /** Create a group the OA owns, and return its thread. */
  async create(
    options: CreateGroupOptions,
  ): Promise<{ threadId: string; group: ZaloOaGroupInfoLike }> {
    const name = String(options.name ?? "").trim();
    if (!name) {
      throw new ValidationError(ADAPTER_NAME, "A group name is required.");
    }
    const assetId = String(options.assetId ?? "").trim();
    if (!assetId) {
      throw new ValidationError(
        ADAPTER_NAME,
        "An asset ID is required to create a group; take one from listAssets().",
      );
    }
    const members = userIds(options.memberUserIds, "create a group");
    if (members.length > MAX_MEMBERS) {
      throw new ValidationError(
        ADAPTER_NAME,
        `A group takes at most ${MAX_MEMBERS} members at creation; got ${members.length}.`,
      );
    }

    const group = await this.api.request<ZaloOaGroupInfoLike>({
      method: "POST",
      path: "v3.0/oa/group/creategroupwithoa",
      body: {
        group_name: name,
        ...(options.description !== undefined ? { group_description: options.description } : {}),
        asset_id: assetId,
        member_user_ids: members,
      },
    });
    const groupId = String(group?.group_id ?? "");
    if (!groupId) {
      throw new ValidationError(ADAPTER_NAME, "Zalo created the group but returned no group_id.");
    }
    return { threadId: this.threadIdOf(groupId), group };
  }

  /** The groups the OA manages, as threads. */
  async list(
    options?: GroupPageOptions,
  ): Promise<ZaloOaGroupPage<ZaloOaGroupSummary & { threadId: string }>> {
    const { offset, count } = page(options);
    const data = await this.api.request<{ total?: number; groups?: ZaloOaGroupSummary[] }>({
      method: "GET",
      path: "v3.0/oa/group/getgroupsofoa",
      query: { offset, count },
    });
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const items: Array<ZaloOaGroupSummary & { threadId: string }> = [];
    for (const group of groups) {
      // `String(undefined)` is "undefined", a valid-looking segment that
      // would become a thread ID nothing can ever be sent to.
      const groupId = typeof group?.group_id === "string" ? group.group_id : "";
      if (!groupId) {
        this.logger().warn("Skipping a Zalo OA group listing entry with no group_id", { group });
        continue;
      }
      items.push({ ...group, threadId: this.threadIdOf(groupId) });
    }
    return { items, total: Number(data?.total ?? groups.length) };
  }

  async get(threadId: string): Promise<ZaloOaGroupDetail> {
    return this.api.request<ZaloOaGroupDetail>({
      method: "GET",
      path: "v3.0/oa/group/getgroup",
      query: { group_id: this.groupIdOf(threadId) },
    });
  }

  async update(threadId: string, patch: UpdateGroupOptions): Promise<ZaloOaGroupDetail> {
    const { name, description, avatar } = patch;
    const body: Record<string, unknown> = { group_id: this.groupIdOf(threadId) };
    // Only the known settings are copied: spreading the rest of the patch
    // would let a stray `group_id` in it retarget the update. An explicit
    // `undefined` would be dropped by JSON anyway, so it must not count as
    // something to update.
    for (const key of SETTING_KEYS) {
      if (patch[key] !== undefined) body[key] = patch[key];
    }
    if (name !== undefined) body.group_name = name;
    if (description !== undefined) body.group_description = description;
    if (avatar !== undefined) body.group_avatar = avatar;
    if (Object.keys(body).length === 1) {
      throw new ValidationError(ADAPTER_NAME, "Nothing to update: the patch is empty.");
    }
    return this.api.request<ZaloOaGroupDetail>({
      method: "POST",
      path: "v3.0/oa/group/updateinfo",
      body,
    });
  }

  /**
   * Move the group onto another package: a larger one, or a fresh one when
   * the current one expired. An unrenewed group is dissolved after 45 days.
   */
  async renew(threadId: string, assetId: string): Promise<ZaloOaGroupDetail> {
    const id = String(assetId ?? "").trim();
    if (!id) {
      throw new ValidationError(ADAPTER_NAME, "An asset ID is required to renew a group.");
    }
    return this.api.request<ZaloOaGroupDetail>({
      method: "POST",
      path: "v3.0/oa/group/updateasset",
      body: { group_id: this.groupIdOf(threadId), asset_id: id },
    });
  }

  /** Dissolve the group. Irreversible. */
  async delete(threadId: string): Promise<void> {
    await this.api.request({
      method: "POST",
      path: "v3.0/oa/group/delete",
      body: { group_id: this.groupIdOf(threadId) },
    });
  }

  async listMembers(
    threadId: string,
    options?: GroupPageOptions,
  ): Promise<ZaloOaGroupPage<ZaloOaGroupMember>> {
    return this.memberPage("v3.0/oa/group/listmember", threadId, options);
  }

  /** Users who asked to join and await approval. */
  async listPendingMembers(
    threadId: string,
    options?: GroupPageOptions,
  ): Promise<ZaloOaGroupPage<ZaloOaGroupMember>> {
    return this.memberPage("v3.0/oa/group/listpendinginvite", threadId, options);
  }

  private async memberPage(
    path: string,
    threadId: string,
    options: GroupPageOptions | undefined,
  ): Promise<ZaloOaGroupPage<ZaloOaGroupMember>> {
    const { offset, count } = page(options);
    const data = await this.api.request<{ total?: number; members?: ZaloOaGroupMember[] }>({
      method: "GET",
      path,
      query: { group_id: this.groupIdOf(threadId), offset, count },
    });
    const members = Array.isArray(data?.members) ? data.members : [];
    return { items: members, total: Number(data?.total ?? members.length) };
  }

  /** Invite users. Each must follow the OA or have interacted with it in the last 7 days. */
  async invite(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/invite", threadId, memberUserIds, "invite");
  }

  async remove(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/removemembers", threadId, memberUserIds, "remove");
  }

  async accept(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/acceptpendinginvite", threadId, memberUserIds, "accept");
  }

  async reject(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/rejectpendinginvite", threadId, memberUserIds, "reject");
  }

  /** Make members deputy admins of the group. */
  async addAdmins(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/addadmins", threadId, memberUserIds, "promote");
  }

  async removeAdmins(threadId: string, memberUserIds: string[]): Promise<void> {
    await this.members("v3.0/oa/group/removeadmins", threadId, memberUserIds, "demote");
  }

  private async members(
    path: string,
    threadId: string,
    memberUserIds: string[],
    what: string,
  ): Promise<void> {
    await this.api.request({
      method: "POST",
      path,
      body: { group_id: this.groupIdOf(threadId), member_user_ids: userIds(memberUserIds, what) },
    });
  }
}

/** The creation endpoint's `data`: a group summary with the fields it reports. */
export type ZaloOaGroupInfoLike = ZaloOaGroupSummary & { total_member?: number | string };
