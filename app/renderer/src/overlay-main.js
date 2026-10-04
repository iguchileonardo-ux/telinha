// Página da camada transparente sobre a tela de quem transmite.
import { Annotator } from './annotate.js';

const canvas = document.getElementById('ink');
const annotator = new Annotator(canvas, () => ({ x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight }));

window.overlay?.onEvent((data) => {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'pointer') annotator.pointer(data.id, data.name, data.color, data.x, data.y, data.hide);
  else if (data.type === 'stroke') annotator.stroke(data.key, data.pts, data.color, data.done);
  else if (data.type === 'clear') annotator.clear();
});
