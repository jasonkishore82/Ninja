import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

const SIZE = 200
const SEGMENTS = 400

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Raised platforms with ramped edges: [x, z, top radius, height]
const PLATFORMS = [
  [14, -6, 4, 0.9],
  [-12, 10, 5, 1.3],
  [4, 18, 3, 0.6],
  [-18, -14, 6, 1.8],
]

// Ground height at a world position. Flat around the spawn point, rolling hills further out.
export function heightAt(x, z) {
  const r = Math.hypot(x, z)
  let h =
    (0.7 * Math.sin(x * 0.16 + 1) * Math.cos(z * 0.13) +
      0.35 * Math.sin((x + z) * 0.29) +
      0.2 * Math.cos(x * 0.47 - z * 0.21)) *
    smoothstep(6, 14, r)
  for (const [px, pz, pr, ph] of PLATFORMS) {
    const ramp = Math.max(2.5, ph * 2)
    h += ph * smoothstep(pr + ramp, pr, Math.hypot(x - px, z - pz))
  }
  return h
}

// Surface normal from the height gradient.
export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.15
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e)
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)
  return out.set(-dx, 1, -dz).normalize()
}

function makeGridTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#c4c4c0'
  ctx.fillRect(0, 0, size, 2)
  ctx.fillRect(0, 0, 2, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(SIZE, SIZE) // one grid square per world unit
  tex.anisotropy = 16
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export default function Terrain({ dark }) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)))
    geo.computeVertexNormals()

    // Bake in shading so the landforms read under any lighting:
    // slopes darken, and higher ground gets a slightly warmer tint than the valleys.
    const normals = geo.attributes.normal
    const colors = new Float32Array(pos.count * 3)
    const low = new THREE.Color('#b9bcc4')
    const high = new THREE.Color('#ffffff')
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const flat = Math.pow(normals.getY(i), 6)
      const h = THREE.MathUtils.clamp((pos.getY(i) + 0.8) / 2.6, 0, 1)
      c.copy(low).lerp(high, 0.35 + 0.65 * h).multiplyScalar(0.62 + 0.38 * flat)
      colors.set([c.r, c.g, c.b], i * 3)
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geo
  }, [])
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: makeGridTexture(),
        vertexColors: true,
        roughness: 0.95,
      }),
    [],
  )
  useEffect(() => {
    material.color.set(dark ? '#45454e' : '#f2f2ee')
  }, [dark, material])

  return <mesh geometry={geometry} material={material} receiveShadow />
}
