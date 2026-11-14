import type { Consumer, JetStreamManager, JsMsg } from '@nats-io/jetstream';
import { z } from 'zod';
import { JOBS_STREAM_NAME } from './nats';
import { toErrorMessage } from './errors';

const advisorySchema = z.object({
  stream: z.literal(JOBS_STREAM_NAME),
  stream_seq: z.number().int().positive(),
  deliveries: z.number().int().positive(),
});
const envelopeSchema = z.object({ opId: z.uuid(), jobId: z.uuid() });

function decodeJson(message: { json(): unknown }): unknown {
  try {
    return message.json();
  } catch {
    return undefined;
  }
}

export async function drainExhaustedJobs(input: {
  consumer: Consumer;
  streams: Pick<JetStreamManager['streams'], 'getMessage' | 'deleteMessage'>;
  settle: (job: { opId: string; jobId: string; deliveryAttempt: number }) => Promise<void>;
  logger: { warn(data: unknown, message: string): void };
}): Promise<boolean> {
  const settle = async (message: JsMsg): Promise<void> => {
    try {
      const parsed = advisorySchema.safeParse(decodeJson(message));
      if (!parsed.success) {
        message.term('Invalid exhausted compute job advisory');
        return;
      }
      const advisory = parsed.data;
      const job = await input.streams.getMessage(JOBS_STREAM_NAME, { seq: advisory.stream_seq });
      if (job) {
        const envelope = envelopeSchema.safeParse(decodeJson(job));
        if (envelope.success) {
          await input.settle({ ...envelope.data, deliveryAttempt: advisory.deliveries });
        }
        await input.streams.deleteMessage(JOBS_STREAM_NAME, advisory.stream_seq);
      }
      message.ack();
    } catch (error) {
      input.logger.warn({ error: toErrorMessage(error) }, 'exhausted compute job reconciliation failed');
      message.nak(15_000);
    }
  };
  const messages = await input.consumer.fetch({ max_messages: 16, expires: 1_000 });
  let hadMessages = false;
  const pending: Promise<void>[] = [];
  try {
    for await (const message of messages) {
      hadMessages = true;
      pending.push(settle(message));
      if (pending.length >= 4) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
  } finally {
    await messages.close();
  }
  return hadMessages;
}
