// Runtime switches also make each graphics stage independently comparable.
export interface GraphicsEffects {tone: boolean; shadows: boolean; bloom: boolean; reflection: boolean}
const params = new URLSearchParams(location.search);
export const effects: GraphicsEffects = {
  tone: params.get('tone') !== '0', shadows: params.get('shadows') !== '0',
  bloom: params.get('bloom') !== '0', reflection: params.get('reflection') !== '0',
};
export function setGraphicsEffects(next: Partial<GraphicsEffects>) {Object.assign(effects, next);}
