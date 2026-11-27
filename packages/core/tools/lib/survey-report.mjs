/**
 * 抽样汇总与分片派发（2026-11-27，3.5.4 从 tools/mutate.mjs 抽出）。
 *
 * `self` 与 `repo` 走参数：搬进 lib/ 之后 `import.meta.url` 指向 lib 自己，
 * 而子进程必须重启**入口脚本**，不能指向这里。
 */
import { spawn } from "node:child_process"

/**
 * 起 `jobs` 个分片子进程，合并结果。
 *
 * 为什么不是 worker_threads：被测的是子进程（`node --test`），线程里再 spawn 进程
 * 没有任何收益，反而多一层共享状态。
 */
export async function surveyParallel({ jobs, self, repo }) {
  const runs = Array.from({ length: jobs }, (_, i) => {
    return new Promise((resolve) => {
      const cp = spawn('node', [self, '--survey', '--shard', `${i}/${jobs}`], {
        cwd: repo,
        env: process.env,
      })
      let out = ''
      cp.stdout.on('data', (d) => {
        out += d
      })
      cp.stderr.on('data', (d) => process.stderr.write(d))
      cp.on('close', () => {
        const m = out.match(/__ROWS__([\s\S]*)$/)
        if (!m) {
          process.stderr.write(`[survey] 分片 ${i} 无结果\n`)
          resolve([])
          return
        }
        try {
          resolve(JSON.parse(m[1]))
        } catch {
          resolve([])
        }
      })
    })
  })
  const rows = (await Promise.all(runs)).flat()
  reportSurvey(rows)
}

/** 表格按得分升序：最薄的排最前，那才是要动手的地方。 */
export function reportSurvey(rows) {
  const scored = rows.filter((r) => typeof r.score === 'number').sort((a, b) => a.score - b.score)
  const skipped = rows.filter((r) => r.skipped)
  console.log('\n模块                                     变异体  杀掉   得分')
  for (const r of scored) {
    console.log(`${r.rel.padEnd(38)} ${String(r.total).padStart(5)} ${String(r.killed).padStart(5)} ${String(r.score).padStart(6)}%`)
  }
  const avg = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0
  console.log(`\n可测模块 ${scored.length} 个，平均得分 ${avg.toFixed(1)}%；跳过 ${skipped.length} 个`)
  for (const r of skipped) console.log(`  跳过 ${r.rel}：${r.skipped.split('，')[0].slice(0, 50)}`)
}
