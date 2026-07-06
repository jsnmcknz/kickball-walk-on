# GitHub Pages Setup — Zero-Assumed-Knowledge Walkthrough

Written 2026-07-06, first build session, because tonight's game made this urgent. This is the one-time setup; see `02-phone-install.md` for what happens on the phone after this is done.

**Before you start — a real tradeoff to know about:** GitHub's free plan only publishes Pages sites from **public** repositories, and the published site is publicly viewable by anyone with the URL regardless of plan — there's no way to make it truly private on a personal account (confirmed against GitHub's docs, 2026-07-06). That means the walk-up clips — real songs, base64-embedded in the page — will sit on a public, technically-discoverable URL. In practice: it won't be indexed by search engines (the page has a `noindex` tag) and nobody finds an unlisted GitHub Pages URL by accident, but "nobody will find it" isn't the same as "it's private." This is worth being aware of, not necessarily a blocker — you know your own risk tolerance here better than I do. I'm not a lawyer and this isn't legal advice.

---

## 1. Check whether you have git installed

Open **Terminal** (Applications → Utilities → Terminal, or Spotlight search "Terminal").

Type:
```
git --version
```
and press Return. If you see something like `git version 2.39.2`, you're set — skip to step 2. If you see an error, macOS will usually offer to install the Xcode Command Line Tools for you — click Install and wait for it to finish, then re-run the command above.

## 2. Create a GitHub account (skip if you already have one)

Go to **github.com/join** in your browser, pick a username, enter your email and a password, and follow the verification steps. Free accounts are all you need here.

## 3. Create a new (empty) repository

1. Once logged in, go to **github.com/new**.
2. **Repository name:** `kickball-walk-on` (or anything you like — it becomes part of the URL).
3. **Public** (this is required for free Pages hosting — see the callout above).
4. Leave "Add a README," "Add .gitignore," and "Choose a license" all **unchecked** — we're pushing an existing folder, not starting from scratch.
5. Click **Create repository**. GitHub will show you a page with setup commands — keep that tab open, you'll want the URL it shows (looks like `https://github.com/yourusername/kickball-walk-on.git`).

## 4. Push this project folder to that repository

Back in Terminal:

```
cd ~/Workspace/personal/kickball-walk-on
git init
git add .
git commit -m "Initial build"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/kickball-walk-on.git
git push -u origin main
```

Replace `YOURUSERNAME` with your actual GitHub username (or paste the exact URL GitHub showed you in step 3). The first push may open a browser window asking you to sign in to GitHub and authorize — that's normal, follow the prompts.

If `git push` asks for a username/password and rejects a normal password: GitHub retired password-based pushes a while back. When prompted, either let the browser sign-in flow complete (most common on a fresh setup) or, if it insists on a password prompt in Terminal, you'll need a "personal access token" instead of your account password — go to github.com → Settings → Developer settings → Personal access tokens → Generate new token (classic), check the "repo" box, generate it, and paste that token in as the password when asked. Flag this back to me if you hit it and I'll walk through the token step live.

## 5. Turn on GitHub Pages

1. On your repo's GitHub page, click **Settings** (top tab bar).
2. In the left sidebar, click **Pages**.
3. Under "Build and deployment" → **Source**, choose **Deploy from a branch**.
4. Under **Branch**, choose **main** and **/ (root)**, then **Save**.
5. GitHub will show a message like "Your site is live at `https://yourusername.github.io/kickball-walk-on/`" — this can take 1-2 minutes the first time. Refresh the Pages settings page if it doesn't appear immediately.

That URL is what you'll open on the phone — see `02-phone-install.md`.

## 6. Updating later (mid-season roster changes, new clips, etc.)

```
cd ~/Workspace/personal/kickball-walk-on
python3 build.py
git add .
git commit -m "Update roster"
git push
```

Then on the phone: open the home-screen app once **while on Wi-Fi** so it fetches the new version and re-caches it for offline use at the next game.
