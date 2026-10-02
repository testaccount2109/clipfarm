# Repository change history

- Check `git status` before editing so existing user changes are preserved.
- After completing and reviewing each cohesive user-requested change, create one descriptive Git commit. Keep unrelated work in separate commits.
- Do not amend or rewrite existing commits. Use `git revert <commit>` to undo a committed change while keeping the history.
- Do not commit captures, logs, build output, dependencies, local environment files, credentials, or account/session data; keep `.gitignore` current.
- Before committing, review `git diff --check`, the changed-file list, and the staged diff for accidental private data.
