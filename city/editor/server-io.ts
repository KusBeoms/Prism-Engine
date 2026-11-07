// 에디터 서버(tools/editor-server.mjs) 연동: 있으면 원본에 직접 저장·빌드, 없으면 기존 다운로드로 폴백.
import {download, exportText, loadCompiledDefault} from './io.js';
import {ed, emit, setMsg} from './state.js';

export interface ServerInfo { up: boolean; source: string; backupDir: string; keep: number }
export const server: ServerInfo = {up: false, source: '', backupDir: '', keep: 0};
let busy = false;
export const isBusy = () => busy;

export async function pingServer(): Promise<boolean> {
  try {
    const r = await fetch('api/ping', {cache: 'no-store'});
    const j = r.ok ? await r.json() : null;
    server.up = !!(j && j.ok && j.server === 'city-editor');
    if (server.up) { server.source = String(j.source ?? ''); server.backupDir = String(j.backupDir ?? ''); server.keep = +j.keep || 0; }
  } catch { server.up = false; }
  emit('ui');
  return server.up;
}
const sizeKb = (n: number) => `${(n / 1024).toFixed(0)}KB`;

/** 저장: 서버가 있으면 city.source.json 을 덮어쓴다(백업 후). 결과 문장을 상태줄에 표시하고 반환 */
export async function saveSource(): Promise<{ok: boolean; msg: string; server: boolean}> {
  if (!ed.doc) return {ok: false, msg: '자료 없음', server: false};
  if (!server.up && !(await pingServer())) {
    download();
    const msg = `서버 없이 다운로드로 저장했습니다 (${ed.name.replace(/\.json$/i, '')}.edited.json) — npm run editor 로 열면 원본에 직접 저장됩니다`;
    setMsg(msg); return {ok: true, msg, server: false};
  }
  if (busy) return {ok: false, msg: '저장/빌드가 진행 중입니다', server: true};
  busy = true; emit('ui');
  try {
    const r = await fetch('api/source', {method: 'PUT', headers: {'content-type': 'application/json'}, body: exportText()});
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { const msg = `서버 저장 실패: ${j.error ?? 'HTTP ' + r.status}`; setMsg(msg); return {ok: false, msg, server: true}; }
    ed.dirty = false;
    const msg = `저장됨 → ${j.path} (${sizeKb(j.bytes)})` + (j.backup ? ` · 백업 ${j.backup.split('/').pop()}` : '');
    setMsg(msg); return {ok: true, msg, server: true};
  } catch (e) {
    server.up = false; const msg = `서버에 닿지 않아 저장하지 못했습니다: ${(e as Error).message}`; setMsg(msg); return {ok: false, msg, server: true};
  } finally { busy = false; emit('ui'); }
}
/** 저장 + 빌드(npm run build:city). 빌드 결과(거부 수)를 상태줄에 표시하고 빌드 거부 탭 자료를 새로 읽는다 */
export async function saveAndBuild(): Promise<{ok: boolean; msg: string}> {
  const s = await saveSource();
  if (!s.ok || !s.server) return {ok: false, msg: s.server ? s.msg : '빌드는 서버(npm run editor)가 있을 때만 가능합니다'};
  busy = true; setMsg('저장됨 — 빌드 중… (수 초)'); emit('ui');
  try {
    const r = await fetch('api/build', {method: 'POST'});
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const msg = `저장됨 · 빌드 실패${j.code !== undefined ? ` (종료 ${j.code})` : ''}: ${String(j.error ?? 'HTTP ' + r.status).split('\n').slice(-3).join(' / ')}`; setMsg(msg); return {ok: false, msg}; }
    await loadCompiledDefault();
    const msg = `저장+빌드 완료 — ${j.summary || '성공'} (${((j.ms ?? 0) / 1000).toFixed(1)}초)`;
    setMsg(msg); return {ok: true, msg};
  } catch (e) { const msg = `저장됨 · 빌드 요청 실패: ${(e as Error).message}`; setMsg(msg); return {ok: false, msg}; }
  finally { busy = false; emit('ui'); }
}
