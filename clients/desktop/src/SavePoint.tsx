import { useEffect, useRef } from 'react'
import sheet from './assets/savepoint.webp'

// Pre-rendered rotation (tools/render_savepoint.py: 120 frames, 12 columns of 200 px) played at 60 fps.
// requestAnimationFrame stops while the window is hidden in the tray, so it costs nothing there.
const COLS = 12
const FRAMES = 120
const CELL = 200

export function SavePoint({ size }: { size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const img = new Image()
    img.src = sheet
    let raf = 0
    const start = performance.now()
    const draw = (now: number) => {
      const ctx = canvas.current?.getContext('2d')
      if (ctx && img.complete) {
        const f = Math.floor(((now - start) / 1000) * 60) % FRAMES
        ctx.clearRect(0, 0, size, size)
        ctx.drawImage(img, (f % COLS) * CELL, Math.floor(f / COLS) * CELL, CELL, CELL, 0, 0, size, size)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])
  return <canvas ref={canvas} width={size} height={size} style={{ width: size, height: size }} aria-hidden />
}
