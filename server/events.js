import { EventEmitter } from 'node:events';

export class JobEvents extends EventEmitter {
  publish(id, payload) {
    this.emit(id, payload);
    this.emit('*', { id, ...payload });
  }
}

export function writeSseEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
