// Paperclip entity shapes (mirrors @paperclipai/shared). Dates arrive as ISO
// strings over the wire. Shared by the ContextVM client and the mobile app.

export type AgentStatus =
  | "active"
  | "paused"
  | "idle"
  | "running"
  | "error"
  | "pending_approval"
  | "terminated";

export type AgentRole =
  | "ceo"
  | "cto"
  | "cmo"
  | "cfo"
  | "security"
  | "engineer"
  | "designer"
  | "pm"
  | "qa"
  | "devops"
  | "researcher"
  | "general";

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: string | null;
  errorReason?: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

export interface AgentDetail extends Agent {
  chainOfCommand?: AgentChainOfCommandEntry[];
}

export type CompanyStatus = "active" | "paused" | "archived";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  issuePrefix: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  brandColor: string | null;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CompanyStats = Record<
  string,
  { agentCount: number; issueCount: number }
>;

export type HeartbeatRunStatus =
  | "queued"
  | "scheduled_retry"
  | "running"
  | "succeeded"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface HeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  status: HeartbeatRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  exitCode: number | null;
  logBytes: number | null;
  lastOutputSeq: number;
  createdAt: string;
  updatedAt: string;
  currentStatusMessage?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
}

export interface AgentWakeupSkipped {
  status: "skipped";
  reason: string;
  message: string | null;
}

export type AgentWakeupResponse = HeartbeatRun | AgentWakeupSkipped;

export interface HeartbeatRunEvent {
  id: number;
  companyId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  level: "info" | "warn" | "error" | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RunLogChunk {
  runId: string;
  store: string | null;
  logRef: string | null;
  content: string;
  nextOffset?: number | null;
}

export type ApprovalStatus =
  "pending" | "revision_requested" | "approved" | "rejected" | "cancelled";

export type ApprovalType =
  | "hire_agent"
  | "approve_ceo_strategy"
  | "budget_override_required"
  | "request_board_approval";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalComment {
  id: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

/** A related issue as it appears in blockedBy / blocks / children. */
export interface IssueRelationSummary {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
}

export interface Issue {
  id: string;
  companyId: string;
  parentId?: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  identifier: string | null;
  labels?: Array<{ id: string; name: string; color?: string | null }> | null;
  blockedBy?: IssueRelationSummary[];
  blocks?: IssueRelationSummary[];
  createdAt: string;
  updatedAt: string;
}

/** A row from the issue activity feed (drives the timeline). */
export interface ActivityEvent {
  id: string;
  action: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  runId: string | null;
  createdAt: string;
  details: Record<string, unknown>;
}

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type IssuePriority = "critical" | "high" | "medium" | "low";

export interface IssueUpdate {
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string | null;
  title?: string;
  description?: string | null;
  comment?: string;
  reopen?: boolean;
  resume?: boolean;
  interrupt?: boolean;
}

/** An agent-initiated prompt in an issue thread (confirmation, questions, etc.). */
export interface IssueInteraction {
  id: string;
  issueId?: string;
  kind: string; // request_confirmation | ask_user_questions | request_checkbox_confirmation | suggest_tasks | ...
  status: string; // pending | accepted | rejected | answered | cancelled | expired
  title?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  result?: unknown;
  sourceRunId?: string | null;
  sourceCommentId?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorType: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  derivedAuthorAgentId?: string | null;
  body: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueAttachment {
  id: string;
  issueId: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  contentPath?: string;
  openPath?: string;
  downloadPath?: string;
}

export interface IssueWorkProduct {
  id: string;
  issueId: string;
  type: string;
  provider: string;
  title: string;
  url: string | null;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  healthStatus: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  runCount: number;
  runtimeMs: number;
}

export interface IssueDocumentSummary {
  id: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  latestRevisionNumber: number;
  updatedAt?: string;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

// Live event payloads (forwarded from the paperclip company WebSocket).
export interface RunStatusPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  status: HeartbeatRunStatus;
  triggerDetail?: string | null;
  error?: string | null;
}

export interface RunProgressPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  message?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  updatedAt?: string;
}

export interface RunLogPayload {
  runId: string;
  chunk: string;
  stream: "stdout" | "stderr" | "system";
  ts?: string;
}

export interface AgentStatusPayload {
  agentId: string;
  status: AgentStatus;
}
