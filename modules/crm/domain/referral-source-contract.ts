import { APPROVED_REFERRAL_SOURCE_TYPES } from "./approved-p2-contract.ts";

export const REFERRAL_SOURCE_TYPES = APPROVED_REFERRAL_SOURCE_TYPES;
export const REFERRAL_SOURCE_STATUSES = Object.freeze(["active", "inactive"] as const);
export type ReferralSourceType = (typeof REFERRAL_SOURCE_TYPES)[number];
export type ReferralSourceStatus = (typeof REFERRAL_SOURCE_STATUSES)[number];
