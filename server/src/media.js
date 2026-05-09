import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { PUBLIC_BASE_URL } from './common/config.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');

export const AVATAR_SUBDIR = 'avatars';
export const MEDIA_SUBDIR = 'media';
export const TMP_SUBDIR = 'tmp';

export function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

ensureDirSync(UPLOAD_DIR);
ensureDirSync(path.join(UPLOAD_DIR, AVATAR_SUBDIR));
ensureDirSync(path.join(UPLOAD_DIR, MEDIA_SUBDIR));
ensureDirSync(path.join(UPLOAD_DIR, TMP_SUBDIR));

export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.AVATAR_MAX_BYTES || 2_000_000) },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(file.mimetype || '').toLowerCase());
    cb(ok ? null : new Error('bad_avatar_mime'), ok);
  },
});

export const mediaUpload = multer({
  dest: path.join(UPLOAD_DIR, TMP_SUBDIR),
  limits: { fileSize: Number(process.env.MEDIA_MAX_BYTES || 15_000_000) },
});

function absUrl(relativePath) {
  if (!PUBLIC_BASE_URL) return relativePath;
  return `${PUBLIC_BASE_URL}${relativePath}`;
}

function extFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase().slice(1);
  return (ext && ext.length <= 12) ? ext : '';
}

export function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return '';
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function localUploadPathFromUrl(urlPath) {
  const rel = String(urlPath || '').replace(/^\/uploads\//, '');
  const full = path.resolve(UPLOAD_DIR, rel);
  if (!full.startsWith(UPLOAD_DIR + path.sep) && full !== UPLOAD_DIR) return null;
  return full;
}

export function safeUnlinkIfLocal(urlPath) {
  try {
    if (!urlPath || !String(urlPath).startsWith('/uploads/')) return;
    const full = localUploadPathFromUrl(urlPath);
    if (!full) return;
    fs.unlinkSync(full);
  } catch (_) {}
}

export async function finalizeMediaUpload({ tmpPath, originalName, mime, size: _size, userId, channelId }) {
  const mimeLc = String(mime || '').toLowerCase();
  const isImage = mimeLc.startsWith('image/');
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');

  const baseDir = path.join(UPLOAD_DIR, MEDIA_SUBDIR, yyyy, mm);
  ensureDirSync(baseDir);

  const id = crypto.randomBytes(16).toString('hex');

  try {
    const inBuf = await fs.promises.readFile(tmpPath);

    let outBuf = inBuf;
    let outMime = mimeLc || 'application/octet-stream';
    let outExt = extFromName(originalName) || mimeToExt(outMime) || 'bin';
    let width = null;
    let height = null;

    if (isImage && mimeLc !== 'image/svg+xml') {
      try {
        const img = sharp(inBuf, { animated: true });
        const meta = await img.metadata();
        if (meta && meta.width) width = meta.width;
        if (meta && meta.height) height = meta.height;

        const maxSide = Number(process.env.MEDIA_IMAGE_MAX_SIDE || 2048);
        const needResize = (meta?.width && meta?.height) ? (meta.width > maxSide || meta.height > maxSide) : false;
        const q = Number(process.env.MEDIA_WEBP_QUALITY || 82);

        let pipeline = sharp(inBuf, { animated: true });
        if (needResize) {
          pipeline = pipeline.resize({
            width: maxSide,
            height: maxSide,
            fit: 'inside',
            withoutEnlargement: true,
          });
        }

        outBuf = await pipeline.webp({ quality: q, effort: 4 }).toBuffer();
        outMime = 'image/webp';
        outExt = 'webp';

        const meta2 = await sharp(outBuf, { animated: true }).metadata();
        if (meta2?.width) width = meta2.width;
        if (meta2?.height) height = meta2.height;
      } catch (_) {
      }
    }

    const filename = `${Date.now()}_${id}.${outExt}`;
    const finalPath = path.join(baseDir, filename);

    await fs.promises.writeFile(finalPath, outBuf);

    const rel = `/uploads/${MEDIA_SUBDIR}/${yyyy}/${mm}/${filename}`;
    const url = absUrl(rel);

    return {
      ok: true,
      media: {
        url,
        rel,
        filename,
        originalName: String(originalName || ''),
        mime: outMime,
        size: outBuf.length,
        width,
        height,
        channelId,
        uploadedBy: userId,
      },
    };
  } catch (e) {
    return { ok: false, status: 500, error: 'upload_failed', details: String(e?.message || e) };
  } finally {
    safeUnlink(tmpPath);
  }
}
