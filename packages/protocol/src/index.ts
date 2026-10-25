export type HealthDto = { ok: true; mode: "shadow" | "active"; listenerRunning: boolean };
export type ApprovalDecision = "approve" | "reject";
export type ApprovalDto = { id: number; messageId: number; operation: string; status: string; expiresAt: string };
