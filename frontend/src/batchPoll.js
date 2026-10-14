export const STUDIO_RPC = 'https://studio.genlayer.com/api';
export const VIEW_FROM = '0x0000000000000000000000000000000000000001';

export function studioRpcUrl(origin) {
  if (!origin || typeof origin !== 'string') return STUDIO_RPC;
  return `${origin.replace(/\/$/, '')}/api/genlayer`;
}

export function formatWalletError(err, fallback = 'Wallet request failed') {
  const raw = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (raw.includes('user rejected') || raw.includes('user denied') || raw.includes('user cancel')) {
    return 'MetaMask cancelled the request. Switch to Genlayer Studio Network, then click Confirm.';
  }
  if (raw.includes('no address provided') || raw.includes('no account')) {
    return 'Connect a wallet first, then try again.';
  }
  if (raw.includes('unrecognized chain') || raw.includes('chain disconnected') || raw.includes('4902')) {
    return 'Approve adding Genlayer Studio Network in MetaMask, then send the transaction again.';
  }
  return err?.shortMessage || err?.message || fallback;
}

export function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function resolveReadAccount(account) {
  if (typeof account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account)) {
    return { address: account };
  }
  if (account && typeof account === 'object' && typeof account.address === 'string') {
    return { address: account.address };
  }
  return { address: VIEW_FROM };
}

export function unwrapViewResult(res) {
  if (res === null || res === undefined) return res;
  if (typeof res === 'bigint') return Number(res);
  if (typeof res === 'number' || typeof res === 'boolean') return res;
  if (res instanceof Uint8Array) {
    return unwrapViewResult(new TextDecoder().decode(res));
  }
  if (res instanceof Map) {
    return unwrapViewResult(Object.fromEntries(res));
  }
  if (typeof res === 'object') {
    if (Array.isArray(res)) return res.map((item) => unwrapViewResult(item));
    if ('result' in res) return unwrapViewResult(res.result);
    if ('data' in res && (typeof res.data === 'string' || Array.isArray(res.data))) {
      return unwrapViewResult(res.data);
    }
    return res;
  }
  if (typeof res !== 'string') return res;

  const trimmed = res.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 4 && trimmed.length % 2 === 0) {
    try {
      const hex = trimmed.slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const text = new TextDecoder().decode(bytes).trim();
      if (text.startsWith('[') || text.startsWith('{') || /^\d+$/.test(text)) {
        return unwrapViewResult(text);
      }
    } catch {
      // keep original string
    }
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return unwrapViewResult(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function normalizeBatchRow(row, fallbackId) {
  if (row === null || row === undefined) return null;
  const unwrapped = unwrapViewResult(row);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return null;
  const id = unwrapped.batch_id ?? unwrapped.id ?? fallbackId;
  if (id === null || id === undefined || id === '') return null;
  return { ...unwrapped, batch_id: String(id) };
}

export function normalizeBatchList(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (Array.isArray(unwrapped)) {
    return unwrapped
      .map((row, index) => normalizeBatchRow(row, String(index)))
      .filter(Boolean);
  }
  if (unwrapped && typeof unwrapped === 'object' && Array.isArray(unwrapped.batches)) {
    return normalizeBatchList(unwrapped.batches);
  }
  const single = normalizeBatchRow(unwrapped);
  return single ? [single] : [];
}

export function parseCount(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return unwrapped;
  if (typeof unwrapped === 'string' && /^\d+$/.test(unwrapped)) return Number(unwrapped);
  if (unwrapped && typeof unwrapped === 'object' && unwrapped.count != null) {
    return parseCount(unwrapped.count);
  }
  return null;
}

export function shouldKeepPolling({ previousCount, currentCount, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  if (typeof currentCount === 'number' && currentCount > previousCount) return false;
  if (rows.length > previousCount) return false;
  return true;
}

export function newestBatchId(rows) {
  let best = null;
  let bestN = -1n;
  for (const row of rows || []) {
    const id = String(row?.batch_id ?? '');
    if (!/^\d+$/.test(id)) continue;
    const n = BigInt(id);
    if (best === null || n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

export async function pollUntilListed({
  previousCount,
  load,
  attempts = 20,
  intervalMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = { rows: [], count: previousCount };
  for (let i = 0; i < attempts; i += 1) {
    last = await load();
    if (!shouldKeepPolling({ previousCount, currentCount: last.count, rows: last.rows })) {
      return last;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export async function pollUntilStatusChanges({
  loadRow,
  fromStatus,
  attempts = 36,
  intervalMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await loadRow();
    const status = String(last?.status || '');
    if (status && status !== fromStatus) return last;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export function deadlinePassed(unixStr, nowMs = Date.now()) {
  const raw = String(unixStr ?? '').trim();
  if (!/^\d+$/.test(raw)) return false;
  const nowSec = BigInt(nowMs) / 1000n;
  return nowSec > BigInt(raw);
}

export function formatDeadline(unixStr) {
  const raw = String(unixStr ?? '').trim();
  if (!/^\d+$/.test(raw)) return '—';
  const sec = Number(raw);
  if (!Number.isFinite(sec)) return raw;
  try {
    return new Date(sec * 1000).toUTCString();
  } catch {
    return raw;
  }
}

export const FLOW_STEPS = [
  { id: 'create', label: '1. Create' },
  { id: 'submit', label: '2. Submit' },
  { id: 'ai', label: '3. AI check' },
  { id: 'done', label: '4. Payout' },
];

export function flowCurrentStep(status) {
  const s = String(status || '');
  if (!s) return 'create';
  if (s === 'AWAITING_SUBMISSION' || s === 'REVISION_REQUESTED' || s === 'DISPUTED') return 'submit';
  if (s === 'SUBMITTED') return 'ai';
  return 'done';
}

export function statusLabel(status) {
  const map = {
    AWAITING_SUBMISSION: 'Waiting for the submission',
    SUBMITTED: 'Submitted, waiting for AI',
    REVISION_REQUESTED: 'Revision needed',
    RESOLVED_ACCEPTED: 'Accepted — paid the labeler',
    RESOLVED_REJECTED: 'Rejected — refunded the requester',
    DISPUTED: 'Not confident enough — submit again',
    PAYOUT_FAILED: 'Payout failed',
    EXPIRED_REFUNDED: 'Expired — refunded the requester',
  };
  return map[status] || status || '—';
}

export function statusTone(status) {
  const map = {
    AWAITING_SUBMISSION: 'waiting',
    SUBMITTED: 'submitted',
    REVISION_REQUESTED: 'revision',
    RESOLVED_ACCEPTED: 'accepted',
    RESOLVED_REJECTED: 'rejected',
    DISPUTED: 'disputed',
    PAYOUT_FAILED: 'failed',
    EXPIRED_REFUNDED: 'expired',
  };
  return map[status] || 'none';
}

export function nextActionHint({ status, isRequester, isLabeler }) {
  const s = String(status || '');
  if (s === 'AWAITING_SUBMISSION' && isLabeler) {
    return {
      title: 'Read the locked materials before you start',
      body: 'The guidelines, gold answers, and acceptance criteria below cannot be changed. When the work is done, paste the submission link.',
    };
  }
  if (s === 'AWAITING_SUBMISSION' && isRequester) {
    return {
      title: 'Waiting on the labeler',
      body: 'Share this batch link. The fee stays in the contract until there is a result or the deadline passes.',
    };
  }
  if (s === 'SUBMITTED') {
    return {
      title: 'Ready to check',
      body: 'Click Request an AI check. Validators agree only when they return the same ACCEPTED or REJECTED result.',
    };
  }
  if (s === 'REVISION_REQUESTED' && isLabeler) {
    return {
      title: 'You have 1 revision left',
      body: 'Update the batch so it meets the gold answers and the guidelines, then submit again. The fee has not moved.',
    };
  }
  if (s === 'REVISION_REQUESTED') {
    return {
      title: 'The labeler has 1 revision left',
      body: 'The fee is still untouched. The batch cannot be cancelled before the deadline.',
    };
  }
  if (s === 'DISPUTED') {
    return {
      title: 'The AI is not confident enough',
      body: 'The labeler can submit a clearer public link. The fee stays in escrow.',
    };
  }
  if (s === 'PAYOUT_FAILED') {
    return {
      title: 'The payout did not finish',
      body: 'The verdict is already stored. Click Try again to send the same locked fee. AI will not run again.',
    };
  }
  if (s === 'RESOLVED_ACCEPTED') {
    return { title: 'Paid the labeler', body: 'The submission met the locked acceptance criteria.' };
  }
  if (s === 'RESOLVED_REJECTED') {
    return {
      title: 'Refunded the requester',
      body: 'The submission missed the criteria after the revision, or the deadline had passed. The requester may already have seen the submission.',
    };
  }
  if (s === 'EXPIRED_REFUNDED') {
    return { title: 'Refunded because the deadline passed', body: 'No submission was accepted before the deadline.' };
  }
  return { title: 'Follow this batch', body: 'Connect a studionet wallet to create a batch or submit work.' };
}

export function asUrlList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}
