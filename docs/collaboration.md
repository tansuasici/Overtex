# Working with co-authors

Overtex has no server and no account. Each co-author keeps a copy of the project, and the copies are kept in step with **git**, through a host you already use: GitHub, GitLab, Codeberg, or a server of your own. Overtex does the git work for you with a few commands. [Lesson 7](tutorial/07-co-authors.md) walks through the basics.

## Share Changes and Get Changes

| Command | Does |
| --- | --- |
| **Overtex: Share Changes** | Saves all your edits as one version, with an optional short description (an empty one becomes "Update"), gets your co-authors' versions, combines them with yours, and sends the result to your online copy. |
| **Overtex: Get Changes** | Only gets your co-authors' versions and combines them with yours. |

The status bar shows how many versions there are to get (↓) and to send (↑), and a dot for edits not shared yet. Click it to share.

**Routine:** Get Changes before you start writing; Share Changes when you have done some work.

### Your copy and theirs

Share Changes sends only to **your own copy**: the remote you pushed to before, or `origin`. A co-author's copy is only read from. So each of you can keep a copy on a different host, one on GitHub and one on GitLab, and get changes from the other's.

### Conflicts

When you and a co-author changed the same lines, nothing is sent. The file opens with both versions marked so you can pick one; then share again.

### Build files

The first time build files such as `main.aux` or the built `main.pdf` are among the changes, Overtex offers to add them to `.gitignore`, since each co-author builds them. PDF figures are never left out.

### First time

Share Changes uses VS Code's built-in Git and its sign-in.

- A folder without git is offered a one-click setup.
- A folder with no online copy yet is offered a private copy on GitHub or GitLab.

## Invite Co-author (GitHub)

**Overtex: Invite Co-author** asks for a GitHub username and invites that person to edit your copy on GitHub; GitHub emails them the invitation.

If your copy is not on GitHub yet, Overtex first makes a private repository under your account (you pick the name), saves your edits as a version and sends the project there; Share Changes goes to it from then on. An existing remote stays as a copy you get changes from.

You sign in with VS Code's own GitHub account (the Accounts menu). Inviting needs you to own the repository or be an admin of it.

## Invite codes

Invite codes are for a co-author who keeps their own copy, on GitHub, GitLab or another host, without either of you needing access to the other's account.

1. **You** run **Overtex: Create Invite Code**. It copies a code with your copy's address and a new key made for this invite. Nothing is sent anywhere. Send the code to your co-author.
2. **Your co-author** runs **Overtex: Enter Invite Code** and pastes it. Overtex gives your key read-only access to their copy (a deploy key), adds your copy as one they get changes from, and copies an **answer code** for them to send back. If their project is not online yet, it first makes a private copy, on GitHub or GitLab, wherever they already keep their projects, and asks them to confirm. An empty project starts from yours.
3. **You** run **Enter Invite Code** with the answer code.

From then on Share Changes and Get Changes work both ways, each of you sending only to your own copy.

A code is for one co-author: make a new one for each.

### How it stays safe

- Each invite has its own key, kept in the project's `.git/overtex` folder and used only for that co-author's copy.
- The project's ssh settings pin GitHub's and GitLab's host keys, so git talks to those servers and no other.
- GitHub uses VS Code's GitHub sign-in. GitLab asks once for an access token with the `api` scope, kept in VS Code's secret storage and never put in an address.

### Servers of your own

A copy can live on a GitLab server of your own, a university's or a company's: choose **Other GitLab Server…** and give its web address (https; a sub-path such as `https://example.edu/gitlab` is fine).

Overtex asks that server for its ssh address and port, and puts the server's host key in your codes. The key is taken from your own `known_hosts` or, the first time, shown to you as a SHA256 fingerprint to confirm. Each server's token is kept on its own and sent only to the server it was entered for.

**Other Server…** also offers Codeberg and Gitea or Forgejo servers of your own. Make their access token under **Settings > Applications**, with "repository" and "user" set to Read and Write.

Invite codes need `ssh-keygen`, which comes with git.

## Notes, Track Changes and history

- [Notes on the text](reviewing.md#notes-on-the-text) are saved in `.overtex/notes.json` and shared with Share Changes.
- [Track Changes](reviewing.md#track-changes) marks your edits for a co-author to accept or reject.
- [History](reviewing.md#history) is kept on your computer only and is not shared.

## Overleaf

Overtex works on local files and never connects to Overleaf. To work on an Overleaf project from VS Code, add the separate [Overleaf Connect](https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect) extension, which uses Overleaf's Git integration. Overleaf Connect syncs the project and waits while a build runs; Overtex builds and previews it.
