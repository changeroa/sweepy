# sweepy

개발 디스크에서 두 가지만 치운다: **빌드 산출물**(`node_modules`, `target`, `.next`, `__pycache__`)과 **git 워크트리**. 무엇을 지워도 되는지는 정책 파일이 정하고, sweepy는 제안을 만들고 승인된 것만 적용한다. 탐지·삭제는 [Void](https://github.com/eladbash/void)와 git이 하고, 사람과의 대화는 sweepy 밖(에이전트 세션)이 한다.

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
- **Docker는 Colima 안에 있다.** 범위 밖이지만, `docker builder prune` 뒤에 `colima ssh -- sudo fstrim -av`를 해야 공간이 돌아온다.

## 제거

```sh
bin/sweepy uninstall
rm -rf ~/.local/state/sweepy
```
