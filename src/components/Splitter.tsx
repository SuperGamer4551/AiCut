import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import './Splitter.css'

type Props = {
  /** A vertical bar resizes width; a horizontal bar resizes height. */
  orientation: 'vertical' | 'horizontal'
  label: string
  onStart: () => void
  onMove: (delta: number) => void
  onNudge: (delta: number) => void
}

const NUDGE_PX = 16

export function Splitter({ orientation, label, onStart, onMove, onNudge }: Props) {
  const [origin, setOrigin] = useState<number | null>(null)
  const onMoveRef = useRef(onMove)
  const vertical = orientation === 'vertical'

  onMoveRef.current = onMove

  useEffect(() => {
    if (origin === null) return

    function handleMove(event: PointerEvent) {
      // A release outside the window sends no pointerup, so treat a move with
      // no button held as the end of the drag.
      if (event.buttons === 0) {
        setOrigin(null)
        return
      }
      onMoveRef.current((vertical ? event.clientX : event.clientY) - (origin as number))
    }

    function handleUp() {
      setOrigin(null)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [origin, vertical])

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return

    event.preventDefault()
    onStart()
    setOrigin(vertical ? event.clientX : event.clientY)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp'
    const forward = vertical ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== back && event.key !== forward) return

    event.preventDefault()
    onNudge(event.key === back ? -NUDGE_PX : NUDGE_PX)
  }

  return (
    <div
      className={`splitter splitter-${orientation}${origin === null ? '' : ' is-active'}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      title={label}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
