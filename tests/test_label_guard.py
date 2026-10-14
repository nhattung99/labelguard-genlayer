import json
import pytest

CONTRACT_PATH = "contracts/label_guard.py"

GUIDELINE = "https://guidelines.example.com/image-labels"
GOLD = "https://gold.example.com/answers"
SUBMISSION = "https://submissions.example.com/batch-1"
CRITERIA = "Khớp tối thiểu 90% đáp án chuẩn trên các mục mẫu và tuân thủ hướng dẫn gán nhãn."
DESCRIPTION = "Classify product photos as defective or acceptable"
PAYMENT = 1000
FUTURE_DEADLINE = 2_000_000_000
PAST_DEADLINE = 1


def _set_value(vm, amount):
    if hasattr(vm, "value"):
        try:
            vm.value = amount
        except Exception:
            pass
    if hasattr(vm, "_value"):
        vm._value = amount
    if hasattr(vm, "_refresh_gl_message"):
        vm._refresh_gl_message()


def _clear_value(vm):
    _set_value(vm, 0)


def _active_vm(direct_vm):
    try:
        from gltest.direct.loader import _get_active_vm
        return _get_active_vm() or direct_vm
    except Exception:
        return direct_vm


def sim_installMocks(vm, web=None, llm=None):
    """Install nondet mocks before every AI tx."""
    web = web or {}
    llm_payload = llm if isinstance(llm, str) or llm is None else json.dumps(llm)

    if hasattr(vm, "sim_installMocks"):
        vm.sim_installMocks({"web": web, "llm": llm_payload})
        return
    if hasattr(vm, "sim_install_mocks"):
        vm.sim_install_mocks({"web": web, "llm": llm_payload})
        return

    if hasattr(vm, "clear_mocks"):
        try:
            vm.clear_mocks()
        except Exception:
            pass
    for url, body in web.items():
        payload = body if isinstance(body, dict) else {"status": 200, "body": body}
        vm.mock_web(url, payload)
    if llm_payload is not None:
        vm.mock_llm(".*", llm_payload)


def _parse(raw):
    if isinstance(raw, str):
        return json.loads(raw or "{}")
    return raw or {}


def _parse_list(raw):
    if isinstance(raw, str):
        return json.loads(raw or "[]")
    return raw or []


def _row(contract, batch_id):
    return _parse(contract.get_batch(batch_id))


def _addr(account):
    if hasattr(account, "address"):
        return account.address
    if hasattr(account, "as_hex"):
        return account.as_hex
    return account


def _norm_addr(value):
    if value is None:
        return ""
    if hasattr(value, "as_hex"):
        try:
            return str(value.as_hex).lower()
        except Exception:
            pass
    s = str(value).lower()
    marker = 'address("'
    if marker in s:
        s = s.split(marker, 1)[1].split('"', 1)[0]
    if not s.startswith("0x") and len(s) == 40:
        s = "0x" + s
    return s


def _create(
    contract,
    vm,
    requester,
    labeler,
    guidelines=None,
    gold=None,
    criteria=CRITERIA,
    deadline=FUTURE_DEADLINE,
    payment=PAYMENT,
    description=DESCRIPTION,
):
    vm.sender = requester
    _set_value(vm, payment)
    batch_id = contract.create_batch(
        _addr(labeler),
        description,
        guidelines if guidelines is not None else [GUIDELINE],
        gold if gold is not None else [GOLD],
        criteria,
        deadline,
    )
    _clear_value(vm)
    return batch_id


def _submit(contract, vm, labeler, batch_id, urls=None):
    vm.sender = labeler
    contract.submit_batch(batch_id, urls or [SUBMISSION])


def _default_web():
    return {
        GUIDELINE: "Label each photo defective or acceptable. Defective means a visible crack or missing part.",
        GOLD: "item-1 acceptable\nitem-2 defective\nitem-3 acceptable",
        SUBMISSION: "item-1 acceptable\nitem-2 defective\nitem-3 acceptable",
    }


def _resolve(contract, vm, batch_id, verdict, confidence=90, reason="Gold items match and the guidelines were followed", web=None):
    sim_installMocks(
        vm,
        web=web or _default_web(),
        llm={"verdict": verdict, "confidence": confidence, "reason": reason},
    )
    contract.resolve_batch(batch_id)


def _patch_clock(contract, monkeypatch, ts):
    def fake_now():
        return int(ts)

    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_current_unix_timestamp", None)) and hasattr(mod, "Batch"):
            monkeypatch.setattr(mod, "_current_unix_timestamp", fake_now)
            return True

    inner = getattr(contract, "_contract", None) or getattr(contract, "__wrapped__", None)
    target = inner or contract
    meth = getattr(target, "claim_expired_refund", None)
    func = getattr(meth, "__func__", meth) if meth is not None else None
    g = getattr(func, "__globals__", None) if func is not None else None
    if g is not None and "_current_unix_timestamp" in g:
        monkeypatch.setitem(g, "_current_unix_timestamp", fake_now)
        return True
    return False


def _loaded_mod(contract=None):
    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_consensus_accepts", None)) and hasattr(mod, "Batch"):
            return mod
    return None


def _install_transfer_hook(monkeypatch, fail=False):
    import gltest.direct.loader

    original = gltest.direct.loader._EOAProxy.emit_transfer
    calls = []
    state = {"fail": fail}

    def wrapped(self, value=None, **kwargs):
        if state["fail"]:
            raise Exception("Simulated native transfer execution failure")
        calls.append((_norm_addr(self.address), int(value)))
        return original(self, value, **kwargs)

    monkeypatch.setattr(gltest.direct.loader._EOAProxy, "emit_transfer", wrapped)
    return calls, state


def test_consensus_is_absolute(direct_vm, direct_deploy, direct_accounts):
    contract = direct_deploy(CONTRACT_PATH)
    mod = _loaded_mod(contract)
    assert mod is not None
    accept = mod._consensus_accepts

    assert accept("ACCEPTED", 95, "ACCEPTED", 80) is True
    assert accept("REJECTED", 90, "REJECTED", 61) is True
    assert accept("ACCEPTED", 95, "REJECTED", 95) is False
    assert accept("ACCEPTED", 95, "ACCEPTED", 40) is False
    assert accept("REJECTED", 59, "REJECTED", 10) is True
    assert accept("", 0, "", 0) is True
    assert accept("", 0, "ACCEPTED", 0) is False
    assert accept("", 80, "", 80) is False
    assert accept("ACCEPTED", 100, "ACCEPTED", 101) is False


def test_happy_path_accepted_pays_labeler(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    calls, _state = _install_transfer_hook(monkeypatch)

    batch_id = _create(contract, vm, requester, labeler)
    assert batch_id == "0"
    row = _row(contract, batch_id)
    assert row["status"] == "AWAITING_SUBMISSION"
    assert row["payment_amount"] == str(PAYMENT)
    assert row["settled"] is False
    assert row["guideline_urls"] == [GUIDELINE]
    assert row["gold_standard_urls"] == [GOLD]
    assert row["acceptance_criteria"] == CRITERIA

    _submit(contract, vm, labeler, batch_id)
    assert _row(contract, batch_id)["status"] == "SUBMITTED"

    _resolve(contract, vm, batch_id, "ACCEPTED", 95, "item-1 item-2 and item-3 match the gold answers")
    assert vm.run_validator() is True
    assert vm.run_validator(leader_result={"verdict": "REJECTED", "confidence": 95, "reason": "mismatch"}) is False
    assert vm.run_validator(leader_result={"verdict": "ACCEPTED", "confidence": 20, "reason": "unsure"}) is False

    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_ACCEPTED"
    assert row["verdict"] == "ACCEPTED"
    assert row["confidence"] == 95
    assert row["settled"] is True
    assert row["payment_amount"] == str(PAYMENT)
    assert row["guideline_urls"] == [GUIDELINE]
    assert row["gold_standard_urls"] == [GOLD]
    assert row["acceptance_criteria"] == CRITERIA
    assert "item-1" in row["verdict_reason"]
    assert len(calls) == 1
    assert calls[0][0] == row["labeler"]
    assert calls[0][1] == PAYMENT


def test_rejected_then_revision_then_accepted(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    calls, _state = _install_transfer_hook(monkeypatch)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    _resolve(contract, vm, batch_id, "REJECTED", 88, "item-2 was labeled acceptable but gold says defective")

    row = _row(contract, batch_id)
    assert row["status"] == "REVISION_REQUESTED"
    assert row["verdict"] == "REJECTED"
    assert row["revisions_used"] == 1
    assert row["settled"] is False
    assert row["payment_amount"] == str(PAYMENT)
    assert calls == []

    vm.sender = requester
    with pytest.raises(Exception):
        contract.resolve_batch(batch_id)

    _submit(contract, vm, labeler, batch_id)
    assert _row(contract, batch_id)["status"] == "SUBMITTED"
    assert _row(contract, batch_id)["revisions_used"] == 1
    assert _row(contract, batch_id)["acceptance_criteria"] == CRITERIA

    _resolve(contract, vm, batch_id, "ACCEPTED", 93, "Revised labels now match every gold item")
    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_ACCEPTED"
    assert row["settled"] is True
    assert row["verdict"] == "ACCEPTED"
    assert row["payment_amount"] == str(PAYMENT)
    assert calls[0][0] == row["labeler"]
    assert calls[0][1] == PAYMENT


def test_rejected_after_revision_refunds_requester(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    _resolve(contract, vm, batch_id, "REJECTED", 91, "item-3 mismatches the gold answer")
    assert _row(contract, batch_id)["status"] == "REVISION_REQUESTED"
    assert _row(contract, batch_id)["settled"] is False

    _submit(contract, vm, labeler, batch_id)
    calls, _state = _install_transfer_hook(monkeypatch)
    _resolve(contract, vm, batch_id, "REJECTED", 96, "item-3 still mismatches after the revision")

    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_REJECTED"
    assert row["verdict"] == "REJECTED"
    assert row["settled"] is True
    assert row["revisions_used"] == 1
    assert row["payment_amount"] == str(PAYMENT)
    assert calls[0][0] == row["requester"]
    assert calls[0][1] == PAYMENT


def test_rejected_past_deadline_skips_revision(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler, deadline=FUTURE_DEADLINE)
    _submit(contract, vm, labeler, batch_id)

    patched = _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 10)
    assert patched is True

    calls, _state = _install_transfer_hook(monkeypatch)
    _resolve(contract, vm, batch_id, "REJECTED", 90, "Deadline passed and item-2 mismatches")

    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_REJECTED"
    assert row["revisions_used"] == 0
    assert row["settled"] is True
    assert row["payment_amount"] == str(PAYMENT)
    assert calls[-1][0] == row["requester"]
    assert calls[-1][1] == PAYMENT


def test_expired_with_no_submission_refunds_requester(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler, deadline=PAST_DEADLINE)
    assert _row(contract, batch_id)["status"] == "AWAITING_SUBMISSION"

    vm.sender = labeler
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, [SUBMISSION])

    vm.sender = other
    with pytest.raises(Exception):
        contract.claim_expired_refund(batch_id)

    calls, _state = _install_transfer_hook(monkeypatch)
    vm.sender = requester
    contract.claim_expired_refund(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["settled"] is True
    assert row["verdict"] == ""
    assert row["payment_amount"] == str(PAYMENT)
    assert calls[0][0] == row["requester"]
    assert calls[0][1] == PAYMENT

    with pytest.raises(Exception):
        contract.claim_expired_refund(batch_id)


def test_late_submit_blocked_and_refund_before_deadline_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler, deadline=FUTURE_DEADLINE)
    vm.sender = requester
    with pytest.raises(Exception):
        contract.claim_expired_refund(batch_id)
    assert _row(contract, batch_id)["status"] == "AWAITING_SUBMISSION"
    assert _row(contract, batch_id)["settled"] is False

    patched = _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 5)
    assert patched is True
    vm.sender = labeler
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, [SUBMISSION])
    assert _row(contract, batch_id)["status"] == "AWAITING_SUBMISSION"
    assert _row(contract, batch_id)["payment_amount"] == str(PAYMENT)


def test_low_confidence_disputed_then_resubmit(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    _resolve(contract, vm, batch_id, "ACCEPTED", 59, "Not sure item-2 matches the gold sheet")

    row = _row(contract, batch_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 59
    assert row["payment_amount"] == str(PAYMENT)
    assert vm.run_validator() is True

    with pytest.raises(Exception):
        contract.resolve_batch(batch_id)

    _submit(contract, vm, labeler, batch_id)
    assert _row(contract, batch_id)["status"] == "SUBMITTED"
    _resolve(contract, vm, batch_id, "ACCEPTED", 84, "The resubmitted sheet matches every gold item")
    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_ACCEPTED"
    assert row["settled"] is True
    assert row["confidence"] == 84
    assert row["payment_amount"] == str(PAYMENT)


def test_web_fail_and_invalid_json(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)

    sim_installMocks(vm, web={}, llm={"verdict": "ACCEPTED", "confidence": 99, "reason": "should not be used"})
    contract.resolve_batch(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 0
    assert row["verdict"] == ""
    assert row["payment_amount"] == str(PAYMENT)
    assert "Failed to fetch" in row["verdict_reason"]
    assert vm.run_validator() is True

    _submit(contract, vm, labeler, batch_id)
    sim_installMocks(vm, web=_default_web(), llm="this is not json at all")
    contract.resolve_batch(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 0
    assert "Failed to parse" in row["verdict_reason"]
    assert row["guideline_urls"] == [GUIDELINE]
    assert row["gold_standard_urls"] == [GOLD]


def test_missing_urls_empty_criteria_and_same_party_blocked(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(requester), DESCRIPTION, [GUIDELINE], [GOLD], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), "   ", [GUIDELINE], [GOLD], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), DESCRIPTION, [GUIDELINE], [GOLD], "   ", FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), DESCRIPTION, [], [GOLD], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), DESCRIPTION, [GUIDELINE], [], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, PAYMENT)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), DESCRIPTION, ["ftp://guidelines.example.com/a"], [GOLD], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = requester
    _set_value(vm, 0)
    with pytest.raises(Exception):
        contract.create_batch(_addr(labeler), DESCRIPTION, [GUIDELINE], [GOLD], CRITERIA, FUTURE_DEADLINE)
    _clear_value(vm)

    batch_id = _create(contract, vm, requester, labeler)
    vm.sender = labeler
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, [])
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, ["not-a-url"])
    vm.sender = requester
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, [SUBMISSION])
    assert _row(contract, batch_id)["status"] == "AWAITING_SUBMISSION"
    assert contract.get_batch_count() == 1


def test_baseline_has_no_update_method(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    mod = _loaded_mod(contract)
    assert mod is not None

    mutable = [
        name for name in dir(mod.Contract)
        if name.startswith(("update", "set_", "change", "edit", "revise"))
    ]
    assert mutable == []

    batch_id = _create(
        contract,
        vm,
        requester,
        labeler,
        guidelines=[GUIDELINE, "https://guidelines.example.com/extra"],
        gold=[GOLD],
    )
    _submit(contract, vm, labeler, batch_id)
    row = _row(contract, batch_id)
    assert row["guideline_urls"] == [GUIDELINE, "https://guidelines.example.com/extra"]
    assert row["gold_standard_urls"] == [GOLD]
    assert row["acceptance_criteria"] == CRITERIA
    assert row["task_description"] == DESCRIPTION


def test_double_submit_and_double_resolve_blocked(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    with pytest.raises(Exception):
        contract.submit_batch(batch_id, [SUBMISSION])
    assert _row(contract, batch_id)["status"] == "SUBMITTED"

    _resolve(contract, vm, batch_id, "ACCEPTED", 90, "All gold items match")
    assert _row(contract, batch_id)["settled"] is True
    with pytest.raises(Exception):
        contract.resolve_batch(batch_id)
    vm.sender = labeler
    with pytest.raises(Exception):
        contract.retry_resolution(batch_id)


def test_transfer_fail_accepted_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    _resolve(contract, vm, batch_id, "ACCEPTED", 94, "Gold items match")

    row = _row(contract, batch_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == "ACCEPTED"
    assert row["payment_amount"] == str(PAYMENT)
    assert "Transfer failed" in row["verdict_reason"]
    assert calls == []

    vm.sender = other
    with pytest.raises(Exception):
        contract.retry_resolution(batch_id)

    state["fail"] = False
    vm.sender = labeler
    contract.retry_resolution(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_ACCEPTED"
    assert row["settled"] is True
    assert row["verdict"] == "ACCEPTED"
    assert calls[-1][0] == row["labeler"]
    assert calls[-1][1] == PAYMENT


def test_transfer_fail_final_rejected_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler)
    _submit(contract, vm, labeler, batch_id)
    _resolve(contract, vm, batch_id, "REJECTED", 90, "item-1 mismatches")
    assert _row(contract, batch_id)["status"] == "REVISION_REQUESTED"

    _submit(contract, vm, labeler, batch_id)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    _resolve(contract, vm, batch_id, "REJECTED", 97, "item-1 still mismatches")

    row = _row(contract, batch_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == "REJECTED"
    assert "Transfer failed" in row["verdict_reason"]

    state["fail"] = False
    vm.sender = requester
    contract.retry_resolution(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "RESOLVED_REJECTED"
    assert row["settled"] is True
    assert calls[-1][0] == row["requester"]
    assert calls[-1][1] == PAYMENT


def test_transfer_fail_expired_refund_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    batch_id = _create(contract, vm, requester, labeler, deadline=PAST_DEADLINE)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    vm.sender = requester
    contract.claim_expired_refund(batch_id)

    row = _row(contract, batch_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == ""
    assert "Expired refund failed" in row["verdict_reason"]

    state["fail"] = False
    vm.sender = labeler
    contract.retry_resolution(batch_id)
    row = _row(contract, batch_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["settled"] is True
    assert row["verdict"] == ""
    assert calls[-1][0] == row["requester"]
    assert calls[-1][1] == PAYMENT


def test_list_and_owner(direct_vm, direct_deploy, direct_accounts):
    requester = direct_accounts[1]
    labeler = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    owner = contract.get_owner()
    assert isinstance(owner, str)
    assert owner.startswith("0x")

    first = _create(contract, vm, requester, labeler)
    second = _create(contract, vm, requester, labeler, description="Score short answers against the rubric")
    assert first == "0"
    assert second == "1"
    rows = _parse_list(contract.list_batches())
    assert len(rows) == 2
    assert rows[0]["payment_amount"] == str(PAYMENT)
    assert rows[1]["task_description"] == "Score short answers against the rubric"
    assert rows[0]["acceptance_criteria"] == CRITERIA
    assert contract.get_batch_count() == 2
