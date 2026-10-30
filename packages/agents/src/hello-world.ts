import 'dotenv/config';
import {
  defineRuntime,
  RuntimeState,
  createAgent,
  createHuman,
  SituationSpecification,
  Agent,
  type SituationHandler,
  type SituationContext,
} from '@mozaik-ai/core';

const MODEL = process.env.MOZAIK_MODEL ?? 'claude-sonnet-4-6';

class AppState extends RuntimeState {}

const { initializeRuntime, join, sendMessage, runLoop } = defineRuntime<AppState>();

initializeRuntime({ state: new AppState() });

class WhenOthersSendAMessage extends SituationSpecification {
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    return event.type === 'message.sent' && event.producerId !== participant.getId();
  }
}

class WhenModelAnswers extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === 'model.answer';
  }
}

const thinkOnMessage: SituationHandler = {
  specification: new WhenOthersSendAMessage(),
  processor: {
    apply({ event, participant }) {
      if (!(participant instanceof Agent)) return;
      const { message } = event.payload as { message: string };
      runLoop(participant.getId(), message, {
        model: MODEL,
        context: participant.getMemory().getContext(),
        tools: participant.getTools(),
      });
    },
  },
};

const printAnswer: SituationHandler = {
  specification: new WhenModelAnswers(),
  processor: {
    apply({ event }) {
      console.log('[model.answer]', event.producerId, event.payload);
    },
  },
};

const agent = createAgent({
  name: 'Assistant',
  capabilities: ['inference'],
  instruction: 'You are a helpful teammate.',
  tools: [],
  handlers: [thinkOnMessage],
});

const human = createHuman({ name: 'User', capabilities: [], handlers: [] });
const transcript = createHuman({ name: 'Transcript', capabilities: [], handlers: [printAnswer] });

join(transcript);
join(human);
join(agent);

sendMessage('Hello', human.getId());
