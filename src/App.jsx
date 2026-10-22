import { Canvas } from '@react-three/fiber'
import { OrbitControls, ContactShadows } from '@react-three/drei'
import StoneCrawler from './components/StoneCrawler.jsx'

export default function App() {
  return (
    <>
      <Canvas shadows camera={{ position: [6.5, 6, 7.5], fov: 40 }}>
        <color attach="background" args={['#f4f4f2']} />
        <hemisphereLight args={['#ffffff', '#b9a58c', 1.6]} />
        <directionalLight
          position={[5, 9, 6]}
          intensity={2.6}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <StoneCrawler />
        <ContactShadows position={[0, 0.01, 0]} opacity={0.45} scale={14} blur={2.4} far={5} />
        <OrbitControls target={[0, 1.6, 0]} maxPolarAngle={Math.PI / 2.05} minDistance={4} maxDistance={16} />
      </Canvas>
      <div className="hint">Drag to orbit · scroll to zoom</div>
    </>
  )
}
