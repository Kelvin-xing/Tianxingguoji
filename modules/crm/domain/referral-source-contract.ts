export const REFERRAL_SOURCE_TYPES = Object.freeze(["bank", "insurance", "other_partner"] as const);
export const REFERRAL_SOURCE_STATUSES = Object.freeze(["active", "inactive"] as const);
export type ReferralSourceType = (typeof REFERRAL_SOURCE_TYPES)[number];
export type ReferralSourceStatus = (typeof REFERRAL_SOURCE_STATUSES)[number];
