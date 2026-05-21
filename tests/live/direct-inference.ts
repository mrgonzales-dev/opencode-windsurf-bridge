/**
 * Direct cloud inference: POST inference.codeium.com/exa.api_server_pb.
 * ApiServerService/GetStreamingModelAPITextCompletion with Connect+JSON.
 *
 * NO language_server. NO Windsurf binary. NO Devin agent layer.
 * Pure HTTPS streaming Connect-RPC to Codeium's inference cluster.
 *
 * Auth is via the `apiKey` field INSIDE the `Metadata` JSON object — not
 * an Authorization header. That was the key insight I missed earlier:
 * empty bodies were producing 401s because the gateway parses Metadata
 * before validating.
 *
 * Wire format (Connect-streaming over HTTPS):
 *
 *   POST <host>/<service>/<method>
 *   Content-Type: application/connect+json
 *   Connect-Protocol-Version: 1
 *   Body (request): [flag=0x00 1byte][len 4byte BE][JSON message]
 *
 *   Response is the same envelope-framed format. Each frame starts with
 *   1-byte flags (bit 0x02 = end-of-stream / trailers); 4-byte BE length;
 *   then JSON. End-of-stream frame is the "trailer" — Connect status.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { loadCredentials } from '../../src/oauth/storage.js';

function readApiKey(): { apiKey: string; apiServerUrl: string } {
  // Prefer OAuth credentials; fall back to scraping windsurfAuthStatus.
  const oauth = loadCredentials();
  if (oauth) return { apiKey: oauth.apiKey, apiServerUrl: oauth.apiServerUrl };
  const STATE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
  const row = execSync(`sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';"`, { encoding: 'utf8' }).trim();
  const apiKey = JSON.parse(row).apiKey as string;
  return { apiKey, apiServerUrl: 'https://server.codeium.com' };
}

function buildMetadata(apiKey: string): Record<string, unknown> {
  return {
    apiKey,
    extensionName: 'windsurf',
    extensionVersion: '2.0.0',
    ideName: 'windsurf',
    ideType: 'windsurf',
    ideVersion: '2.0.0',
    locale: 'en',
    os: 'darwin',
    requestId: Date.now(),
    sessionId: crypto.randomUUID(),
    triggerId: crypto.randomUUID(),
    extensionPath: '',
    deviceFingerprint: '',
    planName: 'Unset',
  };
}

// Connect-streaming envelope encoding: 1-byte flags + 4-byte big-endian length + payload
function encodeFrame(jsonObj: unknown, endOfStream = false): Buffer {
  const payload = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = endOfStream ? 0x02 : 0x00;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

interface DecodedFrame { flags: number; endOfStream: boolean; json: any }

function decodeFrames(buf: Buffer): DecodedFrame[] {
  const out: DecodedFrame[] = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;
    const payload = buf.slice(offset + 5, offset + 5 + len);
    let json: any;
    try { json = JSON.parse(payload.toString('utf8')); } catch { json = { _raw: payload.toString('utf8') }; }
    out.push({ flags, endOfStream: (flags & 0x02) !== 0, json });
    offset += 5 + len;
  }
  return out;
}

async function call(
  host: string,
  service: string,
  method: string,
  body: object,
): Promise<{ status: number; frames: DecodedFrame[]; raw: Buffer }> {
  const url = `${host}/${service}/${method}`;
  const frame = encodeFrame(body, /*endOfStream*/ true);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
    },
    body: frame,
  });
  const raw = Buffer.from(await resp.arrayBuffer());
  const frames = decodeFrames(raw);
  return { status: resp.status, frames, raw };
}

async function tryGetModelConfigs(host: string, apiKey: string): Promise<void> {
  console.log(`\n[direct] GetCascadeModelConfigs @ ${host}`);
  const r = await call(host, 'exa.api_server_pb.ApiServerService', 'GetCascadeModelConfigs', {
    metadata: buildMetadata(apiKey),
  });
  console.log(`  status=${r.status}, ${r.frames.length} frame(s)`);
  for (const f of r.frames) {
    if (f.endOfStream) {
      console.log(`  END frame:`, JSON.stringify(f.json).slice(0, 200));
    } else {
      const summary = JSON.stringify(f.json).slice(0, 400);
      console.log(`  data:`, summary);
    }
  }
}

async function tryDirectInference(host: string, apiKey: string, modelUid: string): Promise<void> {
  console.log(`\n[direct] GetStreamingModelAPITextCompletion @ ${host} model=${modelUid}`);
  const req = {
    metadata: buildMetadata(apiKey),
    model: modelUid,
    systemPrompt: '',
    chatMessagePrompts: [
      {
        prompt: `Reply with EXACTLY: hi from ${modelUid}`,
        source: 'CHAT_MESSAGE_SOURCE_USER',
        messageId: crypto.randomUUID(),
      },
    ],
    requestType: 'CHAT_MESSAGE_REQUEST_TYPE_USER',
    completionConfiguration: { maxOutputTokens: 256, temperature: 0.0 },
  };
  const r = await call(host, 'exa.api_server_pb.ApiServerService', 'GetStreamingModelAPITextCompletion', req);
  console.log(`  status=${r.status}, ${r.frames.length} frame(s)`);
  for (const f of r.frames) {
    const summary = JSON.stringify(f.json).slice(0, 500);
    console.log(`  ${f.endOfStream ? 'END' : 'data'}:`, summary);
  }
}

async function main(): Promise<void> {
  const { apiKey, apiServerUrl } = readApiKey();
  console.log(`[direct] apiKey: ${apiKey.slice(0, 25)}…${apiKey.slice(-8)}`);
  console.log(`[direct] apiServerUrl (from creds): ${apiServerUrl}`);

  // 1) Discover available models — what UIDs work?
  const hostsToTry = [
    apiServerUrl,
    'https://server.codeium.com',
    'https://inference.codeium.com',
  ];
  for (const h of hostsToTry) {
    try {
      await tryGetModelConfigs(h, apiKey);
    } catch (e) {
      console.error(`  ERROR:`, e instanceof Error ? e.message : e);
    }
  }

  // 2) Try direct inference. Use the Cognition string UID `claude-opus-4.7`
  //    (same string our cascade-client uses) and also the legacy enum form.
  for (const modelUid of ['claude-opus-4.7', 'MODEL_CHAT_CLAUDE_4_7_OPUS', 'MODEL_CHAT_CLAUDE_4_5_SONNET']) {
    for (const h of [apiServerUrl, 'https://inference.codeium.com']) {
      try {
        await tryDirectInference(h, apiKey, modelUid);
      } catch (e) {
        console.error(`  ERROR:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
