/**
 * A compact acoustic fingerprint: one 32-bit word per short step of audio.
 *
 * The scheme is Haitsma and Kalker's (2002): split each frame's spectrum into
 * 33 bands on a logarithmic scale between 300 and 2000 Hz, and record, for each
 * neighbouring pair of bands, whether the difference between them grew or
 * shrank since the previous frame. Only the sign of a change survives, so the
 * word is the same whether the theme tune was mixed louder, encoded as AAC
 * instead of E-AC-3, or resampled on the way here — which is exactly the
 * difference between one episode's copy of an intro and the next one's.
 *
 * Written here rather than taken from chromaprint because the FFmpeg on the
 * server is not guaranteed to have been built with it, and nothing else in the
 * pipeline needs it.
 */

/** Decode rate. The bands stop at 2 kHz, so 5.5 kHz keeps everything used. */
export const FINGERPRINT_SAMPLE_RATE = 5_512;
const FRAME_SIZE = 2_048;
/**
 * One word every ~23 ms. Two copies of a theme are almost never shifted by a
 * whole number of words, and the words drift apart as the misalignment grows
 * towards half a hop; at this step the worst case still compares cleanly.
 */
export const FINGERPRINT_HOP = 128;
export const FINGERPRINT_SECONDS_PER_WORD =
  FINGERPRINT_HOP / FINGERPRINT_SAMPLE_RATE;

const BAND_COUNT = 33;
const MIN_FREQUENCY = 300;
const MAX_FREQUENCY = 2_000;

/** The FFT bin each band edge falls in, computed once. */
const BAND_EDGES: number[] = (() => {
  const edges: number[] = [];
  const ratio = Math.pow(MAX_FREQUENCY / MIN_FREQUENCY, 1 / BAND_COUNT);
  for (let band = 0; band <= BAND_COUNT; band += 1) {
    const frequency = MIN_FREQUENCY * Math.pow(ratio, band);
    edges.push(Math.round((frequency * FRAME_SIZE) / FINGERPRINT_SAMPLE_RATE));
  }
  return edges;
})();

const HANN: Float64Array = (() => {
  const window = new Float64Array(FRAME_SIZE);
  for (let index = 0; index < FRAME_SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / FRAME_SIZE);
  }
  return window;
})();

/** Bit-reversal permutation for a `FRAME_SIZE` transform. */
const BIT_REVERSED: Uint32Array = (() => {
  const table = new Uint32Array(FRAME_SIZE);
  const bits = Math.log2(FRAME_SIZE);
  for (let index = 0; index < FRAME_SIZE; index += 1) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((index >> bit) & 1);
    }
    table[index] = reversed;
  }
  return table;
})();

const COSINE = new Float64Array(FRAME_SIZE / 2);
const SINE = new Float64Array(FRAME_SIZE / 2);
for (let index = 0; index < FRAME_SIZE / 2; index += 1) {
  COSINE[index] = Math.cos((-2 * Math.PI * index) / FRAME_SIZE);
  SINE[index] = Math.sin((-2 * Math.PI * index) / FRAME_SIZE);
}

/** In-place iterative radix-2 FFT of `FRAME_SIZE` points. */
function fft(real: Float64Array, imaginary: Float64Array): void {
  for (let index = 0; index < FRAME_SIZE; index += 1) {
    const reversed = BIT_REVERSED[index]!;
    if (index < reversed) {
      const swapReal = real[index]!;
      real[index] = real[reversed]!;
      real[reversed] = swapReal;
      const swapImaginary = imaginary[index]!;
      imaginary[index] = imaginary[reversed]!;
      imaginary[reversed] = swapImaginary;
    }
  }
  for (let length = 2; length <= FRAME_SIZE; length <<= 1) {
    const halfLength = length >> 1;
    const stride = FRAME_SIZE / length;
    for (let start = 0; start < FRAME_SIZE; start += length) {
      for (let offset = 0; offset < halfLength; offset += 1) {
        const even = start + offset;
        const odd = even + halfLength;
        const twiddleReal = COSINE[offset * stride]!;
        const twiddleImaginary = SINE[offset * stride]!;
        const oddReal =
          real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary =
          real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
      }
    }
  }
}

/**
 * Fingerprints mono signed 16-bit PCM at `FINGERPRINT_SAMPLE_RATE`.
 *
 * Word `n` describes the audio starting at `n * FINGERPRINT_SECONDS_PER_WORD`
 * seconds into the samples given. Fewer samples than one frame produce none.
 */
export function fingerprintPcm(samples: Int16Array): Uint32Array {
  const frameCount =
    samples.length < FRAME_SIZE
      ? 0
      : Math.floor((samples.length - FRAME_SIZE) / FINGERPRINT_HOP) + 1;
  if (frameCount < 2) return new Uint32Array(0);

  const words = new Uint32Array(frameCount - 1);
  const real = new Float64Array(FRAME_SIZE);
  const imaginary = new Float64Array(FRAME_SIZE);
  let previous = new Float64Array(BAND_COUNT);
  let current = new Float64Array(BAND_COUNT);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * FINGERPRINT_HOP;
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      real[index] = (samples[offset + index]! / 32_768) * HANN[index]!;
      imaginary[index] = 0;
    }
    fft(real, imaginary);

    for (let band = 0; band < BAND_COUNT; band += 1) {
      let energy = 0;
      for (let bin = BAND_EDGES[band]!; bin < BAND_EDGES[band + 1]!; bin += 1) {
        energy += real[bin]! * real[bin]! + imaginary[bin]! * imaginary[bin]!;
      }
      current[band] = energy;
    }

    if (frame > 0) {
      let word = 0;
      for (let band = 0; band < BAND_COUNT - 1; band += 1) {
        const change =
          current[band]! -
          current[band + 1]! -
          (previous[band]! - previous[band + 1]!);
        if (change > 0) word |= 1 << band;
      }
      words[frame - 1] = word >>> 0;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return words;
}

/** Bits that differ between two words. */
export function bitErrors(left: number, right: number): number {
  let value = (left ^ right) >>> 0;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
