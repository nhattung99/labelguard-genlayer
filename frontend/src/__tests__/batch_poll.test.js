import {
  studioRpcUrl,
  STUDIO_RPC,
  formatWalletError,
  sameAddress,
  resolveReadAccount,
  VIEW_FROM,
  unwrapViewResult,
  normalizeBatchList,
  normalizeBatchRow,
  parseCount,
  shouldKeepPolling,
  newestBatchId,
  pollUntilStatusChanges,
  deadlinePassed,
  flowCurrentStep,
  FLOW_STEPS,
  nextActionHint,
  statusLabel,
  asUrlList,
} from '../batchPoll.js';
import {
  DEADLINE_PRESETS,
  PAYMENT_PRESETS,
  buildAcceptanceCriteria,
  deadlineUnixFromPreset,
  urlProblem,
  PUBLIC_LINK_BANNER,
  LOCKED_LINE,
  FREE_BANNER,
} from '../data/presets.js';
import { parseGenToWei, formatWeiToGen } from '../money.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${msg}: expected ${right}, got ${left}`);
}

const row = {
  batch_id: '0',
  status: 'AWAITING_SUBMISSION',
  payment_amount: '1000',
  requester: '0x0000000000000000000000000000000000000002',
  labeler: '0x0000000000000000000000000000000000000003',
  guideline_urls: ['https://example.com/guide'],
  gold_standard_urls: ['https://example.com/gold'],
  acceptance_criteria: 'Match at least 90% of the gold-standard sample and follow the labeling guidelines (Image classification).',
};

async function run() {
  console.log('Starting batch poll tests...');

  assertEqual(studioRpcUrl(undefined), STUDIO_RPC, 'node uses Studio RPC');
  assertEqual(studioRpcUrl('https://labelguard.vercel.app'), 'https://labelguard.vercel.app/api/genlayer', 'browser proxy');
  assert(formatWalletError({ message: 'User rejected the request' }).includes('Confirm'), 'rejected wallet is explained');
  assert(sameAddress('0xAbC', '0xabc') === true, 'address compare ignores case');
  assertEqual(resolveReadAccount(undefined).address, VIEW_FROM, 'missing account uses view from');
  assertEqual(unwrapViewResult(JSON.stringify([row]))[0].status, 'AWAITING_SUBMISSION', 'json list');
  assertEqual(normalizeBatchList([row]).length, 1, 'native list');
  assertEqual(normalizeBatchRow({ id: 4, status: 'SUBMITTED' }).batch_id, '4', 'fallback id');
  assertEqual(parseCount('2'), 2, 'count string');
  assert(shouldKeepPolling({ previousCount: 0, currentCount: 0, rows: [] }) === true, 'keep polling empty');
  assert(shouldKeepPolling({ previousCount: 0, currentCount: 1, rows: [row] }) === false, 'stop when listed');
  assertEqual(newestBatchId([{ batch_id: '2' }, { batch_id: '10' }]), '10', 'newest id');

  let n = 0;
  const settled = await pollUntilStatusChanges({
    fromStatus: 'SUBMITTED',
    attempts: 4,
    intervalMs: 1,
    sleep: async () => {},
    loadRow: async () => {
      n += 1;
      return n < 3 ? { status: 'SUBMITTED' } : { status: 'REVISION_REQUESTED', verdict: 'REJECTED' };
    },
  });
  assert(settled.status === 'REVISION_REQUESTED', 'poll leaves SUBMITTED');
  assert(n === 3, 'poll retries');

  assert(deadlinePassed('1', 2_000_000) === true, 'past deadline');
  assert(deadlinePassed('5000', 2_000_000) === false, 'future deadline');
  assert(flowCurrentStep('SUBMITTED') === 'ai', 'submitted is the AI step');
  assert(flowCurrentStep('REVISION_REQUESTED') === 'submit', 'revision returns to submit');
  assert(FLOW_STEPS.length === 4, 'four flow steps');
  assert(statusLabel('RESOLVED_ACCEPTED').includes('Accepted'), 'accepted label');
  assert(nextActionHint({ status: 'REVISION_REQUESTED', isRequester: false, isLabeler: true }).title.includes('1 revision'), 'revision copy');
  assert(nextActionHint({ status: 'PAYOUT_FAILED', isRequester: true, isLabeler: false }).body.includes('Try again'), 'retry copy');
  assertEqual(asUrlList(['https://a.test']), ['https://a.test'], 'url list');

  const criteria = buildAcceptanceCriteria('image', '90');
  assert(criteria.includes('90%'), 'threshold is written into the criteria sentence');
  assert(criteria.includes('Image classification'), 'category is written into the criteria sentence');
  assert(buildAcceptanceCriteria('translate', '95').includes('95%'), '95 threshold');
  assert(buildAcceptanceCriteria('sentiment', '80').includes('Text sentiment'), 'sentiment category');
  assert(urlProblem([''], 1, 'guideline').includes('At least'), 'blank url blocked');
  assert(urlProblem(['ftp://private.example/a'], 1, 'guideline').includes('http'), 'non-http blocked');
  assert(urlProblem(['https://example.com/guide'], 1, 'guideline') === '', 'public https url ok');

  for (const preset of PAYMENT_PRESETS) {
    const wei = parseGenToWei(preset);
    assert(formatWeiToGen(wei) === preset, `preset ${preset} round trip`);
    assert(wei > 0n, 'preset locks a positive amount');
  }
  const now = deadlineUnixFromPreset(DEADLINE_PRESETS[0].seconds);
  assert(typeof now === 'bigint', 'deadline is a bigint second count');
  assert(now > 0n, 'deadline is positive');

  assert(PUBLIC_LINK_BANNER.includes('Google Sheet'), 'public link warning');
  assert(LOCKED_LINE.includes('locked'), 'locked baseline line');
  assert(FREE_BANNER.startsWith('Free to use'), 'free banner');

  const stored = row.payment_amount;
  assert(stored === '1000', 'stored payment is the full amount string');
  assert(row.acceptance_criteria.includes('90%'), 'percent lives in the criteria text');
  assert(!stored.includes('.'), 'stored payment is base units, not a GEN fraction');

  console.log('All batch poll tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
