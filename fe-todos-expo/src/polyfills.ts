// Polyfills for RN. Hermes 0.74+ ships `crypto.randomUUID`, but several
// dependency stacks still expect `getRandomValues` to be present even
// when randomUUID exists. The shim is tiny and a no-op on platforms
// where it's already available — safer to always import it first.
import 'react-native-get-random-values';

// Confirm the runtime has randomUUID available now. RN 0.81 / Hermes
// ships it; on older stacks `expo-crypto` provides a polyfill (we'd
// alias it here if needed).
if (typeof crypto?.randomUUID !== 'function') {
  // Fallback: random hex with a v4-shaped layout. Not crypto-quality but
  // good enough for the queue's correlation keys; in practice every
  // supported RN version has the real thing.
  const fallback = () => {
    const bytes = new Uint8Array(16);
    (
      globalThis.crypto ?? (globalThis as { crypto: Crypto }).crypto
    ).getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  if (!globalThis.crypto) (globalThis as { crypto: Crypto }).crypto = {} as Crypto;
  (globalThis.crypto as { randomUUID?: () => string }).randomUUID = fallback;
}
