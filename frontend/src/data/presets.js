export const PAYMENT_PRESETS = ['0.5', '1', '2', '5', '10'];

export const DEADLINE_PRESETS = [
  { id: '24h', label: '24 hours', seconds: 86400n },
  { id: '3d', label: '3 days', seconds: 3n * 86400n },
  { id: '7d', label: '7 days', seconds: 7n * 86400n },
  { id: '14d', label: '14 days', seconds: 14n * 86400n },
];

export const THRESHOLDS = ['80', '90', '95'];

export const CATEGORIES = [
  {
    id: 'image',
    label: 'Image classification',
    hint: 'Give each image one label from the guideline. Example: defective or acceptable.',
  },
  {
    id: 'sentiment',
    label: 'Text sentiment',
    hint: 'Mark each sentence positive, negative, or neutral, following the guideline.',
  },
  {
    id: 'score',
    label: 'Answer scoring',
    hint: 'Score each answer against the locked rubric. Scores must match the gold sample.',
  },
  {
    id: 'translate',
    label: 'Translation',
    hint: 'Keep the meaning, and keep proper names and terms from the guideline.',
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'Describe the labeling job in a short note. The acceptance line still comes from the match threshold.',
  },
];

export const EXAMPLE_GUIDELINE_URL = 'https://example.com';
export const EXAMPLE_GOLD_URL = 'https://www.rfc-editor.org/rfc/rfc2606.txt';
export const EXAMPLE_SUBMISSION_URL = 'https://example.net';

export const DESCRIPTION_HINT = 'A short description of the work. Example: label 20 product photos as defective or acceptable.';

export const PUBLIC_LINK_BANNER = 'Use only public text links (a Google Sheet published to the web, or a GitHub gist or raw file). Private files and pages that require a login cannot be read.';

export const LOCKED_LINE = 'These materials are locked and cannot be changed after the batch is created.';

export const FREE_BANNER = 'Free to use — you only pay GenLayer network gas when you sign a transaction. There is no platform fee.';

export function categoryById(id) {
  return CATEGORIES.find((item) => item.id === id) || CATEGORIES[0];
}

export function buildAcceptanceCriteria(categoryId, threshold) {
  const category = categoryById(categoryId);
  const pct = THRESHOLDS.includes(threshold) ? threshold : '90';
  return `Match at least ${pct}% of the gold-standard sample and follow the labeling guidelines (${category.label}).`;
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
  if (urls.length < minimum) return `At least ${minimum} ${label} link is required.`;
  for (const url of urls) {
    if (!(url.startsWith('http://') || url.startsWith('https://'))) {
      return `Each ${label} link must start with http:// or https://.`;
    }
  }
  return '';
}
