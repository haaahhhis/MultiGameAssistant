import type { AdgClient } from '@adg/client-core'
import type { ScriptJob } from '@adg/protocol'
import { formatBytes, PHASE_LABEL } from './data.ts'

/** One job's phase and, while downloading, a progress bar; finished jobs show their outcome. */
export function JobProgress({ client, job, compact = false }: { client: AdgClient; job: ScriptJob; compact?: boolean }) {
  const running = job.endedAt === undefined
  const ratio = job.total !== undefined && job.total > 0 && job.received !== undefined ? Math.min(1, job.received / job.total) : undefined
  const label = job.kind === 'env-fix' ? '修复环境' : job.kind === 'update' ? '更新' : '安装'
  return (
    <div className={`job ${job.phase}${compact ? ' compact' : ''}`} role="status">
      <div className="job-line">
        <span className="job-phase">{label} · {job.setup !== undefined && job.phase === 'done' ? '已交给 agent 安装' : PHASE_LABEL[job.phase]}{job.version !== undefined && job.phase === 'done' ? ` ${job.version}` : ''}</span>
        {ratio !== undefined && running && <span className="job-bytes">{formatBytes(job.received ?? 0)} / {formatBytes(job.total ?? 0)}</span>}
        {running && (
          <button className="link-button" onClick={() => void client.connection.call('scripts/jobs/cancel', { jobId: job.id }).catch(() => {})}>取消</button>
        )}
      </div>
      {running && (
        <div className={`progress ${ratio === undefined ? 'indeterminate' : ''}`} aria-hidden="true">
          <span style={ratio === undefined ? undefined : { width: `${(ratio * 100).toFixed(1)}%` }} />
        </div>
      )}
      {!compact && job.message !== undefined && (running || job.setup !== undefined) && <div className="job-message muted small">{job.message}</div>}
      {job.error !== undefined && <div className="job-error small">{job.error}</div>}
    </div>
  )
}
