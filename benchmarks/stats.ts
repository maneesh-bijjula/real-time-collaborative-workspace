export function quantile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}
export function latencyAcceptance(expected: number, values: number[], p95Limit = 100) {
  const stats = distribution(values);
  return {
    ...stats,
    expected,
    missing: expected - stats.count,
    passed: expected > 0 && stats.count === expected && stats.p95 !== null && stats.p95 < p95Limit,
  };
}
