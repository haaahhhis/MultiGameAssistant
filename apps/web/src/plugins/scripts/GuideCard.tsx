import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { PackGuide, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from './data.ts'

type Tab = 'tasks' | 'features' | 'config' | 'before' | 'problems'

const INPUT_LABEL: Readonly<Record<PackGuide['tasks'][number]['input'], string>> = {
  desktop: '占用鼠标键盘',
  adb: '用模拟器，不占鼠标',
  window: '后台操作游戏窗口',
  none: '不占用',
}

/** `60m` → 约 60 分钟. */
function duration(text: string): string {
  const m = /^(\d+)(s|m|h)$/.exec(text)
  return m === null ? text : `约 ${m[1]} ${m[2] === 's' ? '秒' : m[2] === 'm' ? '分钟' : '小时'}`
}

/** One line of facts: 「可选值：… · 默认：…」, leaving out the missing ones. */
function Facts({ items }: { items: readonly (readonly [string, string | undefined])[] }) {
  const shown = items.filter((item): item is readonly [string, string] => item[1] !== undefined && item[1] !== '')
  if (shown.length === 0) return null
  return <div className="guide-facts muted small">{shown.map(([label, value]) => <span key={label}>{label}：{value}</span>)}</div>
}

/**
 * 使用说明: what the script does, its tasks and parameters, how to turn its
 * features on, its config files (the keys that matter and what runs change
 * for themselves), what to set up and check, and common problems — from its pack.
 */
export function GuideCard({ client, script }: { client: AdgClient; script: ScriptInfo }) {
  const status = useStore(client.connection.status)
  const [guide, setGuide] = useState<PackGuide | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [tab, setTab] = useState<Tab>('tasks')

  useEffect(() => client.connection.on('packs/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || script.packId === undefined) return
    let live = true
    client.connection.call('scripts/guide', { id: script.id })
      .then(r => { if (live) { setGuide(r.guide); setError(null) } })
      .catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, script.id, script.packId, status.state, revision])

  if (script.packId === undefined || guide === null) return null
  const tabs: [Tab, string, boolean][] = guide === undefined ? [] : [
    ['tasks', `任务与参数（${guide.tasks.length}）`, true],
    ['features', `功能开启（${guide.features.length}）`, guide.features.length > 0],
    ['config', '配置文件', guide.config.length > 0],
    ['before', '运行前', guide.setup.length + guide.checks.length > 0],
    ['problems', `常见问题（${guide.troubleshooting.length}）`, guide.troubleshooting.length > 0],
  ]
  const shown = tabs.filter(([, , has]) => has)
  const current = shown.some(([id]) => id === tab) ? tab : 'tasks'

  return (
    <section className="card script-guide">
      <div className="card-head">
        <div>
          <h3>使用说明</h3>
          <p className="muted small">
            {guide === undefined ? '读取中…'
              : guide.written ? `脚本包 ${guide.packId} 的说明${guide.builtin ? '（内置）' : ''}`
                : '这个脚本包还没有写使用说明，下面只有任务和运行时的临时修改；可以在「脚本包」里点「让 agent 改进」补上。'}
          </p>
        </div>
      </div>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      {guide !== undefined && (
        <>
          {guide.overview !== undefined && <p className="guide-overview">{guide.overview}</p>}
          {shown.length > 1 && (
            <div className="segmented guide-tabs" role="tablist">
              {shown.map(([id, label]) => (
                <label key={id} className={current === id ? 'active' : ''}>
                  <input type="radio" name={`guide-${script.id}`} checked={current === id} onChange={() => setTab(id)} />{label}
                </label>
              ))}
            </div>
          )}
          {current === 'tasks' && <Tasks guide={guide} />}
          {current === 'features' && <Features guide={guide} />}
          {current === 'config' && <Config guide={guide} />}
          {current === 'before' && <Before guide={guide} />}
          {current === 'problems' && <Problems guide={guide} />}
        </>
      )}
    </section>
  )
}

function Tasks({ guide }: { guide: PackGuide }) {
  if (guide.tasks.length === 0) return <p className="muted small">脚本包没有声明任务。</p>
  return (
    <ul className="guide-list">
      {guide.tasks.map(task => (
        <li key={task.id}>
          <div className="guide-item-head">
            <strong>{task.title}</strong>
            <span className="chip">{task.id}</span>
            <span className="badge">{INPUT_LABEL[task.input]}</span>
            {task.expectedDuration !== undefined && <span className="muted small">{duration(task.expectedDuration)}</span>}
          </div>
          {task.description !== undefined && <p>{task.description}</p>}
          {task.utterances.length > 0 && <p className="muted small">可以这样说：{task.utterances.map(u => `「${u}」`).join('')}</p>}
          {task.params.length === 0 ? <p className="muted small">没有参数。</p> : (
            <dl className="guide-keys">
              {task.params.map(param => (
                <div key={param.name}>
                  <dt><code>{param.name}</code></dt>
                  <dd>
                    <span>{param.description ?? '（没有说明）'}</span>
                    <Facts items={[['可选值', param.values], ['默认', param.default ?? (param.values === undefined ? '无，运行时必须填' : undefined)]]} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  )
}

function Features({ guide }: { guide: PackGuide }) {
  return (
    <ul className="guide-list">
      {guide.features.map(feature => (
        <li key={feature.title}>
          <div className="guide-item-head">
            <strong>{feature.title}</strong>
            {feature.tasks.length > 0 && <span className="muted small">任务：{feature.tasks.join('、')}</span>}
          </div>
          {feature.description !== undefined && <p>{feature.description}</p>}
          <p><span className="guide-label">怎么开启</span>{feature.enable}</p>
          {feature.config.length > 0 && (
            <div className="guide-facts muted small">
              {feature.config.map(c => <span key={`${c.file}:${c.key}`}>配置：<code>{c.file}</code> 里 <code>{c.key}</code> 设为 <code>{c.value}</code></span>)}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function Config({ guide }: { guide: PackGuide }) {
  return (
    <div className="guide-files">
      {guide.config.map(file => (
        <div key={file.file} className="guide-file">
          <div className="guide-item-head"><code className="guide-file-name">{file.file}</code></div>
          {file.about !== undefined && <p>{file.about}</p>}
          {file.keys.length > 0 && (
            <>
              <div className="field-label">重要的键</div>
              <dl className="guide-keys">
                {file.keys.map(key => (
                  <div key={key.key}>
                    <dt><code>{key.key}</code></dt>
                    <dd>
                      <span>{key.meaning}</span>
                      <Facts items={[['取值', key.values], ['默认', key.default]]} />
                      {key.advice !== undefined && <span className="guide-advice">建议：{key.advice}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {file.changes.length > 0 && (
            <>
              <div className="field-label">运行时本应用临时修改的键（只改本应用用的那份配置，运行结束后还原）</div>
              <dl className="guide-keys">
                {file.changes.map(change => (
                  <div key={`${change.key}=${change.value}:${change.when ?? ''}`}>
                    <dt><code>{change.key}</code></dt>
                    <dd>
                      <span>设为 <code>{change.value}</code>{change.note === undefined ? '' : `：${change.note}`}</span>
                      <Facts items={[['条件', change.when], ['任务', change.tasks.join('、')]]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function Before({ guide }: { guide: PackGuide }) {
  return (
    <div className="guide-before">
      {guide.setup.length > 0 && (
        <div>
          <div className="field-label">第一次使用前</div>
          <ol className="guide-steps">{guide.setup.map((step, i) => <li key={i}>{step}</li>)}</ol>
        </div>
      )}
      {guide.checks.length > 0 && (
        <div>
          <div className="field-label">每次运行前检查</div>
          <ul className="guide-steps checks">{guide.checks.map((check, i) => <li key={i}>{check}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

function Problems({ guide }: { guide: PackGuide }) {
  return (
    <ul className="guide-list">
      {guide.troubleshooting.map((item, i) => (
        <li key={i}>
          <strong>{item.problem}</strong>
          {item.cause !== undefined && <p><span className="guide-label">原因</span>{item.cause}</p>}
          <p><span className="guide-label">怎么办</span>{item.fix}</p>
        </li>
      ))}
    </ul>
  )
}
