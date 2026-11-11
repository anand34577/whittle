/** Colour maths for the theme contrast test: parse oklch() and #hex, and work out WCAG contrast. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type RGB = [number, number, number];

function oklchToRgb(l: number, c: number, h: number): RGB {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  return lin.map((v) => Math.min(1, Math.max(0, v))) as RGB; // linear
}

/** Linear-light RGB of a CSS colour (oklch or hex), or null for anything else. */
export function parseColor(v: string): RGB | null {
  v = v.trim();
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/.*)?\)$/.exec(v);
  if (ok) return oklchToRgb(+ok[1]!, +ok[2]!, +ok[3]!);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join("") : hex[1]!;
    return [0, 2, 4].map((i) => {
      const s = parseInt(h.slice(i, i + 2), 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as RGB;
  }
  return null;
}

export function contrast(a: RGB, b: RGB): number {
  const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Every `[data-theme="x"]` (and :root) block's custom properties, later files and blocks overriding earlier ones. */
export function themeTokens(): Map<string, Record<string, string>> {
  const dir = fileURLToPath(new URL("../src/styles/", import.meta.url));
  const out = new Map<string, Record<string, string>>();
  for (const f of ["tokens.css", "themes.css", "daylight.css"]) {
    const css = readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1]!.split(",").map((s) => s.trim());
      const vars = Object.fromEntries([...m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]));
      if (!Object.keys(vars).length) continue;
      for (const sel of sels) {
        const t = sel === ":root" ? "graphite" : /^\[data-theme="(\w+)"\]$/.exec(sel)?.[1];
        // Daylight's default accent is written for both of its variants at once.
        const both = /^\[data-theme\^="daylight"\]\[data-accent="orange"\]$/.test(sel) ? ["daylight", "daylightdark"] : /^\[data-theme="(\w+)"\]\[data-accent="orange"\]$/.exec(sel) ? [/"(\w+)"/.exec(sel)![1]!] : null;
        for (const name of t ? [t] : (both ?? [])) out.set(name, { ...(out.get(name) ?? {}), ...vars });
      }
    }
  }
  return out;
}
