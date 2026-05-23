export type KanbanColumn = "planning" | "on_progress" | "done";

export type PlanningType = "prd" | "tech_plan" | "task_breakdown";

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  planningType?: PlanningType;
  docRefs?: string[];
  implementationSummary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEditProposal {
  cardId: string;
  filePath: string;
  action: "create" | "replace";
  content: string;
  summary: string;
}

export interface KanbanBoard {
  id: string;
  title: string;
  requirement: string;
  cards: KanbanCard[];
  createdAt: string;
  updatedAt: string;
}

export type KanbanWebviewMessage =
  | { type: "KANBAN_READY" }
  | { type: "KANBAN_SET_PLANNING_TYPE"; cardId: string; planningType: PlanningType }
  | { type: "KANBAN_MOVE_CARD"; cardId: string; to: KanbanColumn }
  | { type: "KANBAN_IMPLEMENT"; cardIds?: string[] }
  | { type: "KANBAN_NEW_FROM_WEBVIEW"; requirement: string }
  | { type: "KANBAN_ATTACH_DOC_REFS"; cardId: string }
  | { type: "KANBAN_ATTACH_DOC_REFS_DROP"; cardId: string; paths: string[] };

export type KanbanHostMessage =
  | { type: "KANBAN_STATE"; board: KanbanBoard | null }
  | { type: "KANBAN_BUSY"; busy: boolean; message?: string }
  | { type: "KANBAN_ERROR"; message: string }
  | { type: "KANBAN_INFO"; message: string };
