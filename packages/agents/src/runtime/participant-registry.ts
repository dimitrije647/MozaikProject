import type { Participant } from '@mozaik-ai/core';
import type { FactoryPhase } from '../factory/phases';
import type { FactoryRuntimeState } from '../factory/state';

/** What a participant factory receives when a phase starts. */
export interface ParticipantContext {
  readonly runId: string;
  readonly phase: FactoryPhase;
  /** Shared run state (boards, findings). Contains no credentials. */
  readonly state: FactoryRuntimeState;
}

export type ParticipantFactory = (context: ParticipantContext) => Participant;

export interface ParticipantRegistration {
  readonly phase: FactoryPhase;
  readonly name: string;
  readonly create: ParticipantFactory;
}

/**
 * Where future agent packages plug in. A package registers factories per phase; when the
 * (future) phase runner starts a phase it asks the registry for that phase's participants and
 * `join()`s them to the run's runtime. The backend never sees individual agents.
 *
 * NOT wired into a phase runner yet: no business agents exist in this milestone.
 */
export class ParticipantRegistry {
  private readonly entries: ParticipantRegistration[] = [];

  register(registration: ParticipantRegistration): this {
    if (this.entries.some((e) => e.phase === registration.phase && e.name === registration.name)) {
      throw new Error(`Participant "${registration.name}" is already registered for ${registration.phase}`);
    }
    this.entries.push(registration);
    return this;
  }

  forPhase(phase: FactoryPhase): readonly ParticipantRegistration[] {
    return this.entries.filter((e) => e.phase === phase);
  }

  all(): readonly ParticipantRegistration[] {
    return [...this.entries];
  }
}
