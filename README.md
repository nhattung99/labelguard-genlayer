# LabelGuard — Neutral labeling escrow on GenLayer

Small AI teams hire people to label data (image classes, answer scores, translations) and then have no cheap referee for each small batch. Labelers worry the requester will reject finished work without paying. LabelGuard holds **one fixed GEN fee** in **one Intelligent Contract**. The requester locks the guidelines, the gold-standard answers, and the acceptance criteria at creation. GenLayer AI returns exactly one of two verdicts:

`ACCEPTED` · `REJECTED`

There is no percentage tolerance on the money. There is no second amount. The whole `payment_amount` goes to the labeler, or back to the requester.

> LabelGuard dies without GenLayer: no EVM smart contract can read an unstructured labeling batch and compare it with natural-language guidelines and gold answers, and no auditor is cheap enough to review each small job from an independent AI team. Only GenLayer's decentralized AI consensus can do this at near-zero cost.

## Live App

https://labelguard-genlayer.vercel.app

## Deployed Contract

- **Network:** studionet only
- **Address:** `0xe5280FbC862E8d6452277DBC78595A5052D86cB9`
- **Explorer:** https://genlayer-explorer.vercel.app/address/0xe5280FbC862E8d6452277DBC78595A5052D86cB9

## Why the verdict is binary

JobVerdict was rejected because a percent tolerance let two validators "agree" while locking two different amounts. LabelGuard has only two discrete outcomes. Validators compare with absolute equality:

- the verdict string is identical (`ACCEPTED` or `REJECTED`, including an empty string when the response cannot be parsed)
- both confidences sit on the same side of 60 (`>= 60` settles, `< 60` is `DISPUTED`)

There is no numeric tolerance. Confidence never scales the fee. A figure such as "90%" lives only inside the `acceptance_criteria` sentence, which the model applies inside the judgment. The final output is still ACCEPTED or REJECTED, and the GEN that moves is always the locked `payment_amount`.

The first `REJECTED`, while the deadline is still open and `revisions_used == 0`, moves the batch to `REVISION_REQUESTED`. The fee does not move. `revisions_used` becomes 1. A later `REJECTED`, or a `REJECTED` after the deadline, refunds the requester in full.

## Why one contract

The requester sends GEN into this contract on `create_batch`. Payouts use `gl.get_contract_at(recipient).emit_transfer(value=u256(payment_amount))`. There is no second contract and no value-forward hop.

## Resolution flow

1. **Create** — the requester sets a labeler address (different from their own), a description, at least one guideline URL, at least one gold-standard URL, the acceptance criteria, a deadline, and attaches `payment_amount` GEN greater than 0.
2. Guidelines, gold answers, and the acceptance criteria are stored once. This contract has **no method that can change them**.
3. **Submit** — only the labeler, and only while status is `AWAITING_SUBMISSION`, `REVISION_REQUESTED`, or `DISPUTED`, and only before the deadline. At least one submission URL starting with `http://` or `https://`. Status becomes `SUBMITTED`.
4. **Resolve** — anyone can call `resolve_batch` while status is `SUBMITTED`. `gl.vm.run_nondet` renders each URL and asks for JSON `{verdict, confidence, reason}`.
5. `confidence < 60`, an empty verdict, or unparseable JSON becomes `DISPUTED`. The fee stays put. The labeler may submit again.
6. If a guideline, gold-standard, or submission URL cannot be read, the contract does not ask the model and does not pay anyone. Status becomes `DISPUTED` with reason `Failed to fetch ...`. A hard revert would leave status `SUBMITTED`, and `submit_batch` cannot replace URLs in that status.
7. `REJECTED` with `revisions_used == 0` and `now <= submission_deadline` becomes `REVISION_REQUESTED`. The fee stays put.
8. Otherwise `_execute_settlement` pays the full fee: the labeler on `ACCEPTED` (`RESOLVED_ACCEPTED`), the requester on `REJECTED` (`RESOLVED_REJECTED`).
9. A failed transfer sets `PAYOUT_FAILED` and keeps the verdict. `retry_resolution` (requester or labeler) pays the same party again and does not rerun AI. An expired refund that failed has an empty verdict; retry pays the requester and finishes as `EXPIRED_REFUNDED`.
10. If the deadline passes while status is still `AWAITING_SUBMISSION`, `REVISION_REQUESTED`, or `DISPUTED`, the requester calls `claim_expired_refund`. No AI. There is no cancel before the deadline.

Status is written to the success value before `emit_transfer`, so a re-entrant resolve no longer sees `SUBMITTED`.

## Honest limits

1. This field has **no independent third-party source** that can verify labeling quality. The only baseline is the guidelines plus the gold-standard answers set by the requester. Fairness comes from **locking those materials when the batch is created**, not from an outside verifier. The AI judges whether the submission is consistent with that baseline. It does not judge absolute objective truth.
2. A requester can still set an unfair gold standard. The labeler must read it carefully before accepting the job. The UI shows the guidelines, gold answers, and acceptance criteria prominently before the labeler starts.
3. On `REJECTED`, the requester is refunded but may already have seen the submitted batch. That is a commercial limit outside the contract.
4. `gl.nondet.web.render` can only read public text links (a Google Sheet published to the web, a GitHub gist or raw file, or a text page). Private files or pages that require a login fail to fetch. The UI says this clearly.

## Verified APIs

| Need | API used | Do not use |
|---|---|---|
| Caller | `gl.message.sender_address` | `gl.message.sender` |
| Pay GEN | `gl.get_contract_at(addr).emit_transfer(value=u256(amount))` | `gl.transfer(...)` |
| Receive GEN | `@gl.public.write.payable` + `gl.message.value` on `create_batch` | plain `@gl.public.write` when attaching GEN (current Studio raises `called non-payable method` and leaves `value` at 0) |
| Timestamp | `gl.message.datetime` parsed with `datetime.fromisoformat` via `_current_unix_timestamp` | `gl.block.timestamp` |
| TreeMap | `in` plus a walk of `batch_counter`; `.get(key, default)` exists in the SDK | — |

Header copied from the current Studio template:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

An older note that `@gl.public.write.payable` "does not exist" is wrong for this Studio hash. AuthentiCheck, SponsorCheck, and AuditBounty all deploy with the same hash and mark the value-receiving method `.payable`. Only `create_batch` is payable. Every other write is `@gl.public.write`.

### Write methods

- `create_batch(labeler, task_description, guideline_urls, gold_standard_urls, acceptance_criteria, submission_deadline) -> batch_id` — attach GEN `> 0`
- `submit_batch(batch_id, submission_urls)` — labeler only
- `resolve_batch(batch_id)` — AI, only from `SUBMITTED`
- `claim_expired_refund(batch_id)` — requester only, after the deadline, while nothing has been accepted or is waiting on review
- `retry_resolution(batch_id)` — requester or labeler, only `PAYOUT_FAILED`

### View methods

Views return JSON text except the count and the owner:

- `get_batch(batch_id) -> str`
- `list_batches() -> str`
- `get_batch_count() -> int`
- `get_owner() -> str`

`payment_amount` and `submission_deadline` are decimal integer strings, never JSON numbers, so the browser does not round them.

## Money handling — one field only

`payment_amount` is the only money field. It is the full batch fee in wei (10^18 base units per GEN). Nothing in the contract or the frontend multiplies it by a percent.

| Step | Where | What happens |
|---|---|---|
| WRITE | `frontend/src/App.jsx` create form | Chip or typed GEN string → `parseGenToWei` → `writeContract({ value })` |
| WRITE | `create_batch` | `payment = bigint(gl.message.value)` stored on `Batch.payment_amount` |
| WRITE | `_execute_settlement` | `emit_transfer(value=u256(payment_amount))` to the labeler on `ACCEPTED`, or to the requester on `REJECTED` |
| WRITE | `claim_expired_refund` and the empty-verdict branch of `retry_resolution` | the same full `payment_amount` back to the requester |
| READ | `get_batch` / `list_batches` | `str(int(payment_amount))` inside JSON |
| READ | `frontend/src/App.jsx` | `readWei` (digit string or bigint only) → `formatWeiToGen` |

`parseGenToWei` and `formatWeiToGen` are string splits plus `BigInt`. They do not call `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil`. `scripts/check-no-float-money.js` scans `frontend/src/**/*.{js,jsx}` and fails the build if those calls sit near `payment`, `amount`, `payout`, `refund`, `balance`, `wei`, or `gen`. The frontend `prebuild` script runs it.

Display chips such as `1 GEN` are labels. The value that leaves the browser is the wei integer from `parseGenToWei`.

## Deploy on studionet (manual)

Do this in GenLayer Studio. Do not switch the app to another chain.

1. Open [GenLayer Studio](https://studio.genlayer.com) on **studionet**.
2. Create a contract and paste `contracts/label_guard.py` unchanged, including the two header lines.
3. Deploy. Wait until the receipt says **Result: SUCCESS**.
4. The deployed address is recorded under **Deployed Contract** above.

Local preview:

```bash
cd frontend
npm install
npm run dev
```

Without `VITE_CONTRACT_ADDRESS`, the page shows the missing-address banner and the free-to-use banner. Creating a batch shows an error instead of a blank page.

## Tests

```bash
pip install -r requirements.txt
python -m pytest tests/test_label_guard.py -q
cd frontend && npm test
```

Covered paths: accepted payout to the labeler, first rejection with the fee untouched then an accepted resubmit, rejection after the one revision refunds the requester, rejection after the deadline skips revision, an expired batch with no submission refunds the requester, a late submit is blocked, confidence below 60 disputes and a resubmit can resolve, web fetch failure and broken JSON dispute without paying, missing URLs or criteria or the same party are blocked, the baseline has no update method and does not change after submit, double submit and double resolve are blocked, and a forced `emit_transfer` failure on all three payout branches (accepted, final rejection, expired refund) is followed by `retry_resolution` to the correct recipient.

## Frontend

Task type is a chip: Image classification, Text sentiment, Answer scoring, Translation, or Other. A dropdown of 80% / 90% / 95% writes the acceptance sentence. The user does not type the criteria. Fee chips. Deadline dropdown: 24 hours, 3 days, 7 days, 14 days. Each link row has a paste button. Create and submit both show the public-link banner. The detail view highlights the locked guidelines, gold answers, criteria, fee, and deadline, with the line "These materials are locked and cannot be changed after the batch is created." `REVISION_REQUESTED` says the labeler has one revision left. `DISPUTED` can resubmit. `PAYOUT_FAILED` has **Try again**. The sticky banner states that the only cost is GenLayer gas.

Wallet traffic stays on `chains.studionet`. Reads go through `/api/genlayer`, which Vercel and the Vite dev server proxy to `https://studio.genlayer.com/api`.
