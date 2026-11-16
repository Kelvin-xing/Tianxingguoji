/** BR-051 v68 directory-only field ownership. Raw strings are preserved:
 * comparison rules must never rewrite source names or website evidence. */
export const DIRECTORY_SCHOOL_FIELDS = [
  "school_name_zh", "school_name_en", "school_level", "student_gender", "is_sen",
  "tuition_info", "tuition_year", "tuition_source_url", "has_boarding", "boarding_info",
] as const;
export const DIRECTORY_CAMPUS_FIELDS = [
  "source_school_key", "registration_number", "location_marker", "official_website",
  "profile_url", "district", "address", "phone", "fax", "school_session", "finance_type",
] as const;
export type DirectorySchoolField = typeof DIRECTORY_SCHOOL_FIELDS[number];
export type DirectoryCampusField = typeof DIRECTORY_CAMPUS_FIELDS[number];
export type DirectoryValue = string | boolean | null;
export type DirectoryFieldValues = Readonly<Record<string, DirectoryValue>>;
