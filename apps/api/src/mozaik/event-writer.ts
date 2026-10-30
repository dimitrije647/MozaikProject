import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { redact, safeErrorMessage, type RecordedEvent } from '@launchpilot/agents';
import { PrismaService } from '../common/prisma.service';

/**
 * Persists a run's events in order. Mozaik delivers events synchronously and does not wait for
 * the sink, so writes are chained on one promise: ordered, and `flush()` can wait for the tail.
 */
export class EventWriter {
  private chain: Promise<void> = Promise.resolve();
  readonly errors: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  push = (event: RecordedEvent): void => {
    this.chain = this.chain.then(async () => {
      try {
        await this.prisma.campaignEvent.create({
          data: {
            runId: event.runId,
            sequence: event.sequence,
            eventType: event.type,
            phase: event.phase,
            participant: event.participant,
            // Sanitized by the runtime already; redact again so the DB boundary is safe on its own.
            payloadJson: event.payload ? (redact(event.payload) as Prisma.InputJsonObject) : Prisma.JsonNull,
            createdAt: new Date(event.occurredAt),
          },
        });
      } catch (err) {
        const message = safeErrorMessage(err);
        this.errors.push(message);
        this.logger.error(`Failed to persist event #${event.sequence} of run ${event.runId}: ${message}`);
      }
    });
  };

  flush(): Promise<void> {
    return this.chain;
  }
}
