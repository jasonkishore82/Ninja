import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useRef, useState } from 'react'
import Robot, { HARDWARE } from './components/Robot.jsx'
import Terrain from './components/Terrain.jsx'
import CameraRig, { FREE_DISTANCE } from './components/CinematicCamera.jsx'

const COLORS = [
  { name: 'Stone', value: null, swatch: '#8c6d4d' },
  { name: 'Black', value: '#000000', swatch: '#000000' },
  { name: 'Ivory', value: '#e9e4d4', swatch: '#e9e4d4' },
  { name: 'Crimson', value: '#a31621', swatch: '#a31621' },
  { name: 'Cobalt', value: '#1f4fb3', swatch: '#1f4fb3' },
  {
    name: 'Hardware (real parts)',
    value: HARDWARE,
    swatch: 'linear-gradient(135deg, #eef0f3, #9aa0a8 48%, #1d1e21 52%, #3a3c41)',
  },
]

// One zoom scale for every view: 1 = 100%, larger = further out.
const ZOOM_MIN = 0.35
const ZOOM_MAX = 2.5
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

const VIEWS = [
  { id: 'free', label: 'Free', key: '1' },
  { id: 'top', label: 'Top', key: '2' },
  { id: 'side', label: 'Side', key: '3' },
  { id: 'cinematic', label: 'Cinematic', key: '4' },
]

function Toggle({ label, on, onChange }) {
  return (
    <label className="toggle">
      <button
        className={`flip ${on ? 'on' : ''}`}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={(e) => {
          onChange(!on)
          e.currentTarget.blur()
        }}
      >
        <span className="knob" />
      </button>
      {label}
    </label>
  )
}

export default function App() {
  const [color, setColor] = useState(HARDWARE)
  const [dark, setDark] = useState(true)
  const [mechanics, setMechanics] = useState(true)
  const [wander, setWander] = useState(true)
  const [view, setView] = useState('cinematic')
  const cinematic = view === 'cinematic'
  const [zoom, setZoom] = useState(2.5) // camera distance multiplier, shown as 100/zoom % (2.5 = 40%)
  const [shot, setShot] = useState('')
  const bg = dark ? '#16161a' : '#f4f4f2'
  const controls = useRef()
  const robot = useRef()
  const previews = useRef({}) // live preview window per view

  // Set the zoom for every view. In free view the orbit camera is moved to the matching distance.
  const applyZoom = (z) => {
    const next = clampZoom(z)
    setZoom(next)
    const c = controls.current
    if (view === 'free' && c) {
      const offset = c.object.position.clone().sub(c.target)
      offset.setLength(FREE_DISTANCE * next)
      c.object.position.copy(c.target).add(offset)
      c.update()
    }
  }
  // factor < 1 zooms in
  const zoomBy = (factor) => applyZoom(zoom * factor)

  // the mouse wheel moves the orbit camera directly in free view: mirror its distance into the zoom value
  const syncZoomFromControls = () => {
    const c = controls.current
    if (!c || view !== 'free') return
    const z = c.object.position.distanceTo(c.target) / FREE_DISTANCE
    setZoom((prev) => (Math.abs(prev - z) > 0.005 ? z : prev))
  }
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy

  // number keys 1-4 switch camera views, +/- zoom
  useEffect(() => {
    const onKey = (e) => {
      const v = VIEWS.find((x) => x.key === e.key)
      if (v) setView(v.id)
      if (e.key === '+' || e.key === '=') zoomRef.current(0.85)
      if (e.key === '-' || e.key === '_') zoomRef.current(1.18)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // mouse wheel zooms the directed views (orbit controls handle it in free view)
  useEffect(() => {
    if (view === 'free') return
    const onWheel = (e) => zoomRef.current(e.deltaY > 0 ? 1.08 : 0.93)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [view])
  return (
    <>
      <Canvas shadows camera={{ position: [9, 8.5, 11], fov: 40 }}>
        <color attach="background" args={[bg]} />
        <hemisphereLight args={['#ffffff', '#b9a58c', dark ? 1.1 : 1.6]} />
        <Terrain dark={dark} />
        <Robot color={color} controls={controls} showMechanics={mechanics} wander={wander} stateRef={robot} />
        <OrbitControls
          ref={controls}
          target={[0, 3.5, 0]}
          maxPolarAngle={Math.PI / 2.05}
          minDistance={FREE_DISTANCE * ZOOM_MIN}
          maxDistance={FREE_DISTANCE * ZOOM_MAX}
          onChange={syncZoomFromControls}
        />
        <CameraRig mode={view} robot={robot} controls={controls} onShot={setShot} zoom={zoom} previews={previews} />
      </Canvas>
      <div className={`letterbox ${cinematic ? 'on' : ''}`}>
        <div className="shot-label">{cinematic && shot}</div>
      </div>
      <div className="topbar">
        <Toggle label="Dark" on={dark} onChange={setDark} />
        <Toggle label="Mechanics" on={mechanics} onChange={setMechanics} />
        <Toggle label="Wander" on={wander} onChange={setWander} />
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c.name}
              title={c.name}
              aria-label={c.name}
              className={`swatch ${color === c.value ? 'sel' : ''}`}
              style={{ background: c.swatch }}
              onClick={(e) => {
                setColor(c.value)
                e.currentTarget.blur()
              }}
            />
          ))}
        </div>
      </div>
      <div className="views" role="radiogroup" aria-label="Camera view">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="radio"
            aria-checked={view === v.id}
            className={`tile ${view === v.id ? 'sel' : ''}`}
            onClick={(e) => {
              setView(v.id)
              e.currentTarget.blur()
            }}
          >
            {/* transparent window: the canvas draws this view's live camera into it */}
            <span className="preview" ref={(el) => (previews.current[v.id] = el)} />
            <span className="label">
              <span className="key">{v.key}</span>
              {v.label}
            </span>
          </button>
        ))}
        <div className="zoom" aria-label="Zoom">
          <button aria-label="Zoom in" title="Zoom in (+)" onClick={(e) => (zoomBy(0.8), e.currentTarget.blur())}>
            +
          </button>
          <button
            aria-label="Reset zoom"
            title="Reset zoom"
            className="reset"
            onClick={(e) => (applyZoom(1), e.currentTarget.blur())}
          >
            {Math.round(100 / zoom)}%
          </button>
          <button aria-label="Zoom out" title="Zoom out (-)" onClick={(e) => (zoomBy(1.25), e.currentTarget.blur())}>
            {'−'}
          </button>
        </div>
      </div>
      {!cinematic && (
        <div className="hint" style={{ color: dark ? '#aaa' : '#666' }}>
          WASD / arrows to move · Shift to run · Space to jump · click the robot to shove it · 1–4 to switch view · +/− to zoom · drag to orbit · scroll to zoom
        </div>
      )}
    </>
  )
}
