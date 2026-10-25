import { WebSocket } from 'ws';
import { once } from 'node:events';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export function frame(id: string, type: number, body?: (encoder: encoding.Encoder) => void) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, id);
  encoding.writeVarUint(encoder, type);
  body?.(encoder);
  return encoding.toUint8Array(encoder);
}
export const auth = (id: string, token: string) =>
  frame(id, 2, (e) => {
    encoding.writeVarUint(e, 0);
    encoding.writeVarString(e, token);
  });
export const sync = (id: string, type: number, update: Uint8Array) =>
  frame(id, 0, (e) => {
    encoding.writeVarUint(e, type);
    encoding.writeVarUint8Array(e, update);
  });
export const stateless = (id: string, value: unknown) =>
  frame(id, 5, (e) => encoding.writeVarString(e, JSON.stringify(value)));
export function messageType(data: Uint8Array): number {
  const decoder = decoding.createDecoder(data);
  decoding.readVarString(decoder);
  return decoding.readVarUint(decoder);
}
export function isAuthenticated(data: Uint8Array): boolean {
  const decoder = decoding.createDecoder(data);
  decoding.readVarString(decoder);
  return decoding.readVarUint(decoder) === 2 && decoding.readVarUint(decoder) === 2;
}
export async function rawClient(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration`);
  const messages: Buffer[] = [];
  socket.on('message', (data) => messages.push(Buffer.from(data as Buffer)));
  socket.on('error', () => {});
  const closed = once(socket, 'close').then(([code]) => code as number);
  // A failed HTTP upgrade is tested separately; guard against unhandled close
  // promise rejections in callers asserting that refusal.
  void closed.catch(() => {});
  await once(socket, 'open');
  return { socket, messages, closed };
}
export async function authenticateRaw(
  client: Awaited<ReturnType<typeof rawClient>>,
  document: { id: string; token: string },
) {
  client.socket.send(auth(document.id, document.token));
  client.socket.send(sync(document.id, 0, Uint8Array.of(0)));
  const deadline = Date.now() + 5000;
  while (
    !client.messages.some((data) => isAuthenticated(data)) ||
    !client.messages.some((data) => messageType(data) === 0)
  ) {
    if (Date.now() >= deadline) throw new Error('Raw client authentication did not complete');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
