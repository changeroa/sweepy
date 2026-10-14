디스크 감시 알림이다. gisul에서 void-disk-cleanup 스킬을 찾아 로드하고 그 절차를 따른다. 이번 실행은 보고만 한다: 삭제·plan apply 금지.
1. `/Users/iyen/.local/bin/void --json guard check`로 현재 여유 공간을 확인한다.
2. 후보 계획은 2분 제한으로 만든다: `perl -e 'alarm shift; exec @ARGV' 120 /Users/iyen/.local/bin/void --json plan --stale-days 14 -p /Users/iyen/projects -k node_modules -k target_dir -k framework_build_cache -k pycache_dir`. 시간 초과면 `log show --last 10m --style compact --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING"'`로 macOS 권한 대화상자 대기 여부를 확인해 그대로 보고한다.
3. 실행 중인 프로세스가 작업 디렉터리로 쓰는 프로젝트(`lsof -d cwd`)와 Void blocked_paths(~/Library/Application Support/com.void.app/config.json) 아래 항목은 후보에서 빼고 제외 목록으로 따로 적는다.
4. 보고: 여유 공간(%·GiB), 회수 가능 용량, 큰 항목 상위 10개, 제외 항목과 이유, plan id. 마지막 줄에 '정리하려면 "디스크 정리 승인"이라고 답장해 주세요'를 적는다. 승인 답장을 받으면 같은 조건으로 계획을 다시 만들고(계획은 1시간 뒤 만료), 이번 보고와 차이가 크면 다시 확인받은 뒤에만 apply한다.
