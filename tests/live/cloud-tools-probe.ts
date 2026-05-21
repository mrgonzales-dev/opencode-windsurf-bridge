/**
 * Live probe: send a GetChatMessage with a `tools` field set and inspect the
 * response stream to figure out how tool_calls come back. We need this to
 * implement proper tool-call decoding in cloud-direct.
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { loadCredentials } from '../../src/oauth/storage.js';
import {
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from '../../src/cloud-direct/wire.js';
import { buildMetadata } from '../../src/cloud-direct/metadata.js';
import { getCachedUserJwt } from '../../src/cloud-direct/auth.js';

function encodeChatMessagePrompt(prompt: string, source: number): Buffer {
  return Buffer.concat([
    encodeVarintField(2, source),
    encodeString(3, prompt),
    encodeVarintField(4, Math.max(1, Math.floor(prompt.length / 4))),
    encodeVarintField(5, 1),
  ]);
}

function encodeChatToolDefinition(name: string, description: string, schema: any): Buffer {
  // Mitm capture showed ChatToolDefinition has:
  //   #1 name (string)
  //   #2 description (string)
  //   #3 schema (JSON-as-string)
  return Buffer.concat([
    encodeString(1, name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(schema)),
  ]);
}

function encodeCompletionConfiguration(): Buffer {
  const enc64 = (fn: number, n: number) => {
    const b = Buffer.alloc(8); b.writeDoubleLE(n, 0);
    return Buffer.concat([Buffer.from([(fn << 3) | 1]), b]);
  };
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, 64000),
    encodeVarintField(3, 4096),
    enc64(5, 0.6),
    enc64(6, 0.95),
    encodeVarintField(7, 50),
    enc64(8, 1.0),
    enc64(11, 1.0),
  ]);
}

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('no creds');
  const userJwt = await getCachedUserJwt(creds.apiKey, creds.apiServerUrl);

  const metadata = buildMetadata({
    apiKey: creds.apiKey,
    userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });

  // Single tool: a fake calculator
  const tool = encodeChatToolDefinition(
    'add_numbers',
    'Add two integers and return the sum',
    {
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'integer' },
      },
      required: ['a', 'b'],
    },
  );

  const userPrompt = encodeChatMessagePrompt(
    'Use the add_numbers tool to compute 17 + 25. Do not respond with text — call the tool.',
    1,
  );

  const reqProto = Buffer.concat([
    encodeMessage(1, metadata),
    encodeMessage(3, userPrompt),
    encodeVarintField(7, 5),                    // request_type CASCADE
    encodeMessage(8, encodeCompletionConfiguration()),
    encodeMessage(10, tool),                    // tools (repeated)
    encodeString(16, crypto.randomUUID()),      // cascade_id
    encodeString(21, 'swe-1-6'),                // chat_model_uid
    encodeString(22, crypto.randomUUID()),      // prompt_id
  ]);
  const framed = frameConnectStream(reqProto, true);
  console.log(`[tools-probe] proto ${reqProto.length}B → gzipped ${framed.length}B`);

  const resp = await fetch(`${creds.apiServerUrl.replace(/\/$/, '')}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
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
  console.log(`[tools-probe] HTTP ${resp.status}, ${respBuf.length}B`);

  // Parse each frame and dump TOP-LEVEL field structure
  let i = 0;
  let frameN = 0;
  while (i + 5 <= respBuf.length) {
    const flag = respBuf[i];
    const n = respBuf.readUInt32BE(i + 1);
    if (i + 5 + n > respBuf.length) break;
    let payload = respBuf.slice(i + 5, i + 5 + n);
    if (flag & 0x01) {
      try { payload = zlib.gunzipSync(payload); } catch { /* */ }
    }
    const eos = (flag & 0x02) !== 0;
    if (eos) {
      console.log(`\n=== frame[${frameN}] EOS: ${payload.toString('utf8')}`);
      break;
    }
    // Print all top-level field numbers + a peek at their content
    console.log(`\n--- frame[${frameN}] ${payload.length}B ---`);
    for (const f of iterFields(payload)) {
      if (f.wire === 2 && Buffer.isBuffer(f.value)) {
        const buf = f.value;
        // Try utf-8
        const s = buf.toString('utf8');
        const printable = [...s].filter(c => c.charCodeAt(0) >= 32 || '\n\t'.includes(c)).length;
        if (s.length > 0 && printable / s.length > 0.9 && s.length < 200) {
          console.log(`  #${f.num} str: ${JSON.stringify(s)}`);
        } else {
          console.log(`  #${f.num} msg/bytes (${buf.length}B): ${buf.slice(0, 60).toString('hex')}…`);
          // Recurse one level for printable strings
          for (const sf of iterFields(buf)) {
            if (sf.wire === 2 && Buffer.isBuffer(sf.value)) {
              const ss = (sf.value as Buffer).toString('utf8');
              const sp = [...ss].filter(c => c.charCodeAt(0) >= 32 || '\n\t'.includes(c)).length;
              if (ss.length > 0 && sp / ss.length > 0.9 && ss.length < 200) {
                console.log(`     #${sf.num} str: ${JSON.stringify(ss)}`);
              }
            } else if (sf.wire === 0) {
              console.log(`     #${sf.num} v: ${sf.value}`);
            }
          }
        }
      } else if (f.wire === 0) {
        console.log(`  #${f.num} v: ${f.value}`);
      }
    }
    frameN++;
    i += 5 + n;
  }

  // Now accumulate ALL text + look for non-text fields appearing in any frame
  i = 0;
  let allText = '';
  const nonTextFields = new Set<number>();
  const fieldExamples = new Map<number, string>();
  while (i + 5 <= respBuf.length) {
    const flag = respBuf[i];
    const n = respBuf.readUInt32BE(i + 1);
    if (i + 5 + n > respBuf.length) break;
    let payload = respBuf.slice(i + 5, i + 5 + n);
    if (flag & 0x01) {
      try { payload = zlib.gunzipSync(payload); } catch { /* */ }
    }
    const eos = (flag & 0x02) !== 0;
    i += 5 + n;
    if (eos) break;
    for (const f of iterFields(payload)) {
      if (f.num === 9 && f.wire === 2) {
        const buf = f.value as Buffer;
        allText += buf.toString('utf8');
      } else if (![1, 2, 7, 9, 12, 17].includes(f.num)) {
        // Anything outside the "known per-chunk fields" — likely tool-call data
        nonTextFields.add(f.num);
        const bytes = f.wire === 2 ? (f.value as Buffer).toString('hex').slice(0, 100) : String(f.value);
        if (!fieldExamples.has(f.num)) fieldExamples.set(f.num, bytes);
      }
    }
  }
  console.log(`\n\n=== full text from field 9 ===`);
  console.log(allText);
  console.log(`\n=== unknown top-level field numbers seen ===`);
  for (const [k, v] of fieldExamples) {
    console.log(`  #${k}: ${v}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
