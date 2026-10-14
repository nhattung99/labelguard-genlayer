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
              onError('Could not read the clipboard. Paste the text manually.');
            }
          }}
        >
          <ClipboardPaste size={14} /> Paste
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
      throw new Error('No contract address is configured. Deploy on studionet, then set VITE_CONTRACT_ADDRESS.');
    }
    if (!account) {
      throw new Error('Connect a wallet first.');
    }
  };

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setErrorMessage('MetaMask is required to use LabelGuard on studionet.');
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
      setErrorMessage(formatWalletError(err, 'Could not connect the wallet'));
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
        setErrorMessage(loaded.listError.message || 'Could not load batches');
      }
      return loaded;
    } catch (err) {
      console.warn('list_batches failed:', err);
      if (!silent) setErrorMessage(err?.message || 'Could not load batches');
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
          const stuck = `No new verdict yet. Refresh in a few minutes. Use a public text link. Explorer: ${explorer}`;
          if (receiptLooksFailed(receipt)) {
            throw new Error(`GenVM rolled this check back. ${stuck}`);
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
      setErrorMessage(formatWalletError(err, 'Transaction failed'));
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
      if (!description.trim()) throw new Error('Describe the labeling job.');
      if (!/^0x[0-9a-fA-F]{40}$/.test(labelerAddr.trim())) {
        throw new Error('The labeler address must be 0x followed by 40 hex characters.');
      }
      if (sameAddress(labelerAddr.trim(), account)) {
        throw new Error('The requester and the labeler must use different wallets.');
      }
      const guideError = urlProblem(guidelineUrls, 1, 'guideline');
      if (guideError) throw new Error(guideError);
      const goldError = urlProblem(goldUrls, 1, 'gold-standard');
      if (goldError) throw new Error(goldError);
      if (paymentWei <= 0n) throw new Error('The fee must be greater than 0.');
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
      setErrorMessage(err?.message || 'Could not create the batch');
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    try {
      const problem = urlProblem(submissionUrls, 1, 'submission');
      if (problem) throw new Error(problem);
      await runWrite('submit_batch', [
        String(activeId),
        submissionUrls.map((item) => item.trim()).filter(Boolean),
      ]);
    } catch (err) {
      setErrorMessage(err?.message || 'Could not submit the batch');
    }
  };

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1600);
    } catch {
      setErrorMessage('Could not read the clipboard. Paste the text manually.');
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
            <p>Labeling escrow · studionet</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> {networkName}</div>
          <button className="btn-secondary" onClick={connectWallet} type="button">
            <Wallet size={16} />
            {account ? shortAddr(account) : 'Connect wallet'}
          </button>
        </div>
      </header>

      {!hasContractAddress && (
        <div className="missing-banner" role="status">
          No contract address yet. The page still opens and will not send a transaction. After a studionet deploy shows Result: SUCCESS, set <span className="mono">VITE_CONTRACT_ADDRESS</span> and build again.
        </div>
      )}

      {hasContractAddress && (
        <p className="contract-line mono">
          Contract {shortAddr(CONTRACT_ADDRESS)}
        </p>
      )}

      <p className="pitch">
        The requester locks one fixed GEN fee for the whole batch. Guidelines, gold answers, and the acceptance criteria lock at creation. AI returns only ACCEPTED or REJECTED. Accepted pays the labeler in full. The first rejection, while the deadline is still open, allows one resubmission and does not move the fee.
      </p>

      {errorMessage && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{errorMessage}</span>
          <button type="button" className="btn-ghost" onClick={() => setErrorMessage(null)}>Close</button>
        </div>
      )}
      {txHash && (
        <a className="tx-link" href={txExplorerUrl(txHash)} target="_blank" rel="noreferrer">
          View transaction on the explorer
        </a>
      )}

      <div className="layout">
        <form className="card" onSubmit={onCreate}>
          <h2>Create a batch</h2>
          <p className="hint">The requester signs and sends GEN into escrow. The job description is the only free-text field. The acceptance line is generated from the task type and the match threshold.</p>
          <div className="public-banner">{PUBLIC_LINK_BANNER}</div>

          <label className="label">Labeler address</label>
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
                catch { setErrorMessage('Could not read the clipboard.'); }
              }}
            >
              <ClipboardPaste size={14} /> Paste
            </button>
          </div>

          <label className="label">Task type</label>
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

          <label className="label">Job description</label>
          <textarea
            className="textarea"
            rows={4}
            maxLength={800}
            placeholder={DESCRIPTION_HINT}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label className="label">Guideline link</label>
          <UrlFields urls={guidelineUrls} setUrls={setGuidelineUrls} placeholder="https://" onError={setErrorMessage} />
          <button type="button" className="btn-ghost" onClick={() => addUrl(guidelineUrls, setGuidelineUrls)}>
            <Plus size={14} /> Add link
          </button>

          <label className="label">Gold-standard link</label>
          <UrlFields urls={goldUrls} setUrls={setGoldUrls} placeholder="https://" onError={setErrorMessage} />
          <button type="button" className="btn-ghost" onClick={() => addUrl(goldUrls, setGoldUrls)}>
            <Plus size={14} /> Add link
          </button>

          <label className="label">Acceptance threshold</label>
          <select className="select" value={threshold} onChange={(e) => setThreshold(e.target.value)}>
            {THRESHOLDS.map((pct) => (
              <option key={pct} value={pct}>{pct}% match with the gold standard</option>
            ))}
          </select>
          <div className="criteria-preview">
            <span className="label">Criteria that will be locked</span>
            <p>{criteriaPreview}</p>
          </div>

          <label className="label">Fee for the whole batch</label>
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
          <p className="hint">This will lock {paymentLabel(paymentWei)} in the contract. The amount is fixed for the whole batch.</p>

          <label className="label">Submission deadline</label>
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
              Fill sample public links
            </button>
            <button className="btn-primary" type="submit" disabled={loading}>
              Create batch and lock the fee
            </button>
          </div>
        </form>

        <section className="card">
          <div className="split">
            <h2>Batches</h2>
            <button type="button" className="btn-ghost" onClick={() => fetchRows()} disabled={loading || !hasContractAddress}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <div className="filter-row">
            {[
              ['all', 'All'],
              ['requester', 'I am the requester'],
              ['labeler', 'I am the labeler'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={`chip${filter === id ? ' active' : ''}`} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          {!hasContractAddress && <p className="empty">The list appears after a studionet contract address is configured.</p>}
          {hasContractAddress && visible.length === 0 && <p className="empty">No batches in this filter yet.</p>}
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
                  <strong>Batch #{row.batch_id}</strong>
                  <span className={`badge badge-${statusTone(row.status)}`}>{statusLabel(row.status)}</span>
                </div>
                <p>{row.task_description}</p>
                <p className="hint">{paymentLabel(row.payment_amount)} · deadline {formatDeadline(row.submission_deadline)}</p>
              </button>
            ))}
          </div>
        </section>
      </div>

      {active && (
        <section className="card detail">
          <FlowStrip status={active.status} />
          <div className="split">
            <h2>Batch #{active.batch_id}</h2>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => copyText(`${window.location.origin}${window.location.pathname}?id=${active.batch_id}`, 'share')}
            >
              <Copy size={14} /> {copied === 'share' ? 'Copied' : 'Share'}
            </button>
          </div>
          <p>{active.task_description}</p>
          <div className="meta">
            <span>Requester {shortAddr(active.requester)}</span>
            <span>Labeler {shortAddr(active.labeler)}</span>
            <span>{paymentLabel(active.payment_amount)}</span>
            <span><Clock size={12} /> {formatDeadline(active.submission_deadline)}</span>
            <span>Revisions used: {String(active.revisions_used ?? 0)}/1</span>
          </div>

          <div className="locked">
            <div className="split">
              <strong><Lock size={14} /> Locked baseline</strong>
            </div>
            <p className="lock-line">{LOCKED_LINE}</p>
            <p className="label">Acceptance criteria</p>
            <p className="criteria-text">{active.acceptance_criteria}</p>
            <p className="label">Guidelines</p>
            <ul className="link-list">
              {guidelines.map((url) => (
                <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
              ))}
            </ul>
            <p className="label">Gold standard</p>
            <ul className="link-list">
              {gold.map((url) => (
                <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
              ))}
            </ul>
            <p className="hint">Fee {paymentLabel(active.payment_amount)} · deadline {formatDeadline(active.submission_deadline)}</p>
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
                <span>Confidence {String(active.confidence ?? 0)}/100</span>
              </div>
              <p className="reason">{active.verdict_reason}</p>
            </div>
          )}
          {!active.verdict && active.verdict_reason && (
            <p className="reason">{active.verdict_reason}</p>
          )}

          {submitted.length > 0 && (
            <>
              <p className="label">Submitted work</p>
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
              {resolvingId === String(active.batch_id) ? 'Reading the links and comparing them with the gold standard…' : 'Request an AI check'}
            </button>
          )}

          {canRetry && (
            <button
              type="button"
              className="btn-primary"
              disabled={loading}
              onClick={() => runWrite('retry_resolution', [String(active.batch_id)])}
            >
              <RotateCcw size={16} /> Try again
            </button>
          )}

          {canRefund && (
            <button
              type="button"
              className="btn-danger"
              disabled={loading}
              onClick={() => runWrite('claim_expired_refund', [String(active.batch_id)])}
            >
              Claim the fee (deadline passed)
            </button>
          )}

          {canSubmit && deadlinePassed(active.submission_deadline) && (
            <p className="revision-note">The submission deadline has passed. The requester can claim the fee back.</p>
          )}

          {active.status === 'REVISION_REQUESTED' && isLabeler && !deadlinePassed(active.submission_deadline) && (
            <p className="revision-note">You have 1 revision left. The fee is still untouched in escrow.</p>
          )}

          {canSubmit && !deadlinePassed(active.submission_deadline) && (
            <form onSubmit={onSubmit}>
              <div className="public-banner">{PUBLIC_LINK_BANNER}</div>
              <label className="label">Labeled batch link</label>
              <UrlFields urls={submissionUrls} setUrls={setSubmissionUrls} placeholder="https://" onError={setErrorMessage} />
              <button type="button" className="btn-ghost" onClick={() => addUrl(submissionUrls, setSubmissionUrls)}>
                <Plus size={14} /> Add link
              </button>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSubmissionUrls([EXAMPLE_SUBMISSION_URL])}
                >
                  Fill sample public links
                </button>
                <button className="btn-primary" type="submit" disabled={loading}>Submit batch</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="card limits">
        <h2>Limits to read before you accept the job</h2>
        <ol>
          <li>There is no independent third party that can verify labeling quality. The only baseline is the guidelines and gold answers the requester set, and those are locked when the batch is created. The AI only checks whether the submission matches that baseline.</li>
          <li>A requester can still set an unfair gold standard. Read the locked materials carefully before you start.</li>
          <li>On REJECTED, the requester is refunded but may already have seen the submission. That is a commercial limit, not a right granted by the contract.</li>
          <li>The contract can only read public text links. Private files and pages that require a login will fail.</li>
        </ol>
      </section>
    </div>
  );
}
