import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { matchScripts } from '../src/script-match.ts'
import { SRA_GAMES } from '../src/sra-games.ts'

const games = [
  { id: 'arknights', words: ['明日方舟', '方舟', 'Arknights', 'arknights', ...SRA_GAMES.find(g => g.sra === 'ak')!.words] },
  { id: 'endfield', words: ['明日方舟：终末地', '终末地', 'Endfield', 'endfield', ...SRA_GAMES.find(g => g.sra === 'end')!.words] },
  ...SRA_GAMES.filter(g => !['ak', 'end'].includes(g.sra)).map(g => ({ id: `sra-${g.sra}`, words: [g.name, ...g.words] })),
]

test('installed scripts find their games by id, name, repository or pack, the most specific game winning', () => {
  const found = matchScripts([
    { id: 'ok-ww', texts: ['ok-ww', 'ok-ww', 'ok-oldking/ok-wuthering-waves'] },
    { id: 'better-genshin-impact', texts: ['better-genshin-impact', 'BetterGI', 'babalae/better-genshin-impact'] },
    { id: 'zzz-od', texts: ['zzz-od', '绝区零 一条龙', 'DoctorReid/ZenlessZoneZero-OneDragon'] },
    { id: 'maa', texts: ['maa', 'MAA', 'MaaAssistantArknights/MaaAssistantArknights', 'MAA（明日方舟）', '明日方舟'] },
    { id: 'maaend', texts: ['maaend', 'MaaEnd（终末地）', 'MaaEnd/MaaEnd', '明日方舟：终末地'] },
    { id: 'm7a', texts: ['march7th', '三月七小助手', 'moesnow/March7thAssistant', '崩坏：星穹铁道'] },
    { id: 'my-tool', texts: ['my-tool', 'D:\\Tools\\my-tool', 'upgrade helper'] },
  ], games)
  assert.deepEqual(found.get('ok-ww'), ['sra-ww'])
  assert.deepEqual(found.get('better-genshin-impact'), ['sra-ys'])
  assert.deepEqual(found.get('zzz-od'), ['sra-zzz'])
  assert.deepEqual(found.get('maa'), ['arknights'])
  assert.deepEqual(found.get('maaend'), ['endfield'], '明日方舟：终末地 is more specific than 明日方舟')
  assert.deepEqual(found.get('m7a'), ['sra-sr'])
  assert.deepEqual(found.get('my-tool'), [], 'nothing about a game: no match')
})
