// ==UserScript==
// @name         IKEA IVAR Planner 3D Export
// @namespace    https://github.com/MiloParigi/IKEA-3D-Model-Download-Button
// @version      1.0.0
// @description  Exports the furniture of your IKEA IVAR planner design as OBJ + MTL + PNG textures (zip), ready for Sweet Home 3D
// @match        https://www.ikea.com/addon-app/storageone/ivar/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js#sha256=acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/MiloParigi/IKEA-3D-Model-Download-Button
// @supportURL   https://github.com/MiloParigi/IKEA-3D-Model-Download-Button/issues
// @downloadURL  https://github.com/MiloParigi/IKEA-3D-Model-Download-Button/raw/main/ikea-ivar-planner-export.user.js
// @updateURL    https://github.com/MiloParigi/IKEA-3D-Model-Download-Button/raw/main/ikea-ivar-planner-export.user.js
// ==/UserScript==

/*
 * How it works (observed on planner v16.10, Babylon.js 8.6):
 * - Babylon.js is bundled inside the planner (window.BABYLON is a stub), so the live Scene is
 *   reached through the React fiber tree of the <canvas>.
 * - Every visible part is an InstancedMesh of a hidden source Mesh: geometry is read from the
 *   source and baked with the instance's world matrix.
 * - The scene is right-handed, Y-up, in meters, like OBJ: only a x100 scale (cm) is applied.
 * - Furniture is told apart from the room through the planner's product entities, with a
 *   fallback on Babylon layer masks.
 * - Read-only: the script only reads objects already in memory and never calls IKEA services.
 */
(function () {
  'use strict';

  const VERSION = typeof GM_info !== 'undefined' ? GM_info.script.version : 'dev';
  const ZIP_NAME = 'IVAR-export.zip';
  const OBJ_NAME = 'IVAR.obj';
  const MTL_NAME = 'IVAR.mtl';
  const CM_PER_METER = 100;
  const MIN_ALPHA = 0.5; // below this a mesh is a picking helper or a ghost preview, not furniture
  // Babylon layer masks used by the planner
  const LAYER_MAIN = 0x1;
  const LAYER_PRODUCT = 0x2;
  const LAYER_UI = 0x4;

  const FRENCH = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('fr');
  const TEXT = FRENCH
    ? {
        button: 'Exporter 3D',
        includeRoom: 'Inclure la pièce',
        working: 'Export 3D en cours…',
        done: (s) => `${ZIP_NAME} téléchargé : ${s.furniture} pièces de mobilier${s.room ? ` + ${s.room} éléments de pièce` : ''}, ${s.textures} textures.`,
        unreadableTextures: (n) => ` ${n} texture(s) illisible(s), remplacée(s) par leur couleur.`,
        noScene: 'Scène 3D introuvable. Attendez la fin du chargement du planificateur puis réessayez.',
        noFurniture: 'Aucun meuble visible dans la scène.',
        failed: 'Échec de l’export 3D : ',
      }
    : {
        button: 'Export 3D',
        includeRoom: 'Include room',
        working: 'Exporting 3D…',
        done: (s) => `${ZIP_NAME} downloaded: ${s.furniture} furniture parts${s.room ? ` + ${s.room} room parts` : ''}, ${s.textures} textures.`,
        unreadableTextures: (n) => ` ${n} texture(s) could not be read and were replaced by their color.`,
        noScene: 'No 3D scene found. Wait for the planner to finish loading, then try again.',
        noFurniture: 'No visible furniture in the scene.',
        failed: '3D export failed: ',
      };

  const safe = (fn, fallback = null) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const isBabylon = (obj, className) => safe(() => obj.getClassName() === className, false);

  function userError(message) {
    const error = new Error(message);
    error.userFacing = true;
    return error;
  }

  // ---------------------------------------------------------------------------
  // Finding the scene and the planner core
  // ---------------------------------------------------------------------------

  function canvasFibers() {
    const fibers = [];
    for (const canvas of document.querySelectorAll('canvas')) {
      const key = Object.keys(canvas).find((k) => k.startsWith('__reactFiber$'));
      if (key) fibers.push(canvas[key]);
    }
    return fibers;
  }

  // Breadth-first search of an object graph. Babylon objects are tested but never walked into:
  // their graphs are huge and the scene is always reachable through the app's own objects.
  function searchGraph(roots, maxDepth, test) {
    const seen = new WeakSet();
    let level = roots;
    for (let depth = 0; depth <= maxDepth && level.length; depth++) {
      const next = [];
      for (const obj of level) {
        if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node || obj === window) continue;
        seen.add(obj);
        const hit = safe(() => test(obj));
        if (hit) return hit;
        if (depth === maxDepth || typeof obj.getClassName === 'function') continue;
        for (const key of safe(() => Object.keys(obj), []).slice(0, 150)) {
          if (key === 'return' || key === '_owner' || key.startsWith('__react')) continue;
          const value = safe(() => obj[key]);
          if (value && typeof value === 'object') next.push(value);
        }
      }
      level = next;
    }
    return null;
  }

  function stateRootsAround(fiber) {
    const roots = [];
    for (let depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
      roots.push(fiber.memoizedProps);
      for (let hook = fiber.memoizedState, i = 0; hook && typeof hook === 'object' && i < 60; hook = hook.next, i++) {
        roots.push(hook.memoizedState);
      }
    }
    return roots;
  }

  // Returns { scene, viewer }. `viewer` is IKEA's wrapper around Babylon, which knows the
  // materials and objects; it can be null if only a bare Babylon scene is found.
  function findScene() {
    const roots = canvasFibers().flatMap(stateRootsAround);
    const viewerHit = searchGraph(roots, 3, (obj) =>
      obj.viewer_scene && isBabylon(obj._scene, 'Scene') ? { scene: obj._scene, viewer: obj } : null,
    );
    if (viewerHit) return viewerHit;
    return searchGraph(roots, 4, (obj) => {
      if (isBabylon(obj, 'Scene')) return { scene: obj, viewer: null };
      if (Array.isArray(obj.scenes) && isBabylon(obj.scenes[0], 'Scene')) return { scene: obj.scenes[0], viewer: null };
      return null;
    });
  }

  // The planner core holds the product entities (article numbers, catalog descriptions).
  function findPlannerCore() {
    let root = canvasFibers()[0];
    if (!root) return null;
    while (root.return) root = root.return;
    const asCore = (value) => (typeof value?.entities?.getViewerSceneObjectsForEntity === 'function' ? value : null);
    const stack = [root];
    for (let visited = 0; stack.length && visited < 20000; visited++) {
      const fiber = stack.pop();
      const candidates = [fiber.memoizedProps?.value];
      for (let hook = fiber.memoizedState, i = 0; hook && typeof hook === 'object' && i < 60; hook = hook.next, i++) {
        const state = hook.memoizedState;
        candidates.push(state, state?.current, Array.isArray(state) ? state[0] : null);
      }
      for (const candidate of candidates) {
        const core = safe(() => asCore(candidate));
        if (core) return core;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Selecting and naming parts
  // ---------------------------------------------------------------------------

  function describeProduct(entry, ref, type, article) {
    const dto = entry?.dto;
    // Side units and braces have no description: fall back to the catalog type. Their catalog
    // sizes describe the slot rather than the part, so they are left out; the article number
    // identifies the exact product.
    const label =
      String(dto?.desc ?? '').replace(/\bNNN\b\s*/g, '').trim() ||
      `${entry?.prefix ?? ''} ${String(dto?.type ?? type ?? 'part').replace(/-/g, ' ')}`.trim();
    return { label, article: String(dto?.dexf ?? article ?? ref).replace(/^[A-Z]+-/, '') };
  }

  // Map<IKEA SceneObject, { label, article }> for every object belonging to a product
  function buildProductIndex(core) {
    const index = new Map();
    if (!core) return index;
    const entities = core.entities;
    const dtoById = new Map();
    const dtoByModel = new Map();
    for (const [range, catalog] of Object.entries(core.catalogs ?? {})) {
      const prefix = /^[a-z]+$/.test(range) ? range.toUpperCase() : '';
      for (const dto of safe(() => catalog.productDTOs(), [])) {
        const entry = { dto, prefix };
        if (dto?.id && !dtoById.has(dto.id)) dtoById.set(dto.id, entry);
        if (dto?.modelURI && !dtoByModel.has(dto.modelURI)) dtoByModel.set(dto.modelURI, entry);
      }
    }
    for (const entity of safe(() => [...entities.getAll()], [])) {
      const ref = safe(() => entities.getProductRef(entity));
      if (!ref) continue;
      const type = safe(() => entities.getProductType(entity));
      const article = safe(() => entities.getGlobalArticleNumber(entity));
      for (const sceneObject of safe(() => [...entities.getViewerSceneObjectsForEntity(entity)], [])) {
        if (!sceneObject || index.has(sceneObject)) continue;
        // A section owns its side units and braces: name each part after its own model first
        const entry = dtoByModel.get(sceneObject._mesh_url) ?? dtoById.get(ref);
        index.set(sceneObject, describeProduct(entry, ref, type, article));
      }
    }
    return index;
  }

  function fallbackLabel(mesh, owner, isFurniture) {
    if (isFurniture) {
      const name = String(safe(() => owner.sceneObject.name, ''));
      return name.replace(/\s*\(id: \d+\)$/, '').replace(/\.glb$/i, '') || mesh.name;
    }
    const material = String(mesh.material?.name ?? '').replace(/^Deferred loaded:\s*/, '').replace(/_instance$/, '');
    return `room ${!material || /Betrakta|Unlit|Material/.test(material) ? 'surface' : material}`;
  }

  // Reads a Babylon Color/Vector or one of IKEA's sRGB wrappers, which keep linear values in
  // `target` and convert them in their r/g/b getters: never read `target` directly.
  function rgbaOf(color) {
    if (!color || typeof color !== 'object') return null;
    const pick = (...keys) => keys.map((k) => color[k]).find((v) => typeof v === 'number');
    const r = pick('r', 'x', '_x');
    if (r === undefined) return null;
    return [r, pick('g', 'y', '_y') ?? r, pick('b', 'z', '_z') ?? r, pick('a', 'w', '_w') ?? 1];
  }

  const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function collectParts({ scene, viewer }, core, includeRoom) {
    const owners = new Map(); // Babylon mesh -> { sceneObject, meshInstance } (IKEA viewer objects)
    for (const sceneObject of safe(() => [...viewer.viewer_scene.scene_objects], [])) {
      safe(() =>
        sceneObject.asset_instance?.instance_iterator((meshInstance) => {
          const babylonMesh = meshInstance._babylon_instance ?? safe(() => meshInstance._internal_babylon_instance);
          if (babylonMesh) owners.set(babylonMesh, { sceneObject, meshInstance });
        }),
      );
    }
    const products = buildProductIndex(core);

    const parts = [];
    for (const mesh of scene.meshes) {
      if (!mesh.isEnabled() || !(mesh.getTotalVertices() > 0)) continue;
      if (!(mesh.layerMask & LAYER_MAIN) || mesh.layerMask & LAYER_UI) continue;
      if (/Lines/.test(mesh.getClassName())) continue; // line indices are not triangles
      const owner = owners.get(mesh);
      const material = safe(() => owner.meshInstance.get_custom_material().value) ?? mesh.material;
      if ((material?.alpha ?? 1) < MIN_ALPHA || mesh.visibility < MIN_ALPHA) continue;
      const product = owner ? products.get(owner.sceneObject) : null;
      const isFurniture = Boolean(product) || (mesh.layerMask & LAYER_PRODUCT) !== 0;
      if (isFurniture) {
        // What you see is what you export: parts hidden in the planner are skipped
        if (!mesh.isVisible || safe(() => owner.sceneObject.visible) === false) continue;
      } else if (!includeRoom) {
        continue;
      }
      // Room meshes are kept even when hidden: the planner hides the wall facing the camera
      parts.push({
        mesh,
        material,
        tint: rgbaOf(safe(() => owner.sceneObject._base_color_srgb_roughness_factor)),
        label: product?.label ?? fallbackLabel(mesh, owner, isFurniture),
        article: product?.article ?? null,
        isFurniture,
      });
    }
    // Furniture first, so materials and textures are named after furniture parts
    return parts.sort((a, b) => b.isFurniture - a.isFurniture);
  }

  // ---------------------------------------------------------------------------
  // Materials and textures
  // ---------------------------------------------------------------------------

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const fmt = (value, digits) => {
    const rounded = Number(value.toFixed(digits));
    return rounded === 0 || !Number.isFinite(rounded) ? '0' : String(rounded);
  };
  const slug = (text) =>
    String(text)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9.-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'part';

  function diffuseTextureOf(material) {
    return (
      safe(() => material._betrakta_textures.get('diffuseTexture').value) ??
      material?.albedoTexture ??
      material?.diffuseTexture ??
      null
    );
  }

  function uvTransformOf(material) {
    const sampler = safe(() => material.base_color_sampler);
    const transform = sampler?._uv_transform;
    return {
      kind: sampler?.uv_set === 1 ? 'uv2' : 'uv',
      row0: transform?._row0 ?? { x: 1, y: 0, z: 0 },
      row1: transform?._row1 ?? { x: 0, y: 1, z: 0 },
    };
  }

  // Reads the texture back from the GPU. Rows come out in texture order (v = 0 first), so the
  // PNG is written as-is and the OBJ uses vt = 1 - v.
  async function textureToPng(texture, fileName) {
    try {
      const { width, height } = texture.getSize();
      if (!width || !height) return null;
      const pixels = await texture.readPixels();
      if (!pixels || pixels.length < width * height * 4) return null;
      const bytes = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < bytes.length; i++) {
        // Furniture is opaque: force alpha so importers don't turn packed channels into holes
        bytes[i] = i % 4 === 3 ? 255 : pixels instanceof Uint8Array ? pixels[i] : Math.round(clamp01(pixels[i]) * 255);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(bytes, width, height), 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob ? { fileName, blob } : null;
    } catch (error) {
      console.warn('[IVAR export] texture not readable:', texture?.name, error);
      return null;
    }
  }

  async function materialFor(part, registry, textureFiles, stats) {
    const material = part.material;
    const linear = rgbaOf(safe(() => material.base_color_factor_linear));
    const base =
      rgbaOf(safe(() => material.base_color_factor_srgb)) ??
      (linear && [...linear.slice(0, 3).map(linearToSrgb), linear[3]]) ??
      rgbaOf(material?.albedoColor ?? material?.diffuseColor) ??
      [0.8, 0.8, 0.8, 1];
    const tint = part.tint ?? [1, 1, 1];
    const kd = [0, 1, 2].map((i) => clamp01(base[i] * tint[i]));
    const texture = diffuseTextureOf(material);
    const key = `${material?.uniqueId}|${kd.join(',')}`;
    if (registry.has(key)) return registry.get(key);

    const name = `mat${String(registry.size + 1).padStart(2, '0')}_${slug(part.label)}`;
    const entry = {
      name,
      kd,
      alpha: clamp01(material?.alpha ?? 1),
      roughness: clamp01(safe(() => material.roughness_factor, 1)),
      texture: null,
      uv: uvTransformOf(material),
    };
    if (texture) {
      if (!textureFiles.has(texture)) {
        const png = await textureToPng(texture, `${name}.png`);
        textureFiles.set(texture, png);
        if (!png) stats.unreadableTextures++;
      }
      entry.texture = textureFiles.get(texture);
    }
    registry.set(key, entry);
    return entry;
  }

  function mtlText(materials) {
    const lines = [`# IKEA IVAR planner export (userscript ${VERSION})`];
    for (const m of materials.values()) {
      const kd = m.kd.map((c) => fmt(c, 4)).join(' ');
      const specular = fmt(0.02 + 0.25 * (1 - m.roughness), 3);
      lines.push(
        '',
        `newmtl ${m.name}`,
        `Ka ${kd}`,
        `Kd ${kd}`,
        `Ks ${specular} ${specular} ${specular}`,
        `Ns ${fmt(10 + 240 * (1 - m.roughness) ** 2, 1)}`,
        `d ${fmt(m.alpha, 3)}`,
        'illum 2',
      );
      if (m.texture) lines.push(`map_Kd ${m.texture.fileName}`);
    }
    return lines.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  // World matrices of a mesh: one per instance, or one per thin instance (thin x world)
  function worldMatricesOf(mesh) {
    const world = mesh.computeWorldMatrix(true).m;
    const thin = !mesh.sourceMesh && mesh.thinInstanceCount > 0 ? mesh._thinInstanceDataStorage?.matrixData : null;
    if (!thin) return [world];
    return Array.from({ length: mesh.thinInstanceCount }, (_, k) => {
      const t = thin.subarray(16 * k, 16 * k + 16);
      const out = new Float64Array(16);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          out[4 * i + j] = t[4 * i] * world[j] + t[4 * i + 1] * world[4 + j] + t[4 * i + 2] * world[8 + j] + t[4 * i + 3] * world[12 + j];
        }
      }
      return out;
    });
  }

  // Normals transform with the inverse transpose of the 3x3 part, i.e. the cofactor matrix up to
  // the sign of the determinant. Babylon matrices are row-major and multiply row vectors.
  function normalMatrix(m) {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const cof = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
    const det = a * cof[0] + b * cof[1] + c * cof[2];
    return { cof: det < 0 ? cof.map((v) => -v) : cof, det };
  }

  // Appends one mesh instance to the OBJ lines; returns the number of triangles written.
  function appendGeometry(lines, mesh, matrix, material, offsets, zSign) {
    const source = mesh.sourceMesh ?? mesh;
    const positions = source.getVerticesData('position');
    if (!positions) return 0;
    const count = positions.length / 3;
    const rawNormals = source.getVerticesData('normal');
    const rawUvs = material.texture ? source.getVerticesData(material.uv.kind) : null;
    const uvs = rawUvs?.length === count * 2 ? rawUvs : null;
    const indices = source.getIndices() ?? Array.from({ length: count }, (_, i) => i);
    const m = matrix;

    const p = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
      p[3 * i] = (x * m[0] + y * m[4] + z * m[8] + m[12]) * CM_PER_METER;
      p[3 * i + 1] = (x * m[1] + y * m[5] + z * m[9] + m[13]) * CM_PER_METER;
      p[3 * i + 2] = (x * m[2] + y * m[6] + z * m[10] + m[14]) * CM_PER_METER * zSign;
    }

    const { cof, det } = normalMatrix(m);
    let n = null;
    if (rawNormals?.length === positions.length) {
      n = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        const x = rawNormals[3 * i], y = rawNormals[3 * i + 1], z = rawNormals[3 * i + 2];
        const nx = x * cof[0] + y * cof[3] + z * cof[6];
        const ny = x * cof[1] + y * cof[4] + z * cof[7];
        const nz = (x * cof[2] + y * cof[5] + z * cof[8]) * zSign;
        const length = Math.hypot(nx, ny, nz) || 1;
        n[3 * i] = nx / length;
        n[3 * i + 1] = ny / length;
        n[3 * i + 2] = nz / length;
      }
    }

    // OBJ front faces are counter-clockwise. Pick the winding that agrees with the normals,
    // which also covers mirrored instances and a left-handed scene.
    let flip = det * zSign < 0;
    if (n) {
      let facing = 0;
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        facing +=
          (uy * vz - uz * vy) * (n[a] + n[b] + n[c]) +
          (uz * vx - ux * vz) * (n[a + 1] + n[b + 1] + n[c + 1]) +
          (ux * vy - uy * vx) * (n[a + 2] + n[b + 2] + n[c + 2]);
      }
      flip = facing < 0;
    }

    for (let i = 0; i < count; i++) lines.push(`v ${fmt(p[3 * i], 3)} ${fmt(p[3 * i + 1], 3)} ${fmt(p[3 * i + 2], 3)}`);
    if (uvs) {
      const { row0, row1 } = material.uv;
      for (let i = 0; i < count; i++) {
        const u = uvs[2 * i], v = uvs[2 * i + 1];
        const tu = row0.x * u + row0.y * v + row0.z;
        const tv = row1.x * u + row1.y * v + row1.z;
        lines.push(`vt ${fmt(tu, 5)} ${fmt(1 - tv, 5)}`);
      }
    }
    if (n) for (let i = 0; i < count; i++) lines.push(`vn ${fmt(n[3 * i], 4)} ${fmt(n[3 * i + 1], 4)} ${fmt(n[3 * i + 2], 4)}`);

    const ref = (k) => {
      const v = offsets.v + k;
      if (uvs) return n ? `${v}/${offsets.vt + k}/${offsets.vn + k}` : `${v}/${offsets.vt + k}`;
      return n ? `${v}//${offsets.vn + k}` : `${v}`;
    };
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t];
      const b = flip ? indices[t + 2] : indices[t + 1];
      const c = flip ? indices[t + 1] : indices[t + 2];
      lines.push(`f ${ref(a)} ${ref(b)} ${ref(c)}`);
    }
    offsets.v += count;
    if (uvs) offsets.vt += count;
    if (n) offsets.vn += count;
    return Math.floor(indices.length / 3);
  }

  async function buildModel(parts, rightHanded) {
    const lines = [`# IKEA IVAR planner export (userscript ${VERSION}), centimeters, Y up`, `mtllib ${MTL_NAME}`];
    const materials = new Map();
    const textureFiles = new Map();
    const groupCounts = new Map();
    const offsets = { v: 1, vt: 1, vn: 1 };
    const stats = { furniture: 0, room: 0, triangles: 0, textures: 0, unreadableTextures: 0 };

    for (const part of parts) {
      const material = await materialFor(part, materials, textureFiles, stats);
      for (const matrix of worldMatricesOf(part.mesh)) {
        const base = slug(part.article ? `${part.label}_${part.article}` : part.label);
        const count = (groupCounts.get(base) ?? 0) + 1;
        groupCounts.set(base, count);
        const group = `${base}_${String(count).padStart(2, '0')}`;
        lines.push('', `o ${group}`, `g ${group}`, `usemtl ${material.name}`);
        stats.triangles += appendGeometry(lines, part.mesh, matrix, material, offsets, rightHanded ? 1 : -1);
        stats[part.isFurniture ? 'furniture' : 'room']++;
      }
    }
    const textures = [...new Set(textureFiles.values())].filter(Boolean);
    stats.textures = textures.length;
    return { obj: lines.join('\n') + '\n', mtl: mtlText(materials), textures, stats };
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async function createExport(includeRoom) {
    const found = findScene();
    if (!found) throw userError(TEXT.noScene);
    const parts = collectParts(found, findPlannerCore(), includeRoom);
    if (!parts.some((part) => part.isFurniture)) throw userError(TEXT.noFurniture);
    const model = await buildModel(parts, found.scene.useRightHandedSystem);
    const zip = new JSZip();
    zip.file(OBJ_NAME, model.obj);
    zip.file(MTL_NAME, model.mtl);
    for (const texture of model.textures) zip.file(texture.fileName, texture.blob, { compression: 'STORE' });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { blob, stats: model.stats };
  }

  function download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Summary to paste in bug reports: run `ivarExport.diagnose()` in the DevTools console
  function diagnose() {
    const found = findScene();
    const core = findPlannerCore();
    const parts = found ? collectParts(found, core, true) : [];
    return {
      script: VERSION,
      planner: [...document.scripts].map((s) => s.src.match(/\/version\/(v[\d.]+)\//)?.[1]).find(Boolean) ?? null,
      babylon: safe(() => found.scene.getEngine().constructor.Version),
      sceneFound: Boolean(found),
      viewerFound: Boolean(found?.viewer),
      plannerCoreFound: Boolean(core),
      rightHanded: found?.scene.useRightHandedSystem ?? null,
      meshes: found?.scene.meshes.length ?? 0,
      furniture: parts.filter((p) => p.isFurniture).map((p) => (p.article ? `${p.label} (${p.article})` : p.label)),
      roomParts: parts.filter((p) => !p.isFurniture).length,
    };
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function mountUi() {
    const panel = document.createElement('div');
    panel.id = 'ivar-3d-export';
    // Below the planner's menu button: the only spot left free by its top bar on every layout
    panel.style.cssText =
      'position:fixed;top:92px;left:24px;z-index:2147483000;display:none;align-items:center;gap:12px;' +
      'padding:6px 6px 6px 16px;background:#fff;color:#111;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.18);' +
      'font:14px/1.2 "Noto IKEA","Noto Sans",system-ui,sans-serif;white-space:nowrap;';

    const roomLabel = document.createElement('label');
    roomLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    const roomCheckbox = document.createElement('input');
    roomCheckbox.type = 'checkbox';
    roomCheckbox.style.cssText = 'margin:0;width:16px;height:16px;accent-color:#0058a3;';
    roomLabel.append(roomCheckbox, TEXT.includeRoom);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = TEXT.button;
    button.style.cssText =
      'border:0;border-radius:999px;padding:10px 18px;background:#0058a3;color:#fff;font:inherit;font-weight:700;cursor:pointer;';

    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.style.cssText =
      'position:fixed;top:152px;left:24px;z-index:2147483000;display:none;max-width:min(560px,calc(100vw - 48px));' +
      'padding:10px 16px;border-radius:8px;color:#fff;font:14px/1.4 "Noto IKEA","Noto Sans",system-ui,sans-serif;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;white-space:normal;';
    status.addEventListener('click', () => (status.style.display = 'none'));

    let hideTimer = null;
    const showStatus = (text, kind) => {
      status.textContent = text;
      status.style.background = kind === 'error' ? '#cc0008' : '#111';
      status.style.display = 'block';
      clearTimeout(hideTimer);
      if (kind !== 'busy') hideTimer = setTimeout(() => (status.style.display = 'none'), kind === 'error' ? 15000 : 8000);
    };

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.style.opacity = '0.6';
      showStatus(TEXT.working, 'busy');
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the status paint before the heavy work
      try {
        const { blob, stats } = await createExport(roomCheckbox.checked);
        download(blob, ZIP_NAME);
        showStatus(TEXT.done(stats) + (stats.unreadableTextures ? TEXT.unreadableTextures(stats.unreadableTextures) : ''), 'ok');
      } catch (error) {
        console.error('[IVAR export]', error);
        showStatus(error.userFacing ? error.message : TEXT.failed + error.message, 'error');
      } finally {
        button.disabled = false;
        button.style.opacity = '';
      }
    });

    panel.append(roomLabel, button);
    document.body.append(panel, status);
    // Only show the button while the 3D planner canvas is on screen
    setInterval(() => (panel.style.display = document.querySelector('canvas') ? 'flex' : 'none'), 1000);
  }

  window.ivarExport = { diagnose, createExport, version: VERSION };
  if (!document.getElementById('ivar-3d-export')) mountUi();
})();
