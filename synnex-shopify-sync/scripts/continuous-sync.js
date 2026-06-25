'use strict';

/**
 * continuous-sync.js
 *
 * Invokes the synnex-shopify-sync Lambda in catalog-sync discover mode
 * repeatedly until the full TD Synnex catalog is processed.
 *
 * Each Lambda run: downloads the .ap catalog (or uses S3 cache), skips
 * products already in Shopify, and adds new ones until timeout.
 * This script re-invokes until a run reports 0 new products synced.
 *
 * Usage: source .env && node scripts/continuous-sync.js
 *
 * Prerequisites:
 *   - AWS credentials must be configured (aws configure or env vars)
 *   - Lambda must be deployed with latest transform.js (run ./deploy.sh first)
 */

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const FUNCTION_NAME = process.env.SYNC_FUNCTION_NAME || 'synnex-shopify-sync-sync';
const AWS_REGION    = process.env.AWS_REGION || 'us-east-1';
const MAX_RUNS      = 200; // safety cap — stops after this many invocations

const lambda = new LambdaClient({ region: AWS_REGION });

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function invokeSync(runNumber) {
  const payload = JSON.stringify({ job: 'catalog-sync', discover: true });
  const start = Date.now();

  process.stdout.write(`  Run ${runNumber}: invoking Lambda…`);

  const cmd = new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(payload),
  });

  const response = await lambda.send(cmd);
  const elapsed = Date.now() - start;

  if (response.FunctionError) {
    const body = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : {};
    throw new Error(`Lambda error: ${body.errorMessage || response.FunctionError}`);
  }

  const result = response.Payload
    ? JSON.parse(Buffer.from(response.Payload).toString())
    : {};

  // Lambda may return { statusCode, body } or the result object directly
  const body = result.body ? JSON.parse(result.body) : result;

  process.stdout.write(
    ` done in ${formatDuration(elapsed)}` +
    ` — synced: ${body.synced ?? '?'}` +
    ` fetched: ${body.fetched ?? '?'}` +
    ` skipped: ${body.skipped ?? '?'}` +
    ` errors: ${body.errors?.length ?? body.errorCount ?? 0}` +
    (body.timedOut ? ' [timed out — more remain]' : '') +
    '\n'
  );

  return body;
}

async function main() {
  console.log(`\nContinuous catalog sync → ${FUNCTION_NAME} (region: ${AWS_REGION})\n`);
  console.log('Each run processes a batch of new products from the TD Synnex catalog.');
  console.log('Will stop automatically when no more new products are found.\n');
  console.log(`${'─'.repeat(72)}`);

  const overallStart = Date.now();
  let totalSynced = 0;
  let totalErrors = 0;
  let run = 1;

  while (run <= MAX_RUNS) {
    try {
      const result = await invokeSync(run);
      totalSynced += result.synced || 0;
      totalErrors += result.errors?.length || result.errorCount || 0;

      // Stop when a run processes nothing new
      if (!result.timedOut && (result.synced || 0) === 0 && (result.fetched || 0) === 0) {
        console.log(`\n${'─'.repeat(72)}`);
        console.log('✓ All products synced — catalog fully processed.');
        break;
      }

      run++;
      // Brief pause to avoid hammering Lambda concurrency limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`\n  ✗ Run ${run} failed: ${e.message}`);
      console.error('  Retrying in 30s…');
      await new Promise(r => setTimeout(r, 30_000));
      // Don't increment run — retry the same run number
    }
  }

  if (run > MAX_RUNS) {
    console.log(`\nReached max runs (${MAX_RUNS}). Re-run to continue.`);
  }

  console.log(`\nTotal synced: ${totalSynced}  Total errors: ${totalErrors}`);
  console.log(`Total time:   ${formatDuration(Date.now() - overallStart)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
