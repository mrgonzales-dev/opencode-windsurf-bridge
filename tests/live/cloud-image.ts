/**
 * Multimodal image test: send a tiny PNG (1x1 red) inline with a text prompt
 * and confirm the cloud accepts it. Just need the endpoint not to 400.
 */

import { streamChatEvents } from '../../src/cloud-direct/index.js';
import { loadCredentials } from '../../src/oauth/storage.js';

// 1×1 transparent PNG (smallest valid PNG)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('no creds');

  let allText = '';
  let errored: string | undefined;
  try {
    for await (const ev of streamChatEvents({
      apiKey: creds.apiKey,
      apiServerUrl: creds.apiServerUrl,
      modelUid: 'swe-1-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'I attached a tiny 1x1 PNG. Just acknowledge that you received an image and tell me you saw it.' },
            { type: 'image', mimeType: 'image/png', base64Data: TINY_PNG_BASE64 },
          ],
        },
      ],
    })) {
      if (ev.kind === 'text') {
        allText += ev.text;
        process.stdout.write(ev.text);
      }
    }
  } catch (e) {
    errored = e instanceof Error ? e.message : String(e);
  }
  console.log('\n');
  console.log(`text length: ${allText.length} chars`);
  if (errored) console.log(`ERROR: ${errored}`);
  else console.log(`SUCCESS — cloud accepted the multimodal request`);
}

main().catch((e) => { console.error(e); process.exit(1); });
