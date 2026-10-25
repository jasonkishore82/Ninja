import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { makeStoneTexture } from './stoneTexture.js'
import { heightAt, normalAt } from './Terrain.jsx'
import { makeBrushedTexture, makeCarbonTexture } from './hardwareTextures.js'

// ---------------------------------------------------------------------------
// Dimensions (world units). The body frame origin sits at hip height.
// ---------------------------------------------------------------------------
const HIP_HEIGHT = 3.0 // hip balls above the ground at rest
const HIP_OUT = 1.5 // hip ball distance from the body centre
const FOOT_OUT = 2.7 // resting foot distance from the body centre
const UPPER = 1.6 // hip -> knee
const LOWER = 2.0 // knee -> ankle
const ANKLE_H = 0.42 // ankle ball above the sole
const JOINT_R = 0.46
const SOCKET_R = 0.66
const NECK = 0.75 // hip ball centre -> start of the upper strut

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------
const WALK = 1.8
const RUN = 3.4
const ACCEL = 6 // how fast velocity can change (units/s^2)
const TURN_RATE = 3.5 // rad/s
const STEP_HEIGHT = 0.55

// Jump: crouch to load the legs, launch, fly ballistically, absorb the landing.
const GRAVITY = 20
const JUMP_SPEED = 7.5 // take-off vertical velocity
const CROUCH_TIME = 0.16
const AIR_CONTROL = 0.15 // fraction of ground acceleration available mid-air
const SHOVE = 3.2 // velocity kick from a click on the body
const WORLD_LIMIT = 90
const SLOPE_FOLLOW = 0.6 // how much of the ground slope the body tilts with (the rest it levels out)

// Legs go round the body in order; diagonal legs (0+2, 1+3) step together (trot).
const LEG_ANGLES = [1, 3, 5, 7].map((k) => (k * Math.PI) / 4)
const outward = (a) => new THREE.Vector3(Math.cos(a), 0, -Math.sin(a))
const across = (a) => new THREE.Vector3(Math.sin(a), 0, Math.cos(a)) // horizontal, perpendicular to the leg

// Twin actuators flank each leg, set out wider than the socket rim so they never cut through it.
const MOUNT_OUT = 1.25
const MOUNT_Y = 0.55
const ACT_SPREAD = 0.85
const LEGS = LEG_ANGLES.map((a) => ({
  angle: a,
  hip: outward(a).multiplyScalar(HIP_OUT),
  rest: outward(a).multiplyScalar(FOOT_OUT),
  across: across(a),
  mounts: [-1, 1].map((side) =>
    outward(a).multiplyScalar(MOUNT_OUT).add(new THREE.Vector3(0, MOUNT_Y, 0)).addScaledVector(across(a), side * ACT_SPREAD),
  ),
}))

// Gem-cut body: flat table, crown flaring to the girdle, pavilion tapering to a flat base.
const GEM = new THREE.LatheGeometry(
  [
    new THREE.Vector2(0, -0.9),
    new THREE.Vector2(1.05, -0.9),
    new THREE.Vector2(1.75, 0.05),
    new THREE.Vector2(1.0, 0.95),
    new THREE.Vector2(0, 0.95),
  ],
  8,
)

// Head: a pentagon (point up) extruded front-to-back with soft machined bevels.
const HEAD_DEPTH = 1.3
const HEAD = (() => {
  const shape = new THREE.Shape()
  shape.moveTo(-0.95, 0)
  shape.lineTo(0.95, 0)
  shape.lineTo(1.25, 1.05)
  shape.lineTo(0, 1.85)
  shape.lineTo(-1.25, 1.05)
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: HEAD_DEPTH,
    bevelEnabled: true,
    bevelSize: 0.1,
    bevelThickness: 0.1,
    bevelSegments: 3,
  })
  geo.translate(0, 0, -HEAD_DEPTH / 2)
  return geo
})()
const HEAD_FRONT = HEAD_DEPTH / 2 + 0.1

// Stack above the gem's table (0.95): waist bearing -> torso -> neck actuator -> head.
const WAIST_Y = 1.04
const TORSO_SIZE = [2.3, 1.7, 1.5]
const TORSO_Y = 1.13 + TORSO_SIZE[1] / 2
const TORSO_TOP = 1.13 + TORSO_SIZE[1]
const HEAD_BASE = TORSO_TOP + 0.54

const UP = new THREE.Vector3(0, 1, 0)
const KEYS = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
  ShiftLeft: 'run', ShiftRight: 'run',
  Space: 'jump',
}

// scratch objects reused every frame
const _m = new THREE.Matrix4()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _a = new THREE.Vector3()

// Point obj's +Y along `axis`, with +Z as close to `hint` as possible.
function orient(obj, axis, hint) {
  _y.copy(axis).normalize()
  _x.crossVectors(_y, hint).normalize()
  _z.crossVectors(_x, _y)
  _m.makeBasis(_x, _y, _z)
  obj.quaternion.setFromRotationMatrix(_m)
}

// Stretch a unit-height mesh between two points.
function span(obj, from, to, hint) {
  _a.subVectors(to, from)
  obj.position.addVectors(from, to).multiplyScalar(0.5)
  obj.scale.set(1, _a.length(), 1)
  orient(obj, _a, hint)
}

function spring(s, key, target, k, c, dt) {
  const v = key + 'V'
  s[v] += (k * (target - s[key]) - c * s[v]) * dt
  s[key] += s[v] * dt
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const smooth = (t) => t * t * (3 - 2 * t)

export const HARDWARE = 'hardware'

// color: null keeps the stone texture, HARDWARE gives brushed aluminium, otherwise a flat solid colour.
function useStone(color) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: makeStoneTexture(),
        color: '#ffffff',
        roughness: 0.95,
        metalness: 0,
        flatShading: true,
      }),
    [],
  )
  const stone = material.map
  const brushed = useMemo(() => makeBrushedTexture(), [])
  useEffect(() => {
    const hw = color === HARDWARE
    material.map = hw ? brushed : color ? null : stone
    material.color.set(hw || !color ? '#ffffff' : color)
    material.roughness = hw ? 0.34 : color ? 0.45 : 0.95
    material.metalness = hw ? 0.85 : 0
    material.needsUpdate = true
  }, [color, material, stone, brushed])
  return material
}

// Real-parts look: clear-coated carbon fibre struts and rubber foot pads.
const CARBON = new THREE.MeshPhysicalMaterial({
  map: makeCarbonTexture(),
  roughness: 0.4,
  metalness: 0.2,
  clearcoat: 1,
  clearcoatRoughness: 0.08,
})
const METAL_2SIDED = new THREE.MeshStandardMaterial({ color: '#4a4b50', metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide })
const RUBBER = new THREE.MeshStandardMaterial({ color: '#1a1a1c', roughness: 0.95 })

// Hex-head cap screws, facing +z.
function Screws({ points }) {
  return points.map(([x, y, z], i) => (
    <mesh key={i} position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]} material={CHROME}>
      <cylinderGeometry args={[0.045, 0.045, 0.03, 6]} />
    </mesh>
  ))
}

// Machined parts: joints, pins and actuators.
const METAL = new THREE.MeshStandardMaterial({ color: '#4a4b50', metalness: 0.85, roughness: 0.32 })
const CHROME = new THREE.MeshStandardMaterial({ color: '#c9ccd2', metalness: 1, roughness: 0.15 })
const GRAPHITE = new THREE.MeshStandardMaterial({ color: '#2a2b30', metalness: 0.4, roughness: 0.55 })
const VISOR = new THREE.MeshStandardMaterial({ color: '#08090c', metalness: 0.6, roughness: 0.08 })
const ACCENT = new THREE.MeshStandardMaterial({ color: '#3b9dff', emissive: '#3b9dff', emissiveIntensity: 2, toneMapped: false })
const SOCKET_INNER = new THREE.MeshStandardMaterial({ color: '#0c0c0e', roughness: 0.9, side: THREE.DoubleSide })

// Torso: armoured core with a chest plate, side vents and a rear power pack.
function Torso({ material, real }) {
  const [w, h, d] = TORSO_SIZE
  return (
    <group position={[0, TORSO_Y, 0]}>
      <RoundedBox args={TORSO_SIZE} radius={0.16} smoothness={4} material={material} castShadow receiveShadow />
      {/* chest plate seated in a graphite recess */}
      <RoundedBox args={[1.7, 1.05, 0.06]} radius={0.025} position={[0, 0.12, d / 2]} material={GRAPHITE} />
      <RoundedBox args={[1.56, 0.92, 0.1]} radius={0.04} position={[0, 0.12, d / 2 + 0.04]} material={material} castShadow />
      <mesh position={[0, -0.5, d / 2 + 0.01]} material={ACCENT}>
        <boxGeometry args={[0.7, 0.05, 0.02]} />
      </mesh>
      {/* side cooling vents */}
      {[-1, 1].map((side) =>
        [0, 1, 2, 3].map((j) => (
          <mesh key={`${side}${j}`} position={[(side * w) / 2, 0.3 - j * 0.17, 0]} material={GRAPHITE}>
            <boxGeometry args={[0.05, 0.07, 0.9]} />
          </mesh>
        )),
      )}
      {/* rear power pack */}
      <RoundedBox args={[1.5, 1.15, 0.3]} radius={0.08} position={[0, 0.05, -d / 2 - 0.1]} material={GRAPHITE} castShadow />
      {real && (
        <>
          <Screws points={[-0.7, 0.7].flatMap((x) => [0.5, -0.26].map((y) => [x, y, d / 2 + 0.1]))} />
          <group rotation={[0, Math.PI, 0]}>
            <Screws points={[-0.64, 0.64].flatMap((x) => [0.54, -0.44].map((y) => [x, y, d / 2 + 0.26]))} />
          </group>
        </>
      )}
      {/* shoulder trim along the top edges */}
      <RoundedBox args={[w - 0.2, 0.08, d - 0.2]} radius={0.03} position={[0, h / 2 + 0.01, 0]} material={GRAPHITE} />
    </group>
  )
}

// Neck: flanged rotary actuator between torso and head.
function Neck() {
  return (
    <>
      <mesh position={[0, TORSO_TOP + 0.06, 0]} material={METAL} castShadow>
        <cylinderGeometry args={[0.55, 0.62, 0.12, 28]} />
      </mesh>
      <mesh position={[0, TORSO_TOP + 0.27, 0]} material={CHROME} castShadow>
        <cylinderGeometry args={[0.2, 0.2, 0.34, 18]} />
      </mesh>
      {[0.2, 0.32].map((y) => (
        <mesh key={y} position={[0, TORSO_TOP + y, 0]} rotation={[Math.PI / 2, 0, 0]} material={GRAPHITE}>
          <torusGeometry args={[0.24, 0.05, 8, 24]} />
        </mesh>
      ))}
      <mesh position={[0, HEAD_BASE - 0.05, 0]} material={METAL} castShadow>
        <cylinderGeometry args={[0.5, 0.5, 0.1, 28]} />
      </mesh>
    </>
  )
}

// Head: pentagon shell with a visor, a scanning eye, sensor pods and an antenna.
// AMOLED eye screen: true-black panel, glowing iris that blinks and glances where the robot is heading.
const EYE_COLOR = '#3b9dff'
const EYE_W = 160
const EYE_H = 100
function useEyeScreen(sim) {
  const screen = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = EYE_W
    canvas.height = EYE_H
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return { ctx: canvas.getContext('2d'), tex, nextBlink: 2, look: 0 }
  }, [])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const { ctx } = screen
    const s = sim.current

    // blink: a quick close/open every few seconds
    if (t > screen.nextBlink + 0.18) screen.nextBlink = t + 2.5 + Math.random() * 3
    const bt = (t - screen.nextBlink) / 0.18
    const open = bt > 0 && bt < 1 ? Math.abs(bt * 2 - 1) : 1

    // glance sideways toward the direction of travel (in head space)
    const sideways = s ? (s.vel.x * Math.cos(s.yaw) - s.vel.z * Math.sin(s.yaw)) / RUN : 0
    screen.look += (sideways - screen.look) * 0.1
    const cx = EYE_W / 2 + screen.look * 30
    const cy = EYE_H / 2

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, EYE_W, EYE_H)
    ctx.save()
    ctx.shadowColor = EYE_COLOR
    ctx.shadowBlur = 18
    ctx.fillStyle = EYE_COLOR
    ctx.beginPath()
    ctx.ellipse(cx, cy, 30, Math.max(2, 30 * open), 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    if (open > 0.3) {
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.ellipse(cx, cy, 13, 13 * open, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(cx + 9, cy - 10 * open, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    screen.tex.needsUpdate = true
  })
  return screen.tex
}

// Perforated acoustic mesh for the audio receivers: staggered holes clipped to a disc.
const MIC_MESH = (() => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#5d6067'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#060607'
  const gap = 8
  for (let row = 0, y = gap / 2; y < size; row++, y += gap * 0.866) {
    for (let x = gap / 2 + (row % 2 ? gap / 2 : 0); x < size; x += gap) {
      ctx.beginPath()
      ctx.arc(x, y, 2.3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return new THREE.MeshStandardMaterial({ map: tex, metalness: 0.6, roughness: 0.45 })
})()

// Sensor module: mounting plate, machined housing, mic mesh with a central lens, bezel and status ring.
function SensorPod() {
  return (
    <>
      <RoundedBox args={[0.64, 0.64, 0.06]} radius={0.05} position={[0, 0, 0.03]} material={GRAPHITE} castShadow />
      <mesh position={[0, 0, 0.064]} material={ACCENT}>
        <torusGeometry args={[0.36, 0.014, 6, 40]} />
      </mesh>
      <mesh position={[0, 0, 0.14]} rotation={[Math.PI / 2, 0, 0]} material={METAL} castShadow>
        <cylinderGeometry args={[0.29, 0.32, 0.16, 32]} />
      </mesh>
      <mesh position={[0, 0, 0.221]} material={MIC_MESH}>
        <circleGeometry args={[0.24, 32]} />
      </mesh>
      <mesh position={[0, 0, 0.222]} material={CHROME}>
        <torusGeometry args={[0.255, 0.03, 10, 40]} />
      </mesh>
      {/* sensor lens: dark glass in a chrome collar */}
      <mesh position={[0, 0, 0.23]} rotation={[Math.PI / 2, 0, 0]} material={CHROME}>
        <cylinderGeometry args={[0.085, 0.085, 0.03, 20]} />
      </mesh>
      <mesh position={[0, 0, 0.245]} scale={[1, 1, 0.5]} material={VISOR}>
        <sphereGeometry args={[0.065, 20, 12]} />
      </mesh>
      {/* pinhole mics on the plate corners */}
      {[[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => (
        <mesh key={`${x}${y}`} position={[x * 0.24, y * 0.24, 0.061]} material={SOCKET_INNER}>
          <circleGeometry args={[0.022, 10]} />
        </mesh>
      ))}
    </>
  )
}

function Head({ material, headRef, sim }) {
  const eyeTex = useEyeScreen(sim)
  return (
    <group ref={headRef} position={[0, HEAD_BASE, 0]}>
      <mesh geometry={HEAD} material={material} castShadow receiveShadow />
      {/* chin trim */}
      <RoundedBox args={[1.9, 0.12, HEAD_DEPTH + 0.1]} radius={0.04} position={[0, 0.02, 0]} material={GRAPHITE} />
      {/* visor */}
      <RoundedBox args={[2.0, 0.46, 0.12]} radius={0.05} position={[0, 0.95, HEAD_FRONT]} material={VISOR} />
      {/* two AMOLED display eyes set into the visor */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.46, 0.95, HEAD_FRONT + 0.065]}>
          <RoundedBox args={[0.6, 0.4, 0.03]} radius={0.04} material={GRAPHITE} />
          <mesh position={[0, 0, 0.017]}>
            <planeGeometry args={[0.54, 0.3375]} />
            <meshBasicMaterial map={eyeTex} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* side sensor modules: audio receivers plus a sensor lens, local +z facing outward */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 1.2, 0.55, 0]} rotation={[0, (side * Math.PI) / 2, 0]}>
          <SensorPod />
        </group>
      ))}
      {/* antenna on the right slope */}
      <mesh position={[0.55, 1.75, -0.2]} material={CHROME}>
        <cylinderGeometry args={[0.03, 0.03, 0.55, 8]} />
      </mesh>
      <mesh position={[0.55, 2.05, -0.2]} material={ACCENT}>
        <sphereGeometry args={[0.06, 12, 8]} />
      </mesh>
    </group>
  )
}

// The socket is part of the body; the hip ball (on the leg) sits inside it.
function Socket({ leg, material }) {
  return (
    <group rotation={[0, leg.angle, 0]}>
      <mesh position={[HIP_OUT - 0.32, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={material} castShadow receiveShadow>
        <cylinderGeometry args={[SOCKET_R + 0.14, SOCKET_R, 0.75, 16, 1, true]} />
      </mesh>
      <mesh position={[HIP_OUT - 0.32, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={SOCKET_INNER}>
        <circleGeometry args={[SOCKET_R, 16]} />
      </mesh>
      <mesh position={[HIP_OUT + 0.05, 0, 0]} rotation={[0, Math.PI / 2, 0]} material={METAL} castShadow>
        <torusGeometry args={[SOCKET_R, 0.1, 8, 20]} />
      </mesh>
      {/* actuator brackets: an arm out of the body and a clevis block on each side */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh
            position={[(0.9 + MOUNT_OUT) / 2, MOUNT_Y, (side * (0.5 + ACT_SPREAD)) / 2]}
            rotation={[0, Math.atan2(-side * (ACT_SPREAD - 0.5), MOUNT_OUT - 0.9), 0]}
            material={GRAPHITE}
            castShadow
          >
            <boxGeometry args={[Math.hypot(MOUNT_OUT - 0.9, ACT_SPREAD - 0.5) + 0.1, 0.16, 0.16]} />
          </mesh>
          <mesh position={[MOUNT_OUT, MOUNT_Y, side * ACT_SPREAD]} material={GRAPHITE} castShadow>
            <boxGeometry args={[0.3, 0.3, 0.24]} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

// Foot: ankle cup on a hub, three splayed toes with rubber pads. Origin on the ground, +z points away from the body.
const ANKLE_CUP = new THREE.SphereGeometry(0.37, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
function Foot({ shell, sole }) {
  return (
    <>
      <mesh position={[0, ANKLE_H, 0]} geometry={ANKLE_CUP} material={METAL_2SIDED} castShadow />
      <mesh position={[0, 0.16, 0]} material={shell} castShadow receiveShadow>
        <cylinderGeometry args={[0.3, 0.38, 0.2, 20]} />
      </mesh>
      <mesh position={[0, 0.03, 0]} material={sole} receiveShadow>
        <cylinderGeometry args={[0.36, 0.36, 0.06, 20]} />
      </mesh>
      {[0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3].map((a) => (
        <group key={a} rotation={[0, a, 0]}>
          <RoundedBox args={[0.26, 0.14, 0.46]} radius={0.05} position={[0, 0.12, 0.38]} material={shell} castShadow />
          <RoundedBox args={[0.3, 0.07, 0.3]} radius={0.03} position={[0, 0.035, 0.5]} material={sole} receiveShadow />
        </group>
      ))}
    </>
  )
}

function LegParts({ parts, material, strutMaterial, footMaterial }) {
  const set = (k) => (el) => (parts[k] = el)
  return (
    <>
      {/* ball-and-socket hip: free to yaw and pitch */}
      <mesh ref={set('hip')} material={METAL} castShadow>
        <sphereGeometry args={[JOINT_R, 24, 16]} />
      </mesh>
      {/* narrow neck out of the ball, thin enough to swing inside the socket opening */}
      <mesh ref={set('neck')} material={METAL} castShadow>
        <cylinderGeometry args={[0.24, 0.3, 1, 14]} />
      </mesh>
      <mesh ref={set('upper')} material={strutMaterial} castShadow receiveShadow>
        <boxGeometry args={[0.62, 1, 0.5]} />
      </mesh>
      {/* hinge knee: rotates about one axis only, like a real knee */}
      <mesh ref={set('knee')} material={METAL} castShadow>
        <cylinderGeometry args={[0.44, 0.44, 0.78, 20]} />
      </mesh>
      <mesh ref={set('kneePin')} material={CHROME}>
        <cylinderGeometry args={[0.12, 0.12, 0.98, 10]} />
      </mesh>
      <mesh ref={set('lower')} material={strutMaterial} castShadow receiveShadow>
        <boxGeometry args={[0.5, 1, 0.42]} />
      </mesh>
      {/* ankle ball lets the foot stay flat whatever the leg angle */}
      <mesh ref={set('ankle')} material={METAL} castShadow>
        <sphereGeometry args={[0.3, 18, 12]} />
      </mesh>
      {/* slim ankle neck so the lower strut doesn't swallow the ball */}
      <mesh ref={set('ankleNeck')} material={METAL} castShadow>
        <cylinderGeometry args={[0.15, 0.19, 1, 12]} />
      </mesh>
      <group ref={set('foot')}>
        <Foot shell={material} sole={footMaterial} />
      </group>
      {/* twin linear actuators: housings pivot on the body brackets, rods push a cross pin through the upper leg */}
      {[0, 1].map((j) => (
        <group key={j}>
          <mesh ref={set('housing' + j)} material={METAL} castShadow>
            <cylinderGeometry args={[0.13, 0.13, 1, 12]} />
          </mesh>
          <mesh ref={set('rod' + j)} material={CHROME} castShadow>
            <cylinderGeometry args={[0.07, 0.07, 1, 10]} />
          </mesh>
        </group>
      ))}
      <mesh ref={set('crossPin')} material={CHROME} castShadow>
        <cylinderGeometry args={[0.07, 0.07, 1, 10]} />
      </mesh>
    </>
  )
}

export default function Robot({ color = null, controls, showMechanics = false, wander = false, stateRef }) {
  const wanderRef = useRef(wander)
  wanderRef.current = wander
  const material = useStone(color)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const real = color === HARDWARE

  // Real metal needs something to reflect: a procedural studio environment, hardware style only.
  const studio = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    return tex
  }, [gl])
  // Applied per material rather than as scene.environment, which would also light up the ground.
  useEffect(() => {
    const robotMaterials = [material, METAL, METAL_2SIDED, CHROME, GRAPHITE, VISOR, CARBON, RUBBER, MIC_MESH]
    robotMaterials.forEach((m) => {
      m.envMap = real ? studio : null
      m.envMapIntensity = 0.9
      m.needsUpdate = true
    })
  }, [real, material, studio])
  const body = useRef()
  const head = useRef()
  const sun = useRef()
  const sunTarget = useRef()
  const comMarker = useRef()
  const held = useRef(new Set())
  const parts = useMemo(() => LEGS.map(() => ({})), [])
  const targetMarkers = useRef([])
  // ground reaction force on each planted foot
  const forceArrows = useMemo(
    () => LEGS.map(() => new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, '#f97316', 0.24, 0.16)),
    [],
  )

  const support = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
    return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: '#2d7ff9' }))
  }, [])

  // Simulation state lives outside React so it can update every frame.
  const sim = useRef(null)
  if (!sim.current) {
    sim.current = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      acc: new THREE.Vector3(),
      yaw: 0,
      ground: heightAt(0, 0), // smoothed terrain height under the feet
      height: 0, heightV: 0,
      phase: 'ground', // ground | crouch | air
      phaseT: 0,
      air: 0, // height of the jump above normal stance
      vy: 0,
      jumpQueued: false,
      wanderTarget: null,
      wanderWait: 0,
      wanderRun: false,
      pitch: 0, pitchV: 0,
      roll: 0, rollV: 0,
      lastGroup: 1,
      legs: LEGS.map((l) => {
        const foot = l.rest.clone()
        foot.y = heightAt(foot.x, foot.z)
        return {
          foot,
          from: new THREE.Vector3(),
          to: new THREE.Vector3(),
          target: foot.clone(),
          stepping: false,
          t: 0,
        }
      }),
    }
  }

  useEffect(() => {
    sun.current.target = sunTarget.current
    if (stateRef) stateRef.current = sim.current // lets the cinematic camera follow the robot
  }, [stateRef])

  useEffect(() => {
    const down = (e) => {
      if (KEYS[e.code]) {
        if (KEYS[e.code] === 'jump' && !e.repeat) sim.current.jumpQueued = true
        held.current.add(KEYS[e.code])
        e.preventDefault()
      }
    }
    const up = (e) => KEYS[e.code] && held.current.delete(KEYS[e.code])
    const clear = () => held.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Click the body to shove it: it gets a velocity kick and a tilt, and must step to catch itself.
  const shove = (e) => {
    e.stopPropagation()
    const s = sim.current
    if (s.phase === 'air') return
    const d = e.ray.direction.clone().setY(0).normalize()
    s.vel.addScaledVector(d, SHOVE)
    s.pitchV += d.dot(new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw))) * 3
    s.rollV -= d.dot(new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw))) * 3
    s.heightV -= 0.6
  }

  const tmp = useMemo(
    () => ({
      dir: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      step: new THREE.Vector3(),
      n: new THREE.Vector3(),
      H: new THREE.Vector3(),
      A: new THREE.Vector3(),
      K: new THREE.Vector3(),
      u: new THREE.Vector3(),
      w: new THREE.Vector3(),
      hinge: new THREE.Vector3(),
      v: new THREE.Vector3(),
      mount: new THREE.Vector3(),
      attach: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      side: new THREE.Vector3(),
      pinEnd: new THREE.Vector3(),
      rodStart: new THREE.Vector3(),
      qTilt: new THREE.Quaternion(),
      qYaw: new THREE.Quaternion(),
    }),
    [],
  )

  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const s = sim.current
    const k = held.current
    const T = tmp

    // ---- input: camera-relative direction -------------------------------
    const ix = (k.has('r') ? 1 : 0) - (k.has('l') ? 1 : 0)
    const iz = (k.has('f') ? 1 : 0) - (k.has('b') ? 1 : 0)
    T.dir.set(0, 0, 0)
    if (ix || iz) {
      camera.getWorldDirection(T.fwd)
      T.fwd.y = 0
      T.fwd.normalize()
      T.right.crossVectors(T.fwd, UP)
      T.dir.addScaledVector(T.fwd, iz).addScaledVector(T.right, ix).normalize()
      T.dir.multiplyScalar(k.has('run') ? RUN : WALK)
      s.wanderTarget = null // the player takes over; pick a fresh spot when they let go
    } else if (wanderRef.current) {
      // autonomous wander: walk to a random spot, pause, sometimes hop, repeat
      if (s.wanderWait > 0) {
        s.wanderWait -= dt
      } else if (!s.wanderTarget) {
        const a = Math.random() * Math.PI * 2
        const r = 6 + Math.random() * 22
        s.wanderTarget = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)
        s.wanderRun = Math.random() < 0.3
      } else {
        T.dir.subVectors(s.wanderTarget, s.pos).setY(0)
        const dist = T.dir.length()
        if (dist < 0.8) {
          s.wanderTarget = null
          s.wanderWait = 1 + Math.random() * 3
          T.dir.set(0, 0, 0)
          if (Math.random() < 0.25) s.jumpQueued = true
        } else {
          const cruise = s.wanderRun && dist > 6 ? RUN : WALK
          T.dir.multiplyScalar((cruise * Math.min(1, dist / 2.5)) / dist) // ease in on arrival
        }
      }
    }
    const steering = T.dir.lengthSq() > 0

    // ---- body translation: velocity chases the input with limited accel --
    T.prev.copy(s.vel)
    T.v.subVectors(T.dir, s.vel)
    const maxDv = ACCEL * dt * (s.phase === 'air' ? AIR_CONTROL : 1)
    if (T.v.length() > maxDv) T.v.setLength(maxDv)
    s.vel.add(T.v)
    T.step.copy(s.vel).multiplyScalar(dt)
    s.pos.add(T.step)
    s.pos.x = THREE.MathUtils.clamp(s.pos.x, -WORLD_LIMIT, WORLD_LIMIT)
    s.pos.z = THREE.MathUtils.clamp(s.pos.z, -WORLD_LIMIT, WORLD_LIMIT)
    T.v.subVectors(s.vel, T.prev).divideScalar(Math.max(dt, 1e-4))
    s.acc.lerp(T.v, Math.min(1, dt * 10))
    const speed = s.vel.length()

    // ---- heading: turn toward travel (only when steering, so a shove doesn't spin it)
    if (steering && speed > 0.15) {
      const diff = wrapAngle(Math.atan2(s.vel.x, s.vel.z) - s.yaw)
      s.yaw += THREE.MathUtils.clamp(diff, -TURN_RATE * dt, TURN_RATE * dt)
    }

    // ---- body attitude: lean into acceleration, partly follow the slope ---
    T.fwd.set(Math.sin(s.yaw), 0, Math.cos(s.yaw))
    T.right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw))
    normalAt(s.pos.x, s.pos.z, T.n)
    const slopeFwd = -T.n.dot(T.fwd) / T.n.y
    const slopeRight = -T.n.dot(T.right) / T.n.y
    const pitchT =
      THREE.MathUtils.clamp(s.acc.dot(T.fwd) * 0.045, -0.16, 0.16) - Math.atan(slopeFwd) * SLOPE_FOLLOW
    const rollT =
      THREE.MathUtils.clamp(-s.acc.dot(T.right) * 0.045, -0.16, 0.16) + Math.atan(slopeRight) * SLOPE_FOLLOW
    spring(s, 'pitch', pitchT, 70, 9, dt)
    spring(s, 'roll', rollT, 70, 9, dt)

    // ---- jump state machine ------------------------------------------------
    if (s.jumpQueued) {
      if (s.phase === 'ground') {
        s.phase = 'crouch'
        s.phaseT = 0
      }
      s.jumpQueued = false
    }
    s.phaseT += dt
    if (s.phase === 'crouch' && s.phaseT >= CROUCH_TIME) {
      // legs extend: launch, carrying the current run speed with it
      s.phase = 'air'
      s.vy = JUMP_SPEED
      s.heightV += 3 // spring rebounds out of the crouch
      s.legs.forEach((leg) => (leg.stepping = false))
    }
    let touchdown = false
    if (s.phase === 'air') {
      s.vy -= GRAVITY * dt
      s.air += s.vy * dt
      if (s.air <= 0) {
        s.air = 0
        s.phase = 'ground'
        s.heightV += s.vy * 0.4 // landing impact compresses the suspension
        s.pitchV += 0.6 // and rocks the body forward a touch
        s.vy = 0
        touchdown = true
      }
    }

    // ---- ground level: average terrain height under the feet ---------------
    let groundT = 0
    if (s.phase === 'air') groundT = heightAt(s.pos.x, s.pos.z)
    else s.legs.forEach((leg) => (groundT += heightAt(leg.foot.x, leg.foot.z) / s.legs.length))
    const prevGround = s.ground
    s.ground += (groundT - s.ground) * Math.min(1, dt * 8)

    // camera follows the body across the ground
    T.step.y = s.ground - prevGround
    camera.position.add(T.step)
    if (controls.current) {
      controls.current.target.add(T.step)
      controls.current.update()
    }

    // body sinks a little while two legs are in the air, deep in a crouch, and breathes when idle
    const swinging = s.legs.some((l) => l.stepping)
    const idle = 1 - Math.min(1, speed / WALK)
    let heightT = (swinging ? -0.09 : 0) + Math.sin(clock.elapsedTime * 1.6) * 0.03 * idle
    if (s.phase === 'crouch') heightT = -0.7
    const prevHeightV = s.heightV
    spring(s, 'height', heightT, 90, 11, dt)
    s.height = Math.max(s.height, -1.0) // legs bottom out
    const verticalAcc = (s.heightV - prevHeightV) / Math.max(dt, 1e-4)

    const b = body.current
    b.position.set(s.pos.x, s.ground + HIP_HEIGHT + s.height + s.air, s.pos.z)
    b.rotation.set(s.pitch, s.yaw, s.roll, 'YXZ')
    // head partly counter-rotates to stay level, like a stabilised sensor mount
    head.current.rotation.set(-s.pitch * 0.7, 0, -s.roll * 0.7)
    b.updateMatrixWorld(true)

    // ---- gait: feet stay planted until they fall too far behind ----------
    const stepTime = THREE.MathUtils.lerp(0.34, 0.2, Math.min(1, speed / RUN))
    s.legs.forEach((leg, i) => {
      // where this foot would ideally land: its rest spot, led by the velocity, on the terrain
      leg.target.copy(LEGS[i].rest).applyAxisAngle(UP, s.yaw).add(s.pos)
      leg.target.addScaledVector(s.vel, s.phase === 'air' ? 0.12 : stepTime)
      leg.target.y = heightAt(leg.target.x, leg.target.z)
    })

    if (s.phase === 'air') {
      // airborne: feet travel with the body, tucking up on the way up and reaching down to land
      const tuck = (0.7 * Math.max(0, s.vy)) / JUMP_SPEED
      const follow = Math.min(1, dt * 14)
      s.legs.forEach((leg) => {
        leg.foot.x += (leg.target.x - leg.foot.x) * follow
        leg.foot.z += (leg.target.z - leg.foot.z) * follow
        leg.foot.y += (s.ground + s.air + tuck - leg.foot.y) * follow
      })
    } else if (touchdown) {
      s.legs.forEach((leg) => (leg.foot.y = heightAt(leg.foot.x, leg.foot.z)))
    }

    if (!swinging && s.phase === 'ground') {
      const err = [0, 0]
      s.legs.forEach((leg, i) => {
        err[i % 2] = Math.max(err[i % 2], leg.foot.distanceTo(leg.target))
      })
      const threshold = speed > 0.1 ? 0.35 : 0.08
      let group = -1
      if (err[0] > threshold && err[1] > threshold) group = 1 - s.lastGroup
      else if (err[0] > threshold) group = 0
      else if (err[1] > threshold) group = 1
      if (group >= 0) {
        s.legs.forEach((leg, i) => {
          if (i % 2 !== group) return
          leg.stepping = true
          leg.t = 0
          leg.from.copy(leg.foot)
        })
      }
    }

    let landed = 0
    s.legs.forEach((leg, i) => {
      if (!leg.stepping) return
      leg.t = Math.min(1, leg.t + dt / stepTime)
      leg.to.copy(leg.target) // keep re-aiming while in the air
      leg.foot.lerpVectors(leg.from, leg.to, smooth(leg.t))
      // swing clears whatever terrain is under the foot along the way
      const base = Math.max(leg.foot.y, heightAt(leg.foot.x, leg.foot.z))
      const reach = THREE.MathUtils.clamp(leg.from.distanceTo(leg.to) / 0.8, 0.35, 1)
      leg.foot.y = base + Math.sin(Math.PI * leg.t) * STEP_HEIGHT * reach
      if (leg.t >= 1) {
        leg.foot.copy(leg.to)
        leg.stepping = false
        s.lastGroup = i % 2
        landed++
      }
    })
    if (landed) s.heightV -= 0.22 * landed // touchdown jolt through the suspension

    // ---- two-bone IK per leg ---------------------------------------------
    s.legs.forEach((leg, i) => {
      const p = parts[i]
      const def = LEGS[i]
      T.H.copy(def.hip).applyMatrix4(b.matrixWorld)
      T.A.copy(leg.foot).y += ANKLE_H

      T.v.subVectors(T.A, T.H)
      const d = THREE.MathUtils.clamp(T.v.length(), Math.abs(UPPER - LOWER) + 0.01, UPPER + LOWER - 0.01)
      T.u.copy(T.v).normalize()
      T.A.copy(T.H).addScaledVector(T.u, d) // ankle may fall short if out of reach

      // bend plane: vertical plane through hip and ankle; knee bends upward
      T.w.copy(UP).addScaledVector(T.u, -UP.dot(T.u)).normalize()
      T.hinge.crossVectors(T.u, T.w).normalize()
      const cosHip = (UPPER * UPPER + d * d - LOWER * LOWER) / (2 * UPPER * d)
      const alpha = Math.acos(THREE.MathUtils.clamp(cosHip, -1, 1))
      T.K.copy(T.H)
        .addScaledVector(T.u, Math.cos(alpha) * UPPER)
        .addScaledVector(T.w, Math.sin(alpha) * UPPER)

      p.hip.position.copy(T.H)
      orient(p.hip, T.v.subVectors(T.K, T.H), T.hinge)
      // ball -> neck -> strut: the strut only starts once clear of the socket rim
      T.rodStart.copy(T.H).addScaledVector(T.v.normalize(), NECK)
      span(p.neck, T.H, T.rodStart, T.hinge)
      span(p.upper, T.rodStart.addScaledVector(T.v, -0.05), T.K, T.hinge)
      p.knee.position.copy(T.K)
      orient(p.knee, T.hinge, T.u)
      p.kneePin.position.copy(T.K)
      p.kneePin.quaternion.copy(p.knee.quaternion)
      T.v.subVectors(T.A, T.K).normalize()
      T.mid.copy(T.A).addScaledVector(T.v, -0.42)
      span(p.lower, T.K, T.mid, T.hinge)
      span(p.ankleNeck, T.mid.addScaledVector(T.v, -0.05), T.A, T.hinge)
      p.ankle.position.copy(T.A)

      // foot sits flat on the local ground surface, toes pointing away from the body
      p.foot.position.set(T.A.x, T.A.y - ANKLE_H, T.A.z)
      normalAt(leg.foot.x, leg.foot.z, T.n)
      if (leg.stepping || s.phase === 'air') T.n.lerp(UP, 0.5).normalize()
      T.qTilt.setFromUnitVectors(UP, T.n)
      T.qYaw.setFromAxisAngle(UP, Math.atan2(T.A.x - T.H.x, T.A.z - T.H.z))
      p.foot.quaternion.copy(T.qTilt).multiply(T.qYaw)

      // twin actuators: body bracket -> cross pin halfway along the upper leg.
      // Match each bracket to the pin end on its own side of the leg.
      T.mid.lerpVectors(T.H, T.K, 0.5)
      T.side.copy(def.across).transformDirection(b.matrixWorld)
      const flip = Math.sign(T.hinge.dot(T.side)) || 1
      for (let j = 0; j < 2; j++) {
        const sideSign = j === 0 ? -1 : 1
        T.mount.copy(def.mounts[j]).applyMatrix4(b.matrixWorld)
        T.attach.copy(T.mid).addScaledVector(T.hinge, sideSign * flip * ACT_SPREAD)
        if (j === 0) T.pinEnd.copy(T.attach)
        T.v.subVectors(T.attach, T.mount)
        const len = T.v.length()
        T.v.normalize()
        T.rodStart.copy(T.mount).addScaledVector(T.v, len * 0.55)
        span(p['housing' + j], T.mount, T.rodStart, T.u)
        T.rodStart.addScaledVector(T.v, -0.2) // rod slides inside the housing
        span(p['rod' + j], T.rodStart, T.attach, T.u)
      }
      T.pinEnd.addScaledVector(T.hinge, -flip * 0.12)
      T.attach.addScaledVector(T.hinge, flip * 0.12)
      span(p.crossPin, T.pinEnd, T.attach, T.u)

      const marker = targetMarkers.current[i]
      if (marker) marker.position.set(leg.target.x, leg.target.y + 0.03, leg.target.z)
    })

    // ---- sun follows the robot so shadows stay crisp ------------------------
    sun.current.position.set(s.pos.x + 6, s.ground + 11, s.pos.z + 7)
    sunTarget.current.position.set(s.pos.x, s.ground, s.pos.z)
    sunTarget.current.updateMatrixWorld()

    // ---- mechanics overlay -------------------------------------------------
    const plantedLegs = s.phase === 'air' ? [] : s.legs.filter((l) => !l.stepping)
    const planted = plantedLegs.map((l) => l.foot)
    const attr = support.geometry.attributes.position
    planted.forEach((f, j) => attr.setXYZ(j, f.x, f.y + 0.04, f.z))
    attr.needsUpdate = true
    support.geometry.setDrawRange(0, planted.length)

    // ground reaction forces: body weight plus vertical acceleration, shared by the planted feet
    const load = Math.max(0, (GRAVITY + verticalAcc) / GRAVITY)
    s.legs.forEach((leg, i) => {
      const arrow = forceArrows[i]
      const on = plantedLegs.includes(leg)
      arrow.visible = on
      if (!on) return
      arrow.position.copy(leg.foot)
      arrow.setDirection(normalAt(leg.foot.x, leg.foot.z, T.n))
      arrow.setLength(THREE.MathUtils.clamp((0.9 * load * 4) / planted.length, 0.3, 4), 0.24, 0.16)
    })

    comMarker.current.position.set(s.pos.x, heightAt(s.pos.x, s.pos.z) + 0.04, s.pos.z)
    let stable = planted.length >= 3
    if (stable) {
      // inside a convex polygon: same side of every edge
      let sign = 0
      for (let j = 0; j < planted.length; j++) {
        const p0 = planted[j]
        const p1 = planted[(j + 1) % planted.length]
        const c = (p1.x - p0.x) * (s.pos.z - p0.z) - (p1.z - p0.z) * (s.pos.x - p0.x)
        if (sign === 0) sign = Math.sign(c)
        else if (Math.sign(c) !== sign) stable = false
      }
    }
    comMarker.current.material.color.set(stable ? '#22c55e' : planted.length === 2 ? '#f59e0b' : '#ef4444')
  })

  return (
    <>
      <directionalLight
        ref={sun}
        intensity={2.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <object3D ref={sunTarget} />

      <group
        ref={body}
        onPointerDown={shove}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <mesh geometry={GEM} material={material} castShadow receiveShadow />
        {/* waist bearing joining the gem to the torso */}
        <mesh position={[0, WAIST_Y, 0]} material={METAL} castShadow>
          <cylinderGeometry args={[0.75, 0.85, 0.18, 24]} />
        </mesh>
        <mesh position={[0, WAIST_Y + 0.02, 0]} rotation={[Math.PI / 2, 0, 0]} material={CHROME}>
          <torusGeometry args={[0.82, 0.035, 8, 32]} />
        </mesh>
        <Torso material={material} real={real} />
        <Neck />
        <Head material={material} headRef={head} sim={sim} />
        {LEGS.map((leg, i) => (
          <Socket key={i} leg={leg} material={material} />
        ))}
      </group>

      {parts.map((p, i) => (
        <LegParts
          key={i}
          parts={p}
          material={material}
          strutMaterial={real ? CARBON : material}
          footMaterial={RUBBER}
        />
      ))}

      <group visible={showMechanics}>
        <primitive object={support} />
        {forceArrows.map((a, i) => (
          <primitive key={i} object={a} />
        ))}
        <mesh ref={comMarker} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.18, 24]} />
          <meshBasicMaterial color="#22c55e" />
        </mesh>
        {LEGS.map((_, i) => (
          <mesh key={i} ref={(el) => (targetMarkers.current[i] = el)} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.22, 0.3, 24]} />
            <meshBasicMaterial color="#2d7ff9" transparent opacity={0.7} />
          </mesh>
        ))}
      </group>
    </>
  )
}
