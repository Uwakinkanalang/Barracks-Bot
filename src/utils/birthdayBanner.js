import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const bannerPath = fileURLToPath(new URL('../../birthday-banner.png', import.meta.url));

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

export async function createBirthdayBanner(displayName) {
  const source = await readFile(bannerPath);
  const metadata = await sharp(source).metadata();
  const width = metadata.width || 1200;
  const height = metadata.height || 675;
  const safeName = escapeXml(displayName);
  const fontSize = Math.round(Math.min(width * 0.075, height * 0.14));
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-30%" y="-50%" width="160%" height="200%">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <text x="50%" y="76%" text-anchor="middle" dominant-baseline="middle"
      font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900"
      fill="#ffffff" stroke="#071b17" stroke-width="${Math.max(3, fontSize * 0.07)}"
      paint-order="stroke" filter="url(#glow)"
      textLength="${Math.round(width * 0.76)}" lengthAdjust="spacingAndGlyphs">${safeName}</text>
  </svg>`);

  return sharp(source).composite([{ input: svg }]).png().toBuffer();
}
