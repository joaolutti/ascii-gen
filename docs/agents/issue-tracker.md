# Issue tracker: GitHub

Issues and specs live in GitHub Issues. Use the `gh` CLI.
Resolve the repository from the Git remote.

## Operations

- Create: `gh issue create --title "..." --body-file <path>`
- Read: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open`, adding label filters as needed.
- Comment: `gh issue comment <number> --body-file <path>`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

For multiline bodies, write the text to a temporary file and use
`--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the referenced issue.

## Pull requests as a triage surface

PRs as a request surface: no.
