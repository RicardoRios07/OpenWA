import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

// The dispatch lifecycle of one outbound delivery, mirroring ingress_events on the inbound side:
//  - 'pending'    - the row was written before the attempt; nothing durable owns the delivery yet.
//                   The reconciler sweeps these.
//  - 'dispatched' - the delivery reached a durable owner: handed to BullMQ, or completed inline in
//                   direct mode. A failure INSIDE that owner dead-letters separately through
//                   webhook_delivery_failures, so a 'dispatched' row is never the reconciler's
//                   concern. Retiring on ENQUEUE rather than on the POST is what stops the
//                   reconciler duplicating work BullMQ already owns.
//  - 'failed'     - terminal: the reconciler exhausted its replay budget. Recovery continues
//                   through the failure row.
// NULL marks rows that predate these columns on a synchronize-bootstrapped database. NULL reads as
// "not watched", so an upgrade can never mass-replay history.
export type WebhookOutboxState = 'pending' | 'dispatched' | 'failed';

/**
 * Durable record of an outbound webhook delivery, written before the attempt.
 *
 * Fan-out is fire-and-forget from the projector (`void dispatch(...)`), so until this row existed a
 * hard crash between persisting a message and completing its POST lost the delivery with nothing
 * left behind in either mode. The in-memory `inFlightDeliveries` map already tracked exactly this
 * set; the row is its durable twin.
 *
 * UNIQUE(webhookId, idempotencyKey): the key is already salted per webhook at dispatch, so the pair
 * names one delivery attempt-set exactly, and a replay reuses the STORED key rather than deriving a
 * new one, which is what keeps a redelivery deduplicable at the receiver.
 */
@Entity('webhook_outbox_events')
@Index('UQ_webhook_outbox_events_webhook_key', ['webhookId', 'idempotencyKey'], { unique: true })
@Index('IDX_webhook_outbox_events_state_createdAt', ['state', 'createdAt'])
export class WebhookOutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  webhookId!: string;

  @Column()
  sessionId!: string;

  @Column()
  event!: string;

  @Column()
  idempotencyKey!: string;

  @Column()
  deliveryId!: string;

  // Retired to NULL the moment an outcome is recorded: only 'pending' rows are replayable, and a
  // dispatched or failed row has no reason to keep a payload that can carry a whole message body.
  @Column({ type: jsonColumnType(), nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  state!: WebhookOutboxState | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastAttemptAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
