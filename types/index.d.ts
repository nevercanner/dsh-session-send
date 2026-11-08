export declare const name: string
export declare const description: string
export declare const Config: unknown
export declare function apply(ctx: any, config?: Record<string, unknown>): Promise<void>
export type BusKind = 'text' | 'request' | 'response' | 'event'
export interface BusPayload { text: string; data?: unknown }
export interface SendRequest { from: string; to: string; kind?: BusKind; payload: BusPayload | string; replyTo?: string; meta?: Record<string, unknown> }
export interface BusMessage { id: string; ts: number; kind: BusKind; fromId: string; fromName?: string; toId: string; toName?: string; replyTo?: string; payload: BusPayload; broadcastId?: string }
export interface SendReceipt { ok: true; messages: BusMessage[]; deliveries: Array<{ to: string; messageId: string; mode: string; detail?: string }> }
