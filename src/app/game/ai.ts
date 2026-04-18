import { PITCH_CONTACT_MS, PitchType } from './models';

const PITCH_TYPES: PitchType[] = ['straight', 'curl', 'zigzag', 'flyball'];

export function aiPickPitch(): PitchType {
  const weights = [0.35, 0.25, 0.2, 0.2];
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < PITCH_TYPES.length; i++) {
    acc += weights[i];
    if (r < acc) return PITCH_TYPES[i];
  }
  return 'straight';
}

export function aiSwingOffsetMs(pitch: PitchType): number {
  const contact = PITCH_CONTACT_MS[pitch];
  const bias = pitch === 'zigzag' ? 60 : pitch === 'curl' ? 40 : 20;
  const jitter = (Math.random() - 0.5) * 280;
  const swingAt = contact + jitter + (Math.random() < 0.15 ? 600 : 0);
  return swingAt - contact + (Math.random() - 0.5) * bias;
}

export function aiSwingTimeMs(pitch: PitchType): number | null {
  if (Math.random() < 0.12) return null;
  const contact = PITCH_CONTACT_MS[pitch];
  const bias = pitch === 'zigzag' ? 80 : pitch === 'curl' ? 60 : 30;
  const jitter = (Math.random() - 0.5) * 260 + (Math.random() - 0.5) * bias;
  return Math.max(150, contact + jitter);
}
