const shell = document.getElementById('avatar-shell');
const canvas = document.getElementById('avatar-canvas');
const poster = document.getElementById('avatar-poster');
const statusEl = document.getElementById('avatar-status');
let runtimeFailure = '';
const isMobileLayout = window.matchMedia('(max-width: 760px)').matches;
let gl = null;
let contextError = '';
try {
  if (shell && canvas && !isMobileLayout) {
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
  }
} catch (error) {
  contextError = String(error && error.message || error);
}
function setStatus(text, detail = '') {
  if (runtimeFailure) return;
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.title = detail || text;
  }
}

function showRuntimeError(stage, error) {
  const message = String(error && error.message || error || '未知错误');
  window.__companionAvatarError = `${stage}: ${message}`;
  if (statusEl) {
    statusEl.textContent = stage;
    statusEl.title = message;
  }
  runtimeFailure = stage;
  console.error(`[companion avatar: ${stage}]`, error);
}

window.addEventListener('error', (event) => {
  if (event.filename && /avatar\.js|three|GLTFLoader/i.test(event.filename)) {
    showRuntimeError('3D脚本错误', event.message || event.error);
  }
});
window.addEventListener('unhandledrejection', (event) => {
  showRuntimeError('3D运行错误', event.reason);
});

if (shell && canvas && isMobileLayout) {
  if (statusEl) statusEl.textContent = '手机轻量模式';
} else if (shell && canvas && !gl) {
  showRuntimeError('WebGL2不可用', contextError || '当前页面未能创建 WebGL 2 上下文；此 Three.js 版本不支持 WebGL 1。');
} else if (shell && canvas) {
  if (statusEl) statusEl.textContent = '准备 3D 引擎…';
  let threeModule;
  let gltfModule;
  let vrmModule;
  try {
    setStatus('加载 Three.js…');
    threeModule = await import('/liao/vendor/three.module.js?v=20261121k');
    setStatus('加载模型加载器…');
    gltfModule = await import('/liao/vendor/GLTFLoader.js?v=20261121k');
    setStatus('加载 VRM 支持…');
    vrmModule = await import('/liao/vendor/three-vrm.module.js?v=20261121k');
  } catch (error) {
    showRuntimeError('引擎加载失败', error);
  }
  if (threeModule && gltfModule && vrmModule) {
  const THREE = threeModule;
  const { GLTFLoader } = gltfModule;
  const { VRMLoaderPlugin } = vrmModule;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  camera.position.set(0, 1.5, 1.5);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  scene.add(new THREE.HemisphereLight(0xfff7f3, 0x9c8d9c, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(1.5, 2.8, 3);
  scene.add(key);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showRuntimeError('WebGL上下文丢失', '浏览器回收了 3D 渲染上下文。');
    stopRendering();
  });

  const target = new THREE.Vector3(0, 1.3, 0);
  const clock = new THREE.Clock();
  let vrm = null;
  let modelRoot = null;
  let currentState = 'idle';
  let blinkAt = 2 + Math.random() * 3;
  let blinkLeft = 0;
  let loadFailed = false;
  let frameId = 0;
  let modelDrawn = false;
  let renderErrorShown = false;
  let modelLoadDone = false;
  // —— 视线与互动：单一控制器，每帧统一分配头/颈/胸角度 ——
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  let pointerActive = false;        // 鼠标是否在 canvas 上
  const lookTarget = new THREE.Vector3(0, 1.3, 0);  // lookAt 追的点（眼睛）
  let gazeYaw = 0, gazePitch = 0;   // 当前视线角（缓动后）
  let wantYaw = 0, wantPitch = 0;   // 本帧想要的视线角
  let wanderYaw = 0, wanderPitch = 0;// 自由浏览漂移目标
  let wanderT = 2 + Math.random() * 3;
  let interest = 0;                 // 对鼠标关注度 0~1
  let interestHold = 0;
  let pointerSpeed = 0, lastPX = 0, lastPY = 0;
  let petting = false;
  let petT = 0;
  let petMeshes = null;
  const gazeDir = new THREE.Vector3();

  function applyExpression(name, value) {
    if (vrm && vrm.expressionManager) vrm.expressionManager.setValue(name, value);
  }

  // 程序化姿态：呼吸起伏 + 手臂下垂。视线由 updateGaze 统一控制。
  let poseBones = null;
  function getPoseBones() {
    if (poseBones) return poseBones;
    if (!vrm || !vrm.humanoid) return null;
    const h = vrm.humanoid;
    const pick = (n) => { try { return h.getNormalizedBoneNode(n); } catch { return null; } };
    poseBones = {
      head: pick('head'),
      neck: pick('neck'),
      chest: pick('chest'),
      spine: pick('spine'),
      hips: pick('hips'),
      leftUpperArm: pick('leftUpperArm'),
      rightUpperArm: pick('rightUpperArm'),
    };
    return poseBones;
  }
  function animatePose(elapsed, delta, state) {
    const b = getPoseBones();
    if (!b) return;
    // 1) 呼吸：胸腔轻微起伏（绕 X 轴前后倾 + 上下位移）
    if (b.chest) {
      b.chest.rotation.x = Math.sin(elapsed * 1.4) * 0.04;
    }
    if (b.spine) {
      // 稍大幅度的缓慢摇摆，带动头发弹簧骨骼自然下垂摆动
      b.spine.rotation.x = Math.sin(elapsed * 1.4 + 0.3) * 0.02;
      b.spine.rotation.z = Math.sin(elapsed * 0.8) * 0.025;
    }
    if (b.hips) {
      b.hips.rotation.z = Math.sin(elapsed * 0.8 + 0.4) * 0.02;
    }
    // 2) 手臂：自然下垂
    if (b.leftUpperArm) {
      b.leftUpperArm.rotation.z = 1.1;
    }
    if (b.rightUpperArm) {
      b.rightUpperArm.rotation.z = -1.1;
    }
  }

  function setState(state) {
    currentState = state || 'idle';
    const labels = {
      idle: '在这里',
      listening: '在听你说',
      thinking: '想一想',
      speaking: '正在说话',
      reply: '刚刚回复',
      happy: '心情不错',
    };
    setStatus(labels[currentState] || labels.idle);
    applyExpression('happy', currentState === 'happy' ? 0.7 : 0);
  }

  window.addEventListener('companion-avatar', (event) => {
    const detail = event.detail || {};
    if (detail.state) setState(detail.state);
  });

  // —— 鼠标互动实现 ——
  function updatePointer(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pointerSpeed = Math.hypot(nx - lastPX, ny - lastPY);
    lastPX = nx; lastPY = ny;
    pointer.x = nx; pointer.y = ny;
    pointerActive = true;
  }
  function clearPointer() {
    pointerActive = false;
    petting = false;
  }
  if (canvas) {
    canvas.addEventListener('pointermove', updatePointer);
    canvas.addEventListener('pointerleave', clearPointer);
  }

  // 摸头检测：每帧悬停检测，鼠标停在头上即触发
  function detectPetting() {
    if (!vrm || !camera || !modelRoot || !pointerActive) { petting = false; return; }
    if (!petMeshes) {
      petMeshes = [];
      modelRoot.traverse((o) => { if (o.isMesh) petMeshes.push(o); });
    }
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(petMeshes, false);
    const headHit = hits.find((h) => /face|hair|head/i.test(String(h.object.name || '')));
    petting = !!headHit;
    if (petting && !window.__petLogged) {
      window.__petLogged = true;
      console.log('[avatar] 摸头命中:', headHit.object.name);
    }
  }

  // 每帧统一视线控制：头快、颈中、胸慢，按比例分配角度
  function updateGaze(elapsed, delta) {
    const b = getPoseBones();
    if (!b || !b.head) return;

    // 1) 关注度：鼠标快速移动引起注意，静止后慢慢失去兴趣
    if (pointerActive) {
      if (pointerSpeed > 0.015) {
        interest = Math.min(1, interest + pointerSpeed * 6 + 0.04);
        interestHold = 1.5;
      } else {
        interestHold -= delta;
        if (interestHold <= 0) interest = Math.max(0, interest - delta * 0.5);
      }
    } else {
      interest = Math.max(0, interest - delta * 1.2);
    }
    pointerSpeed *= 0.8;

    // 2) 想看的方向
    if (pointerActive && interest > 0.05) {
      raycaster.setFromCamera(pointer, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.4);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(plane, hit)) {
        const dx = THREE.MathUtils.clamp(hit.x, -1.2, 1.2);
        const dy = THREE.MathUtils.clamp(hit.y - 1.35, -0.8, 0.8);
        wantYaw = THREE.MathUtils.clamp(Math.atan2(dx, 0.4), -0.55, 0.55);
        wantPitch = THREE.MathUtils.clamp(Math.atan2(dy, Math.hypot(dx, 0.4)), -0.3, 0.35);
      }
    } else {
      wanderT -= delta;
      if (wanderT <= 0) {
        wanderYaw = (Math.random() * 2 - 1) * 0.3;
        wanderPitch = (Math.random() * 2 - 1) * 0.12;
        wanderT = 3 + Math.random() * 4;
      }
      wantYaw = wanderYaw;
      wantPitch = wanderPitch;
    }

    // 3) 缓动：头快、颈中、胸慢
    const easeHead = Math.min(1, delta * 4);
    const easeNeck = Math.min(1, delta * 2.5);
    const easeChest = Math.min(1, delta * 1.4);
    gazeYaw += (wantYaw - gazeYaw) * easeHead;
    gazePitch += (wantPitch - gazePitch) * easeHead;

    if (b.head) {
      b.head.rotation.y = gazeYaw;
      b.head.rotation.x = gazePitch + Math.sin(elapsed * 0.9) * 0.02;
      b.head.rotation.z = Math.sin(elapsed * 0.6) * 0.02;
    }
    if (b.neck) {
      b.neck.rotation.y += (gazeYaw * 0.4 - b.neck.rotation.y) * easeNeck;
      b.neck.rotation.x += (gazePitch * 0.35 - b.neck.rotation.x) * easeNeck;
    }
    if (b.chest) {
      b.chest.rotation.y += (gazeYaw * 0.15 - b.chest.rotation.y) * easeChest;
    }

    // 4) 眼睛：lookAt 追视线方向上的点
    gazeDir.set(
      Math.sin(gazeYaw) * Math.cos(gazePitch),
      Math.sin(gazePitch),
      Math.cos(gazeYaw) * Math.cos(gazePitch),
    );
    lookTarget.set(0, 1.35, 0).addScaledVector(gazeDir, 1.0);

    // 5) 摸头反应：开心 + 低头蹭
    detectPetting();
    if (petting) petT = Math.min(1, petT + delta * 4);
    else petT = Math.max(0, petT - delta * 3);
    if (petT > 0.01) {
      applyExpression('joy', petT * 0.7);
      applyExpression('fun', petT * 0.5);
      b.head.rotation.x += petT * 0.12;
      b.head.rotation.z += petT * 0.08 * Math.sin(elapsed * 2.5);
    } else {
      applyExpression('joy', 0);
      applyExpression('fun', 0);
    }
  }

  function resize() {
    const width = Math.max(1, shell.clientWidth);
    const height = Math.max(1, shell.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(shell);
  resize();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  setStatus('加载角色…');
  loader.load(
    '/liao/assets/avatar/AliciaSolid.vrm',
    (gltf) => {
      modelLoadDone = true;
      vrm = gltf.userData.vrm;
      modelRoot = vrm ? vrm.scene : gltf.scene;
      // 诊断 + 强力软化弹簧骨骼：让头发/辫子自然下垂摆动
      try {
        const sbm = vrm && vrm.springBoneManager;
        const jointList = sbm && sbm.joints ? Array.from(sbm.joints) : [];
        console.log('[avatar] springBoneManager 存在?', !!sbm, ' joints 数量:', jointList.length);
        if (jointList.length) {
          let n = 0;
          const before = [];
          jointList.forEach((joint, i) => {
            const st = joint.settings;
            if (st) {
              if (i < 3) before.push({ stiffness: st.stiffness, gravityPower: st.gravityPower, dragForce: st.dragForce });
              // 蝴蝶结骨骼保持硬挺，不参与软化
              const boneName = String((joint.bone && joint.bone.name) || joint.name || '');
              if (/ribbon|bow/i.test(boneName)) {
                st.stiffness = 1.5;
                st.gravityPower = 0;
                st.dragForce = 0.6;
              } else {
                st.stiffness = 0.05;    // 极低刚度 -> 软塌下垂
                st.gravityPower = 1.2;  // 强重力 -> 自然下垂
                st.dragForce = 0.35;    // 适度阻力 -> 摆动有阻尼
              }
              n++;
            }
          });
          console.log('[avatar] 已软化', n, '个弹簧关节。示例原始参数:', JSON.stringify(before));
          window.__springJointCount = n;
        } else {
          console.warn('[avatar] 模型没有弹簧骨骼（springBoneManager 为空/无关节）');
          window.__springJointCount = 0;
        }
      } catch (e) {
        console.warn('[avatar] 弹簧骨骼调整失败:', e);
      }
      if (!modelRoot) {
        loadFailed = true;
        showRuntimeError('角色解析失败', 'GLTFLoader 没有返回可显示的场景。');
        return;
      }
      modelRoot.rotation.y = Math.PI;
      const box = new THREE.Box3().setFromObject(modelRoot);
      const height = Math.max(0.1, box.max.y - box.min.y);
      window.__avatarBounds = {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        height,
      };
      shell.dataset.bounds = JSON.stringify(window.__avatarBounds);
      const scale = 1.55 / height;
      modelRoot.scale.setScalar(scale);
      modelRoot.position.y = -box.min.y * scale;
      modelRoot.traverse((object) => {
        object.visible = true;
      });
      scene.add(modelRoot);
      setStatus('模型已载入，渲染中', `Three.js r${THREE.REVISION}；模型高度 ${height.toFixed(2)}`);
    },
    (event) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.round(event.loaded / event.total * 100);
        setStatus(percent >= 100 ? '模型解码中…' : `加载角色 ${percent}%`);
      }
    },
    (error) => {
      modelLoadDone = true;
      loadFailed = true;
      showRuntimeError('角色加载失败', error);
    },
  );

  function animate() {
    frameId = requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;
    if (modelRoot) {
      const sway = currentState === 'thinking' ? 0.012 : 0.006;
      modelRoot.rotation.z = Math.sin(elapsed * 1.1) * sway;
      modelRoot.position.x = Math.sin(elapsed * 0.7) * 0.004;
      if (vrm) {
        if (currentState === 'speaking') {
          applyExpression('aa', 0.18 + (Math.sin(elapsed * 18) + 1) * 0.12);
        } else {
          applyExpression('aa', 0);
        }
        blinkAt -= delta;
        if (blinkAt <= 0) {
          blinkLeft = 0.18;
          blinkAt = 2.5 + Math.random() * 4;
        }
        if (blinkLeft > 0) {
          blinkLeft -= delta;
          applyExpression('blink', Math.min(1, blinkLeft < 0.08 ? blinkLeft / 0.08 : 1));
        } else {
          applyExpression('blink', 0);
        }
        updateGaze(elapsed, delta);
        if (vrm.lookAt && typeof vrm.lookAt.lookAt === 'function') vrm.lookAt.lookAt(lookTarget);

        // —— 程序化姿态动画（覆盖 T-pose 僵硬感）——
        animatePose(elapsed, delta, currentState);

        vrm.update(delta);
      }
    }
    camera.lookAt(target);
    try {
      renderer.render(scene, camera);
    } catch (error) {
      loadFailed = true;
      if (!renderErrorShown) {
        renderErrorShown = true;
        showRuntimeError('WebGL渲染失败', error);
      }
      stopRendering();
      return;
    }
    if (modelRoot && !modelDrawn && renderer.info.render.calls > 0) {
      modelDrawn = true;
      if (poster) poster.hidden = true;
      setStatus('3D角色已显示', `Three.js r${THREE.REVISION}；已提交 ${renderer.info.render.calls} 个绘制调用。`);
    }
  }
  function startRendering() {
    if (!frameId && !document.hidden) frameId = requestAnimationFrame(animate);
  }
  function stopRendering() {
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRendering();
    else { resize(); startRendering(); }
  });
  setTimeout(() => {
    if (!modelLoadDone && !loadFailed) {
      showRuntimeError('模型加载超时', '30 秒内没有完成 VRM 模型读取或解码。');
    } else if (modelLoadDone && !modelDrawn && !loadFailed) {
      showRuntimeError('模型未能绘制', '模型已载入，但没有产生可见的 3D 绘制调用。');
    }
  }, 30000);
  startRendering();
  window.companionAvatar = { setState, get failed() { return loadFailed; } };
  }
}
