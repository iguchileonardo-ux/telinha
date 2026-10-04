// Transforma o PCM vindo do processo principal em uma faixa de áudio WebRTC,
// e mede o volume de faixas para os indicadores da interface.

const RATE = 48000;

// Toca o PCM recebido com um pequeno buffer (≈40 ms) para absorver variações.
const WORKLET_SOURCE = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = ${RATE} * 2;           // 1 s de áudio estéreo intercalado
    this.buf = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.playing = false;
    this.port.onmessage = (event) => this.push(new Int16Array(event.data));
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i] / 32768;
      this.write = (this.write + 1) % this.capacity;
    }
    this.size += samples.length;
    // Atraso acumulado demais (>200 ms): descarta o excesso e volta para ~60 ms.
    const max = ${RATE} * 2 * 0.2;
    if (this.size > max) {
      let drop = this.size - ${RATE} * 2 * 0.06;
      drop -= drop % 2;
      this.read = (this.read + drop) % this.capacity;
      this.size -= drop;
    }
  }
  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    if (!this.playing && this.size >= ${RATE} * 2 * 0.04) this.playing = true;
    for (let i = 0; i < left.length; i++) {
      if (this.playing && this.size >= 2) {
        left[i] = this.buf[this.read];
        right[i] = this.buf[(this.read + 1) % this.capacity];
        this.read = (this.read + 2) % this.capacity;
        this.size -= 2;
      } else {
        left[i] = 0;
        right[i] = 0;
        this.playing = false;
      }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
`;

export async function createPcmTrack() {
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest); // NÃO conecta em ctx.destination: nada toca localmente.
  await ctx.resume().catch(() => {});
  const track = dest.stream.getAudioTracks()[0];

  return {
    track,
    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const usable = bytes.byteLength - (bytes.byteLength % 2);
      if (!usable) return;
      const copy = bytes.slice(0, usable).buffer;
      node.port.postMessage(copy, [copy]);
    },
    close() {
      track.stop();
      node.disconnect();
      ctx.close().catch(() => {});
    },
  };
}

// ---- medidor de volume ----

let meterCtx = null;

// Chama onLevel(0..1) ~12x por segundo enquanto o stream tiver áudio. Retorna função para parar.
export function watchLevel(stream, onLevel) {
  if (!stream?.getAudioTracks().length) return () => {};
  meterCtx ??= new AudioContext();
  meterCtx.resume().catch(() => {});
  let source;
  try {
    source = meterCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  } catch {
    return () => {};
  }
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let smooth = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 4);
    smooth = Math.max(level, smooth * 0.8);
    onLevel(smooth);
  }, 80);
  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
  };
}
