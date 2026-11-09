// 「慢测试」回退清单。
//
// 正常情况下 --tier fast 依据上一次运行的实测耗时（test/.timings.json，
// 由 scripts/test.mjs 自动回写）来判断，不依赖本文件。
// 只有在还没有任何耗时记录（首次运行）时，才用这份人工清单兜底。
//
// 这些文件含真实计时器、文件系统写入或 git worktree 操作，单文件往往 30s 以上，
// 是本地改一处代码却要等半小时的主因。它们并非"不重要"，只是不适合高频回归。
//
// 注意两点：
// 1. 不要改成前缀规则：browser_output_test.ts (0.6s) 与 browser_lifecycle_test.ts
//    同前缀但耗时差两个数量级，session_bootstrap 与 session_persistence 同理。
// 2. 也别指望这份清单长期准确——它必然腐坏，所以才让耗时缓存做主判据。
export const SLOW_TESTS = new Set([
  'approval_test.ts',
  'browser_lifecycle_test.ts',
  'cancellation_persistence_test.ts',
  'member_append_test.ts',
  'member_conflict_recovery_test.ts',
  'member_context_test.ts',
  'member_finish_test.ts',
  'member_hook_cleanup_test.ts',
  'member_persistence_retry_test.ts',
  'member_recovery_test.ts',
  'session_persistence_test.ts',
  'session_transition_test.ts',
  'subagent_batch_results_test.ts',
  'subagent_completion_test.ts',
  'subagent_external_sync_test.ts',
  'subagent_journal_test.ts',
  'subagent_results_test.ts',
  'subagent_scope_test.ts',
  'team_cancellation_lease_test.ts',
  'team_claim_consistency_test.ts',
  'team_creation_hook_test.ts',
  'team_expiry_notification_test.ts',
  'team_heartbeat_expiry_test.ts',
  'team_mail_integrity_test.ts',
  'team_mail_pagination_test.ts',
  'team_task_cache_test.ts',
  'worktree_isolation_test.ts',
  'write_file_atomic_test.ts',
])
