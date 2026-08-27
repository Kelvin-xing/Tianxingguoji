import type { TaskState, TaskTransitionRule } from "./contract.ts";

/**
 * Binding OD-06 policy approved for Release 1. `owner` is the persisted task
 * projection of the current ServiceCase Primary Advisor; the transaction
 * adapter must lock and re-verify that relationship for every owner action.
 */
export const RELEASE_1_TASK_INITIAL_STATE = "assigned" as const;

export const RELEASE_1_TASK_TRANSITION_RULES = Object.freeze([
  {
    from: "assigned",
    to: "accepted",
    actorKind: "assignee",
    allowedActorRoles: Object.freeze(["advisor", "contractor"]),
    requiresReason: false,
    requiresDifferentActor: false,
  },
  {
    from: "assigned",
    to: "awaiting_reassignment",
    actorKind: "assignee",
    allowedActorRoles: Object.freeze(["advisor", "contractor"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "accepted",
    to: "completed",
    actorKind: "assignee",
    allowedActorRoles: Object.freeze(["advisor", "contractor"]),
    requiresReason: false,
    requiresDifferentActor: false,
  },
  {
    from: "assigned",
    to: "awaiting_reassignment",
    actorKind: "owner",
    allowedActorRoles: Object.freeze(["advisor", "founder"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "accepted",
    to: "awaiting_reassignment",
    actorKind: "owner",
    allowedActorRoles: Object.freeze(["advisor", "founder"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "assigned",
    to: "cancelled",
    actorKind: "owner",
    allowedActorRoles: Object.freeze(["advisor", "founder"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "accepted",
    to: "cancelled",
    actorKind: "owner",
    allowedActorRoles: Object.freeze(["advisor", "founder"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
  {
    from: "awaiting_reassignment",
    to: "assigned",
    actorKind: "owner",
    allowedActorRoles: Object.freeze(["advisor", "founder"]),
    requiresReason: true,
    requiresDifferentActor: false,
  },
] as const satisfies readonly TaskTransitionRule[]);

export function hasRelease1TaskPolicyContent(input: {
  readonly initialState: TaskState | null;
  readonly rules: readonly TaskTransitionRule[];
}): boolean {
  if (input.initialState !== RELEASE_1_TASK_INITIAL_STATE) return false;
  if (input.rules.length !== RELEASE_1_TASK_TRANSITION_RULES.length) return false;

  return RELEASE_1_TASK_TRANSITION_RULES.every((expected) =>
    input.rules.some(
      (actual) =>
        actual.from === expected.from &&
        actual.to === expected.to &&
        actual.actorKind === expected.actorKind &&
        actual.requiresReason === expected.requiresReason &&
        actual.requiresDifferentActor === expected.requiresDifferentActor &&
        sameRoles(actual.allowedActorRoles, expected.allowedActorRoles),
    ),
  );
}

function sameRoles(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((role, index) => role === sortedRight[index]);
}
