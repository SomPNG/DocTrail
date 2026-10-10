import fs from 'fs';
import path from 'path';

const src = path.resolve('frontend/dist');
const dest = path.resolve('backend/public');

if (fs.existsSync(src)) {
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`Synced ${src} -> ${dest}`);
}
