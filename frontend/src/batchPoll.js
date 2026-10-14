export const STUDIO_RPC = 'https://studio.genlayer.com/api';
export const VIEW_FROM = '0x0000000000000000000000000000000000000001';

export function studioRpcUrl(origin) {
  if (!origin || typeof origin !== 'string') return STUDIO_RPC;
  return `${origin.replace(/\/$/, '')}/api/genlayer`;
}

export function formatWalletError(err, fallback = 'Giao dịch ví thất bại') {
  const raw = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (raw.includes('user rejected') || raw.includes('user denied') || raw.includes('user cancel')) {
    return 'MetaMask đã huỷ yêu cầu. Chuyển sang Genlayer Studio Network rồi bấm Xác nhận.';
  }
  if (raw.includes('no address provided') || raw.includes('no account')) {
    return 'Hãy kết nối ví trước, rồi thử lại.';
  }
  if (raw.includes('unrecognized chain') || raw.includes('chain disconnected') || raw.includes('4902')) {
    return 'Hãy chấp nhận thêm Genlayer Studio Network trong MetaMask, rồi gửi lại giao dịch.';
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
  { id: 'create', label: '1. Tạo lô' },
  { id: 'submit', label: '2. Nộp bài' },
  { id: 'ai', label: '3. AI chấm' },
  { id: 'done', label: '4. Giải ngân' },
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
    AWAITING_SUBMISSION: 'Chờ nộp bài',
    SUBMITTED: 'Đã nộp, chờ AI chấm',
    REVISION_REQUESTED: 'Cần nộp lại',
    RESOLVED_ACCEPTED: 'Đạt — đã trả người gán nhãn',
    RESOLVED_REJECTED: 'Không đạt — đã hoàn người thuê',
    DISPUTED: 'Chưa đủ tự tin — nộp lại',
    PAYOUT_FAILED: 'Giải ngân lỗi',
    EXPIRED_REFUNDED: 'Hết hạn — đã hoàn tiền',
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
      title: 'Đọc kỹ phần đã khoá trước khi làm',
      body: 'Hướng dẫn, đáp án chuẩn và tiêu chí bên dưới không đổi được. Làm xong thì dán link bài nộp.',
    };
  }
  if (s === 'AWAITING_SUBMISSION' && isRequester) {
    return {
      title: 'Đang chờ người gán nhãn',
      body: 'Gửi link lô việc này cho họ. Tiền công nằm trong contract đến khi có kết quả hoặc hết hạn.',
    };
  }
  if (s === 'SUBMITTED') {
    return {
      title: 'Sẵn sàng chấm',
      body: 'Bấm Yêu cầu AI chấm. Validator chỉ đồng thuận khi cùng ra ACCEPTED hoặc cùng ra REJECTED.',
    };
  }
  if (s === 'REVISION_REQUESTED' && isLabeler) {
    return {
      title: 'Bạn còn 1 lần nộp lại',
      body: 'Sửa bài cho khớp đáp án chuẩn và hướng dẫn, rồi nộp lại. Tiền công chưa bị đụng tới.',
    };
  }
  if (s === 'REVISION_REQUESTED') {
    return {
      title: 'Người gán nhãn còn 1 lần nộp lại',
      body: 'Tiền công vẫn nằm nguyên. Không huỷ được lô trước hạn.',
    };
  }
  if (s === 'DISPUTED') {
    return {
      title: 'AI chưa đủ tự tin',
      body: 'Người gán nhãn có thể nộp lại link rõ hơn. Tiền công vẫn nằm trong escrow.',
    };
  }
  if (s === 'PAYOUT_FAILED') {
    return {
      title: 'Giải ngân chưa xong',
      body: 'Phán quyết đã được lưu. Bấm Thử lại để chuyển đúng số tiền công đã khoá. AI không chạy lại.',
    };
  }
  if (s === 'RESOLVED_ACCEPTED') {
    return { title: 'Đã trả người gán nhãn', body: 'Bài nộp đạt tiêu chí đã khoá.' };
  }
  if (s === 'RESOLVED_REJECTED') {
    return {
      title: 'Đã hoàn người thuê',
      body: 'Bài không đạt sau lần nộp lại, hoặc đã quá hạn. Người thuê có thể đã thấy nội dung bài nộp.',
    };
  }
  if (s === 'EXPIRED_REFUNDED') {
    return { title: 'Đã hoàn vì hết hạn', body: 'Không có bài nào được chấp nhận trước hạn.' };
  }
  return { title: 'Theo dõi lô việc', body: 'Kết nối ví studionet để tạo lô hoặc nộp bài.' };
}

export function asUrlList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}
