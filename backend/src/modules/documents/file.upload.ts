import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { AppError } from '../../common/errors.js';

export const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Only document/scan formats. HTML, SVG, scripts etc. are rejected (stored-XSS risk).
const ALLOWED: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.txt': ['text/plain'],
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9-]/g, '_')
      .slice(0, 60);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}${ext}`);
  },
});

export const fileUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimes = ALLOWED[ext];
    // Some clients send application/octet-stream; accept it only when the extension is allowed
    if (mimes && (mimes.includes(file.mimetype) || file.mimetype === 'application/octet-stream')) {
      return cb(null, true);
    }
    cb(new AppError(`File type not allowed (${ext || 'no extension'}, ${file.mimetype}). Allowed: PDF, PNG, JPG, TXT.`, 400));
  },
});

/** Computes the SHA-256 of a stored upload (recorded on the Document for integrity). */
export function hashFile(filePath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}
