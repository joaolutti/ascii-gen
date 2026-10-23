# Project rules

## Branches

- `development` is the integration branch for new features and testing.
- `main` represents production. Promote completed, tested work from `development` to `main`.
- Create a branch for a spec from `development`; all issues belonging to that spec may share the branch.
- Separate branches for each issue within a spec are optional. Integrate completed spec work into `development`.

## Commits

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footers]
```

- Use `feat` for features and `fix` for bug fixes. Other types include `refactor`, `perf`, `docs`, `test`, `build`, `ci`, and `chore`.
- Mark breaking changes with `!` before the colon or a `BREAKING CHANGE:` footer.
- Use the contributor's configured Git identity for author and committer metadata. Do not use Codex or ChatGPT as authors or co-authors.
- Keep commit messages focused on the change. Do not append co-author lines, signatures, or AI attributions.
