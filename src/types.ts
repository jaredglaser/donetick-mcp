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
  /** Deprecated in Donetick in favour of occurrences, but its getOccurrences still reads either. */
  weekNumbers?: number[] | null;
}

/**
 * A chore in whatever shape it arrived in: the /chores list row, the
 * GET /chores/:id/details view, or a merge of the two. Every field either view
 * omits is optional here, which makes this the right parameter type for the
 * projection and for the read-back merges, and the wrong one for a whole-chore
 * write. ChoreListRow below is what those take.
 */
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
   * Donetick's row version, bumped by every write. Not read here: the concurrency
   * token for the endpoints this server calls is updatedAt, and syncVersion is only
   * checked when a request carries actionOptions, which this server never sends.
   * Modelled so its presence is a fact of record rather than a surprise.
   */
  syncVersion?: number;
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

/**
 * The GET /chores/ row, and the only shape a whole-chore write may merge onto.
 *
 * Measured on v0.1.76: every list row carries these four, empty rather than absent
 * (an unlabelled chore has labelsV2: [], an unassigned one assignees: []), and the
 * /details view carries none of them. Requiring them is what makes mergeEditRequest
 * refuse that view at the call site rather than by guessing at the shape once the
 * object is already in hand. Donetick has no partial update, so every field the
 * merge base does not carry is destroyed on write.
 */
export interface ChoreListRow extends RawChore {
  assignStrategy: string;
  assignees: Array<{ userId: number }>;
  frequencyMetadata: RawFrequencyMetadata | null;
  labelsV2: RawLabel[] | null;
}

/**
 * GET /chores/:id/details, which is not a subset of the list row and not a superset
 * of it either. Measured on v0.1.76 it omits assignStrategy, assignees, circleId,
 * completionWindow, createdAt, frequency, frequencyMetadata, isPrivate, isRolling,
 * labelsV2, notification, notificationMetadata, points, requireApproval, thingChore,
 * updatedAt and updatedBy, and it is the only view carrying lastCompletedDate,
 * lastCompletedBy and totalCompletedCount.
 *
 * Assignable to RawChore and never to ChoreListRow, which is the whole reason it has
 * a name of its own.
 */
export interface ChoreDetails {
  id: number;
  name: string;
  description?: string | null;
  nextDueDate: string | null;
  assignedTo: number | null;
  priority: number;
  status: number;
  frequencyType: string;
  isActive?: boolean;
  createdBy: number;
  syncVersion?: number;
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

/**
 * Chore history rows, which are not the same scale as CHORE_STATUS. Measured on
 * v0.1.76: completing wrote 1, skipping 2, a completion awaiting sign-off 3, and a
 * plain rename wrote 6. 0 is written when someone starts a chore timer, and 4 by a
 * rejection. 5 exists in Donetick's enum as "missed" and nothing writes it, so it is
 * left out rather than advertised.
 *
 * Donetick records a reschedule on every edit that carries a nextDueDate, comparing
 * the old and new dates by pointer, so the row appears even when the date is
 * unchanged.
 */
export const CHORE_HISTORY_STATUS: Record<number, string> = {
  0: "started",
  1: "completed",
  2: "skipped",
  3: "pending_approval",
  4: "rejected",
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
  is_private: boolean;
  assign_strategy: string | null;
  /** The whole list, not just assigned_to: replacing it and adding to it look identical otherwise. */
  assignees: string[];
  labels: string[];
  priority: string;
  project: string | null;
  frequency: string;
  status: string;
  requires_approval: boolean;
  completion_window: number | null;
  subtasks: Array<{ name: string; done: boolean }>;
  /**
   * Notifications were write-only: settable through create_chore and edit_chore and
   * readable nowhere, so "does the trash chore have a reminder on it" had no answer.
   * That also hid the one documented data loss in this server, since an edit that
   * switches notifications off is invisible in the result.
   *
   * Reminders only. Donetick's planner reads Templates, CircleGroup and
   * CircleGroupID and nothing else, so the four booleans it also stores are inert.
   */
  notifications: {
    enabled: boolean;
    /** Signed on the wire, rendered with direction: "30m before", "2h after", "at the due date". */
    reminders: string[];
    /** Present when notifications are on but Donetick will send nothing anyway. */
    note?: string;
  };
  last_completed_at: string | null;
  last_completed_by: string | null;
}
