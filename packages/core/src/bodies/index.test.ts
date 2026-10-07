import { describe, expect, test } from "vitest";
import { cohostsInTitle } from ".";

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

describe("cohostsInTitle", () => {
  test("finds the other body a joint meeting's title names", () => {
    expect(
      cohostsInTitle(
        "Girdwood Board of Supervisors and Girdwood Land Use Committee Joint Meeting August 30, 2022",
        gbos.id,
        bodies,
      ),
    ).toEqual([luc]);
  });

  test("matches short names as whole words, in their own case", () => {
    expect(cohostsInTitle("GBOS/LUC joint meeting", gbos.id, bodies)).toEqual([
      luc,
    ]);
    expect(cohostsInTitle("GBOS/luc joint meeting", gbos.id, bodies)).toEqual(
      [],
    );
    expect(cohostsInTitle("GBOS/LUCK joint meeting", gbos.id, bodies)).toEqual(
      [],
    );
  });

  test("names nobody unless the title says joint", () => {
    expect(
      cohostsInTitle(
        "Girdwood Board of Supervisors hears Girdwood Land Use Committee report",
        gbos.id,
        bodies,
      ),
    ).toEqual([]);
  });

  test("a longer name uses up the shorter name inside it", () => {
    expect(
      cohostsInTitle(
        "Anchorage Assembly Community and Economic Development Committee and Girdwood Land Use Committee Joint Meeting",
        ced.id,
        bodies,
      ),
    ).toEqual([luc]);
  });

  test("finds several co-hosts", () => {
    expect(
      cohostsInTitle(
        "Joint Meeting of the Assembly, GBOS and LUC",
        ced.id,
        bodies,
      ),
    ).toEqual([gbos, luc, assembly]);
  });
});
