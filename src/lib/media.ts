import { NetworkError, ValidationError } from "@chat-adapter/shared";

import type { ZaloOaWebhookEvent } from "../types.js";
import type { ZaloOaApiClient } from "./api-client.js";
import { lookup } from "./lookup.js";
import { ADAPTER_NAME } from "./thread-id.js";

/** What Zalo can deliver as an outbound attachment, each through its own upload endpoint. */
export type ZaloOaMediaKind = "image" | "gif" | "file";

/**
 * Upload size limits, in bytes.
 *
 * Checked locally because each upload spends from a quota of 5,000 a month,
 * and Zalo's rejection of an oversized file does not say which rule broke.
 *
 * Zalo states "1MB" and "5MB" without saying which megabyte. The decimal
 * reading is the smaller, so a file this check passes is one Zalo accepts
 * under either; the binary reading would let through files up to 5% larger
 * that Zalo may refuse after the quota is spent.
 */
export const MEDIA_LIMITS: Readonly<Record<ZaloOaMediaKind, number>> = {
  image: 1_000_000,
  gif: 5_000_000,
  file: 5_000_000,
};

const UPLOAD_PATHS: Readonly<Record<ZaloOaMediaKind, string>> = {
  image: "v2.0/oa/upload/image",
  gif: "v2.0/oa/upload/gif",
  file: "v2.0/oa/upload/file",
};

/** Documents Zalo accepts, by extension. */
export const FILE_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

const KIND_LABELS: Readonly<Record<ZaloOaMediaKind, string>> = {
  image: "an image",
  gif: "a GIF",
  file: "a file",
};

const SUPPORTED_DESCRIPTION = "JPG or PNG images, GIFs, and PDF, DOC, DOCX or CSV files";

export interface PreparedMedia {
  kind: ZaloOaMediaKind;
  data: Buffer;
  filename: string;
  mimeType: string;
  /** Required by Zalo when sending a GIF. */
  width?: number;
  height?: number;
}

/** Normalize the binary forms a Chat SDK `FileUpload` may carry. */
export async function toBuffer(data: Buffer | Blob | ArrayBuffer): Promise<Buffer | null> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  return null;
}

function startsWith(data: Buffer, signature: number[]): boolean {
  return data.length >= signature.length && signature.every((byte, i) => data[i] === byte);
}

/** The image format the bytes actually hold, regardless of what the name claims. */
function sniffImage(data: Buffer): "image/png" | "image/jpeg" | "image/gif" | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  return null;
}

/**
 * Read a GIF's logical screen size from its header.
 *
 * Zalo requires both for a GIF message, and the caller has no other way to
 * know them.
 */
export function gifDimensions(data: Buffer): { width: number; height: number } | null {
  const header = data.subarray(0, 6).toString("latin1");
  if ((header !== "GIF87a" && header !== "GIF89a") || data.length < 10) {
    return null;
  }
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The MIME type for a document extension Zalo reports, such as `"docx"`. */
export function mimeTypeForExtension(extension: string | undefined): string | undefined {
  return extension ? lookup(FILE_TYPES, extension.toLowerCase()) : undefined;
}

const DEFAULT_FILENAMES: Readonly<Record<ZaloOaMediaKind, string>> = {
  image: "image",
  gif: "image.gif",
  file: "file",
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Decide how a file must be sent, and check it against Zalo's limits.
 *
 * Images are identified by their bytes, not their name or declared type:
 * a WebP named `photo.png` would pass a name check and then be refused by
 * Zalo with an unhelpful error, after spending an upload.
 */
export function prepareMedia(data: Buffer, filename: string, mimeType?: string): PreparedMedia {
  if (data.length === 0) {
    throw new ValidationError(ADAPTER_NAME, `"${filename}" is empty.`);
  }

  const sniffed = sniffImage(data);
  let kind: ZaloOaMediaKind;
  let type: string;

  if (sniffed === "image/gif") {
    kind = "gif";
    type = sniffed;
  } else if (sniffed) {
    kind = "image";
    type = sniffed;
  } else {
    const fileType = lookup(FILE_TYPES, extensionOf(filename));
    const declared = mimeType?.toLowerCase();
    if (!fileType || declared?.startsWith("image/")) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Zalo OA can send ${SUPPORTED_DESCRIPTION}; "${filename}" is none of these.`,
      );
    }
    kind = "file";
    type = fileType;
  }

  if (data.length > MEDIA_LIMITS[kind]) {
    throw new ValidationError(
      ADAPTER_NAME,
      `"${filename}" is ${data.length} bytes; Zalo allows at most ${MEDIA_LIMITS[kind]} for ${KIND_LABELS[kind]}.`,
    );
  }

  const prepared: PreparedMedia = { kind, data, filename, mimeType: type };
  if (kind === "gif") {
    const size = gifDimensions(data);
    if (!size) {
      throw new ValidationError(ADAPTER_NAME, `Could not read the size of the GIF "${filename}".`);
    }
    prepared.width = size.width;
    prepared.height = size.height;
  }
  return prepared;
}

/**
 * Upload prepared media and return the identifier a message refers to it by.
 *
 * Images and GIFs come back as an `attachment_id`, files as a `token`. The
 * GIF endpoint's documentation disagrees with itself about which, so either
 * is accepted from every endpoint. Uploads are kept by Zalo for seven days.
 */
export async function uploadMedia(client: ZaloOaApiClient, media: PreparedMedia): Promise<string> {
  const form = new FormData();
  // A nameless part is a malformed multipart field to some servers, so a
  // missing filename gets a generic one.
  form.set(
    "file",
    new Blob([new Uint8Array(media.data)], { type: media.mimeType }),
    media.filename.trim() || DEFAULT_FILENAMES[media.kind],
  );

  const data = await client.request<{ attachment_id?: string; token?: string }>({
    method: "POST",
    path: UPLOAD_PATHS[media.kind],
    formData: form,
  });

  const id =
    media.kind === "file"
      ? (data?.token ?? data?.attachment_id)
      : (data?.attachment_id ?? data?.token);
  if (!id) {
    throw new NetworkError(
      ADAPTER_NAME,
      `Zalo accepted the ${media.kind} upload but returned no identifier for it.`,
    );
  }
  return id;
}

/**
 * The ID of the sticker a user sent, for sending the same one back with
 * `sendSticker()`.
 *
 * Read from the raw webhook payload, since a Chat SDK attachment has nowhere
 * to carry it. History entries record a sticker's image but not its ID, so
 * they yield `undefined`.
 */
export function getStickerId(raw: unknown): string | undefined {
  // `unknown` because that is what a Chat SDK handler holds in `message.raw`;
  // the shape is checked here instead of asking every caller to cast.
  if (!raw || typeof raw !== "object" || !("event_name" in raw)) {
    return undefined;
  }
  const event = raw as ZaloOaWebhookEvent;
  const attachments = Array.isArray(event.message?.attachments) ? event.message.attachments : [];
  const sticker = attachments.find((attachment) => attachment?.type === "sticker");
  const id = sticker?.payload?.id;
  return typeof id === "string" && id ? id : undefined;
}
