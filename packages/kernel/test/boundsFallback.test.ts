/**
 * Five overlapping copies of a shelled box merged in one pattern: OpenCascade's fuse returns an empty shape, which used to
 * vanish from the view with a raw "WebAssembly.Exception" message.
 */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { Builder } from "../src/build";
import { initSolver } from "../src/solver";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await initSolver();
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const DOC = String.raw`{"schema":3,"id":"dmvlukrpleoedex","name":"Untitled","units":"mm","parameters":[],"features":[{"id":"skmvlul3u0c6loml","type":"sketch","name":"Sketch 1","plane":{"kind":"origin","plane":"XY","offset":"0"},"entities":[],"geometry":[{"id":"p1","type":"point","x":-35,"y":-30},{"id":"p2","type":"point","x":35,"y":-30},{"id":"p3","type":"point","x":35,"y":30},{"id":"p4","type":"point","x":-35,"y":30},{"id":"l1","type":"line","a":"p1","b":"p2"},{"id":"l2","type":"line","a":"p2","b":"p3"},{"id":"l3","type":"line","a":"p3","b":"p4"},{"id":"l4","type":"line","a":"p4","b":"p1"}],"constraints":[]},{"id":"exmvlulrdh229032","type":"extrude","name":"Extrude 1","sketch":"skmvlul3u0c6loml","distance":"20","extent":"one","flip":false,"op":"new"},{"id":"fimvlulywy6xzp4l","type":"fillet","name":"Fillet 1","edges":[{"bodyId":"exmvlulrdh229032","mid":[0,-30,0],"tangent":[1,0,0],"curve":"LINE","length":70}],"radius":"2"},{"id":"shmvlummujeere4w","type":"shell","name":"Shell 1","faces":[{"bodyId":"exmvlulrdh229032","center":[0,0,20],"normal":[0,0,1],"surface":"PLANE","area":4200}],"thickness":"2","bodyId":"exmvlulrdh229032"},{"id":"fimvlunravpb9jtp","type":"fillet","name":"Fillet 2","edges":[{"bodyId":"exmvlulrdh229032","mid":[-35,-30,11],"tangent":[0,0,1],"curve":"LINE","length":18},{"bodyId":"exmvlulrdh229032","mid":[35,-30,11],"tangent":[0,0,1],"curve":"LINE","length":18},{"bodyId":"exmvlulrdh229032","mid":[-35,30,10],"tangent":[0,0,1],"curve":"LINE","length":20},{"bodyId":"exmvlulrdh229032","mid":[35,30,10],"tangent":[0,0,1],"curve":"LINE","length":20},{"bodyId":"exmvlulrdh229032","mid":[32.998,27.998,11.001000000000001],"tangent":[0,0,1],"curve":"LINE","length":17.998},{"bodyId":"exmvlulrdh229032","mid":[32.99799999999999,-27.998,11],"tangent":[0,0,1],"curve":"LINE","length":18},{"bodyId":"exmvlulrdh229032","mid":[-32.998,27.998,11.001],"tangent":[0,0,-1],"curve":"LINE","length":17.998},{"bodyId":"exmvlulrdh229032","mid":[-32.998,-27.998,11],"tangent":[0,0,-1],"curve":"LINE","length":18}],"radius":"3"},{"id":"homvluodx0ixja5m","type":"hole","name":"Hole 1","face":{"bodyId":"exmvlulrdh229032","center":[0,1,0],"normal":[0,0,-1],"surface":"PLANE","area":3712},"points":[["-29","-24.5"],["29","-24.5"],["29","24.5"],["-29","24.5"]],"style":"simple","diameter":"2.7","depth":"10","through":true,"headDiameter":"9","headDepth":"3","tipAngle":"118"},{"id":"pamvluoeamlewlgf","type":"pattern","name":"Pattern 1","bodyId":"exmvlulrdh229032","pattern":"linear","axis":"x","count":"5","spacing":"6","angle":"360","merge":true}],"bodies":{"exmvlulrdh229032":{"name":"Body 1","color":"#b7bfc9","visible":true}},"rollback":null,"createdAt":"2026-10-24T03:36:49.737Z","modifiedAt":"2026-10-24T03:36:49.737Z"}`;

it("a merge that comes out empty is reported on the pattern, and the body stays", () => {
  const r = new Builder().regen(JSON.parse(DOC), "final");
  const errors = r.status.filter((s) => s.state === "error");
  expect(errors.map((e) => e.id)).toEqual(["pamvluoeamlewlgf"]);
  expect(errors[0]!.message).toMatch(/overlap too much/);
  expect(r.bodies).toHaveLength(1);
  expect(r.bodies[0]!.volume).toBeGreaterThan(0);
}, 120000);
