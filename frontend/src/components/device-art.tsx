import type { ReactNode } from 'react'

export type DeviceShape = 'horizontal' | 'wide' | 'vertical' | 'vertical-small' | 'clamshell' | 'dual' | 'switch' | 'pc' | 'flashcart'

/** What a device looks like, from its firmware, its console's name and its form factor */
export function shapeOf(consoleName: string | undefined, firmwareSlug: string | undefined, formFactor?: string): DeviceShape {
  const n = (consoleName ?? '').toLowerCase()
  if (firmwareSlug?.includes('flashcart')) return 'flashcart'
  if (/switch/.test(n)) return 'switch'
  if (/\bpc\b|desktop|laptop|steam ?os/.test(n) || formFactor === 'desktop' || firmwareSlug?.includes('desktop')) return 'pc'
  if (/thor|\b(ds|dsi|3ds|2ds)\b|dual/.test(n)) return 'dual'
  if (/\bsp\b|flip|clamshell|rg35xx sp/.test(n)) return 'clamshell'
  if (/steam deck|odin|rg556|rg406|rg cube|retroid pocket (5|4)|rg40xx h|rog ally|legion go|smart pro/.test(n)) return 'wide'
  if (/miyoo mini/.test(n)) return 'vertical-small'
  if (/rg353|r36|rg40xx v|rgb30|rg nano|vertical/.test(n)) return 'vertical'
  return 'horizontal'
}

const Screen = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => <rect x={x} y={y} width={w} height={h} rx={2} className="fill-background" />
const Dpad = ({ x, y, r = 4 }: { x: number; y: number; r?: number }) => <path d={`M${x - r} ${y}h${2 * r}M${x} ${y - r}v${2 * r}`} strokeWidth={3} />
const Buttons = ({ x, y, r = 4 }: { x: number; y: number; r?: number }) => (
  <>
    <circle cx={x + r} cy={y - r / 2} r={1.8} className="fill-current" />
    <circle cx={x - r / 2} cy={y + r / 2} r={1.8} className="fill-current" />
  </>
)

const SHAPES: Record<DeviceShape, ReactNode> = {
  horizontal: (
    <>
      <rect x={10} y={16} width={76} height={34} rx={11} className="fill-muted" />
      <Screen x={34} y={21} w={28} h={22} />
      <Dpad x={22} y={33} />
      <Buttons x={74} y={33} />
    </>
  ),
  wide: (
    <>
      <rect x={3} y={14} width={90} height={38} rx={13} className="fill-muted" />
      <Screen x={25} y={18} w={46} h={28} />
      <Dpad x={14} y={26} />
      <circle cx={14} cy={41} r={3.5} />
      <Buttons x={82} y={26} />
      <circle cx={82} cy={41} r={3.5} />
    </>
  ),
  vertical: (
    <>
      <rect x={28} y={3} width={40} height={58} rx={9} className="fill-muted" />
      <Screen x={33} y={8} w={30} h={24} />
      <Dpad x={39} y={46} />
      <Buttons x={57} y={46} />
    </>
  ),
  'vertical-small': (
    <>
      <rect x={33} y={10} width={30} height={46} rx={6} className="fill-muted" />
      <Screen x={37} y={14} w={22} h={17} />
      <Dpad x={42} y={44} r={3} />
      <Buttons x={54} y={44} r={3} />
    </>
  ),
  clamshell: (
    <>
      <rect x={22} y={3} width={52} height={58} rx={7} className="fill-muted" />
      <path d="M22 31h52" />
      <Screen x={28} y={8} w={40} h={19} />
      <Dpad x={35} y={46} />
      <Buttons x={62} y={46} />
    </>
  ),
  dual: (
    <>
      <rect x={22} y={3} width={52} height={58} rx={7} className="fill-muted" />
      <path d="M22 31h52" />
      <Screen x={28} y={7} w={40} h={20} />
      <Screen x={34} y={35} w={28} h={20} />
      <Dpad x={28} y={45} r={3} />
      <Buttons x={68} y={45} r={3} />
    </>
  ),
  switch: (
    <>
      <rect x={6} y={14} width={14} height={36} rx={6} className="fill-muted" />
      <rect x={76} y={14} width={14} height={36} rx={6} className="fill-muted" />
      <rect x={22} y={14} width={52} height={36} rx={4} className="fill-muted" />
      <Screen x={26} y={18} w={44} h={28} />
      <circle cx={13} cy={26} r={2.5} />
      <circle cx={83} cy={38} r={2.5} />
    </>
  ),
  pc: (
    <>
      <rect x={14} y={6} width={68} height={40} rx={3} className="fill-muted" />
      <Screen x={18} y={10} w={60} h={32} />
      <path d="M48 46v8M34 55h28" strokeWidth={3} />
    </>
  ),
  flashcart: (
    <>
      <path d="M30 6h28l8 8v44H30z" className="fill-muted" />
      <rect x={36} y={14} width={24} height={20} rx={2} className="fill-background" />
      <path d="M38 52h20M38 47h20" strokeDasharray="2 2" />
    </>
  ),
}

/** A small drawing of the kind of device: portrait or landscape handheld, clamshell, dual screen, Switch, PC, flashcart */
export function DeviceArt({ consoleName, firmwareSlug, formFactor, className = 'h-14 w-20' }: { consoleName?: string; firmwareSlug?: string; formFactor?: string; className?: string }) {
  const shape = shapeOf(consoleName, firmwareSlug, formFactor)
  return (
    <svg viewBox="0 0 96 64" role="img" aria-label={shape} className={`shrink-0 text-muted-foreground ${className}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {SHAPES[shape]}
    </svg>
  )
}
