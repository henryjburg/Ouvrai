import {
  PerspectiveCamera,
  WebGLRenderer,
  Scene,
  Color,
  LineSegments,
  LineBasicMaterial,
  PMREMGenerator,
  sRGBEncoding,
  Vector3,
  OrthographicCamera,
  Group,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { BoxLineGeometry } from 'three/examples/jsm/geometries/BoxLineGeometry';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer';
import { DisplayElement } from './DisplayElement';
import { EXRLoader } from './EXRLoader';
import { PBRMapper } from './PBRMapper';
import { RoomEnvironment } from './RoomEnvironment';
import { required } from './utils';
import { World } from 'cannon-es';

export class SceneManager {
  /**
   * three.js renderer for 3D scene
   * @type {WebGLRenderer}
   */
  renderer;
  /**
   * three.js renderer for overlaid CSS scene (created if `cfg.cssScene=true`)
   * @type {CSS2DRenderer}
   */
  cssRenderer;
  /**
   * @type {World}
   */
  physicsWorld;
  /**
   * Camera layout from configuration:
   *  0: Monocular, left
   *  1: Monocular, right
   *  2: Binocular
   * @type {number}
   */
  cameraLayout;
  /**
   * Left eye camera when in VR
   * @type {import('three').WebXRCamera}
   */
  cameraLeft;
  /**
   * Right eye camera when in VR
   * @type {import('three').WebXRCamera}
   */
  cameraRight;

  constructor({
    cfg = required('cfg'),
    toneMapping = 4, //ACESFilmicToneMapping;
    customHandleResize = false,
  }) {
    if (cfg.sceneManager === false) {
      return;
    }
    this.fixedAspect = cfg.fixedAspect;
    this.recentered = false;
    this.disableAutoRecenter = cfg.disableAutoRecenter;

    // 1. Define renderer(s)
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputEncoding = sRGBEncoding;
    this.renderer.toneMapping = toneMapping;
    document.getElementById('screen').appendChild(this.renderer.domElement);
    DisplayElement.hide(this.renderer.domElement);

    if (cfg.cssScene) {
      this.cssRenderer = new CSS2DRenderer();
      this.cssRenderer.setSize(window.innerWidth, window.innerHeight);
      this.cssRenderer.domElement.style.position = 'absolute';
      document
        .getElementById('screen')
        .appendChild(this.cssRenderer.domElement);
      DisplayElement.hide(this.cssRenderer.domElement);
      this.cssScene = new Scene();
    }

    // 2. Create a scene
    this.scene = new Scene();
    this.scene.background = new Color(cfg.backgroundColor);

    // Create a wireframe backdrop
    if (cfg.gridRoom === true) {
      let room = new LineSegments(
        new BoxLineGeometry(6, 6, 6, 5, 5, 5).translate(0, 3, 0),
        new LineBasicMaterial({ color: 'black' })
      );
      this.scene.add(room);
    }

    // Add light using an environment map
    if (cfg.environmentLighting) {
      const pmremGenerator = new PMREMGenerator(this.renderer);
      if (cfg.environmentLighting.endsWith('.js')) {
        // Option 1: Provide a pre-built Scene object (see RoomEnvironment.js)
        this.scene.environment = pmremGenerator.fromScene(
          new RoomEnvironment(0.5),
          0.04
        ).texture;
        pmremGenerator.dispose();
      } else if (
        // Option 2: Provide a .hdr or .exr image
        cfg.environmentLighting.endsWith('.exr') ||
        cfg.environmentLighting.endsWith('.hdr')
      ) {
        let envLoader;
        if (cfg.environmentLighting.endsWith('.exr')) {
          envLoader = new EXRLoader();
        } else {
          envLoader = new RGBELoader();
        }
        envLoader.load(cfg.environmentLighting, (texture) => {
          this.scene.environment =
            pmremGenerator.fromEquirectangular(texture).texture;
          pmremGenerator.dispose();
          texture.dispose();
        });
      }
    }

    if (cfg.orthographic) {
      // 2. Define camera (if not added to scene, used as default by all renderers)
      this.camera = new OrthographicCamera(-1, 1, -1, 1, 0.01, 2);
      this.camera.frustumSize = 2; // bottom top = [-1, 1], left right = [-AR, AR]
      this.renderer.toneMapping = 1; // LinearMapping (for better match to CSS colors)
    } else {
      this.camera = new PerspectiveCamera(70, 1, 0.01, 20);
    }
    if (cfg.requireVR) {
      // The purpose of the cameraGroup is to allow us to recenter the view
      this.cameraGroup = new Group();
      this.camera.position.set(0, 1.6, 1.5);
      this.cameraGroup.add(this.camera);
      this.scene.add(this.cameraGroup);
    } else {
      this.camera.position.set(0, 0, 1);
    }

    // Initial camera layout
    if ([0, 1, 2].includes(cfg.cameraLayout)) {
      this.cameraLayout = cfg.cameraLayout;
    }

    // Add resize listener
    // for consistent scene scale despite window dimensions (see also handleResize):
    // tanFOV = Math.tan(((Math.PI / 180) * camera.fov) / 2);
    // windowHeight = window.innerHeight;
    let callback = (customHandleResize || this.handleResize).bind(this);
    window.addEventListener('resize', callback);
    callback();

    // Orbit controls
    if (cfg.devOptions?.orbitControls) {
      this.orbitControls = new OrbitControls(
        this.camera,
        this.cssRenderer?.domElement || this.renderer.domElement
      );
      let targ = cfg.homePosn ?? new Vector3();
      this.orbitControls.target.set(...targ);
      this.orbitControls.update();
      this.orbitControls.listenToKeyEvents(window); // enable arrow keys
      this.orbitControls.enableDamping = true;
      this.orbitControls.keys = {
        LEFT: 'KeyA', //'ArrowLeft', //left arrow
        UP: 'KeyW', //'ArrowUp', // up arrow
        RIGHT: 'KeyD', //'ArrowRight', // right arrow
        BOTTOM: 'KeyS', //'ArrowDown' // down arrow
      };
    }

    // Prepare texture loader
    this.pbrMapper = new PBRMapper();
  }

  handleResize() {
    this.camera.aspect =
      this.fixedAspect || window.innerWidth / window.innerHeight;
    // for consistent scene scale despite window dimensions (see also constructor...)
    // camera.fov =
    //   (360 / Math.PI) *
    //   Math.atan(
    //     this.cfg.tanFOV * (window.innerHeight / this.cfg.windowHeight)
    //   );
    if (this.camera.isOrthographicCamera) {
      this.camera.left = (-this.camera.frustumSize * this.camera.aspect) / 2;
      this.camera.right = (this.camera.frustumSize * this.camera.aspect) / 2;
      this.camera.top = this.camera.frustumSize / 2;
      this.camera.bottom = -this.camera.frustumSize / 2;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.cssRenderer?.setSize(window.innerWidth, window.innerHeight);
    document.body.dispatchEvent(new Event('cameraupdate'));
  }

  setCameraLayout(layout) {
    this.cameraLayout = layout;
  }

  render() {
    this.updateCameras();
    this.orbitControls?.update();
    this.renderer.render(this.scene, this.camera);
    this.cssRenderer?.render(this.cssScene, this.camera);
    if (
      !this.recentered &&
      !this.disableAutoRecenter &&
      this.renderer.xr.isPresenting
    ) {
      this.recenter();
    }
  }

  updateCameras() {
    if (
      (!this.cameraLeft || !this.cameraRight) &&
      this.renderer.xr.getCamera().cameras.length === 2
    ) {
      // Should run once to assign cameras
      this.cameraLeft = this.renderer.xr.getCamera().cameras[0];
      this.cameraRight = this.renderer.xr.getCamera().cameras[1];
    }

    if (this.renderer.xr.getCamera().cameras.length === 2) {
      // Set the VR cameras depending on the specified layout
      if (this.cameraLayout === 0) {
        // Left camera only
        this.renderer.xr.getCamera().cameras = [this.cameraLeft];
      } else if (this.cameraLayout === 1) {
        // Right camera only
        this.renderer.xr.getCamera().cameras = [this.cameraRight];
      } else {
        this.renderer.xr.getCamera().cameras = [
          this.cameraLeft,
          this.cameraRight,
        ];
      }
    }
  }

  /**
   * Recenters the view, emulating a long-press of the Meta Quest (Oculus) button
   */
  recenter() {
    this.clearCameraOffset();
    // Get camera direction
    let camDir = this.camera.getWorldDirection(new Vector3());
    // Get camera angle with respect to world -Z
    let theta = Math.atan2(-camDir.x, -camDir.z);
    // Rotate camera group at origin so the camera faces down world -Z
    this.cameraGroup.rotateY(-theta);
    // Get XZ world vector that would bring the rotated camera to the origin
    let camVec = this.camera.getWorldPosition(new Vector3()).setY(0).negate();
    let len = camVec.length(); // store the non-normalized length
    // Transform XZ world vector into rotated camera group coordinates
    // Normalize in case it matters
    this.cameraGroup.worldToLocal(camVec).normalize();
    // Apply to cameraGroup
    this.cameraGroup.translateOnAxis(camVec, len);
    this.recentered = true;
  }

  /**
   *
   */
  clearCameraOffset() {
    // Clear
    this.cameraGroup.position.set(0, 0, 0);
    this.cameraGroup.lookAt(0, 0, 1);
  }
}
