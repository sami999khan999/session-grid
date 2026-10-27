const SIZE = 32;
const INK = '#1f2a33';

const cache = new Map<string, Promise<string>>();

/**
 * The site's favicon with a session lamp in the corner, as a PNG data URL. Without a usable
 * favicon (missing, SVG, failed fetch) the result is a plain tile with the session's initial.
 * Runs in the background service worker (OffscreenCanvas).
 */
export function badgedFavicon(iconUrl: string | undefined, color: string, tag: string): Promise<string> {
  const key = `${iconUrl ?? ''}|${color}|${tag}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = draw(iconUrl, color, tag);
    cache.set(key, hit);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

async function draw(iconUrl: string | undefined, color: string, tag: string): Promise<string> {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d')!;
  const icon = await loadIcon(iconUrl);
  if (icon) {
    ctx.drawImage(icon, 0, 0, SIZE, SIZE);
    // Lamp: session colour in a dark ring with a highlight, bottom-right.
    ctx.beginPath();
    ctx.arc(23, 23, 8.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(21, 21, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, SIZE - 3, SIZE - 3, 7);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((tag.trim()[0] ?? '•').toUpperCase(), SIZE / 2, SIZE / 2 + 1);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

async function loadIcon(url: string | undefined): Promise<ImageBitmap | null> {
  if (!url || !/^(https?|data):/i.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const blob = await res.blob();
    if (!res.ok || !blob.type.startsWith('image/') || blob.type.includes('svg') || blob.size > 512 * 1024) return null;
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Dark or light badge text, whichever reads better on `hex`. */
export function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return lum > 0.22 ? INK : '#ffffff';
}
