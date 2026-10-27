import * as THREE from 'three'

function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  draw(canvas.getContext('2d'), size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

// Brushed aluminium: a light base with thousands of fine horizontal grain lines.
export function makeBrushedTexture(size = 512) {
  return canvasTexture(size, (ctx) => {
    ctx.fillStyle = '#b9bdc3'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 2600; i++) {
      const l = 150 + Math.random() * 90
      ctx.strokeStyle = `rgba(${l}, ${l + 3}, ${l + 8}, ${0.08 + Math.random() * 0.18})`
      ctx.lineWidth = Math.random() < 0.9 ? 1 : 2
      const y = Math.random() * size
      const x = Math.random() * size
      ctx.beginPath()
      ctx.moveTo(x - size * 0.4, y)
      ctx.lineTo(x + size * 0.4, y)
      ctx.stroke()
    }
  })
}

// 2x2 twill carbon fibre: alternating tows with a soft sheen across each one.
export function makeCarbonTexture(size = 128) {
  const tex = canvasTexture(size, (ctx) => {
    const tow = size / 4
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const vertical = (row + col) % 4 < 2
        const x = col * tow
        const y = row * tow
        const g = vertical
          ? ctx.createLinearGradient(x, y, x + tow, y)
          : ctx.createLinearGradient(x, y, x, y + tow)
        g.addColorStop(0, '#111214')
        g.addColorStop(0.5, '#3a3d43')
        g.addColorStop(1, '#111214')
        ctx.fillStyle = g
        ctx.fillRect(x, y, tow, tow)
      }
    }
  })
  tex.repeat.set(3, 3)
  return tex
}
