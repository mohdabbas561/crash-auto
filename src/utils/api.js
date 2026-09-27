const BASE = process.env.REACT_APP_API_URL || '';

export async function fetchRounds(limit = 1000) {
  const res = await fetch(`${BASE}/rounds?limit=${limit}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}