import * as vscode from "vscode";
import { KanbanBoard, KanbanCard, KanbanColumn, PlanningType } from "./types";

const STORAGE_KEY = "kanban.board.v1";

function nowIso(): string {
  return new Date().toISOString();
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class KanbanService {
  constructor(private readonly workspaceState: vscode.Memento) {}

  getBoard(): KanbanBoard | null {
    return this.workspaceState.get<KanbanBoard | null>(STORAGE_KEY, null);
  }

  createBoard(requirement: string): KanbanBoard {
    const ts = nowIso();
    const board: KanbanBoard = {
      id: createId(),
      title: requirement.slice(0, 80),
      requirement,
      cards: [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.saveBoard(board);
    return board;
  }

  setPlanningCards(cards: Array<Pick<KanbanCard, "title" | "description">>): KanbanBoard {
    const board = this.requireBoard();
    const ts = nowIso();
    board.cards = cards.map((card) => ({
      id: createId(),
      title: card.title,
      description: card.description,
      column: "planning",
      createdAt: ts,
      updatedAt: ts,
    }));
    board.updatedAt = ts;
    this.saveBoard(board);
    return board;
  }

  setPlanningType(cardId: string, planningType: PlanningType): KanbanBoard {
    const board = this.requireBoard();
    const card = this.requireCard(board, cardId);
    card.planningType = planningType;
    card.updatedAt = nowIso();
    board.updatedAt = nowIso();
    this.saveBoard(board);
    return board;
  }

  setCardDocRefs(cardId: string, docRefs: string[]): KanbanBoard {
    const board = this.requireBoard();
    const card = this.requireCard(board, cardId);
    card.docRefs = [...new Set(docRefs)].filter(Boolean);
    card.updatedAt = nowIso();
    board.updatedAt = nowIso();
    this.saveBoard(board);
    return board;
  }

  appendCardDocRefs(cardId: string, docRefs: string[]): KanbanBoard {
    const board = this.requireBoard();
    const card = this.requireCard(board, cardId);
    const current = Array.isArray(card.docRefs) ? card.docRefs : [];
    card.docRefs = [...new Set([...current, ...docRefs])].filter(Boolean);
    card.updatedAt = nowIso();
    board.updatedAt = nowIso();
    this.saveBoard(board);
    return board;
  }

  moveCard(cardId: string, to: KanbanColumn): KanbanBoard {
    const board = this.requireBoard();
    const card = this.requireCard(board, cardId);
    if (to === "on_progress" && !card.planningType) {
      throw new Error("Pilih planning type dulu sebelum pindah ke On Progress.");
    }
    card.column = to;
    card.updatedAt = nowIso();
    board.updatedAt = nowIso();
    this.saveBoard(board);
    return board;
  }

  completeCards(results: Array<{ cardId: string; summary: string; success: boolean; error?: string }>): KanbanBoard {
    const board = this.requireBoard();
    const ts = nowIso();
    for (const result of results) {
      const card = board.cards.find((item) => item.id === result.cardId);
      if (!card) continue;
      if (result.success) {
        card.column = "done";
        card.implementationSummary = result.summary;
        card.error = undefined;
      } else {
        card.error = result.error || "Implementasi gagal.";
      }
      card.updatedAt = ts;
    }
    board.updatedAt = ts;
    this.saveBoard(board);
    return board;
  }

  getInProgress(cardIds?: string[]): KanbanCard[] {
    const board = this.requireBoard();
    const cards = board.cards.filter((item) => item.column === "on_progress");
    if (!cardIds?.length) return cards;
    const selected = new Set(cardIds);
    return cards.filter((card) => selected.has(card.id));
  }

  private saveBoard(board: KanbanBoard): void {
    void this.workspaceState.update(STORAGE_KEY, board);
  }

  private requireBoard(): KanbanBoard {
    const board = this.getBoard();
    if (!board) {
      throw new Error("Kanban board belum dibuat.");
    }
    return board;
  }

  private requireCard(board: KanbanBoard, cardId: string): KanbanCard {
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) {
      throw new Error("Card tidak ditemukan.");
    }
    return card;
  }
}
