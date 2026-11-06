import { API_BASE, ApiError, getToken, setToken } from "./api";

export interface MainforceMoney {
  net: number | null;
  participation: number | null;
  ratio: number | null;
}
export interface MainforceRow {
  key: string;
  name: string;
  symbol: string | null;
  block_code: string | null;
  members: number;
  covered: number;
  expected: number;
  main: MainforceMoney;
  medium: MainforceMoney;
  small: MainforceMoney;
  continuous_inflow_days: number | null;
  streak_capped: boolean;
  change_rate: number | null;
  limit_up_count: number | null;
  top_stock_name: string | null;
  top_stock_symbol: string | null;
}
export interface MainforceResult {
  items: MainforceRow[];
  total: number;
  as_of: string | null;
  start: string | null;
  period: number;
  days: string[];
  source: string;
  note: string;
  block_name: string | null;
}
export interface MainforceQuery {
  view: "blocks" | "stocks";
  type_code: number;
  block_code?: string;
  period: number;
  end?: string;
  q?: string;
  sort: string;
  page: number;
  size: number;
}
export async function fetchMainforce(query: MainforceQuery, signal: AbortSignal): Promise<MainforceResult> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => { if (v != null && v !== "") params.set(k, String(v)); });
  const token = getToken();
  const res = await fetch(`${API_BASE}/market/mainforce?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, signal,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setToken(null);
      window.dispatchEvent(new CustomEvent("yc:auth-expired"));
    }
    throw new ApiError(res.status, error.code ?? "http_error", error.message ?? `HTTP ${res.status}`, error.detail);
  }
  return res.json();
}
