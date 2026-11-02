export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = value === 0 ? 0 : Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
export function percentage(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}
export function duration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value), days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
  if (days) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds % 60} 秒`;
}
