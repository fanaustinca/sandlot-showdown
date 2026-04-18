import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import * as THREE from 'three';
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

const RELEASE_POS = new THREE.Vector3(0, 2.4, -16);
const PLATE_POS = new THREE.Vector3(0, 1.3, 0.2);

@Component({
  selector: 'app-play',
  templateUrl: './play.html',
  styleUrl: './play.scss',
})
export class PlayComponent implements AfterViewInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  ws = inject(WsService);

  @ViewChild('scene', { static: true }) sceneEl!: ElementRef<HTMLDivElement>;

  mode = signal<Mode>('single');
  humanRole = signal<PlayerId>('p1');

  state = signal<GameState>(newGameState());
  phase = signal<Phase>('idle');
  activePitch = signal<ActivePitch | null>(null);
  lastResult = signal<LastResult | null>(null);
  banner = signal<string | null>(null);
  cooldownUntil = 0;

  readonly pitchTypes: PitchType[] = ['straight', 'curl', 'zigzag', 'flyball'];

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

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private ball!: THREE.Mesh;
  private pitcherGroup!: THREE.Group;
  private batterGroup!: THREE.Group;
  private rafId: number | null = null;
  private resizeObs: ResizeObserver | null = null;
  private offWs: (() => void) | null = null;
  private innerTimeouts: number[] = [];

  constructor() {
    this.route.queryParams.subscribe((params) => {
      const mode = (params['mode'] ?? 'single') as Mode;
      this.mode.set(mode);
      if (mode === 'single') {
        const role = (params['role'] ?? 'p1') as PlayerId;
        this.humanRole.set(role);
      } else if (!this.ws.connected() || !this.ws.role()) {
        this.router.navigate(['/']);
        return;
      } else {
        this.attachWs();
      }
      this.phase.set('selecting_pitch');
      this.scheduleNextTick();
    });

    this.destroyRef.onDestroy(() => {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.innerTimeouts.forEach((t) => clearTimeout(t));
      if (this.offWs) this.offWs();
      if (this.resizeObs) this.resizeObs.disconnect();
      if (this.renderer) {
        this.renderer.dispose();
        const el = this.renderer.domElement;
        el.parentElement?.removeChild(el);
      }
    });
  }

  ngAfterViewInit() {
    this.initScene();
    this.startRenderLoop();
  }

  private initScene() {
    const host = this.sceneEl.nativeElement;
    const width = host.clientWidth;
    const height = host.clientHeight;

    this.scene = new THREE.Scene();
    const skyColor = new THREE.Color(0x5bb3ff);
    this.scene.background = skyColor;
    this.scene.fog = new THREE.Fog(0x87ceeb, 40, 90);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
    this.camera.position.set(0, 3.6, 3.5);
    this.camera.lookAt(0, 2.2, -14);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff4d1, 1.2);
    sun.position.set(-12, 20, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 60;
    this.scene.add(sun);

    this.buildField();
    this.buildPlayers();
    this.buildBall();

    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(host);
  }

  private buildField() {
    const grassMat = new THREE.MeshLambertMaterial({ color: 0x3f9b3f });
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = 0;
    grass.receiveShadow = true;
    this.scene.add(grass);

    const dirtMat = new THREE.MeshLambertMaterial({ color: 0xc08040 });
    const infieldShape = new THREE.Shape();
    const R = 13;
    infieldShape.moveTo(0, -0.5);
    infieldShape.quadraticCurveTo(R, -0.5, R * 0.7, -R * 0.7);
    infieldShape.quadraticCurveTo(0, -R, -R * 0.7, -R * 0.7);
    infieldShape.quadraticCurveTo(-R, -0.5, 0, -0.5);
    const infield = new THREE.Mesh(new THREE.ShapeGeometry(infieldShape), dirtMat);
    infield.rotation.x = -Math.PI / 2;
    infield.position.y = 0.01;
    infield.receiveShadow = true;
    this.scene.add(infield);

    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.6, 0.35, 24),
      new THREE.MeshLambertMaterial({ color: 0xb58660 }),
    );
    mound.position.set(0, 0.175, -15);
    mound.castShadow = true;
    mound.receiveShadow = true;
    this.scene.add(mound);

    const plateMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 1.1), plateMat);
    plate.position.set(0, 0.025, 0.5);
    plate.rotation.y = Math.PI / 4;
    plate.receiveShadow = true;
    this.scene.add(plate);

    const baseMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const baseGeo = new THREE.BoxGeometry(0.9, 0.1, 0.9);
    const bases = [
      new THREE.Vector3(8.5, 0.05, -7),
      new THREE.Vector3(0, 0.05, -15.5),
      new THREE.Vector3(-8.5, 0.05, -7),
    ];
    for (const p of bases) {
      const b = new THREE.Mesh(baseGeo, baseMat);
      b.position.copy(p);
      b.rotation.y = Math.PI / 4;
      b.castShadow = true;
      b.receiveShadow = true;
      this.scene.add(b);
    }

    const fenceGeo = new THREE.TorusGeometry(32, 0.25, 8, 40, Math.PI);
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x1f3a5a });
    const fence = new THREE.Mesh(fenceGeo, fenceMat);
    fence.rotation.x = Math.PI / 2;
    fence.rotation.z = Math.PI;
    fence.position.set(0, 1.2, -4);
    this.scene.add(fence);

    const wallMat = new THREE.MeshLambertMaterial({ color: 0x2a4d7a });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(32, 32, 2.4, 48, 1, true, 0, Math.PI), wallMat);
    wall.position.set(0, 1.2, -4);
    wall.rotation.y = Math.PI;
    this.scene.add(wall);
  }

  private buildPlayers() {
    this.pitcherGroup = this.buildFigure(0x1d4ed8, 0xf1c27d);
    this.pitcherGroup.position.set(0, 0.35, -15);
    this.scene.add(this.pitcherGroup);

    this.batterGroup = this.buildFigure(0xdc2626, 0xf1c27d);
    this.batterGroup.position.set(1.4, 0.05, 0.9);
    this.batterGroup.rotation.y = Math.PI;
    this.scene.add(this.batterGroup);

    const batMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
    const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.4, 8), batMat);
    bat.position.set(-0.45, 2.0, 0.1);
    bat.rotation.z = Math.PI / 3;
    bat.castShadow = true;
    this.batterGroup.add(bat);
  }

  private buildFigure(shirtColor: number, skinColor: number): THREE.Group {
    const g = new THREE.Group();
    const legMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5), legMat);
    legs.position.y = 0.45;
    legs.castShadow = true;
    g.add(legs);

    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 1.0, 0.55),
      new THREE.MeshLambertMaterial({ color: shirtColor }),
    );
    torso.position.y = 1.4;
    torso.castShadow = true;
    g.add(torso);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 16, 16),
      new THREE.MeshLambertMaterial({ color: skinColor }),
    );
    head.position.y = 2.12;
    head.castShadow = true;
    g.add(head);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.18, 16),
      new THREE.MeshLambertMaterial({ color: shirtColor }),
    );
    cap.position.y = 2.34;
    g.add(cap);

    return g;
  }

  private buildBall() {
    const geo = new THREE.SphereGeometry(0.18, 20, 20);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.ball = new THREE.Mesh(geo, mat);
    this.ball.castShadow = true;
    this.ball.visible = false;
    this.scene.add(this.ball);
  }

  private handleResize() {
    if (!this.renderer || !this.camera) return;
    const host = this.sceneEl.nativeElement;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private startRenderLoop() {
    const loop = () => {
      this.tickBall();
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private tickBall() {
    const p = this.activePitch();
    if (!p || this.phase() !== 'pitching') {
      this.ball.visible = false;
      return;
    }
    const t = performance.now() - p.t0;
    const progress = Math.min(1, t / p.flightMs);
    const pos = this.computeBallPos(p, progress);
    this.ball.position.copy(pos);
    this.ball.visible = true;

    if (t >= p.flightMs && p.swungAt === null) {
      if (this.mode() === 'multi') {
        if (this.myTurnAsBatter()) {
          this.ws.send({ type: 'miss', pitchType: p.type });
        }
      } else {
        this.finishMiss(p.type);
      }
    }
  }

  private computeBallPos(p: ActivePitch, progress: number): THREE.Vector3 {
    const start = RELEASE_POS;
    const end = PLATE_POS;
    let x = start.x + (end.x - start.x) * progress;
    let y = start.y + (end.y - start.y) * progress;
    const z = start.z + (end.z - start.z) * progress;

    switch (p.type) {
      case 'straight':
        break;
      case 'curl': {
        const amt = Math.sin(progress * Math.PI) * 2.6 * p.curlSign;
        x += amt;
        break;
      }
      case 'zigzag': {
        const amt = Math.sin(progress * Math.PI * 5) * 1.1 * p.curlSign;
        x += amt;
        break;
      }
      case 'flyball': {
        const arc = Math.sin(progress * Math.PI) * 3.2;
        y += arc;
        break;
      }
    }
    return new THREE.Vector3(x, y, z);
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
    const curlSign = seed % 2 === 0 ? 1 : -1;
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
        const type = aiPickPitch();
        const seed = Math.floor(Math.random() * 1e9);
        this.startPitchAnimation(type, seed, performance.now());
      }
    }, 900);
    this.innerTimeouts.push(id);
  }

  private bannerFor(o: SwingOutcome): string {
    switch (o.quality) {
      case 'home_run': return o.runsScored > 1 ? `HOME RUN! +${o.runsScored}` : 'HOME RUN!';
      case 'triple':   return o.runsScored > 0 ? `Triple! +${o.runsScored}` : 'Triple!';
      case 'double':   return o.runsScored > 0 ? `Double! +${o.runsScored}` : 'Double!';
      case 'single':   return o.runsScored > 0 ? `Single! +${o.runsScored}` : 'Single!';
      case 'strike':   return 'Strike!';
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
