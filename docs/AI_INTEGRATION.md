# AI integration

Whittle is built so that AI models (cloud or local) can design and modify models the same way a person
does: through ordinary, editable, undoable features. Nothing an assistant makes is a "dead" mesh.

## The design API

`apps/web/src/state/designApi.ts` is the single entry point. It's a small set of JSON operations, each
with a JSON Schema, that read and change the open design:

| Tool | What it does |
|---|---|
| `get_design` | Units, parameters (formula and value), the timeline (every feature, its settings and build status) and bodies (size, bounding box, volume). |
| `set_parameter` | Create or change a named parameter; any field can then use it in formulas. |
| `add_sketch` | A sketch on an origin plane (offset, tilted) or a flat face of a body (`top`, `front`...), with shapes: rect, circle, polygon, slot, ellipse, polyline, open path, text, gear. |
| `add_feature` | Extrude (one/two sides, taper, twist), revolve, loft, sweep, primitive, coil/thread, fillet/chamfer (edge selectors), shell, hole (standards-sized, counterbore/countersink), draft, mirror, pattern, move, combine, split, offset, scale. |
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
  `edges: "vertical"`), so a model never handles geometric hashes.
- **Formulas everywhere.** Any number may be a formula (`"width / 2 + 3 mm"`), so designs stay editable.

Scripts and other tools can use the same API from the browser console or an embedding page:

```js
await whittle.api.run("set_parameter", { name: "wall", value: 2 });
const s = await whittle.api.run("add_sketch", { plane: "XY", shapes: [{ type: "rect", width: 60, height: 40, corner_radius: 4 }] });
await whittle.api.run("add_feature", { type: "extrude", settings: { sketch: s.id, distance: 20 } });
await whittle.api.run("add_feature", { type: "shell", settings: { body: "Body 1", face: "top", thickness: "wall" } });
whittle.api.tools; // the JSON Schemas, ready to hand to any tool-calling model
```

## Providers

`apps/web/src/state/ai.ts` runs the tool-use loop for two provider families:

| Provider | How | Notes |
|---|---|---|
| **Claude** (Anthropic) | Official Anthropic TypeScript SDK, loaded only when used | Default model `claude-opus-5-5`; server-side refusal fallbacks enabled on models that support them. |
| **OpenAI-compatible** | `POST {baseUrl}/chat/completions` with `tools` | OpenAI, **Ollama** (`http://localhost:11434/v1`), **LM Studio**, OpenRouter, vLLM, LocalAI, company gateways. |

People add providers in **Settings → AI assistant**. Keys are kept in that browser only and requests go
directly from the browser to the chosen provider. Local servers need to allow the app's origin (Ollama:
`OLLAMA_ORIGINS`; LM Studio: enable CORS). On a self-hosted server, `WHITTLE_AI=false` hides the
assistant and keeps the strict browser security policy.

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
