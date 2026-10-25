export type TrustScope = "trusted" | "untrusted";
export type Risk = "read" | "local-write" | "external-write";
export type ConversationStatus = "active" | "interrupted" | "completed";

export type InboundMessage = {
  platformMessageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string | null;
  senderType: "user" | "bot" | "unknown";
  content: string;
  mentioned: boolean;
  reference?: unknown;
  attachments?: unknown;
  inboundAt: string;
};

export type Capability = {
  id: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  invoke(input: unknown, context: CapabilityContext): Promise<CapabilityResult>;
};

export type CapabilityContext = { conversationId: string; messageId: string; trustScope: TrustScope };
export type CapabilityResult = { ok: boolean; summary: string; data?: unknown; verification?: string[] };

export interface ConversationStore {
  conversationKey(chatId: string, trustScope: TrustScope): string;
  getThreadId(chatId: string, trustScope: TrustScope): string | null;
  setThreadId(chatId: string, trustScope: TrustScope, threadId: string): void;
}

export interface MessageTransport {
  react(messageId: string, emoji: string): Promise<void>;
  replyText(messageId: string, text: string, idempotencyKey: string): Promise<void>;
  replyMedia(messageId: string, files: string[], idempotencyKey: string): Promise<void>;
}

export interface CodexRuntime {
  startThread(input: { cwd: string; trustScope: TrustScope }): Promise<string>;
  startTurn(input: { threadId: string; messageId: string; text: string; images?: string[] }): Promise<string>;
  steerTurn(input: { threadId: string; turnId: string; messageId: string; text: string; images?: string[] }): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export interface ApprovalGateway {
  request(input: { messageId: string; turnId: string; operation: string; approverId: string; expiresAt: string }): Promise<"approved" | "rejected" | "expired">;
}

export interface DeliveryStore {
  enqueue(input: { messageId: string; kind: string; payload: unknown; idempotencyKey: string }): void;
  markSent(idempotencyKey: string): void;
  markFailed(idempotencyKey: string, error: string, retryAt: string | null): void;
}

export interface CapabilityRegistry {
  register(capabilities: Array<Omit<Capability, "invoke">>): void;
  list(): Array<Omit<Capability, "invoke">>;
  invoke(id: string, input: unknown, context: CapabilityContext): Promise<CapabilityResult>;
}

export interface ArtifactStore {
  record(input: { messageId: string; type: string; path: string; checksum?: string }): void;
  list(messageId: string): Array<{ type: string; path: string; checksum?: string }>;
}

export function conversationKey(chatId: string, trustScope: TrustScope): string {
  return `${chatId}::${trustScope}`;
}

export function shouldReply(message: InboundMessage): boolean {
  return message.chatType === "p2p" || message.mentioned;
}

export function shouldSendInterim(message: InboundMessage, sentCount: number): boolean {
  return message.senderType !== "bot" && sentCount < 1;
}
