# sweepy

개발 디스크의 **빌드 산출물**(`node_modules`, `target`, `.next`, `__pycache__`), **git 워크트리**, **캐시·영상 중간 산출물**을 정책에 따라 제안하고 승인된 것만 적용한다. 빌드 산출물·워크트리 탐지와 삭제는 [Void](https://github.com/eladbash/void)와 git이 하고, 사람과의 대화는 sweepy 밖(에이전트 세션)이 한다.

```
launchd (1시간마다) ─▶ sweepy check
                        ├─ scan: 워크트리(git) + 산출물(Void, 정책 범위로 한정) ─▶ 제안 {id, items[tier], excluded[reason]}
                        ├─ auto 등급: policy.auto.enabled면 적용, 아니면 history에 "shadow"로 기록만
                        └─ approve 등급: 1 GiB 이상이거나 디스크가 부족하면 inbox/<id>.json 에 제안 (같은 내용이면 새로 만들지 않음)

에이전트(메신저 세션) ─ inbox/ 감시 ─▶ 사람에게 요약 ─"승인"─▶ sweepy apply <id>
```

## 등급

| 등급 | 대상 | 이유 |
|---|---|---|
| auto | 디렉터리가 사라진 워크트리 기록(`git worktree prune`), 유휴 워크트리 **안의** 빌드 산출물 | 코드와 브랜치는 그대로, 다시 만들 수 있는 것만 |
| approve | `staleDays` 이상 손대지 않은 산출물, 깨끗하고 모든 커밋이 원격에 있고 유휴인 워크트리 제거 | 재설치 시간이 들거나 작업 공간 자체라서 |
| excluded | 커밋 안 된 변경·원격에 없는 커밋·잠긴 워크트리, `protect` 경로, 실행 중인 프로세스가 쓰는 프로젝트, `roots` 밖 | 복구할 수 없어서 |

`apply`는 제안을 그대로 믿지 않는다. 다시 스캔해서 여전히 같은 등급인 항목만 적용하고, 나머지는 `dropped`로 돌려준다. 산출물은 Void 계획을 해당 경로로만 만들어 계획에 승인되지 않은 경로가 섞이면 중단하고, 워크트리는 `git worktree remove`(`--force` 없음)로 지운다. 회수량은 적용 전후 여유 공간을 실제로 재서 기록한다.

## 사용

```sh
bin/sweepy scan                    # 제안 생성(아무것도 지우지 않음)
bin/sweepy apply <id>              # approve 등급 적용
bin/sweepy apply <id> --tier auto  # auto 등급 적용
bin/sweepy check                   # launchd가 부르는 것: scan + auto(또는 shadow) + inbox
bin/sweepy status                  # 여유 공간, 대기 중인 제안, 마지막 실행
bin/sweepy report [--json]         # 디스크를 어디가 쓰는지 표(policy.report 대상 du, 큰 순)
bin/sweepy dry-run [cleaner]       # cleaner별 예상 크기와 도구의 dry-run 출력(실제 정리는 하지 않음)
bin/sweepy dry-run media           # 영상 제안·제외 이유·총 크기만 확인(삭제 없음)
bin/sweepy scan --include-originals # 원격 ID·이름·정확한 크기가 맞는 원본도 검토(항상 approve)
bin/sweepy install | uninstall     # launchd(dev.sweepy.check) 등록/해제
sh scripts/doctor.sh               # 설치·정책·스케줄·macOS 권한 대화상자 점검
```

출력은 모두 JSON이다. 상태는 `~/.local/state/sweepy/`에 남는다: `proposals/`, `inbox/`, `history.jsonl`, `sweepy.log`.

## 정책 (`policy.json`)

| 키 | 뜻 |
|---|---|
| `roots` | 스캔할 곳. 이 밖은 보지 않는다 |
| `protect` | 절대 건드리지 않을 경로(배포 릴리스 등) |
| `artifacts.kinds` / `ecosystems` / `staleDays` | 산출물 종류, Void 생태계, approve 기준 일수 |
| `worktrees.idleDays` | 워크트리를 유휴로 보는 기준(마지막 커밋과 index 갱신 중 늦은 쪽) |
| `auto.enabled` | `false`면 auto 등급을 기록만 한다. history의 shadow 기록을 보고 오판이 없으면 켠다 |
| `inbox.minBytes` | 이 이상 모일 때만 inbox에 제안 |
| `proposalTtlHours` | 제안 유효 시간 |
| `cleaners[]` | 도구의 공식 prune을 감싼 플러그인. `{id, tier, detect, size, dryRun?, apply, shadow?, enabled?}`. 아래 참고 |
| `archives[]` | `{id, paths, match, olderThanDays, tier}`. `match`(정규식)에 맞고 `olderThanDays` 넘게 안 바뀐, 열려 있지 않은(lsof) 파일을 `zstd --rm`으로 압축한다. 삭제하지 않는다 |
| `staleDirs[]` | `{id, parent, keep?: {symlink?, cmd?}, keepNewest?, olderThanDays?, tier}`. `parent`의 하위 디렉터리 중 현재 버전(심볼릭 링크 대상, 명령 출력의 마지막 경로 성분, 최신 N개)을 빼고 제안한다. 현재 버전을 알 수 없으면 아무것도 제안하지 않는다 |
| `brewDuplicates` | `{tier}`(auto여도 approve로 취급). 같은 계열의 버전 formula(node@22+node@24) 중 오래되고 설치된 의존자(`brew uses --installed --recursive`)가 없고 `brew leaves`에 있으며 어디서도 참조되지 않는 것을 `brew uninstall`로 제안. 버전 붙은 formula는 `brew.allowVersionedRemoval: true`일 때만 후보 |
| `brew` | `{allowVersionedRemoval}`(기본 false) |
| `referenceRoots` | 참조 검사에 더할 파일·디렉터리. 기본: `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`, `~/.dori`, `~/.local/bin`, 셸 rc 파일. 텍스트 파일(512KB 이하, node_modules·.git 제외, 15초 제한)에 후보의 keg 이름이나 `opt`/`Cellar` 경로가 나오면 `referenced_by <파일>`로 제외. staleDirs는 `checkReferences: true`일 때 경로 자체를 검사 |
| `clones` | `{namePatterns, idleDays}`. 일회성 클론 탐지. 아래 참고 |
| `report.paths` / `childrenOf` / `top` | `report`가 잴 경로, 하위 디렉터리를 하나씩 잴 부모, 표시할 행 수 |

환경 변수: `SWEEPY_POLICY`, `SWEEPY_STATE_DIR`, `SWEEPY_VOID`, `SWEEPY_SCAN_TIMEOUT`(초), `SWEEPY_DU_TIMEOUT`(초, 기본 60), `SWEEPY_DU_CACHE_HOURS`(기본 24), `SWEEPY_INTERVAL`(초, install 때).

크기 측정(`du -sk`)은 프로세스 마감 시간 안에서만 돈다(macOS엔 `timeout`이 없다). 결과는 `du-cache.json`에 경로별로 남기고, 디렉터리 자체의 mtime이 그대로이고 `SWEEPY_DU_CACHE_HOURS`보다 젊으면 다시 재지 않는다(최상위 mtime은 깊은 곳의 변화를 못 보므로 나이 제한이 있다). 출력·제안·로그·history에 나가는 원격 URL 자격증명(`https://user:token@`)과 GitHub 토큰은 `***`로 가린다.

### cleaner

`detect`(argv)가 성공해야 도구가 있는 것으로 본다. `size`는 세 가지 중 하나다: `{cmd, pattern?}`(출력에서 크기를 읽음, `pattern`의 첫 그룹), `{du: [경로]}`, `{duOf: argv}`(명령이 출력한 경로를 du). `apply`는 도구의 prune 명령이고 sweepy가 직접 파일을 지우지 않는다. `shadow: true`인 cleaner는 `auto.enabled`가 켜져 있어도 history에 기록만 한다. 적용하면 cleaner마다 `estimated`(size)와 `measured`(적용 전후 Data 볼륨 여유 공간 차이)를 history에 남긴다. uv/pnpm/npm의 size는 캐시 전체 크기라서 prune으로 실제 회수되는 양의 상한이다.

기본 cleaner: brew(`brew cleanup --prune=30`), uv(`uv cache prune`), pnpm(`pnpm store prune`), npm(`npm cache verify`). 모두 auto + shadow로 시작한다.

docker(approve): Colima가 켜져 있을 때만(`colima status`). 크기는 `docker system df`의 Images·Build Cache RECLAIMABLE 합(SI 단위). 적용은 `docker builder prune -f` → `docker image prune -f`(dangling만) → `colima ssh -- sudo fstrim -av` 순서로, 앞 단계가 실패하면 멈춘다. fstrim이 돌려주는 VM 디스크 여유분은 추정치에 들어가지 않고 measured에만 나타난다.

### 세션 로그·구버전 (approve)

- `codex-sessions`, `claude-projects`: 30일 넘은 `.jsonl`을 압축. 기억 복구에 쓰라서 지우지 않는다(`zstd -d`로 되돌린다). 추정 회수량은 원본의 85%.
- `codex-releases`: `~/.codex/packages/standalone/releases` 중 `current`가 가리키는 것과 최신 1개 외.
- `pnpm-old-stores`: `pnpm store path`(현재 v11) 외의 예전 형식 store(v10, v3). `pnpm store prune`은 이것을 건드리지 않는다.
- `npx-cache`: 30일 넘게 안 쓴 `~/.npm/_npx/*`. `npm cache verify`는 이것을 치우지 않는다.

`apply`는 압축 직전에 파일이 여전히 오래되고 닫혀 있는지 다시 보고, 승인된 목록과 겹치는 것만 처리한다.

### 일회성 클론 (항상 approve, auto 금지)

이름 패턴(`-backup-YYYYMMDD`, `-prN-review` 등)이나 같은 origin을 가진 다른 클론이 있으면 의심 대상이다. origin마다 대표 클론 하나(origin 리포 이름과 같은 것, 없으면 최신 커밋)는 절대 제안하지 않는다. 제안 조건: `idleDays` 넘게 유휴, `git status` 깨끗, stash 0, 링크된 워크트리 없음, 모든 커밋이 원격에 있음(아니면 `git cherry`로 이미 upstream에 있거나 그 브랜치 PR이 MERGED — 스쿨시 머지 보완), 열린 PR 없음(`gh pr list --head`). origin이 없으면 제외하고 사람이 비교한다. 제안에는 지우면 사라질 ignored 파일 목록(`git status --ignored`, 예: `.env`)을 함께 담는다.

### 모델·앱 캐시·Homebrew (approve)

`staleDirs`의 추가 옵션: `match`(하위 이름 화이트리스트), `lastAccessDays`(안의 파일 중 가장 최근 atime 기준), `unlessRunning`(그 이름의 프로세스가 돌면 규칙 전체를 건너뜀), `parent`가 `/*`로 끝나면 각 하위마다 규칙 적용(`{name}` 치환).

- `hf-models`: `~/.cache/huggingface/hub/models--*` 중 60일 넘게 읽지 않은 것.
- `app-cache-aside`: `~/Library/Caches/Aside`, Aside가 꺼져 있을 때만. 다른 앱은 이름을 화이트리스트에 더해야 본다.
- `brew-old-kegs`: Cellar의 각 formula에서 `/opt/homebrew/opt/<name>`이 가리키는 버전 외(오래된 formula라 `brew cleanup`이 건너뛰는 구버전).

### 영상 산출물 (항상 approve)

`media` 정책의 `roots`, `scratchRoots`, `uploadResults`는 경로·glob 목록이다. 기본 범위는 `~/projects/*/{poc,out,renders,exports}`, `~/.dori/state/{downloads,research}`, `/tmp`의 미디어다. `mp4/mov/mkv/webm/m4a/mp3/wav`와 PNG 프레임을 찾고 기존 timed du로 크기를 잰다. `staleDays` 기본 3, `minBytes` 기본 1 MiB, `originalMinBytes` 기본 100 MiB이며 `enabled: false`로 끈다.

`trust-v1/v2/v3`, `biotokens-v10/v11/v12-hook`처럼 같은 부모·stem의 숫자 버전을 묶어 구버전을 제안한다. 버전 없는 폴더의 `frames/`, `phone-frames/`, `proxies/`, WAV·WebM·proxy 파일도 후보이며 scratch는 `staleDays`가 지나야 한다. `/tmp`는 바로 아래 파일만 본다.

`final/`, `delivery/`, `uploaded/`, `latest/`, 업로드 결과의 `sourceVideoPath`/`video`/`sourcePath`(결과가 가리키는 manifest 포함), 계열 최신 버전, git 추적 파일, 24시간 안에 바뀐 파일은 제외한다. 디렉터리는 하위 파일까지 확인한다. 후보 밖 저장소 텍스트의 절대·상대 경로 참조는 `referenced_by`로 제외하므로 `out/four-shorts-v7-ref/phone-ui.png`를 쓰는 템플릿이 남아 있으면 그 렌더를 제안하지 않는다. 심볼릭 링크·읽기 실패·검사 한도 초과는 보수적으로 제외한다. 참조 검사는 `.git`, `node_modules`, `.venv`, `target`, `.next`를 제외하며 텍스트 파일당 16 MiB, 전체 텍스트 128 MiB, 트리당 100,000개·15초 한도다.

`source-manifest.json`/`proxy-manifest.json`의 `originalFilename`, `driveId`, `bytes` 또는 `remoteBytes`가 이름·정확한 크기와 맞는 원본은 기본 제외한다. `--include-originals` 스캔에서만 원격 ID와 **needed for future edits** 경고를 담아 제안한다. 참조·업로드 보호는 이 플래그로 풀리지 않는다. 적용도 기존 `apply <id>` 재스캔·승인 흐름이며 원본은 같은 플래그가 필요하다. 미디어는 auto가 될 수 없다. 승인된 경로 제거는 staleDirs와 같은 방식이고 출처 `media`로 실측한다.

`dry-run media`는 제안·제외·총 bytes를 JSON으로, `report`는 이유·크기를 표로(`--json`은 `media` 필드), `status`는 inbox 미디어 상세를 보여 준다. 이 조회 명령은 apply를 호출하지 않는다.

### 추정 정확도

`apply`는 출처(cleaner id, archive id, staleDirs id, `clone`, `brew_dup`)마다 `estimated`와 `measured`(적용 전후 Data 볼륨 여유 공간 차이)를 history의 `measurements`에 남긴다. `sweepy status`의 `accuracy`가 출처별 횟수·합계·비율 중앙값을 보여 주고, 중앙값이 0.5 미만이면 `estimateOff: true`다(추정식을 고칠 때). 한 번에 여러 항목을 동시에 적용하면 다른 프로세스의 쓰기가 섭여 오차가 생긴다.

테스트: `bun test` (가짜 `du`/`void` 바이너리와 임시 디렉터리만 쓴다).

## 설치

1. Void CLI: [릴리스](https://github.com/eladbash/void/releases)의 `void-<버전>-aarch64-apple-darwin`을 `~/.local/bin/void`로 받고 sha256을 확인한다. Bun이 필요하다.
2. `bin/sweepy install` (등록 즉시 1회 실행). 리포를 옮기면 다시 `install`.
3. `sh scripts/doctor.sh`

에이전트가 Void를 직접 쓸 때의 전역 보호 경로는 `void/config.json`을 `~/Library/Application Support/com.void.app/config.json`으로 복사한다. sweepy 자신은 정책에서 만든 전용 설정만 쓴다.

## 운영하면서 알게 된 것

- **스캔 범위를 좁혀야 macOS 권한 대화상자가 안 뜬다.** launchd에서 실행된 void는 권한을 자기 이름으로 물어서, 홈 전체를 스캔하면 다운로드·데스크톱·사진 폴더 대화상자가 떠서 멈춘다(실측 4건). sweepy는 `roots`만 스캔해서 0건, 약 10초에 끝난다. 그래서 워크트리도 Void 대신 git으로 직접 찾는다.
- **Void의 `blocked_paths`는 계획에 그대로 나온다.** apply에서만 거부되므로 sweepy가 `protect`로 먼저 거른다.
- **보고된 회수량과 실제 증가량은 다르다.** pnpm·Bun은 APFS 복제로 블록을 공유한다. sweepy는 실측값만 기록한다.
- **경로로 직접 쓰이는 버전 formula를 지우면 서비스가 깨진다.** 2026-10-19 brew_dup approve로 `node@24`·`python@3.13`을 지웠는데 LaunchAgent plist와 `~/.dori` 스크립트가 `/opt/homebrew/opt/node@24/bin/node`를 직접 써서 Slack 브리지가 멈췄다. 그래서 참조 검사를 하고 버전 formula는 기본 제외한다.
- **Docker는 Colima 안에 있다.** 범위 밖이지만, `docker builder prune` 뒤에 `colima ssh -- sudo fstrim -av`를 해야 공간이 돌아온다.

## 제거

```sh
bin/sweepy uninstall
rm -rf ~/.local/state/sweepy
```
