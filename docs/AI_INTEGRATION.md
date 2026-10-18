# AI integration

Whittle is built so that AI models (cloud or local) can design and modify models the same way a person
does: through ordinary, editable, undoable features. Nothing an assistant makes is a "dead" mesh.

## The design API

`apps/web/src/state/designApi.ts` is the single entry point. It's a small set of JSON operations, each
with a JSON Schema, that read and change the open design:

| Tool | What it does |
|---|---|
| `get_design` | Units, parameters (formula and value), the timeline (every feature, its settings and build status; sketches with several enclosed areas list a point inside each as `regions`), bodies (size, bounding box, volume) and the person's current `selection` (faces, edges, bodies, sketches, sketch areas), so "round these edges" means what they picked. |
| `set_parameter` | Create or change a named parameter; any field can then use it in formulas. |
| `add_sketch` | A sketch on an origin plane (offset, tilted) or a flat face of a body (`top`, `front`...), with shapes: rect, circle, polygon, slot, ellipse, polyline, open path, text, gear. Outline and path points can be `[x, y, "arc"]` (the middle of a three-point arc). |
| `add_feature` | Extrude (one/two sides, through all, taper, twist, thin walls and ribs, or only some areas of the sketch with `regions`), revolve (about a sketch axis or a drawn line), loft, sweep, primitive, coil/thread, fillet/chamfer (edge selectors), shell, hole (standards-sized, counterbore/countersink), draft, mirror (offset plane), pattern (row, grid, circular), move,
 combine, split, offset, scale. |
| `constrain_sketch` | Professional sketching on an existing sketch: add points, lines, arcs and circles (rough positions in mm), then constraints (coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, fixed, symmetric `[point, point, line or centre point]`, midpoint `[point, line]`, collinear `[line, line]`) and driving dimensions (distance, radius, diameter of a circle, angle) whose values may be formulas. Refer to points as `"L1.start"`, `"A1.center"`, `"origin"`; axes as `"xaxis"`, `"yaxis"`. Also `trim` / `extend` (`{curve, at: [x, y]}`) and `delete`. Answers with the ids of named items and the solver state (`full`, `under` with `dof`, `over` with a message naming the conflicting constraints, or `error`). `add_sketch` accepts an empty `shapes` list for this. |
| `update_feature` | Change settings of any feature or replace a sketch's shapes. |
| `delete_feature` | Remove a step. |
| `set_body_appearance` | Rename, color, finish, visibility. |
| `undo` | Undo the last change. |

Rules every operation follows:

- **Validated first.** Bad input returns `{ "error": "..." }` with a readable message; nothing changes.
- **One undo step per call**, labelled `Assistant: ...` in the history.
- **Answers after the rebuild.** Each result includes the feature's real build status
  (`ok`, `warning`, `error`, `incomplete`), the kernel's message and, where there is one, a
  `suggested_fix` (for example the largest fillet radius that fits). Models use this to self-correct.
- **Selectors, not fingerprints.** Faces and edges are chosen semantically (`face: "top"`,
  `edges: "vertical"`), or as `"selected"` for exactly what the person picked in the view, so a model
  never handles geometric hashes.
- **Formulas everywhere.** Any number may be a formula (`"width / 2 + 3 mm"`), so designs stay editable.

Scripts and other tools can use the same API from the browser console or an embedding page:

```js
await whittle.api.run("set_parameter", { name: "wall", value: 2 });
const s = await whittle.api.run("add_sketch", { plane: "XY", shapes: [{ type: "rect", width: 60, height: 40, corner_radius: 4 }] });
await whittle.api.run("add_feature", { type: "extrude", settings: { sketch: s.id, distance: 20 } });
await whittle.api.run("add_feature", { type: "shell", settings: { body: "Body 1", face: "top", thickness: "wall" } });
whittle.api.tools; // the JSON Schemas, ready to hand to any tool-calling model

// A fully constrained L-bracket profile whose width follows the wall parameter:
const l = await whittle.api.run("add_sketch", { plane: "XY", shapes: [] });
await whittle.api.run("constrain_sketch", {
  sketch: l.id,
  geometry: [
    { name: "a", type: "line", from: [0, 0], to: [40, 0] },
    { name: "b", type: "line", from: "a.end", to: [40, 8] },
    { name: "c", type: "line", from: "b.end", to: [8, 8] },
    { name: "d", type: "line", from: "c.end", to: [8, 30] },
    { name: "e", type: "line", from: "d.end", to: [0, 30] },
    { name: "f", type: "line", from: "e.end", to: "a.start" },
  ],
  constraints: [
    { type: "coincident", refs: ["a.start", "origin"] },
    ...["a", "c", "e"].map((x) => ({ type: "horizontal", refs: [x] })),
    ...["b", "d", "f"].map((x) => ({ type: "vertical", refs: [x] })),
    { type: "distance", refs: ["a"], value: "wall * 20" },
    { type: "distance", refs: ["f"], value: 30 },
    { type: "distance", refs: ["b"], value: 8 },
    { type: "distance", refs: ["e"], value: 8 },
  ],
}); // → { solver: { state: "full", dof: 0 } }
```

## Providers

`apps/web/src/state/ai.ts` runs the tool-use loop for two provider families:

| Provider | How | Notes |
|---|---|---|
| **Claude** (Anthropic) | Official Anthropic TypeScript SDK, loaded only when used | Default model `claude-opus-5-5`; server-side refusal fallbacks enabled on models that support them. |
| **OpenAI-compatible** | `POST {baseUrl}/chat/completions` with `tools` | OpenAI, **Ollama** (`http://localhost:11434/v1`), **LM Studio**, OpenRouter, vLLM, LocalAI, company gateways. |

People add providers in **Settings → AI assistant**. On a Whittle server the settings and keys are kept in
your account in the server's database (nothing is stored in the browser); without a server they stay on
that device. Requests go directly from the browser to the chosen provider. Local servers need to allow the app's origin (Ollama:
`OLLAMA_ORIGINS`; LM Studio: enable CORS).

A model server on another computer of your network (`http://192.168.1.20:11434/v1`) works too: the
server must listen on the network (Ollama: `OLLAMA_HOST=0.0.0.0`), and the app must be opened over
`http://`, because browsers never let an HTTPS page call a plain-HTTP address other than `localhost`.
If Whittle is served over HTTPS, put the model server behind HTTPS as well. On a self-hosted server, `WHITTLE_AI=false` hides the
assistant and keeps the strict browser security policy.
The desktop app offers the assistant too, and is the simplest way to use a model running on the same
computer. Its requests come from the app's own origin (`http://tauri.localhost` on Windows,
`tauri://localhost` elsewhere), so a local server must allow it: set `OLLAMA_ORIGINS=*` for Ollama, or
enable CORS in LM Studio.


The loop is capped at 24 turns per request, every step is shown in the panel (expand a step to see the
exact input and result), and **Stop** aborts the request.

## Adding a provider

Implement one function with the shape of `runOpenAI` / `runClaude` in `ai.ts`: send the conversation
and `DESIGN_TOOLS`, run each tool call through `runDesignTool`, return the results, repeat until the
model stops calling tools. Add a preset to `PRESETS`.

## Next steps

- **Server-side proxy** so organisations can keep provider keys on the server and log usage
  (the browser would call `/api/ai/...` instead of the provider).
- **Vision**: send a viewport snapshot (`thumbnailHook.image`) so the model can check its work.
- **Streaming** replies and **plan → confirm → apply** mode for large changes.
- **Sketch constraints** in the API once the constraint solver lands.
