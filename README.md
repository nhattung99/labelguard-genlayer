# LabelGuard — Escrow lô gán nhãn trung lập trên GenLayer

Các nhóm AI nhỏ thuê người gán nhãn (phân loại ảnh, chấm câu trả lời, dịch) nhưng không có trọng tài đủ rẻ cho từng lô nhỏ. Người gán nhãn thì lo làm xong bị từ chối vô lý hoặc không được trả. LabelGuard giữ **một khoản GEN cố định** trong **một Intelligent Contract**. Người thuê khoá hướng dẫn, đáp án chuẩn và tiêu chí ngay lúc tạo. AI của GenLayer trả về đúng một trong hai kết quả:

`ACCEPTED` · `REJECTED`

Không có dung sai phần trăm trên tiền. Không có số tiền thứ hai. Toàn bộ `payment_amount` được trả cho người gán nhãn, hoặc hoàn cho người thuê.

> LabelGuard chết nếu không có GenLayer: không có smart contract EVM nào đọc hiểu được một lô dữ liệu gán nhãn phi cấu trúc để đối chiếu với hướng dẫn và đáp án chuẩn bằng ngôn ngữ tự nhiên, và không có bên kiểm định nào đủ rẻ để duyệt từng lô việc nhỏ của các nhóm AI độc lập — chỉ có đồng thuận AI phi tập trung của GenLayer mới làm được với chi phí gần bằng 0.

## Địa chỉ contract

- **Mạng:** studionet, không đổi sang chain khác
- **Địa chỉ:** chưa có — điền sau khi deploy tay và receipt ghi `Result: SUCCESS`
- **App:** chạy được khi chưa có địa chỉ. Banner vàng hiện rõ, bấm tạo lô sẽ báo lỗi, trang không trắng.

## Vì sao verdict nhị phân

JobVerdict bị steward từ chối vì consensus dùng dung sai %: hai validator "đồng thuận" nhưng chốt hai số tiền khác nhau. LabelGuard chỉ có hai kết quả rời rạc. Validator so **tuyệt đối**:

- chuỗi verdict giống hệt nhau (`ACCEPTED` hoặc `REJECTED`, kể cả chuỗi rỗng khi không parse được)
- hai confidence nằm cùng một phía của ngưỡng 60 (`>= 60` thì giải ngân, `< 60` thì `DISPUTED`)

Không có tolerance số. Confidence không nhân với tiền công. "90%" chỉ nằm trong câu `acceptance_criteria` để model áp bên trong phán đoán. Output cuối cùng vẫn là ACCEPTED hoặc REJECTED, và số GEN chuyển đi luôn là `payment_amount` đã khoá.

Lần `REJECTED` đầu, nếu còn hạn và `revisions_used == 0`, trạng thái thành `REVISION_REQUESTED`. Tiền không chuyển. `revisions_used` thành 1. `REJECTED` sau lần nộp lại, hoặc `REJECTED` khi đã quá hạn, hoàn toàn bộ cho người thuê.

## Vì sao một contract

Người thuê gửi GEN thẳng vào contract lúc `create_batch`. Giải ngân dùng `gl.get_contract_at(recipient).emit_transfer(value=u256(payment_amount))`. Không có contract thứ hai, không forward value qua lời gọi chéo.

## Luồng resolve

1. **Tạo** — người thuê đặt địa chỉ labeler (khác mình), mô tả, ít nhất 1 link hướng dẫn, ít nhất 1 link đáp án chuẩn, tiêu chí, hạn nộp, và gửi kèm `payment_amount` GEN > 0.
2. Hướng dẫn, đáp án chuẩn và tiêu chí được ghi một lần. Contract **không có hàm nào sửa** các field này.
3. **Nộp** — chỉ labeler, chỉ khi status là `AWAITING_SUBMISSION`, `REVISION_REQUESTED` hoặc `DISPUTED`, và chỉ trước hạn. Ít nhất 1 link bài nộp dạng `http://` hoặc `https://`. Status thành `SUBMITTED`.
4. **Chấm** — ai cũng có thể gọi `resolve_batch` khi status là `SUBMITTED`. `gl.vm.run_nondet` đọc từng URL và xin JSON `{verdict, confidence, reason}`.
5. `confidence < 60`, verdict rỗng, hoặc JSON hỏng → `DISPUTED`. Tiền nằm yên. Labeler được nộp lại.
6. Nếu một URL hướng dẫn, đáp án chuẩn hoặc bài nộp không đọc được, contract không hỏi model và không trả tiền. Status thành `DISPUTED` với lý do `Failed to fetch ...`. Revert cứng sẽ giữ status `SUBMITTED`, mà `submit_batch` không được thay link khi đang `SUBMITTED`.
7. `REJECTED` khi `revisions_used == 0` và `now <= submission_deadline` → `REVISION_REQUESTED`. Tiền không đổi.
8. Các trường hợp còn lại gọi `_execute_settlement`: labeler nhận đủ nếu `ACCEPTED` (`RESOLVED_ACCEPTED`), requester nhận lại đủ nếu `REJECTED` (`RESOLVED_REJECTED`).
9. Transfer lỗi → `PAYOUT_FAILED`, giữ nguyên verdict. `retry_resolution` (requester hoặc labeler) trả lại đúng người đó và **không** chạy lại AI. Hoàn hạn mà transfer lỗi thì verdict vẫn rỗng; retry trả requester và kết thúc `EXPIRED_REFUNDED`.
10. Hết hạn mà status vẫn là `AWAITING_SUBMISSION`, `REVISION_REQUESTED` hoặc `DISPUTED`: requester gọi `claim_expired_refund`. Không cần AI. Không có hàm huỷ trước hạn.

Status được ghi sang trạng thái thành công **trước** `emit_transfer`, để một lần resolve lồng nhau không còn thấy `SUBMITTED`.

## Bốn giới hạn trung thực

1. Lĩnh vực này **không có nguồn thứ ba độc lập** để xác minh chất lượng gán nhãn. Baseline duy nhất là hướng dẫn + đáp án chuẩn do requester đặt. Vì vậy cơ chế công bằng đến từ việc **khoá bất biến các thứ này lúc tạo lô**, không phải từ nguồn xác minh ngoài. AI chỉ đánh giá bài nộp có nhất quán với baseline đó hay không, không đánh giá "đúng sai khách quan tuyệt đối".
2. Rủi ro requester đặt đáp án chuẩn bất công vẫn tồn tại; labeler phải đọc kỹ trước khi nhận việc. UI phải hiển thị nổi bật hướng dẫn, đáp án chuẩn và tiêu chí cho labeler xem trước.
3. Khi `REJECTED`, requester được hoàn tiền nhưng có thể đã thấy nội dung lô bài nộp. Đây là hạn chế thương mại ngoài phạm vi contract, ghi rõ trong README.
4. `gl.nondet.web.render` chỉ đọc được link công khai dạng văn bản (Google Sheet published-to-web, GitHub gist/raw, trang văn bản). File riêng tư hoặc cần đăng nhập sẽ lỗi fetch. UI phải nhắc rõ.

## API đã dùng

| Việc | API | Không dùng |
|---|---|---|
| Người gọi | `gl.message.sender_address` | `gl.message.sender` |
| Trả GEN | `gl.get_contract_at(addr).emit_transfer(value=u256(amount))` | `gl.transfer(...)` |
| Nhận GEN | `@gl.public.write.payable` + `gl.message.value` trên `create_batch` | `@gl.public.write` trần khi gửi kèm GEN (Studio hiện tại báo `called non-payable method`, `value` về 0) |
| Thời gian | `gl.message.datetime` parse bằng `datetime.fromisoformat` trong `_current_unix_timestamp` | `gl.block.timestamp` |
| TreeMap | `in` và duyệt theo `batch_counter`; `.get(key, default)` có trong SDK | — |

Header lấy từ template Studio và hash đang dùng ở các contract cùng workspace (SponsorCheck, AuditBounty, CargoVerdict):

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

Ghi chú cũ rằng `@gl.public.write.payable` "không tồn tại" không còn đúng với hash này. AuthentiCheck, SponsorCheck và AuditBounty đều deploy bằng hash đó và đánh dấu method nhận value là `.payable`. Chỉ `create_batch` là payable. Mọi write khác là `@gl.public.write`.

### Write

- `create_batch(labeler, task_description, guideline_urls, gold_standard_urls, acceptance_criteria, submission_deadline) -> batch_id` — gửi kèm GEN `> 0`
- `submit_batch(batch_id, submission_urls)` — chỉ labeler
- `resolve_batch(batch_id)` — AI, chỉ từ `SUBMITTED`
- `claim_expired_refund(batch_id)` — chỉ requester, đã quá hạn, chưa có bài được nhận hoặc đang chờ chấm
- `retry_resolution(batch_id)` — requester hoặc labeler, chỉ `PAYOUT_FAILED`

### View

View trả text JSON, trừ count và owner:

- `get_batch(batch_id) -> str`
- `list_batches() -> str`
- `get_batch_count() -> int`
- `get_owner() -> str`

`payment_amount` và `submission_deadline` là chuỗi số nguyên thập phân, không phải số JSON, để trình duyệt không làm tròn.

## Bảng tiền — một field duy nhất

`payment_amount` là field tiền duy nhất. Đơn vị là wei (10^18 đơn vị cơ sở cho 1 GEN). Không chỗ nào trong contract hay frontend nhân field này với một phần trăm.

| Bước | Nơi | Việc xảy ra |
|---|---|---|
| WRITE | `frontend/src/App.jsx`, form tạo lô | Chip hoặc chuỗi GEN gõ tay → `parseGenToWei` → `writeContract({ value })` |
| WRITE | `create_batch` | `payment = bigint(gl.message.value)` lưu vào `Batch.payment_amount` |
| WRITE | `_execute_settlement` | `emit_transfer(value=u256(payment_amount))` cho labeler nếu `ACCEPTED`, cho requester nếu `REJECTED` |
| WRITE | `claim_expired_refund` và nhánh verdict rỗng của `retry_resolution` | đúng `payment_amount` hoàn cho requester |
| READ | `get_batch` / `list_batches` | `str(int(payment_amount))` trong JSON |
| READ | `frontend/src/App.jsx` | `readWei` (chỉ chuỗi chữ số hoặc bigint) → `formatWeiToGen` |

`parseGenToWei` và `formatWeiToGen` tách chuỗi rồi dùng `BigInt`. Chúng không gọi `parseFloat`, `Math.round`, `Math.floor`, hay `Math.ceil`. `scripts/check-no-float-money.js` quét `frontend/src/**/*.{js,jsx}` và làm fail build nếu các lời gọi đó đứng gần `payment`, `amount`, `payout`, `refund`, `balance`, `wei`, hoặc `gen`. Script `prebuild` của frontend chạy kiểm tra này.

Chip `1 GEN` chỉ là nhãn. Giá trị rời trình duyệt là số nguyên wei từ `parseGenToWei`.

## Deploy trên studionet (làm tay)

Làm trong GenLayer Studio. Không đổi app sang testnet hay chain khác.

1. Mở [GenLayer Studio](https://studio.genlayer.com) trên **studionet**.
2. Tạo contract và dán nguyên `contracts/label_guard.py`, kể cả hai dòng header.
3. Deploy. Đợi receipt ghi **Result: SUCCESS**.
4. Gửi lại địa chỉ contract. Bước sau sẽ ghi `frontend/.env` thành `VITE_CONTRACT_ADDRESS=0x...`, build, push GitHub và deploy Vercel.

Xem local khi chưa có địa chỉ:

```bash
cd frontend
npm install
npm run dev
```

Trang phải hiện banner chưa có địa chỉ và banner miễn phí. Tạo lô khi chưa có địa chỉ hiện lỗi, không trắng trang.

## Tests

```bash
pip install -r requirements.txt
python -m pytest tests/test_label_guard.py -q
cd frontend && npm test
```

Đã phủ: ACCEPTED trả labeler; REJECTED lần đầu thành `REVISION_REQUESTED` và tiền nguyên vẹn rồi nộp lại ACCEPTED; REJECTED sau một lần nộp lại hoàn requester; REJECTED khi đã quá hạn hoàn ngay, không qua revision; hết hạn không có bài thì requester hoàn; requester không huỷ được trước hạn; nộp trễ bị chặn; confidence dưới 60 thành DISPUTED rồi nộp lại và chấm lại; web fail và JSON hỏng thành DISPUTED, không trả tiền; thiếu URL hoặc tiêu chí hoặc cùng một địa chỉ bị chặn lúc tạo; baseline không có hàm sửa và không đổi sau khi nộp; double-submit và double-resolve bị chặn; `emit_transfer` bị mock ném lỗi ở cả ba nhánh (ACCEPTED, REJECTED cuối, hoàn hạn) thành `PAYOUT_FAILED`, rồi `retry_resolution` trả đúng người nhận.

## Frontend

Chip loại việc: Phân loại ảnh, Phân tích cảm xúc văn bản, Chấm điểm câu trả lời, Dịch thuật, Khác. Dropdown 80% / 90% / 95% tự sinh câu tiêu chí, người dùng không gõ tiêu chí. Chip tiền công. Dropdown hạn 24 giờ / 3 ngày / 7 ngày / 14 ngày. Mỗi ô link có nút dán. Bước tạo và bước nộp đều hiện banner link công khai. Màn chi tiết khoá nổi bật hướng dẫn, đáp án chuẩn, tiêu chí, tiền công và hạn, kèm dòng "Các nội dung này đã bị khoá và không thể thay đổi sau khi lô việc được tạo". `REVISION_REQUESTED` nói rõ còn 1 lần nộp lại. `DISPUTED` có form nộp lại. `PAYOUT_FAILED` có nút **Thử lại**. Banner dính: miễn phí, chỉ tốn gas GenLayer.

Ví luôn ở `chains.studionet`. Lệnh đọc đi qua `/api/genlayer`, Vite và Vercel proxy tới `https://studio.genlayer.com/api`.
