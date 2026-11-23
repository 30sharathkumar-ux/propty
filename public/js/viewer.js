/**
 * public/js/viewer.js
 * Lazy-loaded 3D equipment viewer using Three.js procedural models.
 * No importmap; uses plain ES module import from /vendor/three.
 * Schematic models from primitives – labelled "schematic model, not a CAD scan".
 * Falls back to static text if WebGL unavailable or prefers-reduced-motion.
 */

let THREE = null;
let renderer = null;
let scene = null;
let camera = null;
let currentItem = null;
let animFrameId = null;
let orbitState = { isDragging: false, lastX: 0, lastY: 0, phi: Math.PI / 4, theta: 0, radius: 3 };
const hotspotMeshes = [];
let selectedHotspot = null;

/** Lazy-load Three.js */
async function loadThree() {
  if (THREE) { return THREE; }
  const mod = await import('/vendor/three/three.module.js');
  THREE = mod;
  return THREE;
}

/**
 * Check if WebGL is available.
 * @returns {boolean}
 */
function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch (_e) { return false; }
}

/**
 * Check if user prefers reduced motion.
 * @returns {boolean}
 */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Initialise the 3D viewer for an item.
 * @param {HTMLElement} container
 * @param {object} item
 */
export async function initViewer(container, item) {
  currentItem = item;
  container.innerHTML = '';

  const shouldUse3D = webglAvailable() && !prefersReducedMotion();

  const layout = document.createElement('div');
  layout.className = 'viewer-layout';

  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'viewer-canvas-wrapper';
  canvasWrapper.setAttribute('aria-label', '3D schematic model viewer');

  const sidebar = document.createElement('div');
  sidebar.className = 'viewer-sidebar';

  layout.appendChild(canvasWrapper);
  layout.appendChild(sidebar);
  container.appendChild(layout);

  // Schematic label
  const schematicLabel = document.createElement('p');
  schematicLabel.className = 'viewer-label';
  schematicLabel.textContent = 'Schematic model – not a CAD scan. For reference only.';
  container.appendChild(schematicLabel);

  // Build sidebar: hotspot list + usage steps
  buildSidebar(sidebar, item, shouldUse3D);

  if (!shouldUse3D) {
    // Static fallback
    const fallback = document.createElement('div');
    fallback.className = 'viewer-fallback';
    const icon = document.createElement('p');
    icon.style.fontSize = '3rem';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '📦';
    const title = document.createElement('p');
    title.textContent = item.name;
    title.style.fontWeight = '700';
    title.style.marginTop = '0.5rem';
    fallback.appendChild(icon);
    fallback.appendChild(title);
    canvasWrapper.appendChild(fallback);
    return;
  }

  // 3D canvas
  try {
    await loadThree();

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0f0f1a);

    const w = canvasWrapper.clientWidth || 500;
    const h = 350;
    renderer.setSize(w, h);
    canvasWrapper.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true'); // navigated via sidebar keyboard list

    // Scene
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    updateCamera();

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 5);
    scene.add(dirLight);

    // Build procedural model
    buildModel(scene, item);

    // Input handlers
    setupOrbitControls(canvasWrapper);

    // Render once (no continuous loop)
    renderOnce();

    // Keyboard: arrow keys rotate, +/- zoom
    canvasWrapper.setAttribute('tabindex', '0');
    canvasWrapper.addEventListener('keydown', handleCanvasKey);
    canvasWrapper.setAttribute('aria-label', '3D viewer. Use arrow keys to rotate, + and - to zoom.');

  } catch (err) {
    canvasWrapper.innerHTML = `<div class="viewer-fallback"><p>3D rendering failed: ${err.message}</p></div>`;
  }
}

function buildSidebar(sidebar, item, has3D) {
  // Part hotspots
  if (item.model3d?.parts?.length) {
    const h3 = document.createElement('h3');
    h3.textContent = 'Parts';
    sidebar.appendChild(h3);
    const ul = document.createElement('ul');
    ul.className = 'hotspot-list';
    ul.setAttribute('role', 'list');
    ul.setAttribute('aria-label', 'Equipment parts');

    for (const part of item.model3d.parts) {
      const li = document.createElement('li');
      li.className = 'hotspot-item';
      li.textContent = part.label;
      li.setAttribute('tabindex', '0');
      li.setAttribute('role', 'button');
      li.setAttribute('aria-pressed', 'false');
      li.setAttribute('aria-describedby', `part-desc-${part.id}`);
      li.dataset.partId = part.id;

      const desc = document.createElement('p');
      desc.id = `part-desc-${part.id}`;
      desc.style.fontSize = '0.75rem';
      desc.style.color = 'var(--color-text-muted)';
      desc.style.marginTop = '0.2rem';
      desc.textContent = part.description;
      li.appendChild(desc);

      li.addEventListener('click', () => selectPart(part.id, ul));
      li.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPart(part.id, ul); }
      });
      ul.appendChild(li);
    }
    sidebar.appendChild(ul);
  }

  // Usage stepper
  if (item.usageSteps?.length) {
    const h3 = document.createElement('h3');
    h3.textContent = 'How to Use';
    h3.style.marginTop = '1rem';
    sidebar.appendChild(h3);
    const stepper = document.createElement('div');
    stepper.className = 'usage-stepper';
    for (let i = 0; i < item.usageSteps.length; i++) {
      const row = document.createElement('div');
      row.className = 'stepper-step';
      const num = document.createElement('span');
      num.className = 'step-num';
      num.setAttribute('aria-hidden', 'true');
      num.textContent = String(i + 1);
      const text = document.createElement('span');
      text.textContent = item.usageSteps[i];
      row.appendChild(num);
      row.appendChild(text);
      stepper.appendChild(row);
    }
    sidebar.appendChild(stepper);
  }
}

function selectPart(partId, ul) {
  // Update aria states
  ul.querySelectorAll('.hotspot-item').forEach(li => {
    li.setAttribute('aria-pressed', li.dataset.partId === partId ? 'true' : 'false');
  });
  selectedHotspot = partId;

  // Highlight the mesh
  if (hotspotMeshes.length) {
    for (const m of hotspotMeshes) {
      if (m.userData.partId === partId) {
        m.material.emissive?.setHex(0x4f46e5);
        m.material.emissiveIntensity = 0.5;
      } else {
        m.material.emissive?.setHex(0x000000);
        m.material.emissiveIntensity = 0;
      }
    }
    renderOnce();
  }
}

// ── Procedural models ─────────────────────────────────────────────────────────

function buildModel(scene, item) {
  const kind = item.model3d?.kind ?? 'generic';
  const builders = {
    oscilloscope:      buildOscilloscope,
    '3d_printer':      build3DPrinter,
    dev_board:         buildDevBoard,
    workstation:       buildWorkstation,
    soldering_station: buildSolderingStation,
    generic:           buildGeneric,
  };
  const builder = builders[kind] ?? buildGeneric;
  builder(scene, item);
}

function buildOscilloscope(scene, item) {
  const parts = item.model3d?.parts ?? [];
  hotspotMeshes.length = 0;

  // Main body
  const bodyGeo = new THREE.BoxGeometry(2, 1.2, 0.8);
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  scene.add(body);

  // Screen
  const screenGeo = new THREE.BoxGeometry(1.2, 0.8, 0.05);
  const screenMat = new THREE.MeshLambertMaterial({ color: 0x00e5ff, emissive: 0x004060 });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.position.set(-0.2, 0.1, 0.43);
  screen.userData.partId = parts.find(p => p.id === 'screen')?.id ?? 'screen';
  scene.add(screen);
  hotspotMeshes.push(screen);

  // Knobs
  for (let i = 0; i < 3; i++) {
    const knobGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.1, 12);
    const knobMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const knob = new THREE.Mesh(knobGeo, knobMat);
    knob.position.set(0.75 + i * 0.18, 0.1, 0.43);
    knob.rotation.x = Math.PI / 2;
    knob.userData.partId = 'knobs';
    scene.add(knob);
    hotspotMeshes.push(knob);
  }

  // Probe ports
  for (let i = 0; i < 4; i++) {
    const portGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 8);
    const portMat = new THREE.MeshLambertMaterial({ color: 0xffcc00 });
    const port = new THREE.Mesh(portGeo, portMat);
    port.position.set(-0.7 + i * 0.15, -0.45, 0.43);
    port.rotation.x = Math.PI / 2;
    port.userData.partId = 'probeports';
    scene.add(port);
    hotspotMeshes.push(port);
  }
}

function build3DPrinter(scene, item) {
  hotspotMeshes.length = 0;
  const parts = item.model3d?.parts ?? [];

  // Frame
  const frameGeo = new THREE.BoxGeometry(1.5, 1.8, 0.1);
  const frameMat = new THREE.MeshLambertMaterial({ color: 0xd0d0d0, wireframe: false });
  const frame = new THREE.Mesh(frameGeo, frameMat);
  scene.add(frame);

  // Bed
  const bedGeo = new THREE.BoxGeometry(1.2, 0.05, 1.2);
  const bedMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.position.set(0, -0.5, 0);
  bed.userData.partId = 'bed';
  scene.add(bed);
  hotspotMeshes.push(bed);

  // Hotend
  const nozzleGeo = new THREE.CylinderGeometry(0.04, 0.02, 0.2, 8);
  const nozzleMat = new THREE.MeshLambertMaterial({ color: 0xcc4400 });
  const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
  nozzle.position.set(0, 0.3, 0);
  nozzle.userData.partId = 'hotend';
  scene.add(nozzle);
  hotspotMeshes.push(nozzle);
}

function buildDevBoard(scene, item) {
  hotspotMeshes.length = 0;

  // PCB
  const pcbGeo = new THREE.BoxGeometry(2, 0.05, 1.3);
  const pcbMat = new THREE.MeshLambertMaterial({ color: 0x1a7a1a });
  const pcb = new THREE.Mesh(pcbGeo, pcbMat);
  scene.add(pcb);

  // Chip / SoC
  const chipGeo = new THREE.BoxGeometry(0.5, 0.08, 0.5);
  const chipMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const chip = new THREE.Mesh(chipGeo, chipMat);
  chip.position.set(-0.3, 0.065, -0.15);
  chip.userData.partId = 'board';
  scene.add(chip);
  hotspotMeshes.push(chip);

  // USB ports
  for (let i = 0; i < 2; i++) {
    const usbGeo = new THREE.BoxGeometry(0.12, 0.08, 0.2);
    const usbMat = new THREE.MeshLambertMaterial({ color: 0x0066cc });
    const usb = new THREE.Mesh(usbGeo, usbMat);
    usb.position.set(0.9, 0.065, -0.3 + i * 0.3);
    usb.userData.partId = 'usb';
    scene.add(usb);
    hotspotMeshes.push(usb);
  }

  // Camera connectors
  const camGeo = new THREE.BoxGeometry(0.4, 0.04, 0.08);
  const camMat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
  const cam = new THREE.Mesh(camGeo, camMat);
  cam.position.set(0.1, 0.045, 0.6);
  cam.userData.partId = 'cam';
  scene.add(cam);
  hotspotMeshes.push(cam);
}

function buildWorkstation(scene, item) {
  hotspotMeshes.length = 0;

  // Tower case
  const towerGeo = new THREE.BoxGeometry(0.6, 1.8, 0.8);
  const towerMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const tower = new THREE.Mesh(towerGeo, towerMat);
  scene.add(tower);

  // GPU accent
  const gpuGeo = new THREE.BoxGeometry(0.55, 0.3, 0.6);
  const gpuMat = new THREE.MeshLambertMaterial({ color: 0x76b900, emissive: 0x1a3300 });
  const gpu = new THREE.Mesh(gpuGeo, gpuMat);
  gpu.position.set(0, 0.2, 0);
  gpu.userData.partId = 'gpu';
  scene.add(gpu);
  hotspotMeshes.push(gpu);

  // Memory slots
  for (let i = 0; i < 4; i++) {
    const ramGeo = new THREE.BoxGeometry(0.05, 0.6, 0.05);
    const ramMat = new THREE.MeshLambertMaterial({ color: 0x44aaff });
    const ram = new THREE.Mesh(ramGeo, ramMat);
    ram.position.set(-0.2 + i * 0.08, 0.5, 0);
    ram.userData.partId = 'ram';
    scene.add(ram);
    hotspotMeshes.push(ram);
  }
}

function buildSolderingStation(scene, item) {
  hotspotMeshes.length = 0;

  // Base unit
  const baseGeo = new THREE.BoxGeometry(0.8, 0.3, 0.6);
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = -0.5;
  base.userData.partId = 'station';
  scene.add(base);
  hotspotMeshes.push(base);

  // Iron handle
  const handleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 8);
  const handleMat = new THREE.MeshLambertMaterial({ color: 0x0066cc });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.position.set(0.5, 0.1, 0);
  handle.rotation.z = Math.PI / 4;
  handle.userData.partId = 'iron';
  scene.add(handle);
  hotspotMeshes.push(handle);

  // Tip
  const tipGeo = new THREE.ConeGeometry(0.02, 0.15, 6);
  const tipMat = new THREE.MeshLambertMaterial({ color: 0xcc4400 });
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.position.set(0.9, 0.5, 0);
  tip.rotation.z = -Math.PI / 4;
  tip.userData.partId = 'tip';
  scene.add(tip);
  hotspotMeshes.push(tip);
}

function buildGeneric(scene, item) {
  hotspotMeshes.length = 0;
  const parts = item.model3d?.parts ?? [];

  // Build a simple arrangement of boxes, one per part
  const palette = [0x4f46e5, 0x0369a1, 0x16a34a, 0xca8a04, 0x9d174d, 0x374151];
  for (let i = 0; i < Math.min(parts.length, 6); i++) {
    const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const mat = new THREE.MeshLambertMaterial({ color: palette[i % palette.length] });
    const mesh = new THREE.Mesh(geo, mat);
    const angle = (i / Math.max(parts.length, 1)) * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * 0.7, 0, Math.sin(angle) * 0.7);
    mesh.userData.partId = parts[i]?.id;
    scene.add(mesh);
    hotspotMeshes.push(mesh);
  }
  if (!parts.length) {
    const geo = new THREE.BoxGeometry(1, 0.6, 0.6);
    const mat = new THREE.MeshLambertMaterial({ color: 0x4f46e5 });
    scene.add(new THREE.Mesh(geo, mat));
  }
}

// ── Orbit controls (custom, no addons) ───────────────────────────────────────

function updateCamera() {
  if (!camera) { return; }
  const { phi, theta, radius } = orbitState;
  camera.position.x = radius * Math.sin(phi) * Math.cos(theta);
  camera.position.y = radius * Math.cos(phi);
  camera.position.z = radius * Math.sin(phi) * Math.sin(theta);
  camera.lookAt(0, 0, 0);
}

function setupOrbitControls(el) {
  el.addEventListener('pointerdown', e => {
    orbitState.isDragging = true;
    orbitState.lastX = e.clientX;
    orbitState.lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointerup', () => { orbitState.isDragging = false; });
  el.addEventListener('pointermove', e => {
    if (!orbitState.isDragging) { return; }
    const dx = e.clientX - orbitState.lastX;
    const dy = e.clientY - orbitState.lastY;
    orbitState.theta -= dx * 0.01;
    orbitState.phi   = Math.max(0.1, Math.min(Math.PI - 0.1, orbitState.phi + dy * 0.01));
    orbitState.lastX = e.clientX;
    orbitState.lastY = e.clientY;
    updateCamera();
    renderOnce();
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    orbitState.radius = Math.max(1, Math.min(10, orbitState.radius + e.deltaY * 0.005));
    updateCamera();
    renderOnce();
  }, { passive: false });

  // Touch pinch
  let lastDist = 0;
  el.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  });
  el.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      orbitState.radius = Math.max(1, Math.min(10, orbitState.radius - (dist - lastDist) * 0.01));
      lastDist = dist;
      updateCamera();
      renderOnce();
    }
  }, { passive: false });
}

function handleCanvasKey(e) {
  const step = 0.1;
  if (e.key === 'ArrowLeft')  { orbitState.theta -= step; }
  if (e.key === 'ArrowRight') { orbitState.theta += step; }
  if (e.key === 'ArrowUp')    { orbitState.phi = Math.max(0.1, orbitState.phi - step); }
  if (e.key === 'ArrowDown')  { orbitState.phi = Math.min(Math.PI - 0.1, orbitState.phi + step); }
  if (e.key === '+' || e.key === '=') { orbitState.radius = Math.max(1, orbitState.radius - 0.3); }
  if (e.key === '-') { orbitState.radius = Math.min(10, orbitState.radius + 0.3); }
  updateCamera();
  renderOnce();
}

function renderOnce() {
  if (!renderer || !scene || !camera) { return; }
  cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(() => {
    renderer.render(scene, camera);
  });
}

/**
 * Dispose renderer and geometries on viewer close.
 * @param {HTMLElement} _container
 */
export function disposeViewer(_container) {
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
  if (scene) {
    scene.traverse(obj => {
      if (obj.geometry) { obj.geometry.dispose(); }
      if (obj.material) {
        if (Array.isArray(obj.material)) { obj.material.forEach(m => m.dispose()); }
        else { obj.material.dispose(); }
      }
    });
    scene = null;
  }
  camera = null;
  hotspotMeshes.length = 0;
  selectedHotspot = null;
  cancelAnimationFrame(animFrameId);
}
