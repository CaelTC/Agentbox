/**
 * Sizes for a Sandbox User: no bytes, no decimals below a gigabyte.
 *
 * In core rather than the renderer because the main process needs the same
 * sentence. Its own GB-only version rendered anything under ~50 MB as "0 GB",
 * so a refused Import read "this needs 0 GB, and only 0 GB is free."
 *
 * `src/renderer/app.ts` keeps its own copy of this and cannot import it: the
 * renderer is a classic `<script>` with contextIsolation on, and tsc emits
 * CommonJS, so any import there becomes a `require()` that throws.
 */
export function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
