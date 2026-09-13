"use strict";

// Remote audio: Chromium plays into a PulseAudio null sink on the server; ffmpeg reads
// that sink's monitor and encodes it, and the packets travel to clients as binary
// WebSocket messages next to the screencast frames.
//
//   [0]     AUDIO_FRAME_TYPE (2)
//   [1]     format: 1 = Opus (48 kHz stereo, 20 ms packets), 2 = PCM s16le (24 kHz stereo)
//   [2..5]  sequence number (uint32, big-endian) so a client can notice gaps
//   [6..]   payload

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");

const AUDIO_FRAME_TYPE = 2;
const AUDIO_HEADER_BYTES = 6;
const AUDIO_FORMAT = { opus: 1, pcm: 2 };
const AUDIO_FORMATS = Object.keys(AUDIO_FORMAT);

const CHANNELS = 2;
const OPUS_RATE = 48000;
const OPUS_FRAME_MS = 20;
const PCM_RATE = 24000;
const PCM_CHUNK_MS = 20;
const PCM_CHUNK_BYTES = (PCM_RATE * CHANNELS * 2 * PCM_CHUNK_MS) / 1000;

const FFMPEG_CANDIDATES = [process.env.FFMPEG_PATH, "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"].filter(Boolean);

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function findFfmpeg() {
  const fromEnv = process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim();
  if (fromEnv) return fromEnv;
  for (const p of FFMPEG_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return "ffmpeg";
}

function encodeAudio(format, seq, payload) {
  const header = Buffer.alloc(AUDIO_HEADER_BYTES);
  header.writeUInt8(AUDIO_FRAME_TYPE, 0);
  header.writeUInt8(AUDIO_FORMAT[format] || 0, 1);
  header.writeUInt32BE(seq >>> 0, 2);
  return Buffer.concat([header, payload]);
}

function decodeAudioHeader(buf) {
  if (!buf || buf.length < AUDIO_HEADER_BYTES || buf.readUInt8(0) !== AUDIO_FRAME_TYPE) return null;
  const code = buf.readUInt8(1);
  const format = AUDIO_FORMATS.find((f) => AUDIO_FORMAT[f] === code) || null;
  return { format, seq: buf.readUInt32BE(2), offset: AUDIO_HEADER_BYTES };
}

// Minimal Ogg demuxer: turns the byte stream ffmpeg writes into individual packets.
// The two Opus header packets (OpusHead, OpusTags) are dropped; a WebCodecs decoder is
// configured out of band and only wants audio packets.
class OggDemuxer {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.partial = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      const idx = this.buf.indexOf("OggS", off);
      if (idx < 0) {
        off = Math.max(off, this.buf.length - 3);
        break;
      }
      if (this.buf.length < idx + 27) {
        off = idx;
        break;
      }
      const nsegs = this.buf[idx + 26];
      const headerLen = 27 + nsegs;
      if (this.buf.length < idx + headerLen) {
        off = idx;
        break;
      }
      let bodyLen = 0;
      for (let i = 0; i < nsegs; i += 1) bodyLen += this.buf[idx + 27 + i];
      if (this.buf.length < idx + headerLen + bodyLen) {
        off = idx;
        break;
      }
      let pos = idx + headerLen;
      for (let i = 0; i < nsegs; i += 1) {
        const len = this.buf[idx + 27 + i];
        if (len) this.partial.push(this.buf.subarray(pos, pos + len));
        pos += len;
        if (len < 255) {
          const packet = this.partial.length === 1 ? this.partial[0] : Buffer.concat(this.partial);
          this.partial = [];
          this._emit(packet);
        }
      }
      off = pos;
    }
    this.buf = off > 0 ? Buffer.from(this.buf.subarray(off)) : this.buf;
  }

  _emit(packet) {
    if (packet.length >= 8) {
      const magic = packet.toString("latin1", 0, 8);
      if (magic === "OpusHead" || magic === "OpusTags") return;
    }
    if (packet.length) this.onPacket(Buffer.from(packet));
  }
}

// Fixed-size chunker for raw PCM so every message is one 20 ms slice.
class PcmChunker {
  constructor(onChunk, size = PCM_CHUNK_BYTES) {
    this.onChunk = onChunk;
    this.size = size;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.buf.length - off >= this.size) {
      this.onChunk(Buffer.from(this.buf.subarray(off, off + this.size)));
      off += this.size;
    }
    this.buf = off > 0 ? Buffer.from(this.buf.subarray(off)) : this.buf;
  }
}

function isSilent(pcm) {
  for (let i = 0; i < pcm.length; i += 2) {
    if (pcm[i] !== 0 || pcm[i + 1] !== 0) return false;
  }
  return true;
}

// One ffmpeg process per encoding, alive only while some client wants that encoding.
class AudioStreamer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.format = opts.format === "pcm" ? "pcm" : "opus";
    this.source = opts.source || process.env.AUDIO_SOURCE || "perch.monitor";
    this.bitrate = clamp(Number(opts.bitrate || process.env.AUDIO_BITRATE) || 96, 24, 256);
    this.ffmpeg = opts.ffmpegPath || findFfmpeg();
    this.proc = null;
    this.wanted = false;
    this.seq = 0;
    this.failures = 0;
    this._retry = null;
    this._silence = 0;
  }

  args() {
    const common = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "pulse",
      "-sample_rate",
      String(OPUS_RATE),
      "-channels",
      String(CHANNELS),
      // 20 ms fragments keep PulseAudio's capture latency small.
      "-fragment_size",
      String((OPUS_RATE * CHANNELS * 2 * 20) / 1000),
      "-i",
      this.source,
      "-ac",
      String(CHANNELS),
    ];
    if (this.format === "pcm") {
      return [...common, "-ar", String(PCM_RATE), "-f", "s16le", "-flush_packets", "1", "pipe:1"];
    }
    return [
      ...common,
      "-ar",
      String(OPUS_RATE),
      "-c:a",
      "libopus",
      "-b:a",
      `${this.bitrate}k`,
      "-vbr",
      "on",
      "-application",
      "audio",
      "-frame_duration",
      String(OPUS_FRAME_MS),
      "-f",
      "ogg",
      // One packet per page, flushed immediately: ffmpeg's default is a 1 s page.
      "-page_duration",
      String(OPUS_FRAME_MS * 1000),
      "-flush_packets",
      "1",
      "pipe:1",
    ];
  }

  start() {
    this.wanted = true;
    if (this.proc || this._retry) return;
    this._spawn();
  }

  stop() {
    this.wanted = false;
    if (this._retry) {
      clearTimeout(this._retry);
      this._retry = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  get running() {
    return Boolean(this.proc);
  }

  _spawn() {
    let proc;
    try {
      proc = spawn(this.ffmpeg, this.args(), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this._onExit(null, err.message);
      return;
    }
    this.proc = proc;
    this.seq = 0;
    const emit = (payload) => {
      this.failures = 0;
      this.emit("packet", encodeAudio(this.format, this.seq, payload), this.seq, payload);
      this.seq = (this.seq + 1) >>> 0;
    };
    const sink =
      this.format === "pcm"
        ? new PcmChunker((chunk) => {
            // Skip digital silence: nothing to hear, and it keeps idle bandwidth at zero.
            if (isSilent(chunk)) {
              this._silence += 1;
              if (this._silence > 1) return;
            } else {
              this._silence = 0;
            }
            emit(chunk);
          })
        : new OggDemuxer(emit);
    proc.stdout.on("data", (chunk) => sink.push(chunk));
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this._onExit(null, err.code === "ENOENT" ? `${this.ffmpeg} not found` : err.message);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this._onExit(code, stderr.trim() || signal || "");
    });
    console.log(`[home-browser] audio: ${this.format} capture from ${this.source}`);
  }

  _onExit(code, detail) {
    if (!this.wanted) return;
    this.failures += 1;
    const wait = Math.min(1000 * 2 ** Math.min(this.failures - 1, 5), 30000);
    if (this.failures <= 3 || this.failures % 10 === 0) {
      console.error(
        `[home-browser] audio (${this.format}) capture ended (${code == null ? "spawn failed" : `exit ${code}`}${
          detail ? `: ${detail.split("\n").pop()}` : ""
        }); retrying in ${wait / 1000}s`
      );
    }
    this.emit("stopped");
    this._retry = setTimeout(() => {
      this._retry = null;
      if (this.wanted) this._spawn();
    }, wait);
  }
}

module.exports = {
  AudioStreamer,
  OggDemuxer,
  PcmChunker,
  encodeAudio,
  decodeAudioHeader,
  findFfmpeg,
  isSilent,
  AUDIO_FRAME_TYPE,
  AUDIO_HEADER_BYTES,
  AUDIO_FORMAT,
  AUDIO_FORMATS,
  OPUS_RATE,
  PCM_RATE,
  PCM_CHUNK_BYTES,
  CHANNELS,
};
