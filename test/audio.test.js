"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  AudioStreamer,
  OggDemuxer,
  PcmChunker,
  encodeAudio,
  decodeAudioHeader,
  isSilent,
  AUDIO_HEADER_BYTES,
  PCM_CHUNK_BYTES,
} = require("../src/audio");

// Build one Ogg page from explicit lacing values and body bytes.
function oggPage(lacing, body, pageNo = 0) {
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "latin1");
  header.writeUInt8(0, 4);
  header.writeUInt8(pageNo === 0 ? 2 : 0, 5);
  header.writeUInt32LE(pageNo, 18);
  header.writeUInt8(lacing.length, 26);
  lacing.forEach((v, i) => header.writeUInt8(v, 27 + i));
  return Buffer.concat([header, body]);
}

describe("audio message protocol", () => {
  it("round-trips format, sequence and payload", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const buf = encodeAudio("opus", 4_000_000_000, payload);
    assert.equal(buf.length, AUDIO_HEADER_BYTES + payload.length);
    assert.equal(buf[0], 2);
    const header = decodeAudioHeader(buf);
    assert.deepEqual(header, { format: "opus", seq: 4_000_000_000, offset: AUDIO_HEADER_BYTES });
    assert.deepEqual(buf.subarray(header.offset), payload);
    assert.equal(decodeAudioHeader(encodeAudio("pcm", 7, payload)).format, "pcm");
  });

  it("does not mistake a video frame for audio", () => {
    assert.equal(decodeAudioHeader(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0])), null);
    assert.equal(decodeAudioHeader(Buffer.alloc(3)), null);
  });
});

describe("OggDemuxer", () => {
  it("emits packets, skips Opus headers, and joins packets that span pages", () => {
    const head = Buffer.from("OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00", "latin1");
    const tags = Buffer.from("OpusTags\x00\x00\x00\x00\x00\x00\x00\x00", "latin1");
    const p1 = Buffer.alloc(300, 0xa1);
    const p2 = Buffer.alloc(10, 0xb2);
    const p3 = Buffer.alloc(355, 0xc3);
    const pages = Buffer.concat([
      oggPage([head.length], head, 0),
      oggPage([tags.length], tags, 1),
      oggPage([255, 45, 10, 255], Buffer.concat([p1, p2, p3.subarray(0, 255)]), 2),
      oggPage([100], p3.subarray(255), 3),
    ]);
    const got = [];
    const demux = new OggDemuxer((pkt) => got.push(pkt));
    // Feed in awkward chunk sizes so page boundaries fall mid-header and mid-body.
    for (let i = 0; i < pages.length; i += 37) demux.push(pages.subarray(i, i + 37));
    assert.equal(got.length, 3);
    assert.deepEqual(got[0], p1);
    assert.deepEqual(got[1], p2);
    assert.deepEqual(got[2], p3);
  });

  it("emits a zero-length lacing packet boundary correctly", () => {
    const got = [];
    const demux = new OggDemuxer((pkt) => got.push(pkt));
    demux.push(oggPage([3, 0, 2], Buffer.from([1, 2, 3, 9, 9]), 5));
    // A 0 lacing value ends an empty packet, which is dropped; the others survive.
    assert.deepEqual(got.map((b) => [...b]), [[1, 2, 3], [9, 9]]);
  });
});

describe("PcmChunker", () => {
  it("slices the stream into fixed 20 ms chunks", () => {
    const got = [];
    const chunker = new PcmChunker((c) => got.push(c.length), 8);
    chunker.push(Buffer.alloc(5));
    chunker.push(Buffer.alloc(12));
    chunker.push(Buffer.alloc(7));
    assert.deepEqual(got, [8, 8, 8]);
    assert.equal(PCM_CHUNK_BYTES, 1920);
  });

  it("detects digital silence", () => {
    assert.equal(isSilent(Buffer.alloc(16)), true);
    const b = Buffer.alloc(16);
    b[9] = 1;
    assert.equal(isSilent(b), false);
  });
});

describe("AudioStreamer", () => {
  it("builds an Opus ffmpeg command that flushes every packet", () => {
    const a = new AudioStreamer({ format: "opus", source: "perch.monitor", bitrate: 64, ffmpegPath: "/x/ffmpeg" });
    const args = a.args().join(" ");
    assert.match(args, /-f pulse .*-i perch\.monitor/);
    assert.match(args, /-c:a libopus -b:a 64k/);
    assert.match(args, /-f ogg -page_duration 20000 -flush_packets 1 pipe:1$/);
    assert.equal(a.running, false);
  });

  it("builds a raw PCM command at 24 kHz stereo", () => {
    const a = new AudioStreamer({ format: "pcm", source: "s", ffmpegPath: "/x/ffmpeg" });
    assert.match(a.args().join(" "), /-ac 2 -ar 24000 -f s16le -flush_packets 1 pipe:1$/);
  });

  it("retries when ffmpeg is missing and stops cleanly", async () => {
    const a = new AudioStreamer({ format: "pcm", source: "s", ffmpegPath: "/nonexistent/ffmpeg" });
    const origError = console.error;
    const logs = [];
    console.error = (m) => logs.push(String(m));
    try {
      const stopped = new Promise((resolve) => a.once("stopped", resolve));
      a.start();
      await stopped;
      assert.equal(a.running, false);
      assert.ok(logs.some((l) => /not found|spawn failed|ENOENT/.test(l)), logs.join("\n"));
      a.stop();
      assert.equal(a.wanted, false);
    } finally {
      console.error = origError;
    }
  });
});
