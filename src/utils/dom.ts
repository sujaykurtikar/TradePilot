/** Small DOM helpers shared by the widget layer. No chart-vendor knowledge here. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True if `a` and `b` differ by less than `epsilon` — used for the sub-pixel skip in §R-P4a. */
export function nearlyEqual(a: number, b: number, epsilon = 0.5): boolean {
  return Math.abs(a - b) < epsilon;
}

export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

/**
 * Formats a price for display with tabular-lining numerals so digits don't
 * jitter when values update live (§R-P3). The CSS (`font-variant-numeric:
 * tabular-nums`) does the actual alignment; this just fixes decimal places.
 */
export function formatPrice(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}
