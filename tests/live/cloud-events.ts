/**
 * Validate streamChatEvents — verify we surface tool_call_start, tool_call_args,
 * and finish events when the cloud emits them.
 */

import { streamChatEvents } from '../../src/cloud-direct/index.js';
import { loadCredentials } from '../../src/oauth/storage.js';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('no creds');

  console.log('[cloud-events] sending tool-call test');
  const events: any[] = [];
  for await (const ev of streamChatEvents({
    apiKey: creds.apiKey,
    apiServerUrl: creds.apiServerUrl,
    modelUid: 'swe-1-6',
    messages: [
      {
        role: 'user',
        content: 'You MUST call the add_numbers tool with a=17 and b=25. Do NOT output any text — only call the tool.',
      },
    ],
    tools: [
      {
        name: 'add_numbers',
        description: 'Add two integers and return the sum',
        parameters: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
      },
    ],
  })) {
    events.push(ev);
    if (ev.kind === 'text') process.stdout.write(`[TXT]${ev.text}`);
    else if (ev.kind === 'tool_call_start') console.log(`\n[TOOL_START] id=${ev.id} name=${ev.name}`);
    else if (ev.kind === 'tool_call_args') console.log(`[TOOL_ARGS] ${JSON.stringify(ev.argsDelta)}`);
    else if (ev.kind === 'finish') console.log(`\n[FINISH] reason=${ev.reason}`);
  }
  console.log(`\n\n=== summary: ${events.length} events ===`);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  console.log(counts);

  const argsAcc = events
    .filter((e) => e.kind === 'tool_call_args')
    .map((e) => e.argsDelta)
    .join('');
  if (argsAcc) console.log(`accumulated tool args: ${argsAcc}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
