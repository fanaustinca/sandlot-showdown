import { Injectable, signal } from '@angular/core';
import { PitchType, PlayerId } from './models';

export type ServerMsg =
  | { type: 'created'; code: string; role: PlayerId }
  | { type: 'joined'; code: string; role: PlayerId }
  | { type: 'peer_joined' }
  | { type: 'peer_left' }
  | { type: 'start' }
  | { type: 'pitch'; pitchType: PitchType; seed: number; t0: number; from: PlayerId }
  | { type: 'swing_result'; offsetMs: number; swingerRole: PlayerId; pitchType: PitchType }
  | { type: 'miss'; swingerRole: PlayerId; pitchType: PitchType }
  | { type: 'error'; msg: string }
  | { type: 'pong'; t: number };

export type ClientMsg =
  | { type: 'create' }
  | { type: 'join'; code: string }
  | { type: 'pitch'; pitchType: PitchType; seed: number }
  | { type: 'swing'; offsetMs: number; pitchType: PitchType }
  | { type: 'miss'; pitchType: PitchType }
  | { type: 'ping'; t: number };

@Injectable({ providedIn: 'root' })
export class WsService {
  ws: WebSocket | null = null;
  readonly connected = signal(false);
  readonly role = signal<PlayerId | null>(null);
  readonly code = signal<string | null>(null);
  readonly peerPresent = signal(false);
  readonly started = signal(false);
  readonly lastError = signal<string | null>(null);

  private listeners = new Set<(m: ServerMsg) => void>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected.set(true);
        resolve();
      };
      ws.onerror = (e) => {
        this.lastError.set('connection error');
        reject(e);
      };
      ws.onclose = () => {
        this.connected.set(false);
        this.started.set(false);
        this.peerPresent.set(false);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMsg;
          this.handle(msg);
        } catch {}
      };
    });
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'created':
        this.code.set(msg.code);
        this.role.set(msg.role);
        break;
      case 'joined':
        this.code.set(msg.code);
        this.role.set(msg.role);
        this.peerPresent.set(true);
        break;
      case 'peer_joined':
        this.peerPresent.set(true);
        break;
      case 'peer_left':
        this.peerPresent.set(false);
        this.started.set(false);
        break;
      case 'start':
        this.started.set(true);
        break;
      case 'error':
        this.lastError.set(msg.msg);
        break;
    }
    this.listeners.forEach((l) => l(msg));
  }

  on(fn: (m: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  reset() {
    this.code.set(null);
    this.role.set(null);
    this.peerPresent.set(false);
    this.started.set(false);
    this.lastError.set(null);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected.set(false);
  }
}
