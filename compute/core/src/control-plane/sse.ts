export interface SseFrameInput<T = unknown> {
  event?: string;
  id?: string | number;
  data?: T;
  comment?: string;
  /** Reconnection delay (ms) sent to the client EventSource as a `retry:` line. */
  retry?: number;
}

export function encodeSseFrame<T = unknown>(input: SseFrameInput<T>): string {
  const lines: string[] = [];
  if (typeof input.comment === 'string') {
    lines.push(`: ${input.comment}`);
  }
  if (typeof input.retry === 'number' && Number.isFinite(input.retry)) {
    lines.push(`retry: ${Math.max(0, Math.floor(input.retry))}`);
  }
  if (typeof input.id !== 'undefined') {
    lines.push(`id: ${String(input.id)}`);
  }
  if (typeof input.event === 'string' && input.event.trim()) {
    lines.push(`event: ${input.event}`);
  }
  if (typeof input.data !== 'undefined') {
    const serialized = typeof input.data === 'string' ? input.data : JSON.stringify(input.data);
    for (const line of serialized.replace(/\r\n/g, '\n').split('\n')) {
      lines.push(`data: ${line}`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

export function parseSsePayload(frame: string): string | null {
  const lines = frame.replace(/\r\n/g, '\n').split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice('data:'.length).trimStart());
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

export function parseSseEventId(frame: string): number | null {
  const lines = frame.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.startsWith('id:')) continue;
    const value = Number(line.slice('id:'.length).trim());
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}

