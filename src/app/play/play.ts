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
  Bases,
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

interface RunnerAnimEntry {
  group: THREE.Group;
  waypoints: THREE.Vector3[];
  durationPerBase: number;
  scored: boolean;
}

interface PostHitAnim {
  startTime: number;
  quality: HitQuality;
  ballTo: THREE.Vector3;
  ballFlightMs: number;
  chaserIdx: number;
  chaserFrom: THREE.Vector3;
  chaserReachMs: number;
  throwTo: THREE.Vector3;
  throwDuration: number;
  runners: RunnerAnimEntry[];
  totalDuration: number;
}

const RELEASE_POS = new THREE.Vector3(0, 2.4, -16);
const PLATE_POS = new THREE.Vector3(0, 1.3, 0.2);

const BASE_POS = [
  new THREE.Vector3(1.4, 0.05, 0.9),
  new THREE.Vector3(8.5, 0.05, -7),
  new THREE.Vector3(0, 0.05, -15.5),
  new THREE.Vector3(-8.5, 0.05, -7),
];

const FIELDER_HOME = [
  new THREE.Vector3(10, 0.05, -8),
  new THREE.Vector3(3, 0.05, -13),
  new THREE.Vector3(-3, 0.05, -13),
  new THREE.Vector3(-10, 0.05, -8),
  new THREE.Vector3(-18, 0.05, -28),
  new THREE.Vector3(0, 0.05, -32),
  new THREE.Vector3(18, 0.05, -28),
];

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

  readonly displayP1Score = computed(() => {
    const s = this.state();
    return s.p1Score + (s.half.batter === 'p1' ? s.half.runs : 0);
  });

  readonly displayP2Score = computed(() => {
    const s = this.state();
    return s.p2Score + (s.half.batter === 'p2' ? s.half.runs : 0);
  });

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private ball!: THREE.Mesh;
  private pitcherGroup!: THREE.Group;
  private batterGroup!: THREE.Group;
  private batPivot!: THREE.Group;
  private batMesh!: THREE.Mesh;
  private fielderGroups: THREE.Group[] = [];
  private runnerPool: THREE.Group[] = [];
  private rafId: number | null = null;
  private resizeObs: ResizeObserver | null = null;
  private offWs: (() => void) | null = null;
  private innerTimeouts: number[] = [];

  private swingStart: number | null = null;
  private swingResetId: number | null = null;
  private postHit: PostHitAnim | null = null;

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
      if (this.swingResetId) clearTimeout(this.swingResetId);
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
    this.updateBaseRunners();
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
    this.camera.position.set(0, 4.2, 5.5);
    this.camera.lookAt(0, 1.8, -14);

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

    this.batPivot = new THREE.Group();
    this.batPivot.position.set(0, 1.7, 0.1);
    this.batPivot.rotation.y = 0.6;
    this.batterGroup.add(this.batPivot);

    const batMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
    this.batMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.4, 8), batMat);
    this.batMesh.rotation.z = -Math.PI / 2 + Math.PI / 8;
    this.batMesh.position.set(-0.7, 0.25, 0);
    this.batMesh.castShadow = true;
    this.batPivot.add(this.batMesh);

    for (const pos of FIELDER_HOME) {
      const f = this.buildFigure(0x1d4ed8, 0xf1c27d);
      f.position.copy(pos);
      f.rotation.y = Math.atan2(-pos.x, 0.5 - pos.z);
      this.scene.add(f);
      this.fielderGroups.push(f);
    }

    for (let i = 0; i < 4; i++) {
      const r = this.buildFigure(0xdc2626, 0xf1c27d);
      r.visible = false;
      this.scene.add(r);
      this.runnerPool.push(r);
    }
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
      this.tickSwing();
      this.tickBall();
      this.tickPostHit();
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private tickSwing() {
    if (this.swingStart === null) return;
    const elapsed = performance.now() - this.swingStart;
    const dur = 250;
    const t = Math.min(1, elapsed / dur);
    const ease = 1 - (1 - t) * (1 - t);
    this.batPivot.rotation.y = 0.6 + (-2.4 - 0.6) * ease;

    if (t >= 1 && this.swingResetId === null) {
      this.swingResetId = window.setTimeout(() => {
        this.batPivot.rotation.y = 0.6;
        this.swingStart = null;
        this.swingResetId = null;
      }, 400);
      this.innerTimeouts.push(this.swingResetId);
    }
  }

  private tickBall() {
    const p = this.activePitch();
    if (p && this.phase() === 'pitching') {
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
      return;
    }

    if (this.postHit) {
      const a = this.postHit;
      const elapsed = performance.now() - a.startTime;

      if (elapsed < a.ballFlightMs) {
        const t = elapsed / a.ballFlightMs;
        const x = PLATE_POS.x + (a.ballTo.x - PLATE_POS.x) * t;
        const z = PLATE_POS.z + (a.ballTo.z - PLATE_POS.z) * t;
        let arc: number;
        switch (a.quality) {
          case 'single': arc = 4; break;
          case 'double': arc = 7; break;
          case 'triple': arc = 10; break;
          case 'home_run': arc = 14; break;
          default: arc = 0;
        }
        const y = PLATE_POS.y + (a.ballTo.y - PLATE_POS.y) * t + arc * Math.sin(t * Math.PI);
        this.ball.position.set(x, y, z);
        this.ball.visible = true;
      } else if (a.quality === 'home_run') {
        this.ball.visible = false;
      } else if (elapsed < a.chaserReachMs) {
        this.ball.position.copy(a.ballTo);
        this.ball.visible = true;
      } else if (elapsed < a.chaserReachMs + a.throwDuration) {
        const tt = (elapsed - a.chaserReachMs) / a.throwDuration;
        const x = a.ballTo.x + (a.throwTo.x - a.ballTo.x) * tt;
        const z = a.ballTo.z + (a.throwTo.z - a.ballTo.z) * tt;
        const y = a.ballTo.y + (a.throwTo.y - a.ballTo.y) * tt + 2 * Math.sin(tt * Math.PI);
        this.ball.position.set(x, y, z);
        this.ball.visible = true;
      } else {
        this.ball.visible = false;
      }
      return;
    }

    this.ball.visible = false;
  }

  private tickPostHit() {
    if (!this.postHit) return;
    const a = this.postHit;
    const elapsed = performance.now() - a.startTime;

    for (const r of a.runners) {
      const segs = r.waypoints.length - 1;
      if (segs <= 0) continue;
      const total = segs * r.durationPerBase;
      const t = Math.min(1, elapsed / total);
      const seg = Math.min(Math.floor(t * segs), segs - 1);
      const segT = t * segs - seg;
      r.group.position.lerpVectors(r.waypoints[seg], r.waypoints[Math.min(seg + 1, segs)], segT);
      r.group.visible = !(r.scored && t >= 1);
      if (seg < segs) {
        const dx = r.waypoints[seg + 1].x - r.waypoints[seg].x;
        const dz = r.waypoints[seg + 1].z - r.waypoints[seg].z;
        r.group.rotation.y = Math.atan2(dx, dz);
      }
    }

    if (a.quality !== 'home_run') {
      const chaser = this.fielderGroups[a.chaserIdx];
      if (elapsed < a.chaserReachMs) {
        const t = Math.min(1, elapsed / a.chaserReachMs);
        chaser.position.lerpVectors(a.chaserFrom, a.ballTo, t);
        const dx = a.ballTo.x - chaser.position.x;
        const dz = a.ballTo.z - chaser.position.z;
        if (Math.abs(dx) + Math.abs(dz) > 0.1) {
          chaser.rotation.y = Math.atan2(dx, dz);
        }
      } else {
        chaser.position.copy(a.ballTo);
        const dx = a.throwTo.x - a.ballTo.x;
        const dz = a.throwTo.z - a.ballTo.z;
        chaser.rotation.y = Math.atan2(dx, dz);
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
        const radius = 1.8 * (1 - progress * 0.3);
        const revolutions = 3;
        const angle = progress * revolutions * Math.PI * 2 * p.curlSign;
        x += Math.sin(angle) * radius;
        y += Math.cos(angle) * radius * 0.6;
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

  private startPostHitAnim(outcome: SwingOutcome, oldBases: Bases, seed: number) {
    const quality = outcome.quality;
    const advance = outcome.basesAdvanced;

    const ballTo = this.computeLandingPos(quality, seed);
    let ballFlightMs: number;
    switch (quality) {
      case 'single': ballFlightMs = 700; break;
      case 'double': ballFlightMs = 900; break;
      case 'triple': ballFlightMs = 1100; break;
      case 'home_run': ballFlightMs = 1400; break;
      default: ballFlightMs = 700;
    }

    const chaserIdx = this.findNearestFielder(ballTo);
    const chaserFrom = FIELDER_HOME[chaserIdx].clone();
    const chaserDist = chaserFrom.distanceTo(ballTo);
    const chaserRunMs = (chaserDist / 12) * 1000;
    const chaserReachMs = Math.max(ballFlightMs, chaserRunMs);

    const throwTo = new THREE.Vector3(0, 1.5, -15);
    const throwDuration = 450;

    const runners: RunnerAnimEntry[] = [];
    let poolIdx = 0;
    const occ = [oldBases.first, oldBases.second, oldBases.third];

    for (let i = 2; i >= 0; i--) {
      if (!occ[i]) continue;
      const fromBase = i + 1;
      const toBase = fromBase + advance;
      const wp: THREE.Vector3[] = [];
      for (let b = fromBase; b <= Math.min(toBase, 4); b++) {
        wp.push(BASE_POS[b % 4].clone());
      }
      runners.push({
        group: this.runnerPool[poolIdx++],
        waypoints: wp,
        durationPerBase: 500,
        scored: toBase >= 4,
      });
    }

    if (advance > 0) {
      const wp: THREE.Vector3[] = [];
      for (let b = 0; b <= Math.min(advance, 4); b++) {
        wp.push(BASE_POS[b % 4].clone());
      }
      runners.push({
        group: this.runnerPool[poolIdx++],
        waypoints: wp,
        durationPerBase: 500,
        scored: advance >= 4,
      });
      this.batterGroup.visible = false;
    }

    for (const r of runners) {
      r.group.visible = true;
      r.group.position.copy(r.waypoints[0]);
    }
    for (let i = poolIdx; i < 4; i++) {
      this.runnerPool[i].visible = false;
    }

    const maxRunMs = runners.reduce((m, r) => Math.max(m, (r.waypoints.length - 1) * r.durationPerBase), 0);
    let totalDuration: number;
    if (quality === 'home_run') {
      totalDuration = Math.max(ballFlightMs, maxRunMs) + 500;
    } else {
      totalDuration = Math.max(chaserReachMs + throwDuration + 300, maxRunMs + 300);
    }

    this.postHit = {
      startTime: performance.now(),
      quality,
      ballTo,
      ballFlightMs,
      chaserIdx,
      chaserFrom,
      chaserReachMs,
      throwTo,
      throwDuration,
      runners,
      totalDuration,
    };
  }

  private computeLandingPos(quality: HitQuality, seed: number): THREE.Vector3 {
    const range = 70;
    const angle = ((seed % range) - range / 2) * Math.PI / 180;
    let dist: number;
    switch (quality) {
      case 'single': dist = 11 + (seed % 6); break;
      case 'double': dist = 20 + (seed % 6); break;
      case 'triple': dist = 28 + (seed % 5); break;
      case 'home_run': dist = 36 + (seed % 5); break;
      default: dist = 0;
    }
    return new THREE.Vector3(Math.sin(angle) * dist, 0.2, -Math.cos(angle) * dist);
  }

  private findNearestFielder(target: THREE.Vector3): number {
    let min = Infinity;
    let idx = 0;
    for (let i = 0; i < FIELDER_HOME.length; i++) {
      const d = FIELDER_HOME[i].distanceTo(target);
      if (d < min) { min = d; idx = i; }
    }
    return idx;
  }

  private resetFielderPositions() {
    for (let i = 0; i < this.fielderGroups.length; i++) {
      this.fielderGroups[i].position.copy(FIELDER_HOME[i]);
      this.fielderGroups[i].rotation.y = Math.atan2(-FIELDER_HOME[i].x, 0.5 - FIELDER_HOME[i].z);
    }
  }

  private updateBaseRunners() {
    const bases = this.state().half.bases;
    const occ = [bases.first, bases.second, bases.third];
    for (let i = 0; i < 3; i++) {
      if (occ[i]) {
        this.runnerPool[i].visible = true;
        this.runnerPool[i].position.copy(BASE_POS[i + 1]);
      } else {
        this.runnerPool[i].visible = false;
      }
    }
    this.runnerPool[3].visible = false;
    this.batterGroup.visible = true;
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

    this.swingStart = now;

    if (this.mode() === 'multi' && this.myTurnAsBatter()) {
      this.ws.send({ type: 'swing', offsetMs, pitchType: p.type });
    } else {
      this.finishSwing(offsetMs, p.type);
    }
  }

  private finishSwing(offsetMs: number, pitchType: PitchType) {
    const cur = this.state();
    const { state: next, outcome } = applySwing(cur, offsetMs, pitchType);
    this.afterResolution(next, outcome, cur.half.batter, cur.half.bases);
  }

  private finishMiss(pitchType: PitchType) {
    const cur = this.state();
    const { state: next, outcome } = applySwing(cur, 9999, pitchType);
    this.afterResolution(next, outcome, cur.half.batter, cur.half.bases);
  }

  private afterResolution(next: GameState, outcome: SwingOutcome, batter: PlayerId, oldBases: Bases) {
    const seed = this.activePitch()?.seed ?? Math.floor(Math.random() * 1e9);

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

    let breakMs: number;
    if (outcome.quality === 'strike') {
      breakMs = 1000;
      this.updateBaseRunners();
    } else {
      this.startPostHitAnim(outcome, oldBases, seed);
      breakMs = this.postHit!.totalDuration + 300;
    }

    const id = window.setTimeout(() => {
      this.postHit = null;
      this.resetFielderPositions();
      this.updateBaseRunners();

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
    this.postHit = null;
    this.swingStart = null;
    this.batPivot.rotation.y = 0.6;
    this.resetFielderPositions();
    this.updateBaseRunners();
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
