# web-ocean

> **Fork note:** this fork adds pirate galleons, a sailboat, GPU buoyancy, ship wakes, rogue waves, storm weather and a frame-by-frame filming mode on top of [Noniv/web-ocean](https://github.com/Noniv/web-ocean). The ocean renderer itself is Noniv's work.
> Live demo: **https://oceano-piratas.vercel.app**

A real-time ocean renderer written from scratch on WebGPU, with no engine or rendering library. It draws a sunset sea with simulated waves, whitecaps, sun glitter, and a physically based sky with clouds. You fly around it with a free camera.

![Looking toward the sun from 2.4 m above the water](docs/front.jpg)

| 75 degrees off the sun, 2.4 m up | Looking toward the sun from 30 m up |
|---|---|
| ![](docs/side.jpg) | ![](docs/high.jpg) |

## Run it

You need a recent Chrome with WebGPU and a reasonably capable GPU. On a laptop, force Chrome onto the dedicated GPU in the Windows graphics settings, or it will fall back to the integrated one.

Open `ocean.html` directly in the browser. `ocean.min.html` is the same page minified (91 KB instead of 153 KB). Both are self-contained and work from `file://`.

To run from source:

```
npm install
npm start        # serves http://localhost:8080/
```

After editing anything under `js/`, run `npm run build` to regenerate both bundles. The minified build strips WGSL comments and whitespace and minifies the JavaScript with esbuild.

## Controls

| Input | Action |
|---|---|
| Click the canvas | Capture the mouse (Esc releases it). Holding the right mouse button also works. |
| Mouse | Look around |
| W A S D | Move |
| Space or E / Q or C | Up / down |
| Shift | 5x speed |
| Mouse wheel | Change base speed |
| H | Settings panel: wind, swell, choppiness, turbidity, foam, sun, haze, clouds, exposure, bloom |

The camera keeps itself above the displaced water surface, so waves never pass through it.

URL parameters are handy for testing. `?w=2560&h=1440` forces the render resolution, `cam=x,y,z,yawDeg,pitchDeg` sets the camera, `fov=deg` sets the field of view, `ui=0` hides the HUD, and any settings key works too, for example `windSpeed=12&swellHs=2&sunElev=8`.

## How it works

### Waves

The sea is a Tessendorf FFT simulation with six cascades of 256 by 256 samples. The patches range from 1103 m down to 0.26 m, so wavelengths run from about a kilometre to a few millimetres. The smallest cascade produces the sharp sun sparkles near the camera.

The spectrum is a fetch-limited JONSWAP wind sea with Donelan-Banner directional spreading, plus a narrow long-crested swell. Dispersion includes the capillary term, and choppy horizontal displacement sharpens the crests. The inverse FFTs are radix-2 compute shaders working in workgroup memory.

The surface mesh is a CDLOD quadtree with 17 levels. Vertices are 6.25 cm apart near the camera and the mesh reaches 160 km, with continuous vertex morphing between levels.

### Shading

- Mip-mapped first and second moments of the wave slopes (LEAN mapping) give the right anisotropic roughness at every distance. The sun glitter widens with distance and the far sea settles into a sheen without aliasing. Screen-space slope derivatives add specular anti-aliasing.
- Sun glitter uses an anisotropic Gaussian slope distribution with Smith masking and the size of the solar disc.
- The sky reflection comes from an environment cube map rebuilt every frame, with roughness-filtered mips. At grazing angles the reflection direction is tilted to account for which wave facets the viewer can actually see.
- The water body is turbid blue-green, lit by the whole sky hemisphere. Backlit crests get a subsurface glow, and wind-gust patches modulate the short ripples.
- Whitecaps start where the total surface Jacobian folds. Foam is stored in two camera-centred world-space maps (128 m and 1 km wide), decays over time, drifts downwind, and breaks into streaks as it ages. A procedural bubble texture gives it its structure.

### Sky

The atmosphere follows Hillaire's approach, with transmittance, multiple-scattering, and sky-view lookup tables plus aerosol haze. There are two cloud layers, a broken low cumulus and a fibrous altostratus deck. Each is shaded with self-shadowing toward the sun, lit rims, silver linings when backlit, and direction-dependent multiple scattering.

Cloud noise octaves are filtered by pixel footprint, and silhouettes are anti-aliased analytically: the screen-space derivative of each layer's edge function sets the width of its opacity edge. Cloud transmittance along the sun direction dims the sunlight that reaches the water, and aerial perspective is applied over the sea.

### Ships, rogue waves and weather

The page opens "after the storm": a big leftover sea under a low golden sun breaking through the clouds. `T` (or the panel) cycles through that scene, a full storm with rain and lightning, and the original calm sunset.

- **Ships.** A 10 m sloop sails a wide circle, chased by two 30 m pirate galleons. The flagship has black sails. Each galleon has a sterncastle and forecastle, an ochre gunport strake, glowing stern windows and lanterns, tattered square sails braced to the wind, and a Jolly Roger that streams downwind. Hulls are analytic shapes, so the mesh, the water clipped inside the hull, and the ray tests on the water all use one definition.
- **Buoyancy.** It runs on the GPU with one workgroup per ship and no readback. Each ship samples the sea under 15 points of its hull and fits a plane through them. Heave, surge and sway, pitch, and roll follow that plane as damped springs. Larger hulls respond more slowly.
- **Wakes, reflections and shadows.** The foam simulation adds a bow wave, wash and churned water astern for every ship. The water shader traces the reflected ray and the sun ray against hulls, sails, and masts.
- **Rogue wave.** `G`, the panel button, or roughly every 50 s (except in the sunset scene) sends a single steep Gerstner wave group, 180 m long, downwind across the camera. Its default height is 32 m from crest to trough, with deep troughs before and after it. It is added analytically to the displacement, slopes, and Jacobian, so it gets correct shading, foam on its crest, buoyancy for the ships, and lift for the camera.
- **Weather.** An overcast deck greys the sky and hides the sun. Lightning bolts are drawn in the sky and flash the whole scene. Rain streaks are drawn in screen space. After the first click or key press, procedural audio plays wind, rain, surf, and delayed thunder.

URL parameters: `scene=swell|storm|sunset`, `ships=0`, `boatAt=deg` (fleet position), `rogueU=-150` (start a rogue wave that many metres away), plus any slider key such as `rain=0` or `rogueHeight=20`.

**Camera and filming.** `follow=i&off=right,up,forward,yawDeg,pitchDeg` rides along with ship `i` (0 = sloop, 1 = black-sailed flagship, 2 = second galleon). With the dev server (`npm start`), `film=frames&fdt=0.0333&name=take` renders an exact frame sequence: a fixed time step, every frame saved to `shots/take_00000.jpg`. In that mode the camera glides from `cam=` to `cam2=`, or from `off=` to `off2=`. `rec=seconds` records the canvas in real time instead.

### Post-processing

The scene renders in HDR with 4x MSAA. Post-processing adds an 8-level bloom, AgX tone mapping, a slight white balance shift, and dithering.

## Performance

At 2560 by 1440 on an RTX 5070 Ti, the GPU takes about 6 to 8 ms per frame, measured while other programs were also using the GPU. The HUD shows FPS and GPU time when the browser supports `timestamp-query`.

The per-frame code reuses preallocated typed arrays and descriptors, so the garbage collector has almost nothing to do. The only recurring allocations are the objects WebGPU itself requires, such as the swap-chain view and command buffers.

## Known limitations

- Far water is still somewhat darker than the bright horizon sky above it.
- The water is tuned toward turbid coastal water. The "Water turbidity" slider gives darker, bluer deep water when turned down.
- The scene is open ocean only, with no shoreline or surf. Ships do not push waves into the water; they only add foam.
- The rogue wave does not break or throw spray. Its crest folds into dense foam.
- Clouds are two flat layers, not volumetric.

## How it was made

I built this with Claude Code (Opus 5.5). I asked for the most realistic water it could produce, in WebGPU, with a floating camera, and left the architecture and implementation to it. It checked its own work by rendering screenshots in headless Chrome and having separate critic subagents review them, so it was not grading its own output. I gave feedback along the way, mainly on the clouds, which led to replacing the volumetric clouds with the flat layers and later fixing their edge aliasing.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page shell, HUD, and settings panel styles |
| `js/main.js` | Device setup, resources, camera, per-frame loop |
| `js/wgsl/` | Shaders as JavaScript modules: `boat.js` (ship geometry, buoyancy, ray tests), `sim.js` (waves and foam), `sky.js` (atmosphere and clouds), `ocean.js` (surface, ship and sky passes), `post.js` (bloom and tone mapping), `common.js` (shared structs) |
| `server.mjs` | Tiny static server for development |
| `build.mjs` | Builds `ocean.html` and `ocean.min.html` |
| `docs/` | README images |

## License

MIT. See [LICENSE](LICENSE).
