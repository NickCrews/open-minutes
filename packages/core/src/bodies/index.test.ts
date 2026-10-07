import { describe, expect, test } from "vitest";
import { jointBodiesInTitle } from ".";

const gbos = {
  id: 1,
  name: "Girdwood Board of Supervisors",
  name_short: "GBOS",
};
const luc = { id: 2, name: "Girdwood Land Use Committee", name_short: "LUC" };
const assembly = { id: 3, name: "Anchorage Assembly", name_short: "Assembly" };
const ced = {
  id: 4,
  name: "Anchorage Assembly Community and Economic Development Committee",
  name_short: "CED",
};
const bodies = [gbos, luc, assembly, ced];

describe("jointBodiesInTitle", () => {
  test("finds the bodies a joint meeting's title names", () => {
    expect(
      jointBodiesInTitle(
        "Girdwood Board of Supervisors and Girdwood Land Use Committee Joint Meeting August 30, 2022",
        bodies,
      ),
    ).toEqual([gbos, luc]);
  });

  test("matches short names as whole words, in their own case", () => {
    expect(jointBodiesInTitle("GBOS/LUC joint meeting", bodies)).toEqual([
      gbos,
      luc,
    ]);
    expect(jointBodiesInTitle("GBOS/luc joint meeting", bodies)).toEqual([
      gbos,
    ]);
    expect(jointBodiesInTitle("GBOS/LUCK joint meeting", bodies)).toEqual([
      gbos,
    ]);
  });

  test("names nobody unless the title says joint", () => {
    expect(
      jointBodiesInTitle(
        "Girdwood Board of Supervisors hears Girdwood Land Use Committee report",
        bodies,
      ),
    ).toEqual([]);
  });

  test("a longer name uses up the shorter name inside it", () => {
    expect(
      jointBodiesInTitle(
        "Anchorage Assembly Community and Economic Development Committee and Girdwood Land Use Committee Joint Meeting",
        bodies,
      ),
    ).toEqual([luc, ced]);
  });

  test("finds several bodies", () => {
    expect(
      jointBodiesInTitle("Joint Meeting of the Assembly, GBOS and LUC", bodies),
    ).toEqual([gbos, luc, assembly]);
  });
});
