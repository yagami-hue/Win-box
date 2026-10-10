/** 使用媒体尺寸，而不是窗口尺寸或文件名中的清晰度标签。 */
export function formatVideoResolution(width: unknown, height: unknown): string {
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return '';
  return `${width}×${height}`;
}

export function playerWindowTitle(name: string, resolution: string): string {
  const title = name || 'Win-Box';
  return resolution ? `${title} · ${resolution}` : title;
}
