import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const SHOT_LENGTH = 6.5 // seconds per shot before cutting to the next

// Each shot places the camera relative to the robot (p = point on the ground under it,
// fwd/right = its heading) and says where to look and how wide the lens is.
// Every shot keeps the whole robot (about 8.5 units tall) in frame: distance is chosen
// from the lens so the body fills roughly two thirds of the picture height.
const SHOTS = [
  {
    name: 'Orbit',
    fov: 40,
    place: (p, fwd, right, t, out) => {
      const a = t * 0.16
      return out.set(p.x + Math.cos(a) * 16, p.y + 5.5, p.z + Math.sin(a) * 16)
    },
    look: (p, fwd, out) => out.set(p.x, p.y + 4, p.z),
  },
  {
    name: 'Tracking',
    fov: 42,
    place: (p, fwd, right, t, out) =>
      out.copy(p).addScaledVector(fwd, 15).addScaledVector(right, 3.5).setY(p.y + 2.2),
    look: (p, fwd, out) => out.set(p.x, p.y + 4.2, p.z),
  },
  {
    name: 'Crane',
    fov: 46,
    place: (p, fwd, right, t, out) =>
      out.copy(p).addScaledVector(fwd, -16).addScaledVector(right, 5).setY(p.y + 12 + Math.sin(t * 0.3) * 1.5),
    look: (p, fwd, out) => out.copy(p).addScaledVector(fwd, 2).setY(p.y + 3),
  },
  {
    name: 'Profile',
    fov: 38,
    place: (p, fwd, right, t, out) =>
      out.copy(p).addScaledVector(right, 16).addScaledVector(fwd, 2 + t * 0.3).setY(p.y + 4.5),
    look: (p, fwd, out) => out.set(p.x, p.y + 4.2, p.z),
  },
  {
    name: 'Ground level',
    fov: 44,
    place: (p, fwd, right, t, out) =>
      out.copy(p).addScaledVector(right, -12).addScaledVector(fwd, 7).setY(p.y + 0.9),
    look: (p, fwd, out) => out.set(p.x, p.y + 3.8, p.z),
  },
]

// Fixed views that track the robot without cutting.
const VIEWS = {
  top: {
    fov: 40,
    place: (p, fwd, right, t, out) => out.set(p.x, p.y + 26, p.z + 1.5),
    look: (p, fwd, out) => out.set(p.x, p.y + 2, p.z),
  },
  side: {
    fov: 38,
    place: (p, fwd, right, t, out) => out.copy(p).addScaledVector(right, 16).setY(p.y + 4.5),
    look: (p, fwd, out) => out.set(p.x, p.y + 4.2, p.z),
  },
}

const DIRECTED = ['top', 'side', 'cinematic']
const ALL = ['free', ...DIRECTED]

function makeRigCamera() {
  return {
    cam: new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500),
    shot: -1,
    shotStart: 0,
    snap: true,
    zoom: 1,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    wantPos: new THREE.Vector3(),
    wantLook: new THREE.Vector3(),
  }
}

// Camera rig: runs every view's camera at once so each can be shown live in its preview window,
// and drives the main camera from whichever view is selected.
//   mode: 'free' (orbit controls) | 'top' | 'side' | 'cinematic' (auto-cut shots, handheld drift)
//   previews: ref of { [mode]: DOM element } marking where each live preview is drawn
export default function CameraRig({ mode, robot, controls, onShot, zoom = 1, previews }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const rig = useMemo(
    () => ({
      ...Object.fromEntries(ALL.map((id) => [id, makeRigCamera()])),
      p: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
      freeOffset: new THREE.Vector3(9, 5, 11), // free camera position relative to its orbit target
    }),
    [],
  )

  // Shadows are rendered once per frame (for the main view) and reused by the previews.
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    return () => {
      gl.shadowMap.autoUpdate = true
    }
  }, [gl])

  useEffect(() => {
    const c = controls.current
    if (!c) return
    c.enabled = mode === 'free'
    if (mode === 'free') {
      // pick up the free camera where it was left
      camera.position.copy(c.target).add(rig.freeOffset)
      camera.fov = 40
      camera.updateProjectionMatrix()
      c.update()
    }
  }, [mode, camera, controls, rig])

  useFrame(({ clock }, dt) => {
    const s = robot.current
    const c = controls.current
    const t = clock.elapsedTime

    // ---- directed cameras follow the robot ---------------------------------
    if (s) {
      rig.p.set(s.pos.x, s.ground, s.pos.z)
      rig.fwd.set(Math.sin(s.yaw), 0, Math.cos(s.yaw))
      rig.right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw))

      for (const id of DIRECTED) {
        const r = rig[id]
        let view
        if (id === 'cinematic') {
          if (r.shot < 0 || t - r.shotStart > SHOT_LENGTH) {
            r.shot = (r.shot + 1) % SHOTS.length
            r.shotStart = t
            r.snap = true // hard cut
            onShot(SHOTS[r.shot].name)
          }
          view = SHOTS[r.shot]
        } else {
          view = VIEWS[id]
        }
        view.place(rig.p, rig.fwd, rig.right, t - r.shotStart, r.wantPos)
        view.look(rig.p, rig.fwd, r.wantLook)

        if (r.snap) {
          r.pos.copy(r.wantPos)
          r.look.copy(r.wantLook)
          r.cam.fov = view.fov
          r.snap = false
        } else {
          // damped follow so the camera lags the action like a real operator
          const k = 1 - Math.exp(-dt * 2.2)
          r.pos.lerp(r.wantPos, k)
          r.look.lerp(r.wantLook, 1 - Math.exp(-dt * 4))
          r.cam.fov += (view.fov - r.cam.fov) * k
        }

        // zoom slides the camera along its line to the subject
        r.zoom += (zoom - r.zoom) * (1 - Math.exp(-dt * 8))
        r.cam.position.subVectors(r.pos, r.look).multiplyScalar(r.zoom).add(r.look)
        if (id === 'cinematic') {
          // subtle handheld drift
          r.cam.position.x += Math.sin(t * 0.9) * 0.06
          r.cam.position.y += Math.sin(t * 1.3 + 1) * 0.04
          r.cam.position.z += Math.cos(t * 0.7) * 0.06
        }
        r.cam.lookAt(r.look)
      }
    }

    // ---- free camera: the orbit camera, kept following the robot while not in use ----
    if (c) {
      if (mode === 'free') rig.freeOffset.subVectors(camera.position, c.target)
      const free = rig.free.cam
      free.position.copy(c.target).add(rig.freeOffset)
      free.lookAt(c.target)
      free.fov = 40
    }

    // ---- main camera shows the selected view ----------------------------------
    if (mode !== 'free') {
      const active = rig[mode].cam
      camera.position.copy(active.position)
      camera.quaternion.copy(active.quaternion)
      camera.fov = active.fov
      camera.updateProjectionMatrix()
    }

    // ---- render: full window, then each live preview into its own rectangle -----
    const canvasRect = gl.domElement.getBoundingClientRect()
    gl.setScissorTest(false)
    gl.setViewport(0, 0, canvasRect.width, canvasRect.height)
    gl.shadowMap.needsUpdate = true
    gl.render(scene, camera)

    gl.setScissorTest(true)
    for (const id of ALL) {
      const el = previews.current[id]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const x = r.left - canvasRect.left
      const y = canvasRect.bottom - r.bottom
      gl.setViewport(x, y, r.width, r.height)
      gl.setScissor(x, y, r.width, r.height)
      const cam = rig[id].cam
      cam.aspect = r.width / r.height
      cam.updateProjectionMatrix()
      gl.render(scene, cam)
    }
    gl.setScissorTest(false)
    gl.setViewport(0, 0, canvasRect.width, canvasRect.height)
  }, 1)

  return null
}
