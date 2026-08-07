export interface RawSubTask {
  id: number;
  choreId?: number;
  name: string;
  completedAt: string | null;
  completedBy?: number;
  parentId?: number | null;
  orderId?: number;
}

export interface RawLabel {
  id: number;
  name: string;
  color?: string;
}

export interface RawFrequencyMetadata {
  unit?: string | null;
  days?: string[] | null;
  months?: string[] | null;
  time?: string | null;
  timezone?: string | null;
  weekPattern?: string | null;
  occurrences?: number[] | null;
}

/** The list-row shape. Detail-only fields are optional so a merged object types cleanly. */
export interface RawChore {
  id: number;
  name: string;
  description?: string | null;
  nextDueDate: string | null;
  assignedTo: number | null;
  assignees?: Array<{ userId: number }>;
  assignStrategy?: string;
  labelsV2?: RawLabel[] | null;
  priority: number;
  status: number;
  frequencyType: string;
  frequency?: number;
  frequencyMetadata?: RawFrequencyMetadata | null;
  isRolling?: boolean;
  isActive?: boolean;
  isPrivate?: boolean;
  requireApproval?: boolean;
  notification?: boolean;
  notificationMetadata?: Record<string, unknown> | null;
  completionWindow?: number | null;
  points?: number | null;
  projectId?: number | null;
  createdBy: number;
  updatedAt?: string;
  /**
   * Present when a Donetick Thing drives this chore. Read-only here: EditChore
   * dissociates the Thing unconditionally and re-associates only when the request
   * carries a thingTrigger, which this server has no way to build, so an edit would
   * sever the link permanently and silently.
   */
  thingChore?: unknown | null;
  subTasks?: RawSubTask[] | null;
  lastCompletedDate?: string | null;
  lastCompletedBy?: number | null;
  totalCompletedCount?: number | null;
}

export interface Member {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  points: number;
  pointsRedeemed: number;
}

export interface Project {
  id: number;
  name: string;
}

/** Four values. 3 is pending approval, which complete_chore must detect. */
export const CHORE_STATUS: Record<number, string> = {
  0: "idle",
  1: "in_progress",
  2: "paused",
  3: "pending_approval",
};

/** Donetick priority is inverted: P1 is the most urgent, 0 means unset. */
/**
 * Chore history rows, which are not the same scale as CHORE_STATUS. Measured on
 * v0.1.76: completing wrote 1, skipping 2, a completion awaiting sign-off 3, and a
 * plain rename wrote 6. Donetick records a reschedule on every edit that carries a
 * nextDueDate, and it compares the old and new dates by pointer, so the row appears
 * even when the date is unchanged.
 */
export const CHORE_HISTORY_STATUS: Record<number, string> = {
  1: "completed",
  2: "skipped",
  3: "pending_approval",
  4: "rejected",
  5: "missed",
  6: "rescheduled",
};

export const PRIORITY_LABEL: Record<number, string> = {
  0: "none",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

/**
 * Derived from PRIORITY_LABEL rather than written out again, so the two directions
 * cannot disagree. Priority is inverted here (P1 is the most urgent, 0 is unset),
 * which makes a hand-maintained second copy the worst place in this codebase for a
 * transcription slip: every value would still look plausible.
 */
export const PRIORITY_VALUE: Record<string, number> = Object.fromEntries(
  Object.entries(PRIORITY_LABEL).map(([value, label]) => [label.toLowerCase(), Number(value)]),
);

export interface ProjectedChore {
  id: number;
  name: string;
  due_date: string | null;
  due_in: string;
  is_overdue: boolean;
  assigned_to: string | null;
  description: string | null;
  points: number | null;
  is_rolling: boolean;
  labels: string[];
  priority: string;
  project: string | null;
  frequency: string;
  status: string;
  requires_approval: boolean;
  completion_window: number | null;
  subtasks: Array<{ name: string; done: boolean }>;
  last_completed_at: string | null;
  last_completed_by: string | null;
}
