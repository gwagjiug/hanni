import type { RunStatus } from "../types";

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  RECEIVED: [
    "VALIDATING",
    "CANCELLED",
    "REJECTED_OUT_OF_SCOPE",
    "REJECTED_PERMISSION",
  ],
  VALIDATING: [
    "ANALYZING",
    "CANCELLED",
    "REJECTED_OUT_OF_SCOPE",
    "FAILED_EXTERNAL",
  ],
  ANALYZING: ["AWAITING_APPROVAL", "FAILED_EXTERNAL", "FAILED_BUDGET"],
  AWAITING_APPROVAL: ["CREATING_PR", "CANCELLED", "EXPIRED"],
  CREATING_PR: ["COMPLETED", "FAILED_EXTERNAL", "FAILED_BUDGET"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED_OUT_OF_SCOPE: [],
  REJECTED_PERMISSION: [],
  FAILED_EXTERNAL: [],
  FAILED_BUDGET: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to))
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
}
