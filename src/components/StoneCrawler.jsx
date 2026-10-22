import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { makeStoneTexture } from './stoneTexture.js'

const UP = new THREE.Vector3(0, 1, 0)
const GLOW = '#1fe27f'

// Joint positions per leg, in the leg's local frame: x = outward from the body, y = up.
// hip (on the body) -> knee (high, out to the side) -> ankle (down) -> foot (on the ground)
const LEG_PROFILE = [
  new THREE.Vector3(0.9, 2.4, 0),
  new THREE.Vector3(2.0, 2.7, 0),
  new THREE.Vector3(2.6, 1.2, 0),
  new THREE.Vector3(2.7, 0.3, 0),
]
const LEG_THICKNESS = [0.7, 0.75, 0.8]

function useStone() {
  return useMemo(() => {
    const map = makeStoneTexture()
    return new THREE.MeshStandardMaterial({
      map,
      color: '#ffffff',
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    })
  }, [])
}

// A cube stretched between two points.
function Segment({ from, to, thickness, material }) {
  const { position, quaternion, length } = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from)
    return {
      length: dir.length(),
      position: new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()),
    }
  }, [from, to])

  return (
    <mesh position={position} quaternion={quaternion} material={material} castShadow receiveShadow>
      <boxGeometry args={[thickness, length, thickness]} />
    </mesh>
  )
}

function GlowSpot({ position, size = 0.14, phase = 0 }) {
  const ref = useRef()
  useFrame(({ clock }) => {
    ref.current.material.emissiveIntensity = 0.9 + Math.sin(clock.elapsedTime * 2 + phase) * 0.5
  })
  return (
    <mesh ref={ref} position={position} rotation={[phase, phase * 2, 0]}>
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial color={GLOW} emissive={GLOW} emissiveIntensity={0.9} toneMapped={false} />
    </mesh>
  )
}

function Leg({ angle, material, phase }) {
  const joints = LEG_PROFILE
  return (
    <group rotation={[0, angle, 0]}>
      {joints.slice(0, -1).map((p, i) => (
        <Segment
          key={i}
          from={p}
          to={joints[i + 1]}
          thickness={LEG_THICKNESS[i]}
          material={material}
        />
      ))}
      {/* cube joints so the segments read as connected blocks */}
      {joints.slice(1, 3).map((p, i) => (
        <mesh key={i} position={p} material={material} castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
        </mesh>
      ))}
      {/* foot block */}
      <mesh position={[joints[3].x + 0.1, 0.18, 0]} material={material} castShadow receiveShadow>
        <boxGeometry args={[0.85, 0.36, 0.85]} />
      </mesh>
      <GlowSpot position={[joints[1].x, joints[1].y + 0.45, 0]} phase={phase} />
      <GlowSpot position={[joints[2].x + 0.36, joints[2].y + 0.2, 0.2]} size={0.11} phase={phase + 1} />
    </group>
  )
}

export default function StoneCrawler() {
  const material = useStone()
  const root = useRef()

  // gentle breathing bob
  useFrame(({ clock }) => {
    root.current.position.y = Math.sin(clock.elapsedTime * 1.2) * 0.04
  })

  const angles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]

  return (
    <group ref={root}>
      {/* diamond body: a flattened octahedron */}
      <mesh position={[0, 2.4, 0]} scale={[1.6, 1.3, 1.6]} material={material} castShadow receiveShadow>
        <octahedronGeometry args={[1, 0]} />
      </mesh>
      <GlowSpot position={[0.15, 3.55, 0.2]} size={0.2} phase={0.5} />
      <GlowSpot position={[-0.2, 3.0, 0.95]} size={0.15} phase={2} />

      {angles.map((a, i) => (
        <Leg key={i} angle={a} material={material} phase={i * 1.3} />
      ))}
    </group>
  )
}
