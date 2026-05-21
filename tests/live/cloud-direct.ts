/**
 * Cloud-direct inference test — no language_server, no Windsurf binary.
 *
 * Steps:
 *   1. POST exa.auth_pb.AuthService/GetUserJwt with a full Metadata body
 *      → server returns a short-lived userJwt (~24min)
 *   2. POST exa.api_server_pb.ApiServerService/GetChatMessage with:
 *      - Connect-streaming envelope ([flag][len32 BE][gzipped proto])
 *      - Metadata with apiKey (field 3) AND userJwt (field 21)
 *      - chat_message_prompts (a user turn)
 *      - chat_model_uid: "swe-1-6" (free Windsurf model)
 *      - cascade_id: a fresh UUID (the BIG unknown — does cloud lazy-register?)
 *      - request_type: 5 (CHAT_MESSAGE_REQUEST_TYPE_CASCADE)
 *
 *   3. Stream-decode the response frames and print the assistant reply.
 *
 * If the cloud responds with model output → cascade_id lazy-registers and
 * cloud-direct is fully feasible.
 * If the cloud responds with "Cascade session error" → strict validation;
 * cloud-direct blocked unless we find an upstream cascade-allocation RPC.
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { loadCredentials } from '../../src/oauth/storage.js';

// ============================================================================
// Manual proto wire encoding (Connect proto3)
// ============================================================================

function encVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) { bytes.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}
function tag(fieldNum: number, wire: number): Buffer { return encVarint((fieldNum << 3) | wire); }
function encString(fieldNum: number, s: string): Buffer {
  const buf = Buffer.from(s, 'utf8');
  return Buffer.concat([tag(fieldNum, 2), encVarint(buf.length), buf]);
}
function encMessage(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([tag(fieldNum, 2), encVarint(body.length), body]);
}
function encVarintField(fieldNum: number, v: number | bigint): Buffer {
  return Buffer.concat([tag(fieldNum, 0), encVarint(v)]);
}

function encTimestampNow(): Buffer {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  return Buffer.concat([
    encVarintField(1, seconds),
    nanos > 0 ? encVarintField(2, nanos) : Buffer.alloc(0),
  ]);
}

// ============================================================================
// Metadata — exa.codeium_common_pb.Metadata, all 13 fields the LS populates
// ============================================================================

interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
}

function encMetadata(m: MetadataInput): Buffer {
  const parts: Buffer[] = [
    encString(1, 'windsurf'),                                          // ide_name
    encString(2, '2.0.0'),                                              // extension_version
    encString(3, m.apiKey),                                             // api_key
    encString(4, 'en'),                                                 // locale
    encString(5, 'darwin'),                                             // os
    encString(7, '2.0.0'),                                              // ide_version
    encVarintField(9, m.requestId),                                     // request_id (uint64)
    encString(10, m.sessionId),                                         // session_id
    encString(12, 'windsurf'),                                          // extension_name
    encMessage(16, encTimestampNow()),                                  // ls_timestamp
    encString(25, m.triggerId),                                         // trigger_id
    encString(26, 'Unset'),                                             // plan_name
    encString(28, 'windsurf'),                                          // ide_type
  ];
  if (m.userJwt) parts.push(encString(21, m.userJwt));                  // user_jwt
  return Buffer.concat(parts);
}

// ============================================================================
// Step 1: GetUserJwt
// ============================================================================

async function mintUserJwt(apiKey: string): Promise<string> {
  // Request: GetUserJwtRequest { metadata: Metadata } — unary application/proto, no envelope.
  const metadata = encMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  const req = encMessage(1, metadata);  // field 1 = metadata

  console.log(`[cloud-direct] POST GetUserJwt (${req.length} bytes)`);
  const resp = await fetch('https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
    },
    body: req,
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  console.log(`[cloud-direct] GetUserJwt HTTP ${resp.status}, ct=${resp.headers.get('content-type')}, ${buf.length} bytes`);

  if (!resp.ok) {
    throw new Error(`GetUserJwt failed: ${buf.toString('utf8').slice(0, 400)}`);
  }

  // Response is GetUserJwtResponse { user_jwt: string } (field 1, probably)
  // Parse to find a JWT-shaped string
  const text = buf.toString('binary');
  const m = text.match(/eyJ[A-Za-z0-9_-]{20,1000}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error(`GetUserJwt response had no JWT: ${buf.toString('utf8').slice(0, 400)}`);
  const jwt = m[0];
  console.log(`[cloud-direct] ✓ user_jwt minted: ${jwt.slice(0, 40)}…${jwt.slice(-20)}`);

  // Decode the JWT payload to show what's in it
  try {
    const parts = jwt.split('.');
    const pad = (s: string) => s + '='.repeat((4 - s.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(pad(parts[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    console.log(`[cloud-direct]   payload: ${JSON.stringify(payload).slice(0, 400)}`);
  } catch { /* informational only */ }

  return jwt;
}

// ============================================================================
// Step 2: GetChatMessage with cascade_id
// ============================================================================

interface ChatRequest {
  apiKey: string;
  userJwt: string;
  modelUid: string;
  prompt: string;
  cascadeId: string;
}

function encChatMessagePrompt(prompt: string, _messageId: string): Buffer {
  // Per mitm capture of a real LS GetChatMessage:
  //   ChatMessagePrompt {
  //     #2 source: 1   (CHAT_MESSAGE_SOURCE_USER)
  //     #3 prompt: <text>
  //     #4 num_tokens: <int>
  //     #5 safe_for_code_telemetry: 1
  //   }
  // No message_id observed in captured prompts — drop my earlier guess.
  return Buffer.concat([
    encVarintField(2, 1),
    encString(3, prompt),
    encVarintField(4, Math.max(1, Math.floor(prompt.length / 4))),
    encVarintField(5, 1),
  ]);
}

function encCompletionConfiguration(): Buffer {
  // Mirror the LS-shipped CompletionConfiguration. The capture showed:
  //   #1 (varint): 1
  //   #2 (varint): 64000   max_input_tokens
  //   #3 (varint): 200     max_output_tokens
  //   #5 (fixed64): 0x3FE3333333333333  temperature (~0.6 as f64)
  //   #6 (fixed64): same   (probably top_p)
  //   #7 (varint): 50      top_k
  //   #8 (fixed64): 0x3FF0000000000000  1.0
  //   #9 (str repeated): stop_tokens
  //   #11 (fixed64): 1.0   repetition_penalty
  const f64 = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n, 0);
    return Buffer.concat([tag(0, 0).slice(0, 0), b]); // placeholder; helper below
  };
  // Helper that writes a fixed64 field
  const enc64 = (fieldNum: number, n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n, 0);
    return Buffer.concat([tag(fieldNum, 1), b]);
  };
  void f64;
  return Buffer.concat([
    encVarintField(1, 1),
    encVarintField(2, 64000),
    encVarintField(3, 4096),
    enc64(5, 0.6),
    enc64(6, 0.6),
    encVarintField(7, 50),
    enc64(8, 1.0),
    enc64(11, 1.0),
  ]);
}

function buildGetChatMessageRequest(r: ChatRequest): Buffer {
  // Mirror what the LS sends, but trim to the minimum hopefully-required.
  const metadata = encMetadata({
    apiKey: r.apiKey,
    userJwt: r.userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });

  const promptMsg = encChatMessagePrompt(r.prompt, crypto.randomUUID());
  const completion = encCompletionConfiguration();

  // GetChatMessageRequest fields (from mitm capture decode):
  //   #1  metadata
  //   #3  chat_message_prompts (repeated)
  //   #7  request_type (varint)
  //   #8  completion_configuration
  //   #16 cascade_id (string)
  //   #21 chat_model_uid (string)
  //   #22 prompt_id (string)
  const parts: Buffer[] = [
    encMessage(1, metadata),
    encMessage(3, promptMsg),
    encVarintField(7, 5),                 // CHAT_MESSAGE_REQUEST_TYPE_CASCADE
    encMessage(8, completion),
    encString(16, r.cascadeId),
    encString(21, r.modelUid),
    encString(22, crypto.randomUUID()),   // prompt_id
  ];
  return Buffer.concat(parts);
}

function frameConnectStream(body: Buffer, compress: boolean): Buffer {
  let payload = body;
  let flags = 0x00;
  if (compress) {
    payload = zlib.gzipSync(body);
    flags = 0x01;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function parseConnectFrames(buf: Buffer): Array<{ flags: number; payload: Buffer; eos: boolean }> {
  const frames: Array<{ flags: number; payload: Buffer; eos: boolean }> = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const n = buf.readUInt32BE(i + 1);
    if (i + 5 + n > buf.length) break;
    let payload = buf.slice(i + 5, i + 5 + n);
    if (flags & 0x01) {
      try { payload = zlib.gunzipSync(payload); } catch { /* keep raw */ }
    }
    frames.push({ flags, payload, eos: (flags & 0x02) !== 0 });
    i += 5 + n;
  }
  return frames;
}

// Parse a single field from a proto blob; returns null if at EOF.
function decodeVarint(buf: Buffer, i: number): [bigint, number] {
  let res = 0n, shift = 0n, j = i;
  while (j < buf.length) {
    const b = buf[j++];
    res |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [res, j];
    shift += 7n;
  }
  throw new Error('truncated varint');
}

interface ProtoField { num: number; wire: number; value: bigint | Buffer }

function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0;
  while (i < buf.length) {
    const [tagBig, ai] = decodeVarint(buf, i);
    i = ai;
    const tag = Number(tagBig);
    const num = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [v, bi] = decodeVarint(buf, i);
      i = bi;
      yield { num, wire, value: v };
    } else if (wire === 1) {
      yield { num, wire, value: buf.slice(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const [n, ci] = decodeVarint(buf, i);
      i = ci;
      const len = Number(n);
      yield { num, wire, value: buf.slice(i, i + len) };
      i += len;
    } else if (wire === 5) {
      yield { num, wire, value: buf.slice(i, i + 4) };
      i += 4;
    } else {
      throw new Error(`bad wire type ${wire}`);
    }
  }
}

/**
 * Extract `delta_text` (top-level field #9) from a streaming ChatMessage proto frame.
 *
 * Observed shape (from mitm capture of swe-1-6):
 *   ChatMessage {
 *     #1 bot_id: "bot-<uuid>"
 *     #2 timestamp { seconds, nanos }
 *     #7 ChatStatus { #6 status_int, #9 model_name }
 *     #9 delta_text: "<incremental output>"   ← this is what we want
 *     #12 (fixed64) some_hash
 *     #17 (string) message_uuid
 *   }
 */
function extractDelta(proto: Buffer): string {
  for (const f of iterFields(proto)) {
    if (f.num === 9 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // Could be string delta OR a nested submessage at the same field number.
      // Heuristic: if first byte is a low-ish ASCII range, treat as text.
      const b = f.value as Buffer;
      // Don't confuse with the #7-nested model_name "swe-1-6" which lives
      // inside the submessage at field 7; iterFields gives top-level only.
      return b.toString('utf8');
    }
  }
  return '';
}

async function chat(r: ChatRequest): Promise<{ ok: boolean; reply: string; error?: string }> {
  const reqBody = buildGetChatMessageRequest(r);
  const framed = frameConnectStream(reqBody, /*compress=*/true);

  console.log(`[cloud-direct] GetChatMessage proto ${reqBody.length}B → gzipped ${framed.length}B`);

  const resp = await fetch('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/connect+proto',
      'Connect-Protocol-Version': '1',
      'Connect-Content-Encoding': 'gzip',
      'Connect-Accept-Encoding': 'gzip',
    },
    body: framed,
  });
  const respBuf = Buffer.from(await resp.arrayBuffer());
  console.log(`[cloud-direct] HTTP ${resp.status}, ${respBuf.length}B response`);

  const frames = parseConnectFrames(respBuf);
  console.log(`[cloud-direct] ${frames.length} frame(s)`);
  const deltas: string[] = [];
  let lastError: string | undefined;

  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx];
    if (f.eos) {
      // EOS frame: empty {} on success, {"error":...} on failure
      const text = f.payload.toString('utf8');
      if (text.includes('"error"')) {
        try {
          const j = JSON.parse(text);
          lastError = j.error?.message ?? text;
          console.log(`  EOS error: ${lastError}`);
        } catch { lastError = text; }
      } else {
        console.log(`  EOS clean (${f.payload.length}B)`);
      }
      continue;
    }
    try {
      const delta = extractDelta(f.payload);
      if (delta) {
        deltas.push(delta);
        // Live-print
        process.stdout.write(delta);
      }
    } catch (e) {
      console.log(`  frame[${idx}] parse error: ${(e as Error).message}`);
    }
  }
  console.log('\n');  // newline after streaming

  const fullReply = deltas.join('');
  return { ok: !lastError && fullReply.length > 0, reply: fullReply, error: lastError };
}

// ============================================================================
// main
// ============================================================================

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('No OAuth creds — run `node dist/src/cli.js login` first');

  console.log(`[cloud-direct] account: ${creds.name}`);
  console.log(`[cloud-direct] apiKey: ${creds.apiKey.slice(0, 30)}…${creds.apiKey.slice(-10)}`);

  const userJwt = await mintUserJwt(creds.apiKey);

  // Test sequence — try each free model in case any is gated for this account.
  const candidates = (process.argv.slice(2).length > 0)
    ? process.argv.slice(2)
    : ['swe-1-6', 'swe-1-6-fast', 'MODEL_SWE_1_5', 'kimi-k2-6'];

  for (const modelUid of candidates) {
    console.log(`\n=== model: ${modelUid} ===`);
    const r = await chat({
      apiKey: creds.apiKey,
      userJwt,
      modelUid,
      prompt: 'Reply with EXACTLY one short line: hi from cloud-direct',
      cascadeId: crypto.randomUUID(),
    });
    if (r.ok) {
      console.log(`[cloud-direct] ✓ ${modelUid}: ${JSON.stringify(r.reply.slice(0, 200))}`);
    } else {
      console.log(`[cloud-direct] ✗ ${modelUid}: ${r.error ?? '(empty reply)'}`);
    }
  }
}

main().catch((e) => {
  console.error('[cloud-direct] FATAL:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
