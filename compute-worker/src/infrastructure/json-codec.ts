export type JsonCodec<T> = {
  encode(value: T): Uint8Array;
  decode(data: Uint8Array): T;
};

export function createJsonCodec<T>(): JsonCodec<T> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode(value: T): Uint8Array {
      return encoder.encode(JSON.stringify(value));
    },
    decode(data: Uint8Array): T {
      return JSON.parse(decoder.decode(data)) as T;
    },
  };
}
