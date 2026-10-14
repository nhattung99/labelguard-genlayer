# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
from datetime import datetime, timezone
import json

UserError = gl.vm.UserError

MIN_CONFIDENCE = 60
VALID_VERDICTS = ("ACCEPTED", "REJECTED")
RENDER_CHAR_CAP = 6000


def _addr_str(a) -> str:
    try:
        return a.as_hex.lower()
    except Exception:
        s = str(a).lower()
        if not s.startswith("0x") and len(s) == 40:
            return "0x" + s
        return s


def _to_address(val) -> Address:
    if isinstance(val, Address):
        return val
    if isinstance(val, str):
        val_str = val.strip()
        if not val_str.startswith("0x"):
            val_str = "0x" + val_str
        return Address(val_str)
    if hasattr(val, "as_hex"):
        return val
    return Address(val)


def _same_addr(a, b) -> bool:
    return _addr_str(a) == _addr_str(b)


def _current_unix_timestamp() -> u256:
    """Verified clock: gl.message.datetime (ISO-8601). Never gl.block.timestamp."""
    raw = None
    try:
        raw = getattr(gl.message, "datetime", None)
    except Exception:
        raw = None
    if raw is None or str(raw).strip() == "":
        try:
            raw = gl.message_raw.get("datetime")
        except Exception:
            raw = None
    if raw is not None and str(raw).strip() != "":
        dt_str = str(raw).strip()
        if dt_str.endswith("Z"):
            dt_str = dt_str[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(dt_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return u256(int(dt.timestamp()))
        except Exception as err:
            raise UserError("Invalid execution timestamp format from GenVM message: " + str(err))
    return u256(int(datetime.now(timezone.utc).timestamp()))


def _now() -> int:
    return int(_current_unix_timestamp())


def _str_list(values) -> list:
    out = []
    try:
        n = len(values)
    except Exception:
        return out
    for i in range(n):
        out.append(str(values[i]))
    return out


def _clean_http_urls(urls, kind: str, minimum: int) -> list:
    cleaned = []
    try:
        n = len(urls)
    except Exception:
        n = 0
    for i in range(n):
        url = str(urls[i]).strip()
        if len(url) == 0:
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            raise UserError("Invalid " + kind + " URL: must start with http:// or https://")
        cleaned.append(url)
    if len(cleaned) < minimum:
        raise UserError("At least " + str(minimum) + " " + kind + " URL(s) required")
    return cleaned


def _bound_page_text(text) -> str:
    s = str(text or "")
    s = s.replace("<<<", "[").replace(">>>", "]").replace("```", "'''")
    if len(s) > RENDER_CHAR_CAP:
        s = s[:RENDER_CHAR_CAP]
    return s


def _page_text(res) -> str:
    if hasattr(res, "body"):
        return str(res.body)
    if hasattr(res, "text"):
        return str(res.text)
    if isinstance(res, dict):
        if "body" in res:
            return str(res["body"])
        if "text" in res:
            return str(res["text"])
        ok = res.get("ok")
        if isinstance(ok, dict):
            if "text" in ok:
                return str(ok["text"])
            if "body" in ok:
                return str(ok["body"])
    return str(res)


def _fetch_page(url: str) -> str:
    try:
        res = gl.nondet.web.render(url)
    except Exception as e:
        return "FETCH_FAILED: " + str(e)
    text = _page_text(res).strip()
    if len(text) == 0:
        return "FETCH_FAILED: empty page"
    return _bound_page_text(text)


def _leader_payload(leader_res):
    for attr in ("value", "calldata"):
        try:
            payload = getattr(leader_res, attr)
        except Exception:
            continue
        if isinstance(payload, dict):
            return payload
    if isinstance(leader_res, dict):
        return leader_res
    return None


def _extract_result(result) -> dict:
    payload = _leader_payload(result)
    if payload is None and isinstance(result, dict):
        payload = result
    if not isinstance(payload, dict):
        raise UserError("Invalid nondet consensus result")
    return payload


def _parse_verdict(raw) -> dict:
    if isinstance(raw, dict) and "verdict" in raw and "confidence" in raw and "reason" in raw:
        data = raw
    elif isinstance(raw, dict):
        data = raw
    else:
        cleaned = str(raw).strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if len(lines) >= 1 and lines[0].startswith("```"):
                lines = lines[1:]
            if len(lines) >= 1 and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            data = json.loads(cleaned)
        except Exception as e:
            return {
                "verdict": "",
                "confidence": 0,
                "reason": "Failed to parse LLM response. Error: " + str(e),
            }

    if not isinstance(data, dict):
        return {
            "verdict": "",
            "confidence": 0,
            "reason": "AI verdict response must be a JSON object",
        }

    verdict = str(data.get("verdict", "")).strip().upper()
    if verdict not in VALID_VERDICTS:
        provided = str(data.get("reason", "")).strip()
        if verdict == "" and provided:
            reason = provided
        else:
            reason = "verdict must be ACCEPTED or REJECTED — got: " + verdict
            if provided:
                reason = reason + " " + provided
        if len(reason) > 800:
            reason = reason[:800]
        return {
            "verdict": "",
            "confidence": 0,
            "reason": reason,
        }

    try:
        conf = int(data.get("confidence", 0))
    except Exception:
        conf = 0
    if conf < 0 or conf > 100:
        conf = 0

    reason = str(data.get("reason", ""))
    if len(reason) > 800:
        reason = reason[:800]
    return {
        "verdict": verdict,
        "confidence": conf,
        "reason": reason,
    }


def _vote_ok(verdict: str, conf: int) -> bool:
    if verdict in VALID_VERDICTS:
        return True
    return verdict == "" and conf < MIN_CONFIDENCE


def _consensus_accepts(leader_verdict, leader_conf, my_verdict, my_conf) -> bool:
    """Absolute equality on the binary verdict and on the settle-vs-dispute branch.

    Validators do not use a percent tolerance. Two ACCEPTED results agree only when
    both confidences sit on the same side of 60, because that is the branch that
    either pays the fixed payment_amount or leaves it untouched.
    """
    try:
        lc = int(leader_conf)
        mc = int(my_conf)
    except Exception:
        return False
    if not (0 <= lc <= 100 and 0 <= mc <= 100):
        return False
    lv = str(leader_verdict or "").strip().upper()
    mv = str(my_verdict or "").strip().upper()
    if not _vote_ok(lv, lc) or not _vote_ok(mv, mc):
        return False
    if mv != lv:
        return False
    return (mc >= MIN_CONFIDENCE) == (lc >= MIN_CONFIDENCE)


def _pay(recipient, amount) -> None:
    gl.get_contract_at(_to_address(recipient)).emit_transfer(value=u256(amount))


def _collect_pages(urls):
    chunks = []
    failed = []
    for url in urls:
        text = _fetch_page(url)
        if text.startswith("FETCH_FAILED"):
            failed.append(str(url))
        chunks.append("[" + str(url) + "]: " + text)
    return chunks, failed


@allow_storage
@dataclass
class Batch:
    requester: Address
    labeler: Address
    task_description: str
    guideline_urls: DynArray[str]
    gold_standard_urls: DynArray[str]
    acceptance_criteria: str
    payment_amount: bigint
    submission_deadline: u256
    submission_urls: DynArray[str]
    revisions_used: u256
    status: str
    verdict: str
    verdict_reason: str
    confidence: u256
    settled: bool


class Contract(gl.Contract):
    owner: Address
    batch_counter: bigint
    batches: TreeMap[str, Batch]

    def __init__(self):
        self.owner = _to_address(gl.message.sender_address)
        self.batch_counter = bigint(0)

    @gl.public.write.payable
    def create_batch(
        self,
        labeler: Address,
        task_description: str,
        guideline_urls: DynArray[str],
        gold_standard_urls: DynArray[str],
        acceptance_criteria: str,
        submission_deadline: u256,
    ) -> str:
        """
        Requester escrows a fixed GEN payment with the call.
        @gl.public.write.payable is required on the current Studio hash so
        gl.message.value is populated. A plain @gl.public.write leaves value
        at 0 and Studio raises "called non-payable method".
        Guidelines, gold answers, and acceptance criteria are stored once
        and this contract has no method that can change them later.
        """
        payment = bigint(gl.message.value)
        if payment <= bigint(0):
            raise UserError("Must send GEN as payment (amount must be > 0)")
        description = str(task_description or "").strip()
        if len(description) == 0:
            raise UserError("Task description cannot be empty")
        criteria = str(acceptance_criteria or "").strip()
        if len(criteria) == 0:
            raise UserError("Acceptance criteria cannot be empty")
        sender = _to_address(gl.message.sender_address)
        labeler_addr = _to_address(labeler)
        if _same_addr(labeler_addr, sender):
            raise UserError("Requester and labeler cannot be the same address")
        if int(submission_deadline) <= 0:
            raise UserError("Submission deadline must be a unix timestamp")
        guidelines = _clean_http_urls(guideline_urls, "guideline", 1)
        gold = _clean_http_urls(gold_standard_urls, "gold standard", 1)

        batch_id = str(self.batch_counter)
        self.batch_counter = self.batch_counter + bigint(1)

        self.batches[batch_id] = Batch(
            requester=sender,
            labeler=labeler_addr,
            task_description=description,
            guideline_urls=guidelines,
            gold_standard_urls=gold,
            acceptance_criteria=criteria,
            payment_amount=payment,
            submission_deadline=u256(submission_deadline),
            submission_urls=[],
            revisions_used=u256(0),
            status="AWAITING_SUBMISSION",
            verdict="",
            verdict_reason="",
            confidence=u256(0),
            settled=False,
        )
        return batch_id

    @gl.public.write
    def submit_batch(self, batch_id: str, submission_urls: DynArray[str]) -> None:
        if batch_id not in self.batches:
            raise UserError("Batch does not exist")
        b = self.batches[batch_id]
        if not _same_addr(gl.message.sender_address, b.labeler):
            raise UserError("Only the labeler can submit")
        if b.settled:
            raise UserError("Batch already settled")
        if b.status not in ["AWAITING_SUBMISSION", "REVISION_REQUESTED", "DISPUTED"]:
            raise UserError("Cannot submit in status: " + str(b.status))
        if _now() > int(b.submission_deadline):
            raise UserError("Submission deadline has passed")
        cleaned = _clean_http_urls(submission_urls, "submission", 1)

        b.submission_urls = cleaned
        b.status = "SUBMITTED"
        self.batches[batch_id] = b

    @gl.public.write
    def claim_expired_refund(self, batch_id: str) -> None:
        """Requester takes the full payment back only after the deadline, and only
        while nothing has been accepted or is waiting on AI. There is no cancel
        before the deadline."""
        if batch_id not in self.batches:
            raise UserError("Batch does not exist")
        b = self.batches[batch_id]
        if not _same_addr(gl.message.sender_address, b.requester):
            raise UserError("Only requester can claim this refund")
        if b.settled:
            raise UserError("Batch already settled")
        if b.status not in ["AWAITING_SUBMISSION", "REVISION_REQUESTED", "DISPUTED"]:
            raise UserError("Refund only available while no submission has been accepted or is pending review")
        if _now() <= int(b.submission_deadline):
            raise UserError("Submission deadline has not passed yet")

        b.status = "EXPIRED_REFUNDED"
        self.batches[batch_id] = b
        try:
            _pay(b.requester, b.payment_amount)
            b.settled = True
            b.status = "EXPIRED_REFUNDED"
        except Exception as e:
            b.settled = False
            b.status = "PAYOUT_FAILED"
            b.verdict_reason = "Expired refund failed: " + str(e)
        self.batches[batch_id] = b

    @gl.public.write
    def resolve_batch(self, batch_id: str) -> None:
        if batch_id not in self.batches:
            raise UserError("Batch does not exist")
        b = self.batches[batch_id]
        if b.settled:
            raise UserError("Batch already settled")
        if b.status != "SUBMITTED":
            raise UserError("Batch not ready for resolution (status: " + str(b.status) + ")")

        task_description = str(b.task_description)
        criteria = str(b.acceptance_criteria)
        guideline_urls_list = _str_list(b.guideline_urls)
        gold_urls_list = _str_list(b.gold_standard_urls)
        submission_urls_list = _str_list(b.submission_urls)

        def leader_fn() -> dict:
            guidelines, guide_failed = _collect_pages(guideline_urls_list)
            gold, gold_failed = _collect_pages(gold_urls_list)
            submission, sub_failed = _collect_pages(submission_urls_list)

            if len(guide_failed) > 0:
                return {
                    "verdict": "",
                    "confidence": 0,
                    "reason": "Failed to fetch guideline URL: " + guide_failed[0],
                }
            if len(gold_failed) > 0:
                return {
                    "verdict": "",
                    "confidence": 0,
                    "reason": "Failed to fetch gold standard URL: " + gold_failed[0],
                }
            if len(sub_failed) > 0:
                return {
                    "verdict": "",
                    "confidence": 0,
                    "reason": "Failed to fetch submission URL: " + sub_failed[0],
                }

            prompt = "You are a neutral data-labeling quality adjudicator.\n"
            prompt += "Task: \"" + task_description + "\"\n"
            prompt += "Labeling guidelines (locked by the requester before work began): " + str(guidelines) + "\n"
            prompt += "Gold-standard answers for a sample of items (locked by the requester before work began): " + str(gold) + "\n"
            prompt += "Acceptance criteria: \"" + criteria + "\"\n"
            prompt += "Labeler's submitted batch: " + str(submission) + "\n\n"
            prompt += "Compare the labeler's answers on the gold-standard items against the gold answers, and check the\n"
            prompt += "submission follows the guidelines. Apply the acceptance criteria exactly as written.\n"
            prompt += "The criteria may mention a match percentage. Apply that judgment only inside this decision.\n"
            prompt += "Do not output a partial payment, a score used as money, or any amount.\n\n"
            prompt += "Decide strictly one of two outcomes:\n"
            prompt += "- \"ACCEPTED\": the submission meets the acceptance criteria.\n"
            prompt += "- \"REJECTED\": it does not meet the criteria, or the submission is missing/unreadable/insufficient.\n\n"
            prompt += "Return ONLY raw JSON, no markdown:\n"
            prompt += "{\"verdict\": \"ACCEPTED\" | \"REJECTED\", \"confidence\": <0-100>, \"reason\": \"<short justification, mention which gold items mismatched if any>\"}"

            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _parse_verdict(raw)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            leader_payload = _leader_payload(leader_res)
            if not isinstance(leader_payload, dict):
                return False
            try:
                my_res = leader_fn()
            except Exception:
                return False
            parsed_leader = _parse_verdict(leader_payload)
            return _consensus_accepts(
                parsed_leader["verdict"],
                parsed_leader["confidence"],
                my_res["verdict"],
                my_res["confidence"],
            )

        result = _parse_verdict(_extract_result(gl.vm.run_nondet(leader_fn, validator_fn)))

        b.verdict = result["verdict"]
        b.confidence = u256(int(result["confidence"]))
        b.verdict_reason = result["reason"]

        if int(result["confidence"]) < MIN_CONFIDENCE or result["verdict"] not in VALID_VERDICTS:
            b.status = "DISPUTED"
            self.batches[batch_id] = b
            return

        if result["verdict"] == "REJECTED":
            if int(b.revisions_used) < 1 and _now() <= int(b.submission_deadline):
                b.revisions_used = u256(int(b.revisions_used) + 1)
                b.status = "REVISION_REQUESTED"
                self.batches[batch_id] = b
                return

        self.batches[batch_id] = b
        self._execute_settlement(batch_id)

    def _execute_settlement(self, batch_id: str) -> None:
        """Pay the party already chosen by the binary verdict. The amount is the
        stored payment_amount. There is no percent of that amount."""
        b = self.batches[batch_id]
        if b.settled:
            raise UserError("Batch already settled")

        if b.verdict == "ACCEPTED":
            recipient = b.labeler
            success_status = "RESOLVED_ACCEPTED"
        elif b.verdict == "REJECTED":
            recipient = b.requester
            success_status = "RESOLVED_REJECTED"
        else:
            raise UserError("No binary verdict to settle")

        b.status = success_status
        self.batches[batch_id] = b
        try:
            _pay(recipient, b.payment_amount)
            b.settled = True
            b.status = success_status
        except Exception as e:
            b.settled = False
            b.status = "PAYOUT_FAILED"
            b.verdict_reason = b.verdict_reason + " (Transfer failed: " + str(e) + ")"
        self.batches[batch_id] = b

    @gl.public.write
    def retry_resolution(self, batch_id: str) -> None:
        """Replay the payout from the stored verdict. Does not run AI again."""
        if batch_id not in self.batches:
            raise UserError("Batch does not exist")
        b = self.batches[batch_id]
        sender = _to_address(gl.message.sender_address)
        if not (_same_addr(sender, b.requester) or _same_addr(sender, b.labeler)):
            raise UserError("Only requester or labeler can retry")
        if b.status != "PAYOUT_FAILED":
            raise UserError("Can only retry PAYOUT_FAILED batches")
        if b.settled:
            raise UserError("Batch already settled")

        if str(b.verdict) == "":
            b.status = "EXPIRED_REFUNDED"
            self.batches[batch_id] = b
            try:
                _pay(b.requester, b.payment_amount)
                b.settled = True
                b.status = "EXPIRED_REFUNDED"
            except Exception as e:
                b.settled = False
                b.status = "PAYOUT_FAILED"
                b.verdict_reason = b.verdict_reason + " (Retry failed again: " + str(e) + ")"
            self.batches[batch_id] = b
            return

        self._execute_settlement(batch_id)

    def _batch_dict(self, batch_id: str, b) -> dict:
        return {
            "batch_id": batch_id,
            "requester": _addr_str(b.requester),
            "labeler": _addr_str(b.labeler),
            "task_description": str(b.task_description),
            "guideline_urls": _str_list(b.guideline_urls),
            "gold_standard_urls": _str_list(b.gold_standard_urls),
            "acceptance_criteria": str(b.acceptance_criteria),
            "payment_amount": str(int(b.payment_amount)),
            "submission_deadline": str(int(b.submission_deadline)),
            "submission_urls": _str_list(b.submission_urls),
            "revisions_used": int(b.revisions_used),
            "status": str(b.status),
            "verdict": str(b.verdict),
            "verdict_reason": str(b.verdict_reason),
            "confidence": int(b.confidence),
            "settled": bool(b.settled),
        }

    @gl.public.view
    def get_batch(self, batch_id: str) -> str:
        if batch_id not in self.batches:
            raise UserError("Batch does not exist")
        return json.dumps(self._batch_dict(batch_id, self.batches[batch_id]))

    @gl.public.view
    def list_batches(self) -> str:
        results = []
        n = int(self.batch_counter)
        for i in range(n):
            bid = str(i)
            if bid in self.batches:
                results.append(self._batch_dict(bid, self.batches[bid]))
        return json.dumps(results)

    @gl.public.view
    def get_batch_count(self) -> int:
        return int(self.batch_counter)

    @gl.public.view
    def get_owner(self) -> str:
        return _addr_str(self.owner)
