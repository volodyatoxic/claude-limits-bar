import { expect, mock, test } from 'claude-code/testing'

import { barSvg, barTone, capsuleParts, caption, current, fresher, left, ringSvg, readConfig, restore, segments, sessionTone, weekElapsed } from '../hooks/register'

const scroll = { offset: 0, bodyRows: 10 }
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll, view: {} },
} as const

const NOW = Date.parse('2026-10-17T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
// Неделя, у которой прошла доля elapsed.
const week = (percentUsed: number, elapsed: number) => ({
  kind: 'seven_day',
  percentUsed,
  resetsAt: new Date(NOW + (1 - elapsed) * 7 * DAY).toISOString(),
})
const parts = (s: { part: string }[]) => s.map(p => p.part).join(' ')

test('session colors', async () => {
  expect(sessionTone(59)).toBe('ok')
  expect(sessionTone(60)).toBe('warn')
  expect(sessionTone(75)).toBe('hot')
  expect(parts(segments({ kind: 'five_hour', percentUsed: 65 }, NOW))).toBe('warn track')
})

test('week segments', async () => {
  // Неделя впереди: синий расход, серая отметка недели, дорожка.
  expect(parts(segments(week(20, 0.45), NOW))).toBe('ok pace track')
  // Чуть быстрее недели — оранжевый перерасход после синего.
  expect(parts(segments(week(52, 0.45), NOW))).toBe('ok warn track')
  // На 15+ п.п. быстрее — красный.
  expect(parts(segments(week(70, 0.45), NOW))).toBe('ok hot track')
  // Всё съедено — дорожки нет.
  expect(parts(segments(week(100, 0.8), NOW))).toBe('ok hot')
  // Синий кончается ровно на отметке недели.
  const over = segments(week(70, 0.5), NOW)
  expect(over[0]?.to).toBe(over[1]?.from)
})

test('bar svg fills the slot', async () => {
  const svg = barSvg(segments(week(70, 0.5), NOW), 200)
  expect(svg).toContain('width="4000"')
  expect(svg).toContain('viewBox="0 0 200 5"')
  expect(svg).toContain('class="hot"')
})

test('last colored segment has a rounded right end', async () => {
  const rounded = (svg: string) => [...svg.matchAll(/<rect class="(\w+)"[^>]*rx=/g)].map(m => m[1])
  // Неделя впереди: закругляет серая отметка, синий — нет.
  expect(rounded(barSvg(segments(week(20, 0.45), NOW), 200))).toEqual(['pace'])
  // Перерасход: закругляет красный.
  expect(rounded(barSvg(segments(week(70, 0.45), NOW), 200))).toEqual(['hot'])
  // Сессия: закругляет её единственный цветной сегмент.
  expect(rounded(barSvg(segments({ kind: 'five_hour', percentUsed: 30 }, NOW), 200))).toEqual(['ok'])
  // Пусто — закруглять нечего.
  expect(rounded(barSvg(segments({ kind: 'five_hour', percentUsed: 0 }, NOW), 200))).toEqual([])
})

test('caption: percent and time left', async () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  expect(caption({ kind: 'five_hour', percentUsed: 19.4, resetsAt: iso(NOW + 131 * 60_000) }, NOW)).toEqual({ pct: '19%', rest: ' / 2:11' })
  expect(caption({ kind: 'seven_day', percentUsed: 21, resetsAt: iso(NOW + 5.2 * DAY) }, NOW)).toEqual({ pct: '21%', rest: ' / 5d 4h' })
  // Окно ещё не началось — без времени.
  expect(caption({ kind: 'five_hour', percentUsed: 0 }, NOW)).toEqual({ pct: '0%', rest: '' })
})

test('time left', async () => {
  expect(left('2026-10-17T14:16:30Z', NOW)).toBe('4:16')
  expect(left('2026-10-17T10:05:00Z', NOW)).toBe('0:05')
  expect(left('2026-10-22T13:05:00Z', NOW)).toBe('5d 3h')
  // 27 часов до сброса — «1d 3h», а не просто «1d».
  expect(left('2026-10-18T13:00:00Z', NOW)).toBe('1d 3h')
  expect(left('2026-10-18T10:00:00Z', NOW)).toBe('1d 0h')
  expect(left(undefined, NOW)).toBe('')
  expect(weekElapsed('2026-10-20T22:00:00Z', NOW)).toBe(0.5)
})

test('band draws two bars and the split drags', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const empty = await $.ui.mount({ plugin: 'limits-bar', surface, ...BAND })
    expect(await empty.find({ text: 'engine' })).toBeDefined()
    await empty.unmount()
  }

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 17, resetsAt: new Date(clock.now() + 5 * DAY).toISOString() },
      { kind: 'five_hour', percentUsed: 9, resetsAt: new Date(clock.now() + 4 * 3600_000).toISOString() },
    ],
    changed: ['rateLimits'],
  })

  const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
  expect(await desk.find({ text: '4:00' })).toBeDefined()
  // Пиктограммы окон: серые кольца с 5 и W, без прогресса.
  const icons = (await desk.findAll({ type: 'Svg' })).map(el => JSON.stringify(el))
  expect(icons.filter(el => el.includes('5 часов') || el.includes('Неделя\\"')).length).toBeGreaterThan(0)
  // Часы на 5:00 (минутная на 12, часовая на 5) и календарь.
  expect(icons.some(el => el.includes('M8 8V3.9M8 8L10.1 11.6'))).toBe(true)
  expect(icons.some(el => el.includes('M2.1 6.6h11.8'))).toBe(true)
  // Подпись: проценты и время до сброса.
  expect(await desk.find({ text: '9%' })).toBeDefined()
  expect(await desk.find({ text: ' / 4:00' })).toBeDefined()
  expect(await desk.find({ text: '17%' })).toBeDefined()
  expect(await desk.find({ text: /\dd \d+h$/ })).toBeDefined()
  await desk.resize({ columns: 100, rows: 1 })

  const seamInLayout = async () => (await desk.findAll({ type: 'Svg' })).some(el => JSON.stringify(el).includes('Стык'))

  // Вдали от стыка сепаратора нет, у стыка — тонкая линия в раскладке.
  await desk.pointer({ type: 'move', x: 10, y: 0 })
  expect(await seamInLayout()).toBe(false)
  await desk.pointer({ type: 'move', x: 50, y: 0 })
  expect(await seamInLayout()).toBe(true)
  expect(await desk.find({ text: '│', in: 'handle' })).toBeUndefined()

  // Пока тянут: черту рисует слой мыши и она едет сразу, линия в раскладке скрыта.
  await desk.pointer({ type: 'down', x: 50, y: 0, button: 'left' })
  await desk.pointer({ type: 'move', x: 70, y: 0, button: 'left' })
  expect(JSON.stringify(await desk.drawn({ in: 'handle' }))).toContain('"left":70')
  expect(await seamInLayout()).toBe(false)

  // Отпустили: пропорция запомнилась, линия снова в раскладке, черта слоя исчезла.
  await desk.pointer({ type: 'up', x: 70, y: 0, button: 'left' })
  expect(JSON.stringify(await desk.drawn())).toContain('"width":"72%"')
  expect(JSON.stringify(await desk.drawn())).toContain('"width":"28%"')
  expect(await seamInLayout()).toBe(true)
  expect(await desk.find({ text: '│', in: 'handle' })).toBeUndefined()

  // Клик далеко от стыка ничего не двигает.
  await desk.pointer({ type: 'down', x: 5, y: 0, button: 'left' })
  await desk.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await desk.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  expect(JSON.stringify(await desk.drawn())).toContain('"width":"72%"')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'limits-bar', surface: 'terminal', ...BAND })
  expect(await term.find({ text: /━/ })).toBeDefined()
  await term.unmount()
})

test('thresholds come from settings', async () => {
  const cfg = readConfig({ sessionWarn: 40, sessionHot: 50, weekOver: 5 })
  expect(sessionTone(45, cfg)).toBe('warn')
  expect(sessionTone(50, cfg)).toBe('hot')
  // Перерасход 7 п.п.: по умолчанию оранжевый, с порогом 5 — красный.
  expect(barTone(week(52, 0.45), NOW)).toBe('warn')
  expect(barTone(week(52, 0.45), NOW, cfg)).toBe('hot')
  // Неделя впереди — тревоги нет.
  expect(barTone(week(20, 0.45), NOW)).toBe('ok')
})

test('animation markup', async () => {
  const parts = segments({ kind: 'five_hour', percentUsed: 65 }, NOW)
  expect(barSvg(parts, 200)).not.toContain('class="sh"')
  const once = barSvg(parts, 200, 'once')
  expect(once).toContain('class="sh"')
  expect(once).toContain('class="warn hl"')
  expect(once).toContain('1.2s ease-in-out 2')
  expect(barSvg(parts, 200, 'loop')).toContain('infinite')
  expect(once).toContain('prefers-reduced-motion')
})

for (const isOn of [true, false]) {
  test(`crossing a threshold ${isOn ? 'animates and notifies' : 'stays quiet when turned off'}`,
    { options: { animation: isOn, notify: isOn } },
    async ($, on) => {
      const clock = mock.clock(on)
      mock.store(on)
      const toasts: string[] = []
      on('session.measure', ($, e) => ({ changed: e.changed }))
      on('ui.toast', ($, e) => {
        toasts.push(e.text)
        return { value: undefined }
      })
      const measure = (five: number) =>
        $.session.measure({
          context: { window: 200000 },
          rateLimits: [
            { kind: 'five_hour', percentUsed: five, resetsAt: new Date(clock.now() + 3 * 3600_000).toISOString() },
            { kind: 'seven_day', percentUsed: 10, resetsAt: new Date(clock.now() + 5 * DAY).toISOString() },
          ],
          changed: ['rateLimits'],
        })
      // Реальная строка: у демо-строк нет 63%.
      const sessionBar = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) =>
        (await ui.findAll({ type: 'Svg' })).map(el => JSON.stringify(el)).find(el => el.includes('Сессия: 63%')) ?? ''

      await measure(50)
      await measure(63)
      const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
      expect((await sessionBar(desk)).includes('class=\\"sh\\"')).toBe(isOn)
      expect(toasts).toEqual(isOn ? ['Сессия: 63% — оранжевая зона'] : [])

      // Через пару секунд анимация гаснет.
      await clock.advance(3000)
      expect(await sessionBar(desk)).not.toContain('class=\\"sh\\"')
      await desk.unmount()
    },
  )
}

test('restore saved readings', async () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const saved = {
    list: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 2 * 3600_000) },
      { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 3 * DAY) },
    ],
  }
  // Окна ещё не сбросились — как было.
  expect(restore(saved, NOW)).toEqual(saved.list)
  // Прошло 4 дня: 5 часов и неделя сбросились; неделя — с нуля до следующего сброса.
  const later = restore(saved, NOW + 4 * DAY)
  expect(later[0]).toEqual({ kind: 'five_hour', percentUsed: 0 })
  expect(later[1]).toEqual({ kind: 'seven_day', percentUsed: 0, resetsAt: iso(NOW + 10 * DAY) })
  // Мусор в хранилище — ничего.
  expect(restore(null, NOW)).toEqual([])
  expect(restore({ list: [{ kind: 1 }] }, NOW)).toEqual([])
})

test('a new session shows saved readings before the first answer', async ($, on) => {
  const clock = mock.clock(on)
  const iso = (ms: number) => new Date(ms).toISOString()
  mock.store(on, {
    last: {
      list: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: iso(clock.now() + 3 * 3600_000) },
        { kind: 'seven_day', percentUsed: 30, resetsAt: iso(clock.now() + 4 * DAY) },
      ],
    },
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } as never }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
  expect(await desk.find({ text: '3:00' })).toBeDefined()
  expect(await desk.find({ text: '4d 0h' })).toBeDefined()

  // Первое настоящее измерение не выдаётся за переход порога.
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 64, resetsAt: iso(clock.now() + 3 * 3600_000) },
      { kind: 'seven_day', percentUsed: 31, resetsAt: iso(clock.now() + 4 * DAY) },
    ],
    changed: ['rateLimits'],
  })
  expect(toasts).toEqual([])
  await desk.unmount()
})

test('current windows: session always shown, stale readings reset', async () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  // Окна 5 часов нет в данных (после долгого перерыва) — показываем его на нуле.
  const weekOnly = current([{ kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 5 * DAY) }], NOW)
  expect(weekOnly.map(one => `${one.kind}:${one.percentUsed}`)).toEqual(['five_hour:0', 'seven_day:20'])
  // Мак спал: сброс 5 часов прошёл — 0% и без времени; неделя — как была.
  const slept = current(
    [
      { kind: 'five_hour', percentUsed: 80, resetsAt: iso(NOW - 3600_000) },
      { kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 5 * DAY) },
    ],
    NOW,
  )
  expect(slept[0]).toEqual({ kind: 'five_hour', percentUsed: 0 })
  expect(slept[1]?.percentUsed).toBe(20)
  // Данных нет совсем — ничего не рисуем.
  expect(current([], NOW)).toEqual([])
})

test('a reading without the session window keeps both halves', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const iso = (ms: number) => new Date(ms).toISOString()
  const measure = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) =>
    $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })

  await measure([
    { kind: 'five_hour', percentUsed: 40, resetsAt: iso(clock.now() + 2 * 3600_000) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: iso(clock.now() + 5 * DAY) },
  ])
  // Следующее измерение — только неделя: 5 часов берём из сохранённого.
  await measure([{ kind: 'seven_day', percentUsed: 21, resetsAt: iso(clock.now() + 5 * DAY) }])

  const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
  const drawn = JSON.stringify(await desk.drawn())
  expect(drawn).toContain('Сессия: 40%')
  expect(drawn).toContain('Неделя: 21%')
  expect(await desk.find({ text: '2:00' })).toBeDefined()
  await desk.unmount()
})

test('fresher reading of one window', async () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const a = { kind: 'five_hour', percentUsed: 5, resetsAt: iso(NOW + 3600_000) }
  const b = { kind: 'five_hour', percentUsed: 8, resetsAt: iso(NOW + 3600_000) }
  const nextWindow = { kind: 'five_hour', percentUsed: 1, resetsAt: iso(NOW + 5 * 3600_000) }
  // Одно окно — больший расход свежее.
  expect(fresher(a, b)).toBe(b)
  expect(fresher(b, a)).toBe(b)
  // Новое окно (сброс позже) свежее, даже если расход меньше.
  expect(fresher(b, nextWindow)).toBe(nextWindow)
  expect(fresher(undefined, a)).toBe(a)
})

test('idle chats pick up readings saved by other chats', async ($, on) => {
  const clock = mock.clock(on)
  const mem = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: mem.get(e.key) }))
  on('store.set', ($, e) => {
    mem.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } as never }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const iso = (ms: number) => new Date(ms).toISOString()
  const reset5 = iso(clock.now() + 4 * 3600_000)
  const week = { kind: 'seven_day', percentUsed: 20, resetsAt: iso(clock.now() + 5 * DAY) }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: reset5 }, week],
    changed: ['rateLimits'],
  })
  const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
  expect(JSON.stringify(await desk.drawn())).toContain('Сессия: 5%')

  // Другой чат получил ответ и сохранил 8% — этот подтягивает через 15 секунд.
  mem.set('last', { list: [{ kind: 'five_hour', percentUsed: 8, resetsAt: reset5 }, week] })
  await clock.advance(15_000)
  expect(JSON.stringify(await desk.drawn())).toContain('Сессия: 8%')

  // Запоздалое измерение этого чата (6%) не затирает более свежие 8%.
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 6, resetsAt: reset5 }, week],
    changed: ['rateLimits'],
  })
  expect(JSON.stringify(await desk.drawn())).toContain('Сессия: 8%')
  expect(JSON.stringify(mem.get('last'))).toContain('"percentUsed":8')
  await desk.unmount()
})

test('the chevron cycles designs and the choice is kept', async ($, on) => {
  const clock = mock.clock(on)
  const mem = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: mem.get(e.key) }))
  on('store.set', ($, e) => {
    mem.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const iso = (ms: number) => new Date(ms).toISOString()
  await $.session.measure({
    context: { window: 200000, percent: 38 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 9, resetsAt: iso(clock.now() + 4 * 3600_000) },
      { kind: 'seven_day', percentUsed: 21, resetsAt: iso(clock.now() + 5 * DAY) },
    ],
    changed: ['rateLimits', 'context'],
  })
  const desk = await $.ui.mount({ plugin: 'limits-bar', surface: 'desktop', ...BAND })
  await desk.resize({ columns: 100, rows: 1 })
  const drawn = async () => JSON.stringify(await desk.drawn())
  const clickChevron = async () => {
    await desk.pointer({ type: 'down', x: 99, y: 0, button: 'left' })
    await desk.pointer({ type: 'up', x: 99, y: 0, button: 'left' })
  }

  // 0 — полоски: шеврон на месте.
  expect(await drawn()).toContain('Следующий вид')
  expect(await drawn()).toContain('M8 8V3.9')

  // 1 — капсулы: подпись внутри, мелкий шрифт.
  await clickChevron()
  expect(await desk.find({ text: '5 ч · 9%' })).toBeDefined()
  expect(await drawn()).toContain('"size":"footnote"')
  // Концы капсулы — ровные полукруги фиксированного размера, середина тянется.
  expect(await drawn()).toContain('Начало капсулы')
  expect(await drawn()).toContain('Конец капсулы')
  expect(mem.get('design')).toBe(1)

  // 2 — кольца по центру: стык не тянется.
  await clickChevron()
  expect(await drawn()).toContain('stroke-dasharray')
  expect(await desk.find({ text: '5 ч · 9%' })).toBeUndefined()
  await desk.pointer({ type: 'down', x: 49, y: 0, button: 'left' })
  await desk.pointer({ type: 'move', x: 70, y: 0, button: 'left' })
  expect(await desk.find({ text: '│', in: 'handle' })).toBeUndefined()
  await desk.pointer({ type: 'up', x: 70, y: 0, button: 'left' })

  // 3 — кольца + контекст этого чата.
  await clickChevron()
  expect(await desk.find({ text: '38%' })).toBeDefined()
  expect(await drawn()).toContain('Контекст')

  // По кругу — снова полоски.
  await clickChevron()
  expect(await drawn()).toContain('M8 8V3.9')
  expect(mem.get('design')).toBe(0)
  await desk.unmount()
})

test('capsule parts split the segments between ends and middle', async () => {
  const five = (pct: number) => segments({ kind: 'five_hour', percentUsed: pct }, NOW)
  // 50% из 300px: левый конец залит полностью, середина — (150-10)/280 → 500 из 1000, правый пуст.
  const half = capsuleParts(five(50), 300)
  expect(half.left).toContain('class="ok" x="0.00" width="10.00"')
  expect(half.mid).toContain('class="ok" x="0.00" width="500.00"')
  expect(half.right).not.toContain('class="ok"')
  // 100% — красная, залиты оба конца.
  expect(capsuleParts(five(100), 300).right).toContain('class="hot" x="0.00" width="10.00"')
  // 0% — заливки нет нигде.
  const none = capsuleParts(five(0), 300)
  expect(none.left + none.mid + none.right).not.toMatch(/class="(ok|warn|hot|pace)"/)
})

test('week pace shows in capsules and rings', async () => {
  // Неделя впереди: синий расход и серый запас до отметки недели.
  const ahead = segments(week(20, 0.45), NOW)
  expect(capsuleParts(ahead, 300).mid).toMatch(/class="ok".*class="pace"/)
  const ringAhead = ringSvg(ahead)
  // Дальняя дуга снизу: сначала серый запас, сверху синий расход.
  expect(ringAhead.indexOf('class="pace"')).toBeLessThan(ringAhead.indexOf('class="ok"'))
  // Расход обогнал неделю: синий до отметки, после — перерасход цветом зоны.
  const behind = segments(week(52, 0.45), NOW)
  expect(capsuleParts(behind, 300).mid).toMatch(/class="ok".*class="warn"/)
  const ringBehind = ringSvg(behind)
  expect(ringBehind.indexOf('class="warn"')).toBeLessThan(ringBehind.indexOf('class="ok"'))
  expect(ringSvg(segments(week(70, 0.45), NOW))).toContain('class="hot"')
})
