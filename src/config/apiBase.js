const DEFAULT_API_BASE = '';

function normalizeApiBase(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  if (cleaned.startsWith('/')) return cleaned;
  return `https://${cleaned}`;
}

const rawEnv = String(process.env.REACT_APP_API_URL || '').trim();

export const API_BASE = normalizeApiBase(rawEnv || DEFAULT_API_BASE);
