import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { WsService } from '../game/ws';
import { PlayerId } from '../game/models';

@Component({
  selector: 'app-menu',
  imports: [FormsModule],
  templateUrl: './menu.html',
  styleUrl: './menu.scss',
})
export class MenuComponent {
  private router = inject(Router);
  ws = inject(WsService);

  view = signal<'home' | 'single' | 'multi'>('home');
  joinCode = signal('');
  connecting = signal(false);
  connectError = signal<string | null>(null);

  chooseSingle(role: PlayerId) {
    this.router.navigate(['/play'], {
      queryParams: { mode: 'single', role },
    });
  }

  async createRoom() {
    this.connectError.set(null);
    this.connecting.set(true);
    try {
      await this.ws.connect();
      this.ws.send({ type: 'create' });
      const off = this.ws.on((msg) => {
        if (msg.type === 'start') {
          off();
          this.connecting.set(false);
          this.router.navigate(['/play'], { queryParams: { mode: 'multi' } });
        }
        if (msg.type === 'error') {
          this.connectError.set(msg.msg);
          this.connecting.set(false);
          off();
        }
      });
    } catch {
      this.connectError.set('Could not reach server');
      this.connecting.set(false);
    }
  }

  async joinRoom() {
    const code = this.joinCode().trim().toUpperCase();
    if (!code) return;
    this.connectError.set(null);
    this.connecting.set(true);
    try {
      await this.ws.connect();
      this.ws.send({ type: 'join', code });
      const off = this.ws.on((msg) => {
        if (msg.type === 'start') {
          off();
          this.connecting.set(false);
          this.router.navigate(['/play'], { queryParams: { mode: 'multi' } });
        }
        if (msg.type === 'error') {
          this.connectError.set(msg.msg);
          this.connecting.set(false);
          off();
        }
      });
    } catch {
      this.connectError.set('Could not reach server');
      this.connecting.set(false);
    }
  }

  back() {
    this.ws.reset();
    this.view.set('home');
    this.connectError.set(null);
  }
}
