# Prism Engine

3D 게임용 재사용 엔진 코드 (TypeScript, three.js r128 전역 `THREE`). 게임 레포 `client/src/engine/` 에 submodule 로 마운트된다.

| 경로 | 내용 |
|---|---|
| `city/` | 도시 JSON 계약(schema·compiled·validate·terrain-codec) |
| `city/gen/` | 도로·교차로·리본·필지·건물·그래프·충돌체 순수 빌더 |
| `city/editor/` | 도시 JSON 에디터 |
| `kit/` | 로우폴리 팔레트·프리미티브·rng·merge |
| `collision/` | 정적/동적 충돌체·데크 |
| `gfx/` | 품질 프로필, 그림자·반사·블룸·계측, `pipeline.ts` |

규칙: 이 디렉터리는 게임 코드(`core/ game/ systems/ data/ render/ …`)를 import 하지 않는다. 게임 데이터는 인자로 주입받는다.
검사는 게임 레포의 `client/tools/check-boundaries.mjs`.
