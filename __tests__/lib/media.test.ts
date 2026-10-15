import { NetworkError, ValidationError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import { ZaloOaApiClient } from "../../src/lib/api-client.js";
import {
  gifDimensions,
  MEDIA_LIMITS,
  mimeTypeForExtension,
  prepareMedia,
  toBuffer,
  uploadMedia,
} from "../../src/lib/media.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);

function gif(width: number, height: number, version = "GIF89a"): Buffer {
  const header = Buffer.alloc(13);
  header.write(version, 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

function padded(data: Buffer, size: number): Buffer {
  return Buffer.concat([data, Buffer.alloc(size - data.length)]);
}

describe("prepareMedia", () => {
  it.each([
    ["a PNG", PNG, "image", "image/png"],
    ["a JPEG", JPEG, "image", "image/jpeg"],
    ["a GIF", gif(10, 20), "gif", "image/gif"],
  ])("identifies %s by its bytes", (_label, data, kind, mimeType) => {
    expect(prepareMedia(data, "upload.bin")).toMatchObject({ kind, mimeType });
  });

  it("trusts the bytes over a misleading name and type", () => {
    // A JPEG named .png and declared as PNG is still a JPEG to Zalo.
    expect(prepareMedia(JPEG, "a.png", "image/png").mimeType).toBe("image/jpeg");
  });

  it.each([
    ["q3.pdf", "application/pdf"],
    ["memo.DOC", "application/msword"],
    ["memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["rows.csv", "text/csv"],
  ])("accepts the document %s as a file", (filename, mimeType) => {
    expect(prepareMedia(Buffer.from("content"), filename)).toMatchObject({
      kind: "file",
      mimeType,
    });
  });

  it.each([
    ["a WebP", Buffer.from("RIFF0000WEBPVP8 "), "a.webp", undefined],
    ["an image that merely claims to be a document", Buffer.from("RIFF"), "a.pdf", "image/webp"],
    ["an unsupported document", Buffer.from("x"), "a.xlsx", undefined],
    ["a file with no extension", Buffer.from("x"), "README", undefined],
  ])("refuses %s", (_label, data, filename, mimeType) => {
    expect(() => prepareMedia(data, filename, mimeType)).toThrow(ValidationError);
  });

  it("does not mistake an inherited name for a document type", () => {
    expect(() => prepareMedia(Buffer.from("x"), "a.constructor")).toThrow(ValidationError);
    expect(() => prepareMedia(Buffer.from("x"), "a.toString")).toThrow(ValidationError);
  });

  it("reads Zalo's 1MB and 5MB as decimal, the stricter reading", () => {
    expect(MEDIA_LIMITS).toEqual({ image: 1_000_000, gif: 5_000_000, file: 5_000_000 });
  });

  it("refuses an empty file", () => {
    expect(() => prepareMedia(Buffer.alloc(0), "a.pdf")).toThrow(/is empty/);
  });

  it.each([
    ["image", padded(PNG, MEDIA_LIMITS.image)],
    ["gif", padded(gif(1, 1), MEDIA_LIMITS.gif)],
    ["file", Buffer.alloc(MEDIA_LIMITS.file, 1)],
  ] as const)("accepts %s at exactly its limit and refuses one byte more", (kind, data) => {
    const name = kind === "file" ? "a.pdf" : "a.bin";
    expect(prepareMedia(data, name).kind).toBe(kind);
    expect(() => prepareMedia(Buffer.concat([data, Buffer.from([0])]), name)).toThrow(
      new RegExp(`at most ${MEDIA_LIMITS[kind]}`),
    );
  });

  it("records a GIF's dimensions", () => {
    expect(prepareMedia(gif(320, 240), "a.gif")).toMatchObject({ width: 320, height: 240 });
  });

  it("refuses a GIF whose size cannot be read", () => {
    expect(() => prepareMedia(gif(0, 240), "a.gif")).toThrow(/size of the GIF/);
  });
});

describe("gifDimensions", () => {
  it("reads both header versions", () => {
    expect(gifDimensions(gif(1, 2, "GIF87a"))).toEqual({ width: 1, height: 2 });
    expect(gifDimensions(gif(65535, 300))).toEqual({ width: 65535, height: 300 });
  });

  it("returns null for a truncated or foreign header", () => {
    expect(gifDimensions(gif(1, 1).subarray(0, 9))).toBeNull();
    expect(gifDimensions(PNG)).toBeNull();
  });
});

describe("toBuffer", () => {
  it("accepts a Buffer, an ArrayBuffer and a Blob", async () => {
    expect(await toBuffer(PNG)).toBe(PNG);
    expect(await toBuffer(new Uint8Array(PNG).buffer)).toEqual(PNG);
    expect(await toBuffer(new Blob([new Uint8Array(PNG)]))).toEqual(PNG);
  });

  it("returns null for anything else", async () => {
    expect(await toBuffer("text" as never)).toBeNull();
  });
});

describe("uploadMedia", () => {
  function client(data: unknown) {
    const fetchImpl = vi.fn(
      async () =>
        ({ status: 200, json: async () => ({ error: 0, message: "Success", data }) }) as Response,
    );
    const api = new ZaloOaApiClient({
      tokens: { getAccessToken: async () => "tok", refreshAccessToken: async () => "tok" },
      fetchImpl: fetchImpl as never,
    });
    return { api, fetchImpl };
  }

  it.each([
    ["image", PNG, "a.png", "image/png", "v2.0/oa/upload/image"],
    ["gif", gif(1, 1), "a.gif", "image/gif", "v2.0/oa/upload/gif"],
    ["file", Buffer.from("%PDF"), "a.pdf", "application/pdf", "v2.0/oa/upload/file"],
  ] as const)(
    "posts %s to its endpoint as the multipart field 'file'",
    async (_k, data, name, type, path) => {
      const { api, fetchImpl } = client({ attachment_id: "id", token: "id" });
      await uploadMedia(api, prepareMedia(data, name));

      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://openapi.zalo.me/${path}`);
      const file = (init.body as FormData).get("file") as File;
      expect(file.name).toBe(name);
      expect(file.type).toBe(type);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
    },
  );

  it("takes an image's attachment_id and a file's token", async () => {
    const both = { attachment_id: "att", token: "tok" };
    expect(await uploadMedia(client(both).api, prepareMedia(PNG, "a.png"))).toBe("att");
    expect(await uploadMedia(client(both).api, prepareMedia(Buffer.from("x"), "a.pdf"))).toBe(
      "tok",
    );
  });

  it("accepts a GIF's ID under either name, as its docs disagree", async () => {
    expect(await uploadMedia(client({ token: "t" }).api, prepareMedia(gif(1, 1), "a.gif"))).toBe(
      "t",
    );
    expect(
      await uploadMedia(client({ attachment_id: "a" }).api, prepareMedia(gif(1, 1), "a.gif")),
    ).toBe("a");
  });

  it("names a nameless upload so the multipart part is well formed", async () => {
    const { api, fetchImpl } = client({ attachment_id: "id" });
    await uploadMedia(api, prepareMedia(gif(1, 1), "  "));
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(((init.body as FormData).get("file") as File).name).toBe("image.gif");
  });

  it("maps document extensions to MIME types, case-insensitively", () => {
    expect(mimeTypeForExtension("PDF")).toBe("application/pdf");
    expect(mimeTypeForExtension("csv")).toBe("text/csv");
    expect(mimeTypeForExtension("exe")).toBeUndefined();
    expect(mimeTypeForExtension("constructor")).toBeUndefined();
    expect(mimeTypeForExtension(undefined)).toBeUndefined();
  });

  it("treats a success with no identifier as a failure", async () => {
    await expect(uploadMedia(client({}).api, prepareMedia(PNG, "a.png"))).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});
