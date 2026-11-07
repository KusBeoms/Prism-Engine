// 단축키·조작 도움말 모달. `?` 또는 헤더의 도움말 버튼으로 열고 Esc 로 닫는다. 표기는 맥(⌘ ⌥ ⇧) 기준, Ctrl 도 같다.
type Row = [string, string];
interface Section { title: string; note?: string; rows: Row[] }

export const HELP: Section[] = [
  {title: '시점 (맥북 트랙패드)', rows: [
    ['두 손가락 스와이프', '상하좌우 이동 (스크롤)'],
    ['핀치 (벌리기/모으기)', '커서 위치 기준 확대/축소 (Safari 제스처·Chrome/Firefox ctrl+휠 모두)'],
    ['마우스 휠 · ⌥ + 스크롤', '커서 기준 부드러운 확대/축소'],
    ['빈 곳 드래그 · Space + 드래그 · 가운데/오른쪽 버튼 드래그', '이동'],
    ['왼쪽 아래 척도 바', '현재 확대에서 100 m · 200 m · 500 m · 1 km 등 보기 좋은 길이를 자동 선택'],
  ]},
  {title: '공통', rows: [
    ['⌘Z  (Ctrl+Z)', '실행 취소 (최대 100단계)'],
    ['⌘⇧Z · ⌘Y  (Ctrl 도 가능)', '다시 실행'],
    ['⌘S  (Ctrl+S)', '저장 — 서버(npm run editor)가 있으면 city.source.json 을 직접 덮어씀(백업 후), 없으면 .edited.json 다운로드'],
    ['?', '이 도움말 열기/닫기'],
    ['Esc', '도움말 닫기 → 그리기 취소 → 선택 해제'],
    ['Delete · ⌫', '선택한 점/도로/객체 삭제'],
  ]},
  {title: '도구 (키)', rows: [
    ['V', '선택/편집'], ['D', '도로 그리기'], ['Z', '구역 브러시 (칠하기)'], ['A', '앵커 배치'], ['B', '건물 배치'], ['H', '높이 브러시 (지형 편집)'],
  ]},
  {title: '선택/편집 모드 (V)', rows: [
    ['클릭', '도로·노드·앵커·건물·구역 선택'],
    ['선택한 도로의 사각 점 드래그', '점 이동 (격자·끝점 스냅). 이웃 도로 점·노드·필지 등이 함께 갱신(참조 자동 갱신)'],
    ['도로 위 더블클릭', '점 삽입'],
    ['점 클릭 → Delete', '점 삭제 (도로는 최소 2점)'],
    ['C', '곡선 ↔ 직선'],
    ['[  ]', '선택한 앵커/건물 회전 ∓15°'],
    ['구역 선택 후 점 드래그 · 변 더블클릭', '구역 점 이동 · 점 삽입 (새 구역은 Z 브러시로 칠한다)'],
  ]},
  {title: '도로 그리기 (D)', rows: [
    ['클릭', '점 추가 (격자·끝점 스냅)'], ['더블클릭 · Enter', '도로 완성 (점 2개 이상)'], ['Esc', '그리기 취소'],
    ['헤더 "자동 교차로"', '다른 도로에 닿거나 교차하면 jx-N 교차로 노드를 자동 생성·정리 (입체교차 제외)'],
  ]},
  {title: '구역 브러시 (Z)', note: '용도는 오른쪽 패널에서 고른다', rows: [
    ['드래그', '칠하기 — 시작점이 기존 구역 안이면 그 구역 확장(용도 유지), 빈 곳이면 선택한 용도의 새 구역'],
    ['⌥ + 드래그', '지우개 — 칠한 부분을 구역에서 제거. 갈라지면 분리, 비면 삭제'],
    ['⇧ + 드래그', '기존 구역 위에서도 새 구역으로 시작'],
    ['[  ]', '브러시 반경 줄이기 / 키우기 (오른쪽 패널 슬라이더도 가능)'],
    ['한 번 드래그', '실행 취소 1단계. 칠한 구역이 이기고 겹친 구역은 그 부분을 잃음. 구멍은 메워짐'],
  ]},
  {title: '앵커 (A) · 건물 (B) · 높이 브러시 (H)', rows: [
    ['A / B + 클릭', '앵커 / 건물 배치 (옵션은 헤더 아래 줄)'],
    ['H + 드래그', 'terrain.edits 에 브러시 1건 추가 (raise/lower/flatten/smooth)'],
    ['선택 후 드래그', '앵커·건물 이동 (고정 앵커는 이동·삭제 불가)'],
  ]},
  {title: '저장 · 주의', rows: [
    ['저장 / 저장+빌드', '서버가 있을 때 원본 직접 저장 / 저장 후 npm run build:city 실행(거부 수 표시). 서버가 없으면 다운로드로 폴백'],
    ['백업', 'tools/.editor-backup/city.source.<시각>.json (최근 20개)'],
    ['경고', 'tools/city-author* 가 city.source.json 을 다시 만들면 에디터 수정이 덮입니다 — 같은 시기에 함께 쓰지 마세요'],
  ]},
];

let box: HTMLElement | null = null;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

function build(): HTMLElement {
  const wrap = el('div'); wrap.id = 'help'; wrap.className = 'hidden'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-label', '단축키 도움말');
  const card = el('div', 'help-card'), head = el('div', 'help-head');
  head.append(el('b', '', '단축키 · 조작 도움말'), el('span', 'muted', '  ? 로 열고 닫기, Esc 로 닫기'));
  const x = el('button', '', '닫기'); x.id = 'helpClose'; x.onclick = closeHelp; head.append(x);
  card.append(head);
  const body = el('div', 'help-body');
  for (const s of HELP) {
    const t = el('table', 'help-table'), cap = el('caption', '', s.title + (s.note ? ` — ${s.note}` : ''));
    t.append(cap);
    for (const [k, d] of s.rows) { const tr = el('tr'), kc = el('td', 'help-key'); kc.textContent = k; tr.append(kc, el('td', '', d)); t.append(tr); }
    body.append(t);
  }
  card.append(body); wrap.append(card);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closeHelp(); });
  document.body.append(wrap);
  return wrap;
}
export const isHelpOpen = () => !!box && !box.classList.contains('hidden');
export function openHelp() { box ??= build(); box.classList.remove('hidden'); }
export function closeHelp() { box?.classList.add('hidden'); }
export function toggleHelp() { if (isHelpOpen()) closeHelp(); else openHelp(); }
