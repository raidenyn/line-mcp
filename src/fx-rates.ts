interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

const rateCache = new Map<string, number>();

export async function getHistoricalRate(date: string, from: string, to: string): Promise<number | null> {
  const cacheKey = `${date}|${from}|${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.frankfurter.dev/v1/${date}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as FrankfurterResponse;
    const rate = data.rates?.[to];
    if (typeof rate !== 'number') return null;
    rateCache.set(cacheKey, rate);
    return rate;
  } catch {
    return null;
  }
}