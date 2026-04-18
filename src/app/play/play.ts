import {
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  GameState,
  HitQuality,
  MAX_INNINGS,
  PITCH_CONTACT_MS,
  PITCH_FLIGHT_MS,
  PitchType,
  PlayerId,
  SWING_COOLDOWN_MS,
  SwingOutcome,
  newGameState,
} from '../game/models';
import { applySwing, currentPitcher } from '../game/engine';
import { aiPickPitch, aiSwingTimeMs } from '../game/ai';
import { WsService } from '../game/ws';

type Mode = 'single' | 'multi';
type Phase =
  | 'idle'
  | 'selecting_pitch'
  | 'pitching'
  | 'swing_resolved'
  | 'inning_break'
  | 'game_over';

interface ActivePitch {
  type: PitchType;
  seed: number;
  t0: number;
  flightMs: number;
  contactMs: number;
  curlSign: number;
  swungAt: number | null;
}

interface LastResult {
  quality: HitQuality;
  runs: number;
  batter: PlayerId;
  basesAdvanced: number;
}

@Component({
  selector: 'app-play',
  templateUrl: './play.html',
  styleUrl: './play.scss',
})
export class PlayComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  ws = inject(WsService);

  mode = signal<Mode>('single');
  humanRole = signal<PlayerId>('p1');

  state = signal<GameState>(newGameState());
  phase = signal<Phase>('idle');
  activePitch = signal<ActivePitch | null>(null);
  lastResult = signal<LastResult | null>(null);
  banner = signal<string | null>(null);
  cooldownUntil = 0;

  ballPos = signal({ x: 50, y: 10, scale: 0.8 });

  readonly pitchTypes: PitchType[] = ['straight', 'curl', 'zigzag', 'flyball'];

  private rafId: number | null = null;
  private offWs: (() => void) | null = null;
  private innerTimeouts: number[] = [];

  readonly PITCH_CONTACT_MS = PITCH_CONTACT_MS;
  readonly MAX_INNINGS = MAX_INNINGS;

  readonly currentBatter = computed(() => this.state().half.batter);
  readonly currentPitcherPid = computed(() => currentPitcher(this.state()));

  readonly myTurnAsPitcher = computed(() => {
    const s = this.state();
    const pitcher = currentPitcher(s);
    if (this.mode() === 'single') {
      return pitcher === this.humanRole();
    }
    return pitcher === this.ws.role();
  });

  readonly myTurnAsBatter = computed(() => {
    const s = this.state();
    if (this.mode() === 'single') {
      return s.half.batter === this.humanRole();
    }
    return s.half.batter === this.ws.role();
  });

  constructor() {
    this.route.queryParams.subscribe((params) => {
      const mode = (params['mode'] ?? 'single') as Mode;
      this.mode.set(mode);
      if (mode === 'single') {
        const role = (params['role'] ?? 'p1') as PlayerId;
        this.humanRole.set(role);
        this.phase.set('selecting_pitch');
        this.scheduleNextTick();
      } else {
        if (!this.ws.connected() || !this.ws.role()) {
          this.router.navigate(['/']);
          return;
        }
        this.attachWs();
        this.phase.set('selecting_pitch');
        this.scheduleNextTick();
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.innerTimeouts.forEach((t) => clearTimeout(t));
      if (this.offWs) this.offWs();
    });
  }

  private attachWs() {
    this.offWs = this.ws.on((msg) => {
      if (msg.type === 'pitch') {
        this.startPitchAnimation(msg.pitchType, msg.seed, performance.now());
      } else if (msg.type === 'swing_result') {
        if (this.activePitch() && msg.swingerRole !== this.ws.role()) {
          this.finishSwing(msg.offsetMs, msg.pitchType);
        }
      } else if (msg.type === 'miss') {
        if (this.activePitch() && msg.swingerRole !== this.ws.role()) {
          this.finishMiss(msg.pitchType);
        }
      } else if (msg.type === 'peer_left') {
        this.banner.set('Opponent disconnected');
        this.phase.set('game_over');
      }
    });
  }

  @HostListener('window:keydown.space', ['$event'])
  onSpace(e: Event) {
    e.preventDefault();
    this.trySwing();
  }

  onTapField() {
    this.trySwing();
  }

  selectPitch(type: PitchType) {
    if (this.phase() !== 'selecting_pitch') return;
    if (!this.myTurnAsPitcher()) return;
    const seed = Math.floor(Math.random() * 1e9);

    if (this.mode() === 'multi') {
      this.ws.send({ type: 'pitch', pitchType: type, seed });
    } else {
      this.startPitchAnimation(type, seed, performance.now());
    }
  }

  private startPitchAnimation(type: PitchType, seed: number, t0: number) {
    const curlSign = (seed % 2 === 0) ? 1 : -1;
    this.activePitch.set({
      type,
      seed,
      t0,
      flightMs: PITCH_FLIGHT_MS[type],
      contactMs: PITCH_CONTACT_MS[type],
      curlSign,
      swungAt: null,
    });
    this.phase.set('pitching');
    this.lastResult.set(null);
    this.banner.set(null);

    if (this.mode() === 'single' && !this.myTurnAsBatter()) {
      const aiTime = aiSwingTimeMs(type);
      if (aiTime !== null) {
        const id = window.setTimeout(() => {
          if (this.phase() === 'pitching') {
            this.registerSwing(performance.now());
          }
        }, aiTime);
        this.innerTimeouts.push(id);
      }
    }

    this.animateBall();
  }

  private animateBall() {
    const loop = () => {
      const pitch = this.activePitch();
      if (!pitch || this.phase() !== 'pitching') {
        this.rafId = null;
        return;
      }
      const t = performance.now() - pitch.t0;
      const progress = Math.min(1, t / pitch.flightMs);
      const pos = this.computeBallPos(pitch, progress);
      this.ballPos.set(pos);

      if (t >= pitch.flightMs) {
        if (pitch.swungAt === null) {
          if (this.mode() === 'multi') {
            if (this.myTurnAsBatter()) {
              this.ws.send({ type: 'miss', pitchType: pitch.type });
            }
          } else {
            this.finishMiss(pitch.type);
          }
        }
        this.rafId = null;
        return;
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private computeBallPos(p: ActivePitch, progress: number) {
    const yStart = 12;
    const yEnd = 82;
    let x = 50;
    let y = yStart + (yEnd - yStart) * progress;
    let scale = 0.5 + progress * 0.9;

    switch (p.type) {
      case 'straight':
        break;
      case 'curl': {
        const amt = Math.sin(progress * Math.PI) * 22 * p.curlSign;
        x = 50 + amt;
        break;
      }
      case 'zigzag': {
        const amt = Math.sin(progress * Math.PI * 5) * 12 * p.curlSign;
        x = 50 + amt;
        break;
      }
      case 'flyball': {
        const arc = Math.sin(progress * Math.PI) * 14;
        y = yStart + (yEnd - yStart) * progress - arc;
        scale = 0.5 + progress * 1.4;
        break;
      }
    }
    return { x, y, scale };
  }

  private trySwing() {
    const now = performance.now();
    if (now < this.cooldownUntil) return;
    if (this.phase() !== 'pitching') return;
    if (!this.myTurnAsBatter()) return;
    const p = this.activePitch();
    if (!p || p.swungAt !== null) return;

    this.cooldownUntil = now + SWING_COOLDOWN_MS;
    this.registerSwing(now);
  }

  private registerSwing(now: number) {
    const p = this.activePitch();
    if (!p || p.swungAt !== null) return;
    const swingDt = now - p.t0;
    const offsetMs = swingDt - p.contactMs;
    this.activePitch.set({ ...p, swungAt: now });

    if (this.mode() === 'multi' && this.myTurnAsBatter()) {
      this.ws.send({ type: 'swing', offsetMs, pitchType: p.type });
    } else {
      this.finishSwing(offsetMs, p.type);
    }
  }

  private finishSwing(offsetMs: number, pitchType: PitchType) {
    const cur = this.state();
    const { state: next, outcome } = applySwing(cur, offsetMs, pitchType);
    this.afterResolution(next, outcome, cur.half.batter);
  }

  private finishMiss(pitchType: PitchType) {
    const cur = this.state();
    const { state: next, outcome } = applySwing(cur, 9999, pitchType);
    this.afterResolution(next, outcome, cur.half.batter);
  }

  private afterResolution(next: GameState, outcome: SwingOutcome, batter: PlayerId) {
    this.state.set(next);
    this.lastResult.set({
      quality: outcome.quality,
      runs: outcome.runsScored,
      batter,
      basesAdvanced: outcome.basesAdvanced,
    });
    this.banner.set(this.bannerFor(outcome));
    this.phase.set('swing_resolved');
    this.activePitch.set(null);

    const breakMs = outcome.quality === 'strike' ? 1000 : 1700;

    const id = window.setTimeout(() => {
      if (next.gameOver) {
        this.phase.set('game_over');
        return;
      }
      this.phase.set('selecting_pitch');
      this.banner.set(null);
      this.scheduleNextTick();
    }, breakMs);
    this.innerTimeouts.push(id);
  }

  private scheduleNextTick() {
    if (this.mode() !== 'single') return;
    if (this.myTurnAsPitcher()) return;
    const id = window.setTimeout(() => {
      if (this.phase() === 'selecting_pitch') {
        this.selectPitch(aiPickPitch());
      }
    }, 900);
    this.innerTimeouts.push(id);
  }

  private bannerFor(o: SwingOutcome): string {
    switch (o.quality) {
      case 'home_run': return o.runsScored > 1 ? `HOME RUN! +${o.runsScored}` : 'HOME RUN!';
      case 'triple':
        return o.runsScored > 0 ? `Triple! +${o.runsScored}` : 'Triple!';
      case 'double':
        return o.runsScored > 0 ? `Double! +${o.runsScored}` : 'Double!';
      case 'single':
        return o.runsScored > 0 ? `Single! +${o.runsScored}` : 'Single!';
      case 'strike':
        return 'Strike!';
    }
  }

  playAgain() {
    this.state.set(newGameState());
    this.lastResult.set(null);
    this.banner.set(null);
    this.phase.set('selecting_pitch');
    this.scheduleNextTick();
  }

  exit() {
    this.ws.reset();
    this.router.navigate(['/']);
  }

  roleLabel(p: PlayerId | 'tie' | null): string {
    if (p === 'tie' || p === null) return '';
    if (this.mode() === 'single') {
      return p === this.humanRole() ? 'You' : 'CPU';
    }
    return p === this.ws.role() ? 'You' : 'Opponent';
  }

  get basesArr() {
    const b = this.state().half.bases;
    return [b.first, b.second, b.third];
  }
}
