import { expect, test } from "vite-plus/test";
import { initials } from "./initials";

test("initials take the first and last names", () => {
  expect(initials("Kyle Q. Kelley")).toBe("KK");
  expect(initials("cher")).toBe("C");
  expect(initials(null)).toBe("?");
});
