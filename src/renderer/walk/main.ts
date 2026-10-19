import './walk.css';
import { WalkGame } from './game';
import { errorText } from './messages';

const root = document.getElementById('walk-root')!;

WalkGame.start(root).catch((e: unknown) => {
  console.error('[walk] startup failed', e);
  root.textContent = '';
  const box = document.createElement('div');
  box.style.cssText = 'height:100vh;display:grid;place-items:center;text-align:center;padding:24px';
  const inner = document.createElement('div');
  const h = document.createElement('h2');
  h.textContent = 'The walking view could not start';
  const p = document.createElement('p');
  p.style.cssText = 'color:#ef5350;max-width:560px;word-break:break-word';
  p.textContent = errorText(e);
  const b = document.createElement('button');
  b.textContent = 'Exit walking';
  b.style.cssText = 'padding:8px 18px;border-radius:6px;border:1px solid #2c313b;background:#3a7bd5;color:#fff;font:inherit;cursor:pointer';
  b.addEventListener('click', () => void window.voxel.endWalk());
  inner.append(h, p, b);
  box.appendChild(inner);
  root.appendChild(box);
});
