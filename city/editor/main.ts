// 도시 JSON 에디터 진입점: 캔버스·컨트롤 연결, 구독 갱신, 시험용 훅(window.__editor).
import {draw, getHover, toScreen, toWorld} from './draw.js';
import {AUTOSAVE_KEY, clearAuto, download, exportText, fitView, loadCompiledDefault, loadDefault, loadFile, parseCompiled, refreshIssues, restoreAuto, saveAuto} from './io.js';
import {bindKeys, setTool} from './keys.js';
import {bindView, scaleBar, setViewSize} from './view.js';
import {isHelpOpen, toggleHelp} from './help.js';
import {pingServer, saveAndBuild, saveSource, server} from './server-io.js';
import {hooks} from './state.js';
import {isJx, rebaseline, summarizeJx, syncJunctions} from './junctions-auto.js';
import {bindCanvas, cancelDraft, finishDraft, insertAt, setSize, snapPoint} from './input.js';
import {focusRoad, renderIssues, renderProps, renderRejected, renderRoads, renderStatus, showBanner} from './panels.js';
import {ed, emit, mutate, mutateDoc, objList, redo, select, selectObj, undo, type Kind, type Tool} from './state.js';
import {renderObjList, renderToolOpts} from './panels2.js';
import {drawnLabels, setCityName} from './names.js';
import {bindPreview, closePreview, openPreview, previewOpen, pvStats, refreshPreview} from './preview3d.js';
import {allGradeHits, currentTerrain, ensureTerrain, heightAt} from './terrain-ed.js';
import {GAME_DRAFT_KEY, saveGameDraft} from './io.js';
import {deleteObj} from './objops.js';
import {lengthNow, nearest} from './roadops.js';
import {ROAD_CLASSES, type RoadClass} from '../city-schema.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>('cv'), ctx = cv.getContext('2d')!;
let cw = 800, ch = 600, need = true, issueTimer = 0;

function resize() {
  const b = cv.parentElement!.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cw = Math.max(100, Math.floor(b.width)); ch = Math.max(100, Math.floor(b.height));
  cv.width = cw * dpr; cv.height = ch * dpr; cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); setSize(cw, ch); setViewSize(cw, ch); need = true;
}
function frame() {
  if (need) { need = false; draw(ctx, cw, ch); }
  requestAnimationFrame(frame);
}
const tabs = ['roads', 'objs', 'issues', 'rej'];
let toolSig = '', pvTimer = 0;
function showTab(t: string) {
  for (const n of tabs) { $('list-' + n).classList.toggle('hidden', n !== t); document.querySelector(`[data-tab="${n}"]`)!.classList.toggle('on', n === t); }
}

ed.subs.push((k: Kind) => {
  need = true;
  syncCityName();
  if (k === 'doc') {
    clearTimeout(issueTimer);
    issueTimer = window.setTimeout(() => { refreshIssues(); renderRoads(); }, 120);
    renderProps(); saveAuto(); renderObjList();
    if (previewOpen()) { clearTimeout(pvTimer); pvTimer = window.setTimeout(() => void refreshPreview(), 400); }
  }
  if (k === 'sel') {
    renderProps(); renderObjList();
    for (const el of document.querySelectorAll('#list-roads .item')) {
      const on = el.getAttribute('data-road') === ed.selRoad;
      el.classList.toggle('on', on);
      if (on) (el as HTMLElement).scrollIntoView({block: 'nearest'});
    }
  }
  if (k === 'issues') renderIssues();
  if (k === 'ui') { renderRejected(); if (toolSig !== ed.tool) { toolSig = ed.tool; renderToolOpts(); renderProps(); resize(); } }
  renderStatus(getHover());
});

function syncCityName() {
  const i = $<HTMLInputElement>('cityName');
  if (document.activeElement !== i) i.value = ed.doc?.name ?? '';
}
function wire() {
  const cn = $<HTMLInputElement>('cityName');
  cn.onchange = () => setCityName(cn.value);
  cn.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') cn.blur(); };
  $<HTMLInputElement>('chkZoneNames').onchange = e => { ed.showZoneNames = (e.target as HTMLInputElement).checked; emit('view'); };
  $('btnOpen').onclick = () => $<HTMLInputElement>('fileIn').click();
  $<HTMLInputElement>('fileIn').onchange = async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) { const err = await loadFile(f); showBanner(err ?? `불러옴: ${f.name}`, err ? 'error' : 'info'); fitView(cw, ch); }
    (e.target as HTMLInputElement).value = '';
  };
  $('btnOpenBuild').onclick = () => $<HTMLInputElement>('buildIn').click();
  $<HTMLInputElement>('buildIn').onchange = async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) { const err = parseCompiled(await f.text(), f.name); if (err) showBanner(err, 'error'); else showTab('rej'); }
    (e.target as HTMLInputElement).value = '';
  };
  $('btnSave').onclick = () => void saveSource();
  $('btnDownload').onclick = download;
  $('btnBuild').onclick = () => void saveAndBuild();
  $('btnHelp').onclick = toggleHelp;
  $<HTMLInputElement>('chkJunc').onchange = e => { ed.autoJunc = (e.target as HTMLInputElement).checked; if (ed.autoJunc) rebaseline(ed.doc); };
  $('btnUndo').onclick = () => { undo(); };
  $('btnRedo').onclick = () => { redo(); };
  $('btnFit').onclick = () => fitView(cw, ch);
  $('btnReset').onclick = async () => {
    if (ed.dirty && !confirm('저장하지 않은 편집이 사라집니다. 원본을 다시 불러올까요?')) return;
    clearAuto(); const err = await loadDefault(); showBanner(err ?? '원본을 다시 불러왔습니다', err ? 'error' : 'info'); fitView(cw, ch);
  };
  $('toolSel').onclick = () => { ed.tool = 'select'; cancelDraft(); };
  $('toolDraw').onclick = () => { ed.tool = 'draw'; select(null); emit('ui'); };
  for (const t of ['zone', 'anchor', 'building', 'brush'] as Tool[]) $('tool-' + t).onclick = () => setTool(t);
  $<HTMLInputElement>('chkRefs').onchange = e => { ed.refs = (e.target as HTMLInputElement).checked; };
  $<HTMLInputElement>('chkHeight').onchange = e => { ed.showHeight = (e.target as HTMLInputElement).checked; emit('view'); if (ed.showHeight && !currentTerrain()) void ensureTerrain(); };
  $<HTMLInputElement>('chkSlope').onchange = e => { ed.showSlope = (e.target as HTMLInputElement).checked; emit('view'); };
  $('btnPreview').onclick = () => (previewOpen() ? closePreview() : openPreview());
  $('btnGame').onclick = e => { const err = saveGameDraft(); if (err) { e.preventDefault(); showBanner(err, 'error'); } else showBanner('편집본을 로컬 초안으로 저장하고 게임을 엽니다 (게임 쪽 검증이 실패하면 사유가 표시됨)'); };
  $<HTMLSelectElement>('objKind').onchange = renderObjList;
  $<HTMLInputElement>('chkGrid').onchange = e => { ed.snapGrid = (e.target as HTMLInputElement).checked; emit('view'); };
  $<HTMLInputElement>('chkPts').onchange = e => { ed.snapPts = (e.target as HTMLInputElement).checked; };
  $<HTMLInputElement>('gridSize').onchange = e => { ed.grid = Math.max(1, +(e.target as HTMLInputElement).value || 5); emit('view'); };
  const dc = $<HTMLSelectElement>('drawCls');
  for (const c of ROAD_CLASSES) dc.append(new Option(c, c, false, c === ed.drawCls));
  dc.onchange = () => { ed.drawCls = dc.value as RoadClass; };
  $<HTMLInputElement>('drawCurve').onchange = e => { ed.drawCurve = (e.target as HTMLInputElement).checked ? 'catmull' : 'line'; };
  $<HTMLInputElement>('filter').oninput = () => { renderRoads(); renderObjList(); };
  for (const b of document.querySelectorAll<HTMLElement>('[data-tab]')) b.onclick = () => showTab(b.dataset.tab!);
  window.addEventListener('resize', resize);
  new ResizeObserver(() => resize()).observe(cv.parentElement!); // 도구 옵션 줄이 나타나 캔버스 영역이 줄어드는 경우
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) { const err = await loadFile(f); showBanner(err ?? `불러옴: ${f.name}`, err ? 'error' : 'info'); fitView(cw, ch); }
  });
  window.addEventListener('beforeunload', e => { if (ed.dirty) { saveAuto(); e.preventDefault(); } });
}

async function start() {
  hooks.afterEdit = doc => { ed.jxMsg = ''; if (!ed.autoJunc) return; ed.jxMsg = summarizeJx(syncJunctions(doc)); };
  hooks.restored = doc => rebaseline(doc);
  resize(); wire(); bindCanvas(cv); bindView(cv); bindKeys(); void pingServer(); bindPreview(); renderToolOpts(); showTab('roads'); requestAnimationFrame(frame);
  if (restoreAuto()) {
    showBanner('이전 편집 내용을 복원했습니다. 처음 상태로 돌아가려면 "원본 다시"를 누르세요.');
  } else {
    const err = await loadDefault();
    if (err) showBanner(err + ' (파일을 끌어다 놓거나 "열기")', 'error');
  }
  fitView(cw, ch); refreshIssues(); renderRoads(); renderProps(); renderObjList(); renderStatus(null);
  void ensureTerrain().then(ok => { refreshIssues(); if (!ok && ed.terrainMsg) showBanner(ed.terrainMsg, 'error'); need = true; });
  loadCompiledDefault().then(() => { renderRoads(); renderRejected(); need = true; });
}

// 시험·디버그 훅 (콘솔에서 __editor 로 접근)
(window as any).__editor = {
  ed, exportText, undo, redo, select, selectObj, focusRoad, mutate, mutateDoc, deleteObj, objList, allGradeHits, heightAt, currentTerrain, saveGameDraft, GAME_DRAFT_KEY,
  lengthNow, zoneLabels: () => drawnLabels.map(l => ({...l})),
  roadDistAt: (x: number, z: number) => Math.min(...(ed.doc?.roads ?? []).map(r => nearest(r, x, z).d)),
  preview: {stats: pvStats, open: openPreview, refresh: refreshPreview},
  scaleBar, syncJunctions, rebaseline, isJx, server, pingServer, saveSource, saveAndBuild, toggleHelp, isHelpOpen,
  insertAt, snapPoint, finishDraft, refreshIssues, AUTOSAVE_KEY,
  screenOf: (x: number, z: number) => { const [sx, sy] = toScreen(cw, ch, x, z), b = cv.getBoundingClientRect(); return [b.left + sx, b.top + sy]; },
  worldOf: (px: number, py: number) => { const b = cv.getBoundingClientRect(); return toWorld(cw, ch, px - b.left, py - b.top); },
};
void start();
