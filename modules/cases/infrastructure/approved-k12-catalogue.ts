import "server-only";

import studentProfile from "../../../schema/k12/student-profile.v1.json" with { type: "json" };
import educationProfile from "../../../schema/k12/education-profile.v1.json" with { type: "json" };
import schoolPreferences from "../../../schema/k12/school-preferences.v1.json" with { type: "json" };
import familyContext from "../../../schema/k12/family-context.v1.json" with { type: "json" };

import {
  composeK12Manifest,
  parseK12Module,
  type K12ManifestComposition,
} from "../domain/contract.ts";

const APPROVED_K12_CATALOGUE = composeK12Manifest([
  parseK12Module(studentProfile),
  parseK12Module(educationProfile),
  parseK12Module(schoolPreferences),
  parseK12Module(familyContext),
]);

export function getApprovedK12Catalogue(): K12ManifestComposition {
  return APPROVED_K12_CATALOGUE;
}
