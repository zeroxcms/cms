// ============================================================
// Media upload validation and serving headers.
//
// Uploads are restricted to an extension allowlist with MIME
// consistency checks and (for images/pdf) magic-byte sniffing.
// The canonical MIME from the allowlist is always stored — never
// the client-supplied Content-Type. Script-capable formats
// (html, svg, xml) are rejected outright.
// ============================================================

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

interface AllowedType {
  /** Canonical MIME type stored in R2 and served back. */
  contentType: string;
  /** Additional client-supplied MIME values accepted for this extension. */
  mimes: string[];
  /** Served inline (images/video/audio); otherwise forced to download. */
  inline: boolean;
  /** Optional magic-byte validator over the first 16 bytes. */
  magic?: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const isJpeg = (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff]);
const isPng = (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
const isGif = (b: Uint8Array) => startsWith(b, [0x47, 0x49, 0x46, 0x38]);
const isWebp = (b: Uint8Array) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
const isIsoMedia = (b: Uint8Array) => startsWith(b, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp
const isPdf = (b: Uint8Array) => startsWith(b, [0x25, 0x50, 0x44, 0x46]); // %PDF

export const ALLOWED_UPLOAD_TYPES: Record<string, AllowedType> = {
  jpg: { contentType: 'image/jpeg', mimes: ['image/jpeg'], inline: true, magic: isJpeg },
  jpeg: { contentType: 'image/jpeg', mimes: ['image/jpeg'], inline: true, magic: isJpeg },
  png: { contentType: 'image/png', mimes: ['image/png'], inline: true, magic: isPng },
  gif: { contentType: 'image/gif', mimes: ['image/gif'], inline: true, magic: isGif },
  webp: { contentType: 'image/webp', mimes: ['image/webp'], inline: true, magic: isWebp },
  avif: { contentType: 'image/avif', mimes: ['image/avif'], inline: true, magic: isIsoMedia },
  mp4: { contentType: 'video/mp4', mimes: ['video/mp4'], inline: true, magic: isIsoMedia },
  webm: { contentType: 'video/webm', mimes: ['video/webm'], inline: true },
  mp3: { contentType: 'audio/mpeg', mimes: ['audio/mpeg', 'audio/mp3'], inline: true },
  pdf: { contentType: 'application/pdf', mimes: ['application/pdf'], inline: false, magic: isPdf },
  csv: { contentType: 'text/csv', mimes: ['text/csv', 'application/vnd.ms-excel'], inline: false },
  txt: { contentType: 'text/plain', mimes: ['text/plain'], inline: false },
  zip: { contentType: 'application/zip', mimes: ['application/zip', 'application/x-zip-compressed'], inline: false },
  woff2: { contentType: 'font/woff2', mimes: ['font/woff2'], inline: false },
};

export type UploadValidation =
  | { ok: true; extension: string; contentType: string }
  | { ok: false; error: string; status: 413 | 415 };

/** Validate an upload against size, extension allowlist, MIME consistency and magic bytes. */
export function validateUpload(file: File, headerBytes: Uint8Array): UploadValidation {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'file_too_large', status: 413 };
  }

  const extension = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const allowed = ALLOWED_UPLOAD_TYPES[extension];
  if (!allowed) {
    return { ok: false, error: 'file_type_not_allowed', status: 415 };
  }

  const declaredType = file.type.split(';')[0].trim().toLowerCase();
  if (declaredType && !allowed.mimes.includes(declaredType)) {
    return { ok: false, error: 'content_type_mismatch', status: 415 };
  }

  if (allowed.magic && !allowed.magic(headerBytes)) {
    return { ok: false, error: 'file_content_mismatch', status: 415 };
  }

  return { ok: true, extension, contentType: allowed.contentType };
}

const INLINE_CONTENT_TYPES = new Set(
  Object.values(ALLOWED_UPLOAD_TYPES).filter((t) => t.inline).map((t) => t.contentType),
);

/**
 * Headers for serving media from R2. Every object gets a sandboxing CSP so
 * nothing stored in the bucket can ever execute on the CMS origin; types not
 * known to be inline-safe are additionally forced to download.
 */
export function applyMediaResponseHeaders(headers: Headers, key: string): void {
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  const contentType = headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  const inlineSafe = (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
    || INLINE_CONTENT_TYPES.has(contentType);
  if (!inlineSafe) {
    const filename = key.split('/').pop() ?? 'download';
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }
}
