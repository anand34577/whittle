/** Body finishes: a few honest material looks, not a full render engine. */
export interface Look {
  id: string;
  label: string;
  hint: string;
  roughness: number;
  metalness: number;
  opacity: number;
  /** How strongly the surroundings reflect: metal is almost all reflection, so the dim fill light alone leaves it grey. */
  reflect?: number;
}

export const LOOKS: Look[] = [
  { id: "matte", label: "Matte", hint: "Printed plastic, cast resin", roughness: 0.62, metalness: 0.04, opacity: 1 },
  { id: "satin", label: "Satin", hint: "Injection-moulded plastic", roughness: 0.34, metalness: 0.08, opacity: 1 },
  { id: "metal", label: "Metal", hint: "Machined aluminium or steel", roughness: 0.28, metalness: 0.9, opacity: 1, reflect: 6 },
  { id: "glass", label: "Clear", hint: "Translucent: PETG, acrylic, resin", roughness: 0.12, metalness: 0, opacity: 0.45, reflect: 2 },
];

export const lookById = (id: string | undefined): Look => LOOKS.find((l) => l.id === id) ?? LOOKS[0]!;
