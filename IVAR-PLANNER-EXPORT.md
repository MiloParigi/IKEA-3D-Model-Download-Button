# IKEA IVAR Planner 3D Export

A Tampermonkey userscript that exports the IVAR furniture you designed in IKEA's online
[IVAR planner](https://www.ikea.com/addon-app/storageone/ivar/web/latest/fr/fr/) as a 3D model
(OBJ + MTL + PNG textures, zipped) that you can import into
[Sweet Home 3D](https://www.sweethome3d.com/), Blender or any OBJ-capable tool.

IKEA's planner has no 3D export, and its pieces are assembled live in the browser, so there is no
file to download. The script reads the 3D scene the planner is displaying and writes it out.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. In Chrome or Edge, allow user scripts: on the extension's details page, turn on
   **Allow User Scripts**. On older versions, turn on **Developer mode** on the extensions page instead.
3. Open [`ikea-ivar-planner-export.user.js`](https://github.com/MiloParigi/IKEA-3D-Model-Download-Button/raw/main/ikea-ivar-planner-export.user.js)
   and click **Install** in the Tampermonkey tab that opens.

## Use

1. Open the IVAR planner (any country) and design your IVAR.
2. An **Exporter 3D / Export 3D** button appears under the planner's menu button, top left.
3. Leave **Inclure la pièce / Include room** unticked to export only the furniture, or tick it to
   also export the planner's demo room (walls, floor, ceiling).
4. Click the button. `IVAR-export.zip` is downloaded with `IVAR.obj`, `IVAR.mtl` and the textures.

What you get:

- **What you see is what you export**: only furniture visible in the planner's 3D view.
- **One part per OBJ object/group**, named after the IKEA product and article number, for
  example `IVAR_shelf_42x30_pine_10318159_03` or `IVAR_cabinet_80x30x83_pine_40033763_01`.
- **One material per product**, with the planner's pine textures, so you can recolor shelves,
  side units or cabinets separately.
- **Centimeters, Y up**, floor at height 0, fronts facing +Z, parts laid out exactly as in the
  planner.

## Import into Sweet Home 3D

1. **Furniture > Import furniture…** (*Meubles > Importer des meubles…*).
2. Click **Find model…** and pick `IVAR-export.zip`. There is no need to unzip it: Sweet Home 3D
   reads the OBJ, its MTL and the textures from the ZIP. Click **Next**.
3. **Orientation**: the front of the IVAR (shelf edges, cabinet doors) should face you. If it
   doesn't, use the rotation buttons until it does. Click **Next**.
4. **Attributes**: the size is read in centimeters, so width, depth and height should match the
   planner (e.g. 134 × 31 × 227 cm for a 2-section IVAR). Keep **Keep proportions** ticked if you
   correct it, set **Elevation** to 0, leave **Door or window** unticked. Click **Next**, then
   **Finish**.
5. Drag the new piece from the furniture catalog onto your plan and push it against a wall.

Tips:

- **Furniture > Modify… > Materials** lists one material per product type, if you want a
  painted or stained look.
- Re-export after each change in the planner; import the new ZIP as a new piece.
- With **Include room** ticked, the IKEA demo room is exported too. In Sweet Home 3D you will
  usually draw your own walls instead; the option is mostly useful in Blender.
- In Blender: unzip, then **File > Import > Wavefront (.obj)** with the default axes
  (Y up, −Z forward).

## Troubleshooting

- **No button**: you must be on the 3D planner page itself, not the IVAR landing page. Reload the
  page and check that Tampermonkey is enabled for ikea.com.
- **"Scène 3D introuvable" / "No 3D scene found"**: wait until the planner has finished loading.
  If it persists, IKEA probably updated the planner. Open the browser console (F12), run
  `ivarExport.diagnose()` and paste the result in an
  [issue](https://github.com/MiloParigi/IKEA-3D-Model-Download-Button/issues).
- **"texture(s) could not be read"**: those parts get a plain color instead of the wood texture;
  the geometry is unaffected.

## Notes

- **Read-only.** The script only reads what the planner already has in memory. It never saves,
  adds to cart, or calls IKEA services. Apart from JSZip, which Tampermonkey downloads once from
  cdnjs with an integrity check, nothing is downloaded or sent anywhere.
- The models are the planner's real-time models: lighter than CAD models, but accurate in size.
- Tested with IVAR planner v16.10.0 (Babylon.js 8.6.1) on side units, shelves, a cabinet with
  doors and an X-brace. Other IVAR parts go through the same path but haven't been checked one
  by one.
- IKEA's other planners (BILLY, PLATSA…) run on the same engine. Adding their URLs to `@match`
  may work, but is untested.

### How it works

- Babylon.js is bundled inside the planner (`window.BABYLON` is only a stub), so the live
  `Scene` is reached through the React fiber tree of the planner's `<canvas>`.
- Every visible part is an `InstancedMesh` of a hidden source mesh. Positions, normals, UVs and
  indices are read from the source, and the instance's world matrix is baked in.
- The scene is right-handed, Y-up and in meters, like OBJ, so only a ×100 scale is applied.
  Triangle winding is checked against the normals for each part.
- Furniture is told apart from the room through the planner's product entities, which also
  provide the catalog names and article numbers. A Babylon layer-mask fallback is used if the
  planner internals change.
- Colors come from IKEA's material wrappers; textures are read back from the GPU with
  `readPixels()` and saved as PNG.

## Disclaimer

For personal home planning only. The models and textures belong to IKEA; respect IKEA's terms of
service and don't redistribute exported files.
