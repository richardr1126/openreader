import { randomUUID } from 'node:crypto';
import { AckPolicy, DeliverPolicy, ReplayPolicy, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';

/**
 * KV.keys() leaves its ordered consumer alive for five minutes, including
 * when the result is empty. Maintenance scans can exhaust the server's
 * consumer limit long before that. Own and delete the scan consumer instead.
 */
export async function* listKvKeys(input: {
  js: JetStreamClient;
  jsm: JetStreamManager;
  bucket: string;
  filter: string;
}): AsyncGenerator<string> {
  const stream = `KV_${input.bucket}`;
  const prefix = `$KV.${input.bucket}.`;
  const name = `kv_scan_${randomUUID().replaceAll('-', '')}`;
  await input.jsm.consumers.add(stream, {
    name,
    filter_subject: `${prefix}${input.filter}`,
    deliver_policy: DeliverPolicy.LastPerSubject,
    ack_policy: AckPolicy.None,
    replay_policy: ReplayPolicy.Instant,
    headers_only: true,
    inactive_threshold: nanos(30_000),
  });
  try {
    const consumer = await input.js.consumers.get(stream, name);
    const info = await consumer.info();
    if (info.num_pending === 0) return;
    const messages = await consumer.consume();
    try {
      for await (const message of messages) {
        const operation = message.headers?.get('KV-Operation');
        if (operation !== 'DEL' && operation !== 'PURGE') yield message.subject.slice(prefix.length);
        if (message.info.pending === 0) break;
      }
    } finally {
      await messages.close();
    }
  } finally {
    await input.jsm.consumers.delete(stream, name);
  }
}
