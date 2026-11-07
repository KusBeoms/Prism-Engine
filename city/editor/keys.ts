// 키보드 단축키(맥 ⌘ 우선, Ctrl 도 동일). 표는 help.ts 가 보여 준다.
import {closeHelp, isHelpOpen, toggleHelp} from './help.js';
import {cancelDraft, deleteSelection, finishDraft, toggleCurve} from './input.js';
import {rotateSel} from './input2.js';
import {renderProps} from './panels.js';
import {saveSource} from './server-io.js';
import {ed, emit, redo, select, undo, type Tool} from './state.js';

const TOOL_KEYS: Record<string, Tool> = {v: 'select', d: 'draw', z: 'zone', a: 'anchor', b: 'building', h: 'brush'};
export const ZB_MIN = 2, ZB_MAX = 80;

export function setZoneRadius(r: number) {
  ed.zbr = Math.max(ZB_MIN, Math.min(ZB_MAX, Math.round(r))); emit('view'); renderProps();
}
export function setTool(t: Tool) {
  ed.tool = t; ed.draft = []; if (t !== 'select') select(null); emit('ui');
}

export function bindKeys() {
  window.addEventListener('keyup', e => { if (ed.alt !== e.altKey) { ed.alt = e.altKey; emit('view'); } });
  window.addEventListener('keydown', e => {
    if (ed.alt !== e.altKey) { ed.alt = e.altKey; emit('view'); }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); void saveSource(); return; }
    if (e.key === 'Escape' && isHelpOpen()) { e.preventDefault(); closeHelp(); return; }
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { e.preventDefault(); toggleHelp(); return; }
    if (isHelpOpen()) return;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    else if (e.key === 'Escape') { if (ed.draft.length) cancelDraft(); else select(null); }
    else if (e.key === 'Enter') finishDraft();
    else if (e.code === 'Space') return;
    else if (k === 'c' && !e.altKey) toggleCurve();
    else if (TOOL_KEYS[k] && !e.altKey) setTool(TOOL_KEYS[k]);
    else if (e.key === '[' || e.key === ']') {
      const dir = e.key === '[' ? -1 : 1;
      if (ed.tool === 'zone') setZoneRadius(ed.zbr + dir * Math.max(1, Math.round(ed.zbr * 0.15)));
      else if (ed.tool === 'brush') { ed.brush.r = Math.max(1, Math.min(200, ed.brush.r + dir * 5)); emit('view'); emit('ui'); }
      else rotateSel(dir * 15);
    }
  });
}
