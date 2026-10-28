import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Limit } from '../types'

const windows = atom({ plugin: 'limits-bar', key: 'windows' } as const, [])
const now = atom({ plugin: 'limits-bar', key: 'now' } as const, 0)
const ratio = atom({ plugin: 'limits-bar', key: 'ratio' } as const, 0.5)
// Сепаратор у стыка: none — скрыт, near — курсор рядом, drag — тянут (рисует слой мыши).
const seam = atom({ plugin: 'limits-bar', key: 'seam' } as const, 'none')
// Какой дизайн показан (листается шевроном «›»): 0 полоски, 1 капсулы, 2 кольца, 3 кольца + контекст.
const design = atom({ plugin: 'limits-bar', key: 'design' } as const, 0)
// Заполненность контекста этого чата, %; −1 — пока неизвестна.
const ctx = atom({ plugin: 'limits-bar', key: 'ctx' } as const, -1)
// Какие полоски сейчас анимируют переход порога: kind → до какого момента (мс).
const flash = atom({ plugin: 'limits-bar', key: 'flash' } as const, {})

const RATIO_KEY = 'ratio'
const DESIGN_KEY = 'design'
export const DESIGNS = 4
// Колонка шеврона «›» справа, в клетках.
const CHEV_CELLS = 2
// Последние показания лимитов: Claude Code узнаёт их только из ответа модели,
// поэтому до первого ответа в новой сессии показываем сохранённые.
const LAST_KEY = 'last'
const clampRatio = (value: number) => Math.max(0.2, Math.min(0.8, value))

// Временно: показать под виджетом все варианты отрисовки.
const SHOW_DEMO = false

const KINDS = ['five_hour', 'seven_day']
// Самая длинная подпись — «100% / 6d 23h».
const TIME_CELLS = 13
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FLASH_MS = 2600
// Как часто чат сверяется с показаниями других чатов.
const SYNC_MS = 15_000

export const BAR_PX = 5
// Зазор между сегментами, как в индикаторе контекста приложения.
const GAP_PX = 2
// Промежуток между половинами в клетках: время · сепаратор · следующая полоска.
const SEP_CELLS = 0.5
const SEP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="12">' +
  '<style>.s{fill:#cfcfcb}@media (prefers-color-scheme:dark){.s{fill:#4a4a48}}</style>' +
  '<rect class="s" width="1" height="12"/></svg>'

// Пиктограммы окон цвета текста времени (#898781 — снято со скриншота приложения;
// для тёмной темы — близкий оттенок): часы на 5:00 и календарь.
const ICON_PX = 15
const icon = (body: string) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
  '<style>.i{fill:none;stroke:#898781;stroke-linecap:round}@media (prefers-color-scheme:dark){.i{stroke:#9a9893}}</style>' +
  body +
  '</svg>'
export const ICONS: Record<string, { source: string; alt: string }> = {
  five_hour: {
    source: icon(
      '<circle class="i" cx="8" cy="8" r="6.85" stroke-width="1.1"/>' +
        '<path class="i" d="M8 8V3.9M8 8L10.1 11.6" stroke-width="1.2"/>',
    ),
    alt: '5 часов',
  },
  seven_day: {
    source: icon(
      '<rect class="i" x="2.1" y="3.1" width="11.8" height="10.9" rx="2.2" stroke-width="1.1"/>' +
        '<path class="i" d="M2.1 6.6h11.8M5.4 1.8v2.6M10.6 1.8v2.6" stroke-width="1.1"/>',
    ),
    alt: 'Неделя',
  },
}

// Цвета — как в меню «Использование» и индикаторе контекста.
const STYLE =
  '.ok{fill:#2f7de1}.warn{fill:#f59e0b}.hot{fill:#e5484d}.pace{fill:#bdbdb8}.track{fill:#e3e3e3}' +
  '@media (prefers-color-scheme:dark){.pace{fill:#6b6b68}.track{fill:#3a3a3a}}'

export type Tone = 'ok' | 'warn' | 'hot'
export type Part = Tone | 'pace' | 'track'
export type Segment = { from: number; to: number; part: Part }
export type Anim = 'once' | 'loop'

const TERMINAL: Record<Tone, string> = { ok: 'suggestion', warn: 'warning', hot: 'error' }
const RANK: Record<Tone, number> = { ok: 0, warn: 1, hot: 2 }
const isTone = (part: Part): part is Tone => part === 'ok' || part === 'warn' || part === 'hot'

// Настройки плагина (userConfig в plugin.json).
export type Config = {
  sessionWarn: number
  sessionHot: number
  weekOver: number
  animation: boolean
  notify: boolean
}
export const DEFAULTS: Config = { sessionWarn: 60, sessionHot: 75, weekOver: 15, animation: true, notify: true }

const num = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

export const readConfig = (options: PluginOptions): Config => ({
  sessionWarn: num(options.sessionWarn, DEFAULTS.sessionWarn),
  sessionHot: num(options.sessionHot, DEFAULTS.sessionHot),
  weekOver: num(options.weekOver, DEFAULTS.weekOver),
  animation: flag(options.animation, DEFAULTS.animation),
  notify: flag(options.notify, DEFAULTS.notify),
})

// 5 часов: просто по порогам.
export const sessionTone = (pct: number, cfg: Config = DEFAULTS): Tone =>
  pct >= cfg.sessionHot ? 'hot' : pct >= cfg.sessionWarn ? 'warn' : 'ok'

// Перерасход недели: до weekOver п.п. — оранжевый, дальше или с 80% — красный.
export const overTone = (pct: number, elapsed: number, cfg: Config = DEFAULTS): Tone =>
  pct - elapsed * 100 >= cfg.weekOver || pct >= 80 ? 'hot' : 'warn'

// Подпись у полоски: «19% / 2:11»; без времени до сброса — просто «0%».
export const caption = (one: Limit, nowMs: number) => {
  const pct = `${Math.round(one.percentUsed)}%`
  const time = left(one.resetsAt, nowMs)

  return { pct, rest: time ? ` / ${time}` : '' }
}

// До сброса: «4:16», а от суток — «5d 3h»: одних суток мало, «1d» бывает и 47 часов.
export const left = (resetsAt: string | undefined, nowMs: number) => {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const mins = Math.max(0, Math.floor((at - nowMs) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`

  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

// Какая доля недели уже прошла, 0..1.
export const weekElapsed = (resetsAt: string | undefined, nowMs: number) => {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return undefined

  return Math.max(0, Math.min(1, 1 - (at - nowMs) / WEEK_MS))
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

// Сегменты полоски слева направо, доли 0..1. Неделя: если неделя впереди —
// синий расход, затем серая отметка недели; если расход впереди — синий до
// отметки недели, затем перерасход.
export const segments = (one: Limit, nowMs: number, cfg: Config = DEFAULTS): Segment[] => {
  const used = clamp01(one.percentUsed / 100)
  const elapsed = one.kind === 'seven_day' ? weekElapsed(one.resetsAt, nowMs) : undefined
  let parts: Segment[]

  if (elapsed === undefined) {
    const tone: Tone =
      one.kind === 'seven_day' ? (one.percentUsed >= 80 ? 'hot' : 'ok') : sessionTone(one.percentUsed, cfg)
    parts = [{ from: 0, to: used, part: tone }]
  } else if (used <= elapsed) {
    parts = [
      { from: 0, to: used, part: 'ok' },
      { from: used, to: elapsed, part: 'pace' },
    ]
  } else {
    parts = [
      { from: 0, to: elapsed, part: 'ok' },
      { from: elapsed, to: used, part: overTone(one.percentUsed, elapsed, cfg) },
    ]
  }

  const end = Math.max(0, ...parts.map(p => p.to))
  parts.push({ from: end, to: 1, part: 'track' })

  return parts.filter(p => p.to - p.from > 0.004)
}

// Самый тревожный цвет полоски: по нему ловим переход порога.
export const barTone = (one: Limit, nowMs: number, cfg: Config = DEFAULTS): Tone =>
  segments(one, nowMs, cfg).reduce<Tone>(
    (worst, p) => (isTone(p.part) && RANK[p.part] > RANK[worst] ? p.part : worst),
    'ok',
  )

// Блик пробегает по цветной части, оранжевый и красный сегменты мягко пульсируют.
// once — дважды при переходе порога; loop — по кругу (для демо).
const animation = (coloredPx: number, anim: Anim) => {
  const sw = Math.max(24, coloredPx * 0.35)
  const travel = (coloredPx + sw).toFixed(1)
  const [dur, count, end] = anim === 'once' ? ['1.2s', '2', 100] : ['3.2s', 'infinite', 38]
  const style =
    `.sh{animation:sh ${dur} ease-in-out ${count}}.hl{animation:pu ${dur} ease-in-out ${count}}` +
    `@keyframes sh{0%{transform:translateX(0)}${end}%{transform:translateX(${travel}px)}100%{transform:translateX(${travel}px)}}` +
    `@keyframes pu{0%{opacity:1}${end / 2}%{opacity:.55}${end}%{opacity:1}100%{opacity:1}}` +
    '@media (prefers-reduced-motion:reduce){.sh,.hl{animation:none}}'
  const markup =
    '<defs><linearGradient id="g" x1="0" x2="1">' +
    '<stop offset="0" stop-color="#fff" stop-opacity="0"/>' +
    '<stop offset=".5" stop-color="#fff" stop-opacity=".7"/>' +
    '<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    `<clipPath id="f"><rect width="${coloredPx.toFixed(1)}" height="${BAR_PX}" rx="${BAR_PX / 2}"/></clipPath></defs>` +
    `<g clip-path="url(#f)"><rect class="sh" x="${(-sw).toFixed(1)}" width="${sw.toFixed(1)}" height="${BAR_PX}" fill="url(#g)"/></g>`

  return { style, markup }
}

// Svg без ширины ужимается до слота: широкий холст всегда заполняет слот целиком.
// Система координат — примерная ширина в пикселях, чтобы скругления и зазоры
// растягивались как можно меньше.
export const barSvg = (parts: readonly Segment[], approxPx = 350, anim?: Anim) => {
  const w = Math.max(60, Math.round(approxPx))
  const r = BAR_PX / 2
  // Последний цветной сегмент перед дорожкой закругляет свой правый конец.
  let lastColored = -1
  parts.forEach((p, i) => {
    if (p.part !== 'track') lastColored = i
  })
  const coloredPx = Math.max(0, ...parts.filter(p => isTone(p.part)).map(p => p.to)) * w
  const fx = anim && coloredPx > 0 ? animation(coloredPx, anim) : undefined

  const rects = parts.map((p, i) => {
    const x = p.from * w + (i > 0 ? GAP_PX / 2 : 0)
    const width = (p.to - p.from) * w - (i > 0 ? GAP_PX / 2 : 0) - (i < parts.length - 1 ? GAP_PX / 2 : 0)
    if (width <= 0) return ''
    const cls = fx && (p.part === 'warn' || p.part === 'hot') ? `${p.part} hl` : p.part
    const at = `class="${cls}" x="${x.toFixed(1)}" height="${BAR_PX}"`
    if (i !== lastColored) return `<rect ${at} width="${width.toFixed(1)}"/>`

    // Скруглённый прямоугольник, а левая половина — прямая, если слева есть сосед.
    return (
      `<rect ${at} width="${width.toFixed(1)}" rx="${r}"/>` +
      (i > 0 ? `<rect ${at} width="${Math.min(width, Math.max(r, width / 2)).toFixed(1)}"/>` : '')
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${BAR_PX}" viewBox="0 0 ${w} ${BAR_PX}" preserveAspectRatio="none">` +
    `<style>${STYLE}${fx?.style ?? ''}</style>` +
    `<clipPath id="c"><rect width="${w}" height="${BAR_PX}" rx="${BAR_PX / 2}"/></clipPath>` +
    `<g clip-path="url(#c)">${rects.join('')}${fx?.markup ?? ''}</g>` +
    `</svg>`
  )
}

// Текст уведомления о переходе порога.
export const notice = (one: Limit, tone: Tone) => {
  const pct = Math.round(one.percentUsed)
  if (one.kind === 'five_hour') return `Сессия: ${pct}% — ${tone === 'hot' ? 'красная' : 'оранжевая'} зона`

  return tone === 'hot' ? `Неделя: ${pct}% — сильный перерасход` : `Неделя: ${pct}% — расход обгоняет неделю`
}

// Кольцо в духе Apple Watch. Рисует те же сегменты, что полоски: для недели — синий
// расход поверх серого запаса до отметки недели, либо синий до отметки поверх перерасхода.
const RING_R = 6.4
const RING_LEN = 2 * Math.PI * RING_R
const RING_STYLE =
  '<style>.t{stroke:#e0dfda}.ok{stroke:#2f7de1}.warn{stroke:#f59e0b}.hot{stroke:#e5484d}.pace{stroke:#b9b7af}' +
  '@media (prefers-color-scheme:dark){.t{stroke:#3a3a38}.pace{stroke:#6b6b68}}</style>'
const ringArc = (to: number, attrs: string) =>
  `<circle cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.4" stroke-linecap="round" ` +
  `stroke-dasharray="${(Math.min(1, to) * RING_LEN).toFixed(2)} ${RING_LEN.toFixed(2)}" transform="rotate(-90 8 8)" ${attrs}/>`
const ringFrame = (arcs: string) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
  RING_STYLE +
  `<circle class="t" cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.4"/>` +
  arcs +
  '</svg>'

export const ringSvg = (parts: readonly Segment[]) =>
  ringFrame(
    parts
      .filter(p => p.part !== 'track' && p.to > 0.004)
      // Дуги от нуля: дальняя снизу, ближняя сверху.
      .sort((x, y) => y.to - x.to)
      .map(p => ringArc(p.to, `class="${p.part}"`))
      .join(''),
  )

// Одноцветное кольцо (контекст чата).
export const ringPlainSvg = (pct: number, color: string) =>
  ringFrame(pct > 0.4 ? ringArc(Math.max(0, Math.min(100, pct)) / 100, `stroke="${color}"`) : '')

// Капсула как индикатор заряда в iOS. Собрана из трёх частей: круглые концы фиксированного
// размера и растягиваемая середина без скруглений — так концы всегда ровные полукруги.
// Сегменты те же, что у полосок. Цвета сплошные, заранее смешанные с подложкой: на стыках
// частей полупрозрачные края сглаживались бы дважды и давали шов.
export const CAPSULE_PX = 20
const CAP_R = CAPSULE_PX / 2
const CAPSULE_BASE = { light: '#e6e5e1', dark: '#3a3a38' }
const mix = (base: string, tone: string, alpha: number) => {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return (
    '#' +
    [0, 1, 2]
      .map(i => Math.round(ch(base, i) * (1 - alpha) + ch(tone, i) * alpha).toString(16).padStart(2, '0'))
      .join('')
  )
}
const capsuleFills = (base: string, weak: number, strong: number, pace: string) =>
  `.b{fill:${base}}.ok{fill:${mix(base, '#2f7de1', weak)}}.warn{fill:${mix(base, '#f59e0b', strong)}}` +
  `.hot{fill:${mix(base, '#e5484d', strong)}}.pace{fill:${pace}}`
const CAPSULE_STYLE =
  `<style>${capsuleFills(CAPSULE_BASE.light, 0.22, 0.38, '#cfcdc6')}` +
  `@media (prefers-color-scheme:dark){${capsuleFills(CAPSULE_BASE.dark, 0.36, 0.5, '#4d4c48')}}</style>`

// Прямоугольники сегментов, попавших в участок [p0, p1] капсулы шириной total (px).
const capRects = (parts: readonly Segment[], total: number, p0: number, p1: number, scale: number) =>
  parts
    .filter(p => p.part !== 'track')
    .map(p => {
      const x0 = Math.max(p.from * total, p0)
      const x1 = Math.min(p.to * total, p1)
      return x1 - x0 > 0.05
        ? `<rect class="${p.part}" x="${((x0 - p0) * scale).toFixed(2)}" width="${((x1 - x0) * scale).toFixed(2)}" height="${CAPSULE_PX}"/>`
        : ''
    })
    .join('')

const capEnd = (side: 'left' | 'right', rects: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CAP_R}" height="${CAPSULE_PX}" viewBox="0 0 ${CAP_R} ${CAPSULE_PX}">` +
  CAPSULE_STYLE +
  `<clipPath id="e"><rect x="${side === 'left' ? 0 : -CAP_R}" width="${CAPSULE_PX}" height="${CAPSULE_PX}" rx="${CAP_R}"/></clipPath>` +
  `<g clip-path="url(#e)"><rect class="b" width="${CAP_R}" height="${CAPSULE_PX}"/>${rects}</g></svg>`

export const capsuleParts = (parts: readonly Segment[], approxPx = 300) => {
  const total = Math.max(60, Math.round(approxPx))
  const midScale = 1000 / (total - 2 * CAP_R)

  return {
    left: capEnd('left', capRects(parts, total, 0, CAP_R, 1)),
    mid:
      `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${CAPSULE_PX}" viewBox="0 0 1000 ${CAPSULE_PX}" preserveAspectRatio="none">` +
      CAPSULE_STYLE +
      `<rect class="b" width="1000" height="${CAPSULE_PX}"/>` +
      capRects(parts, total, CAP_R, total - CAP_R, midScale) +
      '</svg>',
    right: capEnd('right', capRects(parts, total, total - CAP_R, total, 1)),
  }
}

// Шеврон «›»: листает дизайны. Цвет подписей, по центру строки.
const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="12" viewBox="0 0 7 12">' +
  '<style>.c{fill:none;stroke:#898781;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}' +
  '@media (prefers-color-scheme:dark){.c{stroke:#9a9893}}</style>' +
  '<path class="c" d="M1.5 1.5L5.5 6L1.5 10.5"/></svg>'

export const TONE_FILL: Record<Tone, string> = { ok: '#2f7de1', warn: '#f59e0b', hot: '#e5484d' }

const pick = (list: readonly Limit[]) =>
  KINDS.map(kind => list.find(one => one.kind === kind)).filter(
    (one): one is Limit => one !== undefined,
  )

// Демо-варианты: проценты, сколько осталось до сброса 5 часов и какая доля недели прошла.
const DEMO = [
  { label: 'спокойно', five: 25, fiveLeftH: 3, week: 20, elapsed: 0.45 },
  { label: 'ровно', five: 55, fiveLeftH: 2.5, week: 44, elapsed: 0.45 },
  { label: 'чуть быстрее', five: 62, fiveLeftH: 2, week: 52, elapsed: 0.45 },
  { label: 'перерасход', five: 76, fiveLeftH: 1.5, week: 70, elapsed: 0.45 },
  { label: '80%+', five: 90, fiveLeftH: 1, week: 85, elapsed: 0.7 },
  { label: 'конец недели', five: 10, fiveLeftH: 4.5, week: 92, elapsed: 0.97 },
  { label: 'после сброса', five: 0, fiveLeftH: 5, week: 2, elapsed: 0.01 },
  { label: 'всё съедено', five: 100, fiveLeftH: 0.3, week: 100, elapsed: 0.8 },
]

const demoLimits = (d: (typeof DEMO)[number], nowMs: number): Limit[] => [
  { kind: 'five_hour', percentUsed: d.five, resetsAt: new Date(nowMs + d.fiveLeftH * 3600_000).toISOString() },
  { kind: 'seven_day', percentUsed: d.week, resetsAt: new Date(nowMs + (1 - d.elapsed) * WEEK_MS).toISOString() },
]

// Сохранённые показания на момент nowMs: окно, которое успело сброситься, — с нуля.
// Неделя сбрасывается по расписанию, поэтому её следующий сброс известен; у 5 часов — нет.
export const restore = (saved: unknown, nowMs: number): Limit[] => {
  const list = (saved as { list?: unknown } | null)?.list
  if (!Array.isArray(list)) return []

  return list.flatMap((raw): Limit[] => {
    const one = raw as Partial<Limit>
    if (typeof one.kind !== 'string' || typeof one.percentUsed !== 'number') return []
    const at = one.resetsAt ? Date.parse(one.resetsAt) : Number.NaN
    if (Number.isNaN(at) || at > nowMs) return [{ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt }]
    if (one.kind !== 'seven_day') return [{ kind: one.kind, percentUsed: 0 }]
    const next = at + (Math.floor((nowMs - at) / WEEK_MS) + 1) * WEEK_MS

    return [{ kind: one.kind, percentUsed: 0, resetsAt: new Date(next).toISOString() }]
  })
}

// Окна для показа на момент nowMs: устаревшие (сброс прошёл) — с нуля; окна 5 часов
// нет в данных, пока не началось новое (после долгого перерыва), — значит, оно на нуле.
export const current = (list: readonly Limit[], nowMs: number): Limit[] => {
  const fresh = pick(restore({ list }, nowMs))
  if (fresh.length > 0 && !fresh.some(one => one.kind === 'five_hour')) {
    return [{ kind: 'five_hour', percentUsed: 0 }, ...fresh]
  }

  return fresh
}

// Какое из двух показаний одного окна свежее: у которого сброс позже, а при одном
// и том же сбросе — у которого расход больше (внутри окна расход только растёт).
export const fresher = (a: Limit | undefined, b: Limit | undefined) => {
  if (!a || !b) return a ?? b
  const ta = a.resetsAt ? Date.parse(a.resetsAt) : 0
  const tb = b.resetsAt ? Date.parse(b.resetsAt) : 0
  if (ta !== tb) return ta > tb ? a : b

  return b.percentUsed > a.percentUsed ? b : a
}

// По каждому окну — свежее из двух списков.
export const mergeLimits = (a: readonly Limit[], b: readonly Limit[]): Limit[] =>
  KINDS.flatMap(kind => {
    const one = fresher(
      a.find(x => x.kind === kind),
      b.find(x => x.kind === kind),
    )
    return one ? [{ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt }] : []
  })

// Свежие показания этого чата сливаем с общими (их пишут все чаты) и сохраняем.
async function save($: EngineInterface, list: readonly Limit[]) {
  if (list.length === 0) return
  const nowMs = await $.clock.now()
  const merged = mergeLimits(restore({ list }, nowMs), restore(await $.store.get(LAST_KEY), nowMs))
  await update($, windows, () => merged)
  await $.store.set(LAST_KEY, { list: merged })
}

// Чат, в котором давно не было ответа, подтягивает показания, сохранённые другими чатами.
async function sync($: EngineInterface) {
  const nowMs = await $.clock.now()
  const mine = restore({ list: await read($, windows) }, nowMs)
  const merged = mergeLimits(mine, restore(await $.store.get(LAST_KEY), nowMs))
  if (JSON.stringify(merged) !== JSON.stringify(mine)) await update($, windows, () => merged)
  // Дизайн, выбранный в другом чате.
  const chosen = Number(await $.store.get(DESIGN_KEY))
  if (Number.isInteger(chosen) && chosen >= 0 && chosen !== (await read($, design))) await update($, design, () => chosen % DESIGNS)
}

async function tick($: EngineInterface) {
  const ms = await $.clock.now()
  await update($, now, () => ms)
}

// Полоски, у которых цвет стал тревожнее: анимация и уведомление.
async function announce($: EngineInterface, cfg: Config, before: readonly Limit[], after: readonly Limit[], nowMs: number) {
  const rose = after.filter(one => {
    const was = before.find(b => b.kind === one.kind)

    return was !== undefined && RANK[barTone(one, nowMs, cfg)] > RANK[barTone(was, nowMs, cfg)]
  })
  if (rose.length === 0) return

  if (cfg.animation) {
    const until = nowMs + FLASH_MS
    await update($, flash, current => ({ ...current, ...Object.fromEntries(rose.map(one => [one.kind, until])) }))
    $.clock.after(FLASH_MS + 100, () => void update($, flash, () => ({})))
  }
  if (cfg.notify) for (const one of rose) $.ui.toast(notice(one, barTone(one, nowMs, cfg)))
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  // Показания восстановлены из сохранённых: первое настоящее измерение — не «переход порога».
  let isRestored = false

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await tick($)
    $.clock.every(60_000, () => void tick($))
    $.clock.every(SYNC_MS, () => void sync($))

    const saved = Number(await $.store.get(RATIO_KEY))
    if (Number.isFinite(saved) && saved > 0) await update($, ratio, () => clampRatio(saved))

    const chosen = Number(await $.store.get(DESIGN_KEY))
    if (Number.isInteger(chosen) && chosen >= 0) await update($, design, () => chosen % DESIGNS)

    const usage = await $.session.usage().catch(() => null)
    const ctxPct = usage?.context.percent
    if (typeof ctxPct === 'number') await update($, ctx, () => ctxPct)
    if (usage && usage.rateLimits.length > 0) {
      await save($, usage.rateLimits)
    } else {
      const restored = restore(await $.store.get(LAST_KEY), await $.clock.now())
      if (restored.length > 0) {
        isRestored = true
        await update($, windows, () => restored)
      }
    }

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const ctxPct = e.context.percent
    if (typeof ctxPct === 'number') await update($, ctx, () => ctxPct)
    if (e.changed.includes('rateLimits')) {
      const nowMs = await $.clock.now()
      const before = pick(await read($, windows))
      await save($, e.rateLimits)
      await update($, now, () => nowMs)
      if (before.length > 0 && !isRestored) await announce($, cfg, before, pick(e.rateLimits), nowMs)
      isRestored = false
    }

    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { ratio?: number; isDone?: boolean; seam?: string; next?: boolean } | null
    if (data?.next) {
      const value = ((await read($, design)) + 1) % DESIGNS
      await update($, design, () => value)
      await $.store.set(DESIGN_KEY, value)
    }
    if (data?.seam === 'none' || data?.seam === 'near' || data?.seam === 'drag') {
      const value = data.seam
      await update($, seam, () => value)
    }
    if (typeof data?.ratio === 'number') {
      const value = clampRatio(data.ratio)
      await update($, ratio, () => value)
      if (data.isDone) await $.store.set(RATIO_KEY, value)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const nowMs = (await read($, now)) || (await $.clock.now())
    const list = current(await read($, windows), nowMs)
    if (list.length === 0) return next(e)

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const cells = Math.max(6, Math.floor((e.props.bodyColumns - 2 * (TIME_CELLS + 1) - 2) / 2))

      return (
        <Box gap={2}>
          {list.map(one => (
            <Box key={one.kind} gap={1}>
              <Text>
                {segments(one, nowMs, cfg).map(p => {
                  const n = Math.round((p.to - p.from) * cells)
                  if (p.part === 'track') return <Text dimColor>{'─'.repeat(n)}</Text>
                  if (p.part === 'pace') return <Text dimColor>{'━'.repeat(n)}</Text>

                  return <Text color={TERMINAL[p.part]}>{'━'.repeat(n)}</Text>
                })}
              </Text>
              <Text dimColor>{(caption(one, nowMs).pct + caption(one, nowMs).rest).padStart(TIME_CELLS)}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    if (e.surface !== 'desktop') return next(e)
    const { Box, Client, Svg, Text } = $.ui.resolve(e)
    const share = await read($, ratio)
    const isSeamShown = (await read($, seam)) === 'near'
    const flashes: Record<string, number> = await read($, flash)
    const shown = (await read($, design)) % DESIGNS
    const ctxPct = await read($, ctx)
    const clockMs = await $.clock.now()
    const leftPct = Math.round(share * 100)
    const labelCells = SHOW_DEMO ? 13 : 0
    // Примерно 8px на клетку, минус пиктограммы, время, подписи, шеврон и промежутки.
    const totalPx = (e.props.bodyColumns - labelCells - CHEV_CELLS) * 8 - 2 * (72 + ICON_PX + 6) - 24
    const nameOf = (one: Limit) => (one.kind === 'five_hour' ? 'Сессия' : 'Неделя')

    // Половины с перетаскиваемым стыком: внутри — полоска (дизайн 0) или капсула (дизайн 1).
    const halves = (rows: readonly Limit[], how: { hasSeam?: boolean; isDemo?: boolean; isCapsule?: boolean } = {}) =>
      rows.map((one, i) => {
        const isFirst = i === 0 && rows.length > 1
        const part = one.kind === 'five_hour' ? share : 1 - share
        const width = rows.length === 1 ? '100%' : `${one.kind === 'five_hour' ? leftPct : 100 - leftPct}%`
        const parts = segments(one, nowMs, cfg)
        const ico = ICONS[one.kind]
        const cap = caption(one, nowMs)
        const isFlashing = (flashes[one.kind] ?? 0) > clockMs
        const anim: Anim | undefined = !cfg.animation
          ? undefined
          : how.isDemo
            ? parts.some(p => p.part === 'warn' || p.part === 'hot')
              ? 'loop'
              : undefined
            : isFlashing
              ? 'once'
              : undefined
        const seamBox = isFirst && (
          <Box width={SEP_CELLS} flexShrink={0} justifyContent="center" alignItems="center">
            {how.hasSeam && isSeamShown && <Svg source={SEP_SVG} width={1} height={12} alt="Стык" />}
          </Box>
        )

        if (how.isCapsule) {
          return (
            <Box key={one.kind} width={width} alignItems="center" gap={0.5} paddingLeft={i > 0 ? SEP_CELLS : 0}>
              <Box flexGrow={1} flexShrink={1} minWidth={0} position="relative">
                {(() => {
                  const cap3 = capsuleParts(segments(one, nowMs, cfg), totalPx * part + 2 * 72)
                  return (
                    <Box alignItems="center">
                      <Svg source={cap3.left} width={CAP_R} height={CAPSULE_PX} alt="Начало капсулы" />
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Svg source={cap3.mid} height={CAPSULE_PX} alt={`${nameOf(one)}: ${Math.round(one.percentUsed)}%`} />
                      </Box>
                      <Svg source={cap3.right} width={CAP_R} height={CAPSULE_PX} alt="Конец капсулы" />
                    </Box>
                  )
                })()}
                <Box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="space-between" paddingX={1}>
                  <Text size="footnote" color="inactive">
                    {one.kind === 'five_hour' ? '5 ч' : 'Неделя'} · {cap.pct}
                  </Text>
                  <Text size="footnote" dimColor>
                    {left(one.resetsAt, nowMs)}
                  </Text>
                </Box>
              </Box>
              {seamBox}
            </Box>
          )
        }

        return (
          <Box key={one.kind} width={width} alignItems="center" gap={0.5} paddingLeft={i > 0 ? SEP_CELLS : 0}>
            {ico && (
              <Box flexShrink={0}>
                <Svg source={ico.source} width={ICON_PX} height={ICON_PX} alt={ico.alt} />
              </Box>
            )}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Svg source={barSvg(parts, totalPx * part, anim)} height={BAR_PX} alt={`${nameOf(one)}: ${Math.round(one.percentUsed)}%`} />
            </Box>
            <Box flexShrink={0}>
              <Text>
                <Text color="inactive">{cap.pct}</Text>
                <Text dimColor>{cap.rest}</Text>
              </Text>
            </Box>
            {seamBox}
          </Box>
        )
      })

    // Кольцо с подписью «9% · 4:41».
    const ring = (key: string, source: string, alt: string, text: JSX.Element) => (
      <Box key={key} alignItems="center" gap={0.5} flexShrink={0}>
        <Svg source={source} width={16} height={16} alt={alt} />
        {text}
      </Box>
    )
    const limitRings = list.map(one => {
      const cap = caption(one, nowMs)
      const time = left(one.resetsAt, nowMs)
      return ring(
        one.kind,
        ringSvg(segments(one, nowMs, cfg)),
        `${nameOf(one)}: ${Math.round(one.percentUsed)}%`,
        <Text>
          <Text color="inactive">{cap.pct}</Text>
          <Text dimColor>{time ? ` · ${time}` : ''}</Text>
        </Text>,
      )
    })
    const ctxRing =
      ctxPct >= 0
        ? ring(
            'ctx',
            ringPlainSvg(ctxPct, ctxPct >= 80 ? TONE_FILL.hot : ctxPct >= 70 ? TONE_FILL.warn : '#8f8e88'),
            `Контекст: ${ctxPct}%`,
            <Text>
              <Text dimColor>Контекст </Text>
              <Text color="inactive">{`${Math.round(ctxPct)}%`}</Text>
            </Text>,
          )
        : ring('ctx', ringPlainSvg(0, '#8f8e88'), 'Контекст: нет данных', <Text dimColor>Контекст —</Text>)

    const content =
      shown === 1 ? (
        halves(list, { hasSeam: true, isCapsule: true })
      ) : shown === 2 ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center" gap={2}>
          {limitRings}
        </Box>
      ) : shown === 3 ? (
        <Box flexGrow={1} alignItems="center" justifyContent="space-between">
          {ctxRing}
          <Box alignItems="center" gap={2}>
            {limitRings}
          </Box>
        </Box>
      ) : (
        halves(list, { hasSeam: true })
      )

    const label = (text: string) =>
      SHOW_DEMO ? (
        <Box width={labelCells} flexShrink={0}>
          <Text dimColor>{text}</Text>
        </Box>
      ) : null

    return (
      <Box flexDirection="column" gap={0.5}>
        <Box alignItems="center">
          {label('сейчас')}
          <Box position="relative" flexGrow={1} minWidth={0} alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0} alignItems="center">
              {content}
            </Box>
            <Box width={CHEV_CELLS} flexShrink={0} justifyContent="center" alignItems="center">
              <Svg source={CHEVRON_SVG} width={7} height={12} alt="Следующий вид" />
            </Box>
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client
                key="handle"
                module="./handle.tsx"
                props={{ ratio: share, canDrag: shown <= 1, chevCells: CHEV_CELLS }}
                width="100%"
                height="100%"
              />
            </Box>
          </Box>
        </Box>
        {SHOW_DEMO &&
          DEMO.map(d => (
            <Box key={d.label} alignItems="center">
              {label(d.label)}
              <Box flexGrow={1} minWidth={0}>
                {halves(demoLimits(d, nowMs), { isDemo: true })}
              </Box>
            </Box>
          ))}
      </Box>
    )
  })
}
