export const DEFAULT_LIMITS = {
  max_files: 100,
  max_bytes_per_file: 256_000,
  max_total_bytes: 1_500_000,
  max_line_scan_bytes: 128 * 1024 * 1024,
  max_search_results: 250,
  max_tree_entries: 5_000,
  max_task_inventory_files: 10_000,
  max_task_inventory_tree_pages: 40,
  max_task_inventory_file_bytes: 256_000,
  max_project_brief_doc_bytes: 64_000,
  max_decision_log_source_bytes: 64_000,
  max_decision_log_sources: 40,
  max_change_plan_files: 60,
  max_change_plan_tree_pages: 10,
  max_depth: 12,
  max_diff_bytes: 512_000
} as const;

export type LimitKey = keyof typeof DEFAULT_LIMITS;
export type RuntimeLimits = { [Key in LimitKey]: number };

export function resolveRuntimeLimits(configured: Partial<Record<LimitKey, number>> = {}): RuntimeLimits {
  const resolved = { ...DEFAULT_LIMITS } as RuntimeLimits;
  for (const key of Object.keys(DEFAULT_LIMITS) as LimitKey[]) {
    const value = configured[key];
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
}
