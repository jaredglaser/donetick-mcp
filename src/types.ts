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
  subTasks?: RawSubTask[] | null;
  attachments?: unknown[] | null;
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
export const PRIORITY_LABEL: Record<number, string> = {
  0: "none",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

export interface ProjectedChore {
  id: number;
  name: string;
  due_date: string | null;
  due_in: string;
  is_overdue: boolean;
  assigned_to: string | null;
  labels: string[];
  priority: string;
  project: string | null;
  frequency: string;
  status: string;
  requires_approval: boolean;
  completion_window: number | null;
  subtasks: Array<{ name: string; done: boolean }>;
  attachment_count: number;
  last_completed_at: string | null;
  last_completed_by: string | null;
}
