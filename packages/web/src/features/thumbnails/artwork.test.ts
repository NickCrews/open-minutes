import { describe, expect, it } from "vitest";
import { artwork, hashString } from "./artwork";

describe("artwork", () => {
  it("draws the same picture for the same seeds", () => {
    const seeds = { palette: "body:1", layout: "meeting:7", label: "GBOS" };
    expect(artwork(seeds)).toEqual(artwork(seeds));
  });

  it("keeps a body's colors across its meetings but moves the shapes", () => {
    const a = artwork({ palette: "body:1", layout: "meeting:7" });
    const b = artwork({ palette: "body:1", layout: "meeting:8" });
    expect([a.from, a.to]).toEqual([b.from, b.to]);
    expect(a.shapes).not.toEqual(b.shapes);
  });

  it("gives different bodies different colors", () => {
    const a = artwork({ palette: "body:1", layout: "x" });
    const b = artwork({ palette: "body:2", layout: "x" });
    expect(a.from).not.toBe(b.from);
  });

  it("trims long labels", () => {
    expect(
      artwork({ palette: "p", layout: "l", label: " Assembly!! " }).label,
    ).toBe("Assembly");
  });

  it("hashes to an unsigned 32-bit integer", () => {
    for (const s of ["", "a", "body:123", "😀"]) {
      const h = hashString(s);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    }
  });
});
