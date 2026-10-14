import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet,
  Tags,
  ClipboardPaste,
  Scale,
  RefreshCw,
  RotateCcw,
  Copy,
  Clock,
  AlertTriangle,
  Lock,
  Plus,
} from 'lucide-react';
import {
  CONTRACT_ADDRESS,
  hasContractAddress,
  getWriteClient,
  getListClient,
  loadBatches,
  readView,
  waitForTx,
  ensureStudioNetwork,
  formatWalletError,
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  readWei,
  txExplorerUrl,
  receiptLooksFailed,
  studionet,
  normalizeBatchRow,
} from './genlayerClient.js';
import {
  sameAddress,
  deadlinePassed,
  formatDeadline,
  FLOW_STEPS,
  flowCurrentStep,
  nextActionHint,
  statusLabel,
  statusTone,
  pollUntilListed,
  pollUntilStatusChanges,
  newestBatchId,
  resolveReadAccount,
  asUrlList,
} from './batchPoll.js';
import {
  PAYMENT_PRESETS,
  DEADLINE_PRESETS,
  THRESHOLDS,
  CATEGORIES,
  EXAMPLE_GUIDELINE_URL,
  EXAMPLE_GOLD_URL,
  EXAMPLE_SUBMISSION_URL,
  DESCRIPTION_HINT,
  PUBLIC_LINK_BANNER,
  LOCKED_LINE,
  FREE_BANNER,
  buildAcceptanceCriteria,
  deadlineUnixFromPreset,
  urlProblem,
  categoryById,
} from './data/presets.js';

const shortAddr = (a) => {
  if (!a) return '—';
  const s = String(a);
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
};

const pasteClipboard = async () => {
  const text = await navigator.clipboard.readText();
  return (text || '').trim();
};

const paymentLabel = (val) => `${formatWeiToGen(readWei(val))} GEN`;

const FlowStrip = ({ status }) => {
  const current = flowCurrentStep(status);
  const indexOf = { create: 0, submit: 1, ai: 2, done: 3 };
  const currentIdx = indexOf[current] ?? 0;
  return (
    <ol className="flow-strip">
      {FLOW_STEPS.map((step, i) => {
        const done = currentIdx > i || (current === 'done' && step.id === 'done');
        const isCurrent = currentIdx === i;
        return (
          <li key={step.id} className={`flow-step${isCurrent ? ' current' : ''}${done ? ' done' : ''}`}>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
};

const UrlFields = ({ urls, setUrls, placeholder, onError }) => (
  <>
    {urls.map((url, index) => (
      <div className="url-row" key={`${placeholder}-${index}`}>
        <input
          className="input mono"
          placeholder={placeholder}
          value={url}
          onChange={(e) => {
            const next = [...urls];
            next[index] = e.target.value;
            setUrls(next);
          }}
        />
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              const next = [...urls];
              next[index] = await pasteClipboard();
              setUrls(next);
            } catch {
              onError('Không đọc được clipboard. Hãy dán thủ công.');
            }
          }}
        >
          <ClipboardPaste size={14} /> Dán
        </button>
      </div>
    ))}
  </>
);

export default function App() {
  const [account, setAccount] = useState(null);
  const [rows, setRows] = useState([]);
  const [details, setDetails] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [copied, setCopied] = useState('');

  const [labelerAddr, setLabelerAddr] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('image');
  const [threshold, setThreshold] = useState('90');
  const [paymentStr, setPaymentStr] = useState('1');
  const [deadlineId, setDeadlineId] = useState('7d');
  const [guidelineUrls, setGuidelineUrls] = useState(['']);
  const [goldUrls, setGoldUrls] = useState(['']);
  const [submissionUrls, setSubmissionUrls] = useState(['']);

  const paymentWei = useMemo(() => parseGenToWei(paymentStr), [paymentStr]);
  const criteriaPreview = useMemo(
    () => buildAcceptanceCriteria(categoryId, threshold),
    [categoryId, threshold]
  );
  const category = categoryById(categoryId);

  const requireReady = () => {
    if (!hasContractAddress) {
      throw new Error('Chưa có địa chỉ contract. Deploy trên studionet, xác nhận Result: SUCCESS, rồi đặt VITE_CONTRACT_ADDRESS.');
    }
    if (!account) {
      throw new Error('Hãy kết nối ví trước.');
    }
  };

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setErrorMessage('Cần MetaMask để dùng LabelGuard trên studionet.');
        return;
      }
      setErrorMessage(null);
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const addr = accounts[0];
      try {
        await ensureStudioNetwork();
      } catch (err) {
        console.warn('studionet switch note:', err);
      }
      setAccount(addr);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Không kết nối được ví'));
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum?.request) return undefined;
    window.ethereum.request({ method: 'eth_accounts' }).then((accs) => {
      if (Array.isArray(accs) && accs[0]) setAccount(accs[0]);
    }).catch(() => {});
    const onAccounts = (accs) => {
      const next = Array.isArray(accs) && accs[0] ? accs[0] : null;
      setAccount(next);
    };
    window.ethereum.on?.('accountsChanged', onAccounts);
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', onAccounts);
    };
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setActiveId(id);
  }, []);

  const fetchRows = useCallback(async ({ silent = false } = {}) => {
    if (!hasContractAddress) {
      setRows([]);
      return { rows: [], count: 0 };
    }
    try {
      if (!silent) setLoading(true);
      const client = getListClient(account);
      if (!client) return { rows: [], count: 0 };
      const loaded = await loadBatches(client, account);
      setRows(loaded.rows);
      if (!silent && !loaded.rows.length && loaded.listError) {
        setErrorMessage(loaded.listError.message || 'Không tải được danh sách lô');
      }
      return loaded;
    } catch (err) {
      console.warn('list_batches failed:', err);
      if (!silent) setErrorMessage(err?.message || 'Không tải được danh sách lô');
      return { rows: [], count: 0 };
    } finally {
      if (!silent) setLoading(false);
    }
  }, [account]);

  const fetchDetail = async (batchId) => {
    if (!hasContractAddress || batchId == null || String(batchId).startsWith('0x')) return null;
    try {
      const client = getListClient(account);
      const row = normalizeBatchRow(await readView(client, 'get_batch', [String(batchId)], account), String(batchId));
      if (row) {
        setDetails((prev) => ({ ...prev, [String(batchId)]: row }));
        return row;
      }
      return null;
    } catch (err) {
      console.warn('get_batch failed:', err);
      return null;
    }
  };

  useEffect(() => {
    fetchRows();
    if (!hasContractAddress) return undefined;
    const timer = setInterval(() => {
      fetchRows({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [fetchRows]);

  const runWrite = async (fnName, args, value, { resolving, fromStatus } = {}) => {
    requireReady();
    setErrorMessage(null);
    setTxHash(null);
    if (resolving) setResolvingId(resolving);
    setLoading(true);
    const isAi = fnName === 'resolve_batch';
    try {
      await ensureStudioNetwork();
      const client = getWriteClient(account);
      const sender = resolveReadAccount(account);
      const hash = await client.writeContract({
        address: CONTRACT_ADDRESS,
        functionName: fnName,
        args,
        account: sender,
        value: value === undefined ? 0n : value,
      });
      setTxHash(hash);
      const receipt = await waitForTx(client, hash, isAi
        ? { retries: 90, interval: 5000 }
        : { retries: 40, interval: 2000 });

      if (isAi) {
        const settled = await pollUntilStatusChanges({
          fromStatus: fromStatus || 'SUBMITTED',
          attempts: 36,
          intervalMs: 5000,
          loadRow: async () => {
            await fetchRows({ silent: true });
            return fetchDetail(String(args[0]));
          },
        });
        const status = String(settled?.status || '');
        if (!status || status === (fromStatus || 'SUBMITTED')) {
          const explorer = txExplorerUrl(hash);
          const stuck = `Chưa có phán quyết mới. Hãy tải lại sau vài phút. Link phải là trang văn bản công khai. Explorer: ${explorer}`;
          if (receiptLooksFailed(receipt)) {
            throw new Error(`GenVM đã hoàn tác lượt chấm này. ${stuck}`);
          }
          setErrorMessage(stuck);
        }
        return hash;
      }

      const previousCount = rows.length;
      if (fnName === 'create_batch') {
        const listed = await pollUntilListed({
          previousCount,
          attempts: 20,
          intervalMs: 2000,
          load: () => fetchRows({ silent: true }),
        });
        const created = newestBatchId(listed.rows);
        if (created) {
          setActiveId(created);
          await fetchDetail(created);
        }
      } else {
        await fetchRows({ silent: true });
        if (args[0] != null) await fetchDetail(String(args[0]));
      }
      return hash;
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Giao dịch thất bại'));
      return null;
    } finally {
      setLoading(false);
      setResolvingId(null);
    }
  };

  const addUrl = (urls, setUrls) => {
    if (urls.length >= 5) return;
    setUrls([...urls, '']);
  };

  const onCreate = async (event) => {
    event.preventDefault();
    try {
      if (!description.trim()) throw new Error('Hãy mô tả ngắn công việc.');
      if (!/^0x[0-9a-fA-F]{40}$/.test(labelerAddr.trim())) {
        throw new Error('Địa chỉ người gán nhãn phải là 0x và 40 ký tự hex.');
      }
      if (sameAddress(labelerAddr.trim(), account)) {
        throw new Error('Người thuê và người gán nhãn phải là hai ví khác nhau.');
      }
      const guideError = urlProblem(guidelineUrls, 1, 'hướng dẫn');
      if (guideError) throw new Error(guideError);
      const goldError = urlProblem(goldUrls, 1, 'đáp án chuẩn');
      if (goldError) throw new Error(goldError);
      if (paymentWei <= 0n) throw new Error('Tiền công phải lớn hơn 0.');
      const preset = DEADLINE_PRESETS.find((item) => item.id === deadlineId) || DEADLINE_PRESETS[2];
      const deadline = deadlineUnixFromPreset(preset.seconds);
      await runWrite(
        'create_batch',
        [
          labelerAddr.trim(),
          description.trim(),
          guidelineUrls.map((item) => item.trim()).filter(Boolean),
          goldUrls.map((item) => item.trim()).filter(Boolean),
          criteriaPreview,
          deadline,
        ],
        paymentWei
      );
    } catch (err) {
      setErrorMessage(err?.message || 'Không tạo được lô việc');
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    try {
      const problem = urlProblem(submissionUrls, 1, 'bài nộp');
      if (problem) throw new Error(problem);
      await runWrite('submit_batch', [
        String(activeId),
        submissionUrls.map((item) => item.trim()).filter(Boolean),
      ]);
    } catch (err) {
      setErrorMessage(err?.message || 'Không nộp được bài');
    }
  };

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1600);
    } catch {
      setErrorMessage('Không đọc được clipboard. Hãy dán thủ công.');
    }
  };

  const visible = rows.filter((row) => {
    if (filter === 'requester') return sameAddress(row.requester, account);
    if (filter === 'labeler') return sameAddress(row.labeler, account);
    return true;
  });

  const active = activeId
    ? (details[activeId] || rows.find((row) => String(row.batch_id) === String(activeId)) || null)
    : null;

  const isRequester = active ? sameAddress(account, active.requester) : false;
  const isLabeler = active ? sameAddress(account, active.labeler) : false;
  const canSubmit = active && isLabeler && ['AWAITING_SUBMISSION', 'REVISION_REQUESTED', 'DISPUTED'].includes(active.status);
  const canResolve = active && active.status === 'SUBMITTED';
  const canRetry = active && active.status === 'PAYOUT_FAILED' && (isRequester || isLabeler);
  const canRefund = active && isRequester && !active.settled
    && ['AWAITING_SUBMISSION', 'REVISION_REQUESTED', 'DISPUTED'].includes(active.status)
    && deadlinePassed(active.submission_deadline);
  const hint = active ? nextActionHint({ status: active.status, isRequester, isLabeler }) : null;
  const networkName = studionet?.name || 'studionet';
  const guidelines = asUrlList(active?.guideline_urls);
  const gold = asUrlList(active?.gold_standard_urls);
  const submitted = asUrlList(active?.submission_urls);

  return (
    <div className="app">
      <div className="free-banner">{FREE_BANNER}</div>

      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Tags size={20} /></div>
          <div>
            <h1>LabelGuard</h1>
            <p>Escrow gán nhãn · studionet</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> {networkName}</div>
          <button className="btn-secondary" onClick={connectWallet} type="button">
            <Wallet size={16} />
            {account ? shortAddr(account) : 'Kết nối ví'}
          </button>
        </div>
      </header>

      {!hasContractAddress && (
        <div className="missing-banner" role="status">
          Chưa có địa chỉ contract. Trang vẫn mở và không gửi giao dịch. Sau khi deploy trên studionet hiện Result: SUCCESS, đặt <span className="mono">VITE_CONTRACT_ADDRESS</span> rồi build lại.
        </div>
      )}

      {hasContractAddress && (
        <p className="contract-line mono">
          Contract {shortAddr(CONTRACT_ADDRESS)}
        </p>
      )}

      <p className="pitch">
        Người thuê khoá một khoản GEN cố định cho cả lô. Hướng dẫn, đáp án chuẩn và tiêu chí bị khoá ngay lúc tạo. AI chỉ trả về ACCEPTED hoặc REJECTED. Đạt thì trả hết cho người gán nhãn. Không đạt lần đầu, còn hạn, thì được nộp lại một lần — tiền không đổi.
      </p>

      {errorMessage && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{errorMessage}</span>
          <button type="button" className="btn-ghost" onClick={() => setErrorMessage(null)}>Đóng</button>
        </div>
      )}
      {txHash && (
        <a className="tx-link" href={txExplorerUrl(txHash)} target="_blank" rel="noreferrer">
          Xem giao dịch trên explorer
        </a>
      )}

      <div className="layout">
        <form className="card" onSubmit={onCreate}>
          <h2>Tạo lô việc</h2>
          <p className="hint">Người thuê ký và gửi GEN vào escrow. Chỉ mô tả công việc là ô chữ tự do. Tiêu chí được sinh từ loại việc và ngưỡng khớp.</p>
          <div className="public-banner">{PUBLIC_LINK_BANNER}</div>

          <label className="label">Địa chỉ người gán nhãn</label>
          <div className="url-row">
            <input
              className="input mono"
              placeholder="0x..."
              value={labelerAddr}
              onChange={(e) => setLabelerAddr(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                try { setLabelerAddr(await pasteClipboard()); }
                catch { setErrorMessage('Không đọc được clipboard.'); }
              }}
            >
              <ClipboardPaste size={14} /> Dán
            </button>
          </div>

          <label className="label">Loại tác vụ</label>
          <div className="chips">
            {CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip${categoryId === item.id ? ' active' : ''}`}
                onClick={() => setCategoryId(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="hint">{category.hint}</p>

          <label className="label">Mô tả công việc</label>
          <textarea
            className="textarea"
            rows={4}
            maxLength={800}
            placeholder={DESCRIPTION_HINT}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label className="label">Link hướng dẫn</label>
          <UrlFields urls={guidelineUrls} setUrls={setGuidelineUrls} placeholder="https://" onError={setErrorMessage} />
          <button type="button" className="btn-ghost" onClick={() => addUrl(guidelineUrls, setGuidelineUrls)}>
            <Plus size={14} /> Thêm link
          </button>

          <label className="label">Link đáp án chuẩn</label>
          <UrlFields urls={goldUrls} setUrls={setGoldUrls} placeholder="https://" onError={setErrorMessage} />
          <button type="button" className="btn-ghost" onClick={() => addUrl(goldUrls, setGoldUrls)}>
            <Plus size={14} /> Thêm link
          </button>

          <label className="label">Ngưỡng chấp nhận</label>
          <select className="select" value={threshold} onChange={(e) => setThreshold(e.target.value)}>
            {THRESHOLDS.map((pct) => (
              <option key={pct} value={pct}>{pct}% khớp đáp án chuẩn</option>
            ))}
          </select>
          <div className="criteria-preview">
            <span className="label">Tiêu chí sẽ bị khoá</span>
            <p>{criteriaPreview}</p>
          </div>

          <label className="label">Tiền công cho cả lô</label>
          <div className="chips">
            {PAYMENT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`chip${paymentStr === preset ? ' active' : ''}`}
                onClick={() => setPaymentStr(preset)}
              >
                {preset} GEN
              </button>
            ))}
          </div>
          <input
            className="input mono"
            inputMode="decimal"
            value={paymentStr}
            onChange={(e) => setPaymentStr(sanitizeGenInput(e.target.value))}
          />
          <p className="hint">Sẽ khoá {paymentLabel(paymentWei)} trong contract. Đây là số cố định cho cả lô.</p>

          <label className="label">Hạn nộp</label>
          <select className="select" value={deadlineId} onChange={(e) => setDeadlineId(e.target.value)}>
            {DEADLINE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>

          <div className="row-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setGuidelineUrls([EXAMPLE_GUIDELINE_URL]);
                setGoldUrls([EXAMPLE_GOLD_URL]);
              }}
            >
              Điền link mẫu công khai
            </button>
            <button className="btn-primary" type="submit" disabled={loading}>
              Tạo lô và khoá tiền công
            </button>
          </div>
        </form>

        <section className="card">
          <div className="split">
            <h2>Các lô</h2>
            <button type="button" className="btn-ghost" onClick={() => fetchRows()} disabled={loading || !hasContractAddress}>
              <RefreshCw size={14} /> Tải lại
            </button>
          </div>
          <div className="filter-row">
            {[
              ['all', 'Tất cả'],
              ['requester', 'Tôi là người thuê'],
              ['labeler', 'Tôi là người gán nhãn'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={`chip${filter === id ? ' active' : ''}`} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          {!hasContractAddress && <p className="empty">Danh sách hiện sau khi cấu hình địa chỉ contract trên studionet.</p>}
          {hasContractAddress && visible.length === 0 && <p className="empty">Chưa có lô nào trong bộ lọc này.</p>}
          <div className="list">
            {visible.map((row) => (
              <button
                key={row.batch_id}
                type="button"
                className={`batch${String(activeId) === String(row.batch_id) ? ' selected' : ''}`}
                onClick={() => {
                  setActiveId(String(row.batch_id));
                  fetchDetail(row.batch_id);
                }}
              >
                <div className="split">
                  <strong>Lô #{row.batch_id}</strong>
                  <span className={`badge badge-${statusTone(row.status)}`}>{statusLabel(row.status)}</span>
                </div>
                <p>{row.task_description}</p>
                <p className="hint">{paymentLabel(row.payment_amount)} · hạn {formatDeadline(row.submission_deadline)}</p>
              </button>
            ))}
          </div>
        </section>
      </div>

      {active && (
        <section className="card detail">
          <FlowStrip status={active.status} />
          <div className="split">
            <h2>Lô #{active.batch_id}</h2>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => copyText(`${window.location.origin}${window.location.pathname}?id=${active.batch_id}`, 'share')}
            >
              <Copy size={14} /> {copied === 'share' ? 'Đã chép' : 'Chia sẻ'}
            </button>
          </div>
          <p>{active.task_description}</p>
          <div className="meta">
            <span>Người thuê {shortAddr(active.requester)}</span>
            <span>Người gán nhãn {shortAddr(active.labeler)}</span>
            <span>{paymentLabel(active.payment_amount)}</span>
            <span><Clock size={12} /> {formatDeadline(active.submission_deadline)}</span>
            <span>Lần nộp lại đã dùng: {String(active.revisions_used ?? 0)}/1</span>
          </div>

          <div className="locked">
            <div className="split">
              <strong><Lock size={14} /> Baseline đã khoá</strong>
            </div>
            <p className="lock-line">{LOCKED_LINE}</p>
            <p className="label">Tiêu chí chấp nhận</p>
            <p className="criteria-text">{active.acceptance_criteria}</p>
            <p className="label">Hướng dẫn</p>
            <ul className="link-list">
              {guidelines.map((url) => (
                <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
              ))}
            </ul>
            <p className="label">Đáp án chuẩn</p>
            <ul className="link-list">
              {gold.map((url) => (
                <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
              ))}
            </ul>
            <p className="hint">Tiền công {paymentLabel(active.payment_amount)} · hạn nộp {formatDeadline(active.submission_deadline)}</p>
          </div>

          {hint && (
            <div className="hint-box">
              <strong>{hint.title}</strong>
              <p>{hint.body}</p>
            </div>
          )}

          {active.verdict && (
            <div className={`verdict ${String(active.verdict).toUpperCase() === 'ACCEPTED' ? 'verdict-accepted' : 'verdict-rejected'}`}>
              <div className="split">
                <strong>{active.verdict}</strong>
                <span>Độ tin cậy {String(active.confidence ?? 0)}/100</span>
              </div>
              <p className="reason">{active.verdict_reason}</p>
            </div>
          )}
          {!active.verdict && active.verdict_reason && (
            <p className="reason">{active.verdict_reason}</p>
          )}

          {submitted.length > 0 && (
            <>
              <p className="label">Bài đã nộp</p>
              <ul className="link-list">
                {submitted.map((url) => (
                  <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
                ))}
              </ul>
            </>
          )}

          {canResolve && (
            <button
              type="button"
              className="btn-ai"
              disabled={loading}
              onClick={() => runWrite('resolve_batch', [String(active.batch_id)], 0n, { resolving: active.batch_id })}
            >
              <Scale size={16} />
              {resolvingId === String(active.batch_id) ? 'Đang đọc các link và đối chiếu với đáp án chuẩn…' : 'Yêu cầu AI chấm'}
            </button>
          )}

          {canRetry && (
            <button
              type="button"
              className="btn-primary"
              disabled={loading}
              onClick={() => runWrite('retry_resolution', [String(active.batch_id)])}
            >
              <RotateCcw size={16} /> Thử lại
            </button>
          )}

          {canRefund && (
            <button
              type="button"
              className="btn-danger"
              disabled={loading}
              onClick={() => runWrite('claim_expired_refund', [String(active.batch_id)])}
            >
              Lấy lại tiền công (đã hết hạn)
            </button>
          )}

          {canSubmit && deadlinePassed(active.submission_deadline) && (
            <p className="revision-note">Đã quá hạn nộp. Người thuê có thể lấy lại tiền công.</p>
          )}

          {active.status === 'REVISION_REQUESTED' && isLabeler && !deadlinePassed(active.submission_deadline) && (
            <p className="revision-note">Bạn còn 1 lần nộp lại. Tiền công vẫn nằm nguyên trong escrow.</p>
          )}

          {canSubmit && !deadlinePassed(active.submission_deadline) && (
            <form onSubmit={onSubmit}>
              <div className="public-banner">{PUBLIC_LINK_BANNER}</div>
              <label className="label">Link bài đã gán nhãn</label>
              <UrlFields urls={submissionUrls} setUrls={setSubmissionUrls} placeholder="https://" onError={setErrorMessage} />
              <button type="button" className="btn-ghost" onClick={() => addUrl(submissionUrls, setSubmissionUrls)}>
                <Plus size={14} /> Thêm link
              </button>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSubmissionUrls([EXAMPLE_SUBMISSION_URL])}
                >
                  Điền link mẫu công khai
                </button>
                <button className="btn-primary" type="submit" disabled={loading}>Nộp bài</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="card limits">
        <h2>Giới hạn cần biết trước khi nhận việc</h2>
        <ol>
          <li>Không có nguồn thứ ba độc lập để xác minh chất lượng gán nhãn. Baseline duy nhất là hướng dẫn và đáp án chuẩn do người thuê đặt, và hai thứ này bị khoá lúc tạo lô. AI chỉ xem bài nộp có khớp baseline đó hay không.</li>
          <li>Người thuê vẫn có thể đặt đáp án chuẩn bất công. Người gán nhãn cần đọc kỹ phần đã khoá trước khi làm.</li>
          <li>Khi kết quả là REJECTED, người thuê được hoàn tiền nhưng có thể đã thấy nội dung bài nộp. Đây là hạn chế thương mại, không phải một quyền trong contract.</li>
          <li>Contract chỉ đọc được link công khai dạng văn bản. File riêng tư hoặc trang cần đăng nhập sẽ lỗi.</li>
        </ol>
      </section>
    </div>
  );
}
