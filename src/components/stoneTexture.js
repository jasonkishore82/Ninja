import * as THREE from 'three'

// Procedural mottled-stone texture with a few hairline cracks.
export function makeStoneTexture(size = 256) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#8c6d4d'
  ctx.fillRect(0, 0, size, size)

  const img = ctx.getImageData(0, 0, size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 38
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)

  ctx.strokeStyle = 'rgba(40, 28, 18, 0.45)'
  ctx.lineWidth = 1
  for (let c = 0; c < 7; c++) {
    let x = Math.random() * size
    let y = Math.random() * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let s = 0; s < 6; s++) {
      x += (Math.random() - 0.5) * 50
      y += (Math.random() - 0.5) * 50
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
