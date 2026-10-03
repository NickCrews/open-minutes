import { deflateSync } from "node:zlib";
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphPixel } from "./font";

// Just enough of a raster canvas to draw render_audio's pictures and save
// them as PNG, without a native canvas dependency.

export type Rgb = readonly [number, number, number];

export class Image {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb = [255, 255, 255],
  ) {
    this.pixels = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  setPixel(x: number, y: number, [r, g, b]: Rgb): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = r;
    this.pixels[i + 1] = g;
    this.pixels[i + 2] = b;
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) this.setPixel(xx, yy, color);
  }

  /** A straight line, one pixel wide. */
  line(x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++)
      this.setPixel(
        x0 + ((x1 - x0) * i) / steps,
        y0 + ((y1 - y0) * i) / steps,
        color,
      );
  }

  /** Text with its top-left corner at (x, y), clipped to `maxWidth` pixels. */
  text(x: number, y: number, s: string, color: Rgb, maxWidth = Infinity): void {
    const fit = Math.floor(maxWidth / GLYPH_WIDTH);
    [...s.slice(0, fit)].forEach((ch, i) => {
      for (let gy = 0; gy < GLYPH_HEIGHT; gy++)
        for (let gx = 0; gx < GLYPH_WIDTH; gx++)
          if (glyphPixel(ch, gx, gy))
            this.setPixel(x + i * GLYPH_WIDTH + gx, y + gy, color);
    });
  }

  /** The image as a PNG file (8-bit RGB). */
  toPng(): Buffer {
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      const row = y * (this.width * 3 + 1);
      raw[row] = 0; // filter: none
      raw.set(
        this.pixels.subarray(y * this.width * 3, (y + 1) * this.width * 3),
        row + 1,
      );
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

export const textWidth = (s: string) => s.length * GLYPH_WIDTH;
export const TEXT_HEIGHT = GLYPH_HEIGHT;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Magma-like colour for a value in [0, 1]: black, purple, orange, pale yellow. */
export function heat(v: number): Rgb {
  const stops: Rgb[] = [
    [0, 0, 4],
    [59, 15, 112],
    [140, 41, 129],
    [222, 73, 104],
    [254, 159, 109],
    [252, 253, 191],
  ];
  const t = Math.min(1, Math.max(0, v)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const [a, b] = [stops[i]!, stops[i + 1]!];
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as [
    number,
    number,
    number,
  ];
}

/** Distinct colours for speaker labels, in order of use. */
export const LABEL_COLORS: Rgb[] = [
  [31, 119, 180],
  [255, 127, 14],
  [44, 160, 44],
  [214, 39, 40],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [188, 189, 34],
  [23, 190, 207],
  [127, 127, 127],
  [0, 0, 128],
  [128, 128, 0],
];
