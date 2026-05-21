/**
 * Exhaustive OAuth-path validation: walk every model+variant from the user's
 * opencode config, ask each one to reply with a fixed string, and report
 * pass/fail per row.
 *
 * Reuses one spawned language_server across the whole run (the resolver +
 * spawner are idempotent), so the startup cost is amortised. Falls back to
 * the README defaults if no opencode config is present.
 */

import { resolveCredentials } from '../../src/plugin/credentials-resolver.js';
import { streamChatGenerator } from '../../src/plugin/grpc-client.js';
import { stopLanguageServer } from '../../src/plugin/language-server-spawner.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ModelRow {
  base: string;
  variant?: string;
  label: string;
}

function loadOpencodeModels(): ModelRow[] {
  const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  if (!fs.existsSync(cfgPath)) {
    // Fallback: README's 6 base models.
    return ['claude-opus-4.7', 'gpt-5.5', 'deepseek-v4', 'kimi-k2.6', 'gemini-3.5-flash', 'claude-opus-4.6']
      .map((b) => ({ base: b, label: b }));
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const models = cfg?.provider?.windsurf?.models ?? {};
  const rows: ModelRow[] = [];
  for (const base of Object.keys(models)) {
    rows.push({ base, label: base });
    const variants = (models[base]?.variants ?? {}) as Record<string, unknown>;
    for (const v of Object.keys(variants)) {
      rows.push({ base, variant: v, label: `${base}-${v}` });
    }
  }
  return rows;
}

async function runOne(base: string, variant: string | undefined, attempt = 1): Promise<{ ok: boolean; reply: string; ms: number; err?: string }> {
  const t0 = Date.now();
  const effectiveLabel = variant ? `${base}-${variant}` : base;
  const prompt = `Reply with EXACTLY: hi from ${effectiveLabel}`;
  process.env.OPENCODE_WINDSURF_AUTH_MODE = 'oauth';
  try {
    const credentials = await resolveCredentials();
    // The cascade-client resolves variants via the streamChatGenerator's model
    // string when it's of the form "<base>:<variant>".
    const model = variant ? `${base}:${variant}` : base;
    const chunks: string[] = [];
    const gen = streamChatGenerator(credentials, {
      model,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const c of gen) chunks.push(c);
    const reply = chunks.join('').trim();
    return { ok: true, reply, ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < 2 && /Cascade session error|EPIPE|stream/i.test(msg)) {
      return runOne(base, variant, attempt + 1);
    }
    return { ok: false, reply: '', ms: Date.now() - t0, err: msg };
  }
}

async function main(): Promise<void> {
  const rows = loadOpencodeModels();
  console.log(`[oauth-all-models] ${rows.length} model+variant combos`);
  const results: Array<ModelRow & { ok: boolean; reply: string; ms: number; err?: string }> = [];

  for (const row of rows) {
    process.stdout.write(`[${row.label.padEnd(40)}] … `);
    const r = await runOne(row.base, row.variant);
    results.push({ ...row, ...r });
    if (r.ok) {
      const oneLine = r.reply.replace(/\s+/g, ' ').slice(0, 50);
      console.log(`OK   ${r.ms}ms  → ${oneLine}`);
    } else {
      console.log(`FAIL ${r.ms}ms  ${r.err}`);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n[oauth-all-models] ${ok}/${results.length} passed`);

  // Save JSON for later inspection
  const outPath = path.join(process.cwd(), 'tests', 'live', 'oauth-all-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${outPath}`);

  await stopLanguageServer();
  if (ok !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error('[oauth-all-models] fatal:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
