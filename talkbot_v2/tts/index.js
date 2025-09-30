import * as openai from './providers/openai.js';
import * as microsoft from './providers/microsoft.js';

const providers = {
  openai,
  microsoft
  // piper:     await import('./providers/piper.js')     (later)
};

export function getTTSProvider(name) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown TTS provider: ${name}`);
  if (typeof p.speak !== 'function') throw new Error(`Provider ${name} missing speak()`);
  return p;
}
