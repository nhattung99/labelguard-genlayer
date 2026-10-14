export const PAYMENT_PRESETS = ['0.5', '1', '2', '5', '10'];

export const DEADLINE_PRESETS = [
  { id: '24h', label: '24 giờ', seconds: 86400n },
  { id: '3d', label: '3 ngày', seconds: 3n * 86400n },
  { id: '7d', label: '7 ngày', seconds: 7n * 86400n },
  { id: '14d', label: '14 ngày', seconds: 14n * 86400n },
];

export const THRESHOLDS = ['80', '90', '95'];

export const CATEGORIES = [
  {
    id: 'image',
    label: 'Phân loại ảnh',
    hint: 'Mỗi ảnh một nhãn theo bảng hướng dẫn. Ví dụ: defective / acceptable.',
  },
  {
    id: 'sentiment',
    label: 'Phân tích cảm xúc văn bản',
    hint: 'Gán positive, negative hoặc neutral cho từng câu theo hướng dẫn.',
  },
  {
    id: 'score',
    label: 'Chấm điểm câu trả lời',
    hint: 'Chấm từng câu theo rubric đã khoá. Điểm phải khớp đáp án mẫu.',
  },
  {
    id: 'translate',
    label: 'Dịch thuật',
    hint: 'Dịch đúng nghĩa, giữ tên riêng và thuật ngữ trong hướng dẫn.',
  },
  {
    id: 'other',
    label: 'Khác',
    hint: 'Mô tả ngắn việc cần gán. Tiêu chí vẫn do ngưỡng khớp đáp án chuẩn sinh ra.',
  },
];

export const EXAMPLE_GUIDELINE_URL = 'https://example.com';
export const EXAMPLE_GOLD_URL = 'https://www.rfc-editor.org/rfc/rfc2606.txt';
export const EXAMPLE_SUBMISSION_URL = 'https://example.net';

export const DESCRIPTION_HINT = 'Mô tả ngắn việc cần làm. Ví dụ: gán nhãn 20 ảnh sản phẩm là defective hoặc acceptable.';

export const PUBLIC_LINK_BANNER = 'Chỉ dùng link công khai dạng văn bản (Google Sheet published-to-web, GitHub gist/raw). File riêng tư hoặc cần đăng nhập sẽ không đọc được.';

export const LOCKED_LINE = 'Các nội dung này đã bị khoá và không thể thay đổi sau khi lô việc được tạo.';

export const FREE_BANNER = 'Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.';

export function categoryById(id) {
  return CATEGORIES.find((item) => item.id === id) || CATEGORIES[0];
}

export function buildAcceptanceCriteria(categoryId, threshold) {
  const category = categoryById(categoryId);
  const pct = THRESHOLDS.includes(threshold) ? threshold : '90';
  return `Khớp tối thiểu ${pct}% đáp án chuẩn trên các mục mẫu và tuân thủ hướng dẫn gán nhãn (${category.label}).`;
}

export function deadlineUnixFromPreset(seconds) {
  const nowSec = BigInt(Date.now()) / 1000n;
  return nowSec + BigInt(seconds);
}

export function cleanHttpUrls(values) {
  return (values || []).map((item) => String(item || '').trim()).filter(Boolean);
}

export function urlProblem(values, minimum, label) {
  const urls = cleanHttpUrls(values);
  if (urls.length < minimum) return `Cần ít nhất ${minimum} link ${label}.`;
  for (const url of urls) {
    if (!(url.startsWith('http://') || url.startsWith('https://'))) {
      return `Link ${label} phải bắt đầu bằng http:// hoặc https://.`;
    }
  }
  return '';
}
