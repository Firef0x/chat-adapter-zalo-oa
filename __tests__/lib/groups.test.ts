import { ValidationError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import { ZaloOaApiClient } from "../../src/lib/api-client.js";
import { ZaloOaGroups } from "../../src/lib/groups.js";

const OA_ID = "607812198688816074";
const GROUP_ID = "f414c8f76fa586fbdfb4";
const GROUP_THREAD = `zalo-oa:${OA_ID}:group:${GROUP_ID}`;

function ok(data: unknown = {}) {
  return { status: 200, json: async () => ({ error: 0, message: "Success", data }) } as Response;
}

function build(fetchImpl = vi.fn(async () => ok())) {
  const api = new ZaloOaApiClient({
    tokens: { getAccessToken: async () => "tok", refreshAccessToken: async () => "tok" },
    fetchImpl: fetchImpl as never,
  });
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { groups: new ZaloOaGroups(api, OA_ID, () => logger as never), fetchImpl, logger };
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe("ZaloOaGroups", () => {
  describe("assets", () => {
    it("asks for the OA's packages by default", async () => {
      const assets = [{ product_type: "gmf10", asset_id: "a1", status: "available" }];
      const { groups, fetchImpl } = build(vi.fn(async () => ok(assets)));
      await expect(groups.listAssets()).resolves.toEqual(assets);
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/quota/group");
      expect(body).toEqual({ quota_owner: "OA" });
    });

    it("forwards the filters it is given", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok([])));
      await groups.listAssets({ owner: "APP", productType: "gmf50", quotaType: "purchase_quota" });
      expect(lastCall(fetchImpl).body).toEqual({
        quota_owner: "APP",
        product_type: "gmf50",
        quota_type: "purchase_quota",
      });
    });

    it("returns an empty list for a non-array payload", async () => {
      const { groups } = build(vi.fn(async () => ok({})));
      await expect(groups.listAssets()).resolves.toEqual([]);
    });
  });

  describe("create", () => {
    it("creates a group and returns its thread", async () => {
      const created = {
        group_id: GROUP_ID,
        name: "b52",
        status: "enabled",
        group_link: "https://zalo.me/g/x",
      };
      const { groups, fetchImpl } = build(vi.fn(async () => ok(created)));

      const result = await groups.create({
        name: "b52",
        description: "support",
        assetId: "a1",
        memberUserIds: ["1", "2"],
      });

      expect(result).toEqual({ threadId: GROUP_THREAD, group: created });
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/creategroupwithoa");
      expect(body).toEqual({
        group_name: "b52",
        group_description: "support",
        asset_id: "a1",
        member_user_ids: ["1", "2"],
      });
    });

    it("omits the description when none is given", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ group_id: GROUP_ID })));
      await groups.create({ name: "x", assetId: "a", memberUserIds: ["1"] });
      expect(lastCall(fetchImpl).body).not.toHaveProperty("group_description");
    });

    it.each([
      ["an empty name", { name: " ", assetId: "a", memberUserIds: ["1"] }],
      ["no asset", { name: "x", assetId: "", memberUserIds: ["1"] }],
      ["no members", { name: "x", assetId: "a", memberUserIds: [] }],
      ["a blank member", { name: "x", assetId: "a", memberUserIds: ["1", " "] }],
      ["a hundred members", { name: "x", assetId: "a", memberUserIds: Array(100).fill("1") }],
    ])("refuses %s before sending", async (_label, options) => {
      const { groups, fetchImpl } = build();
      await expect(groups.create(options)).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("accepts exactly 99 members", async () => {
      const { groups } = build(vi.fn(async () => ok({ group_id: GROUP_ID })));
      await expect(
        groups.create({ name: "x", assetId: "a", memberUserIds: Array(99).fill("1") }),
      ).resolves.toBeDefined();
    });

    it("fails when Zalo reports success without a group ID", async () => {
      const { groups } = build(vi.fn(async () => ok({ name: "x" })));
      await expect(
        groups.create({ name: "x", assetId: "a", memberUserIds: ["1"] }),
      ).rejects.toThrow(/no group_id/);
    });
  });

  describe("listing", () => {
    it("lists the OA's groups as threads with the total", async () => {
      const { groups, fetchImpl } = build(
        vi.fn(async () =>
          ok({ total: 7, groups: [{ group_id: GROUP_ID, name: "a", status: "enabled" }] }),
        ),
      );
      const result = await groups.list({ offset: 5, count: 10 });

      const { url } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/getgroupsofoa");
      expect(Object.fromEntries(url.searchParams)).toEqual({ offset: "5", count: "10" });
      expect(result).toEqual({
        items: [{ group_id: GROUP_ID, name: "a", status: "enabled", threadId: GROUP_THREAD }],
        total: 7,
      });
    });

    it("pages five at a time by default and falls back to the page length as total", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ groups: [{ group_id: "1" }] })));
      const result = await groups.list();
      expect(Object.fromEntries(lastCall(fetchImpl).url.searchParams)).toEqual({
        offset: "0",
        count: "5",
      });
      expect(result.total).toBe(1);
    });

    it("skips a listing entry with no group_id instead of inventing a thread", async () => {
      const { groups, logger } = build(
        vi.fn(async () => ok({ total: 2, groups: [{ name: "lost" }, { group_id: GROUP_ID }] })),
      );
      const result = await groups.list();
      expect(result.items.map((item) => item.threadId)).toEqual([GROUP_THREAD]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Skipping a Zalo OA group listing entry with no group_id",
        { group: { name: "lost" } },
      );
    });

    it.each([{ offset: -1 }, { offset: 1.5 }, { count: 0 }, { count: Number.NaN }])(
      "refuses the page %o",
      async (options) => {
        const { groups, fetchImpl } = build();
        await expect(groups.list(options)).rejects.toBeInstanceOf(ValidationError);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("reads group info", async () => {
      const detail = { group_info: { group_id: GROUP_ID, name: "a", status: "enabled" } };
      const { groups, fetchImpl } = build(vi.fn(async () => ok(detail)));
      await expect(groups.get(GROUP_THREAD)).resolves.toEqual(detail);
      const { url } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/getgroup");
      expect(url.searchParams.get("group_id")).toBe(GROUP_ID);
    });

    it("lists members and pending members with their totals", async () => {
      const members = [
        { oa_id: OA_ID, name: "OA" },
        { user_id: "7", name: "P" },
      ];
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ total: 2, members })));

      await expect(groups.listMembers(GROUP_THREAD, { count: 2 })).resolves.toEqual({
        items: members,
        total: 2,
      });
      expect(lastCall(fetchImpl).url.pathname).toBe("/v3.0/oa/group/listmember");
      expect(Object.fromEntries(lastCall(fetchImpl).url.searchParams)).toEqual({
        group_id: GROUP_ID,
        offset: "0",
        count: "2",
      });

      await groups.listPendingMembers(GROUP_THREAD);
      expect(lastCall(fetchImpl).url.pathname).toBe("/v3.0/oa/group/listpendinginvite");
    });
  });

  describe("updates", () => {
    it("renames the group and changes its settings in one call", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ group_info: {} })));
      await groups.update(GROUP_THREAD, {
        name: "new",
        description: "d",
        avatar: "https://x/a.png",
        lock_send_msg: true,
        join_appr: false,
      });
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/updateinfo");
      expect(body).toEqual({
        group_id: GROUP_ID,
        group_name: "new",
        group_description: "d",
        group_avatar: "https://x/a.png",
        lock_send_msg: true,
        join_appr: false,
      });
    });

    it("forwards only the known settings, so a stray group_id cannot retarget the update", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ group_info: {} })));
      await groups.update(GROUP_THREAD, {
        join_appr: true,
        group_id: "other",
        extra: 1,
      } as never);
      expect(lastCall(fetchImpl).body).toEqual({ group_id: GROUP_ID, join_appr: true });
    });

    it("refuses an empty patch, including one of only undefined values", async () => {
      const { groups, fetchImpl } = build();
      await expect(groups.update(GROUP_THREAD, {})).rejects.toThrow(/empty/);
      await expect(
        groups.update(GROUP_THREAD, { lock_send_msg: undefined, name: undefined }),
      ).rejects.toThrow(/empty/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("renews onto another asset", async () => {
      const { groups, fetchImpl } = build(vi.fn(async () => ok({ group_info: {} })));
      await groups.renew(GROUP_THREAD, "a2");
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/updateasset");
      expect(body).toEqual({ group_id: GROUP_ID, asset_id: "a2" });
      await expect(groups.renew(GROUP_THREAD, " ")).rejects.toBeInstanceOf(ValidationError);
    });

    it("dissolves the group", async () => {
      const { groups, fetchImpl } = build();
      await groups.delete(GROUP_THREAD);
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/delete");
      expect(body).toEqual({ group_id: GROUP_ID });
    });
  });

  describe("members", () => {
    it.each([
      ["invite", "/v3.0/oa/group/invite"],
      ["remove", "/v3.0/oa/group/removemembers"],
      ["accept", "/v3.0/oa/group/acceptpendinginvite"],
      ["reject", "/v3.0/oa/group/rejectpendinginvite"],
      ["addAdmins", "/v3.0/oa/group/addadmins"],
      ["removeAdmins", "/v3.0/oa/group/removeadmins"],
    ] as const)("%s posts the member IDs to %s", async (method, path) => {
      const { groups, fetchImpl } = build();
      await groups[method](GROUP_THREAD, ["1", " 2 "]);
      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe(path);
      expect(body).toEqual({ group_id: GROUP_ID, member_user_ids: ["1", "2"] });
    });

    it.each([[], [""], ["1", " "]])("refuses the member list %j", async (ids) => {
      const { groups, fetchImpl } = build();
      await expect(groups.invite(GROUP_THREAD, ids)).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("thread checks", () => {
    it.each([
      ["a user thread", `zalo-oa:${OA_ID}:user:7`],
      ["another OA's group", `zalo-oa:1:group:${GROUP_ID}`],
      ["a malformed ID", "nope"],
    ])("refuses %s without a request", async (_label, threadId) => {
      const { groups, fetchImpl } = build();
      await expect(groups.get(threadId)).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("builds a group thread ID", () => {
      const { groups } = build();
      expect(groups.threadIdOf(GROUP_ID)).toBe(GROUP_THREAD);
    });
  });
});
