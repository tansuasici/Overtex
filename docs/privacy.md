# Privacy and security

Overtex works on files on your computer. It has no server, no account and no telemetry, and it contains no AI.

## What uses the network

Only these features go online, and only when you run them:

| Feature | Talks to |
| --- | --- |
| Add Citation from DOI or arXiv, Add Paper | doi.org (arXiv IDs too, through their DOI) |
| Search Papers | api.openalex.org and export.arxiv.org get the words you search for; doi.org gets the papers you add |
| Check Bibliography | doi.org (Crossref and DataCite) and the arXiv API |
| Download Paper PDF from arXiv | arxiv.org |
| Open Paper Page | Your web browser opens the paper's page |
| Share Changes, Get Changes | Your project's git remotes only |
| Invite Co-author | api.github.com, and your new repository through git |
| Create and Enter Invite Code | api.github.com, gitlab.com, codeberg.org or the server you named |

These stay on your computer:

| Feature | Talks to |
| --- | --- |
| Cite from Zotero | Zotero on your computer (`overtex.zotero.url`) |
| Check Spelling and Grammar (Harper) | Nothing: it runs inside Overtex |
| Check Spelling and Grammar (LanguageTool) | Only the server in `overtex.grammar.url`, your own computer unless you change it |

Builds may go online in two cases you choose: [Tectonic](building.md#tectonic) downloads the TeX support files a document needs on its first build, and [Docker](building.md#docker) pulls its image on the first build. The Docker build itself runs with the network off.

## Sign-ins and keys

- GitHub uses VS Code's own GitHub sign-in.
- GitLab, Codeberg, Gitea and Forgejo tokens are kept in VS Code's secret storage, sent only to the server they were entered for, and never put in an address.
- Invite-code keys are kept in the project's `.git/overtex` folder, one per co-author.

## Workspace Trust

A LaTeX project can run programs: latexmk reads a project's `.latexmkrc`, which can run any command. So in an [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust), Overtex does not build, clean, compare versions, share or get changes, or start TexLab.

It also ignores these settings when they come from the workspace, since a project could use them to run programs or send your text elsewhere:

- `overtex.latex.tool`, `overtex.latex.extraArgs`
- `overtex.latex.latexmkPath`, `overtex.tectonic.path`, `overtex.docker.path`, `overtex.synctex.path`, `overtex.latexdiff.path`, `overtex.texlab.path`
- `overtex.docker.image` (an image is code that runs on your machine)
- `overtex.zotero.url`, `overtex.grammar.url`

Opening an existing PDF still works. Trust the folder, when you know where it came from, to build.
