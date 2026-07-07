# Phone Install — Zero-Assumed-Knowledge Walkthrough

Do this after `01-github-pages-setup.md` (you need the live Pages URL first). This is a one-time setup on the team phone; re-do "Add to Home Screen" only if the app is ever removed.

**Important: don't AirDrop the file to the phone.** AirDropping (or opening from Files app) an `.html` file on iOS opens a Quick Look preview, not Safari — no "Add to Home Screen" option shows up, and Quick Look doesn't run JavaScript at all, so the app never loads past the loading screen. Confirmed this the hard way in the first build session. The URL from GitHub Pages, opened in actual Safari, is the only reliable way in.

---

## 1. Open the app in Safari

On the team phone, open the **Safari** app (has to be Safari specifically — Add to Home Screen isn't available the same way in other browsers, and this phone almost certainly only has Safari on it anyway since it's freshly wiped).

Type the Pages URL from step 5 of the GitHub Pages walkthrough into the address bar — something like:

```
https://yourusername.github.io/kickball-walk-on/
```

Wait for "Loading walk-up songs…" to finish and the app to appear. If it hangs, you're either not actually in Safari, or there's a real bug — check with me.

## 2. Add to Home Screen

1. Tap the **Share** button (square with an arrow pointing up, in Safari's toolbar).
2. Scroll down and tap **Add to Home Screen**.
3. Confirm the name (defaults to the team name) and tap **Add**.
4. You should now see a home screen icon for the app. Tap it once to confirm it opens full-screen (no Safari address bar).

## 3. Phone settings (do these once, before the first game)

Open the **Settings** app:

- **Display & Brightness → Auto-Lock → Never.** This is the primary defense against the screen sleeping mid-game — more reliable than the app's own wake-lock trick, which isn't guaranteed to work on every iOS version.
- **Sounds & Haptics → Ringer and Alerts** — turn the volume up (or just use the physical volume buttons once the app is open and something's playing).
- **Ring/Silent switch → Ring** (the small switch on the phone's left edge — orange showing means Silent). **The silent switch completely mutes this app's audio** (confirmed on the team phone): it plays sound through the browser's Web Audio system, which iOS silences in Silent mode even though regular music apps keep playing. If the soundboard ever goes mysteriously quiet, check this switch first.
- **Focus → Do Not Disturb → On** (or swipe down from the top-right corner and tap the crescent moon). Stops notifications from popping up over the app mid-game.

## 4. Guided Access (locks the phone to just this app)

1. **Settings → Accessibility → Guided Access → toggle On.**
2. While you're there, tap **Passcode Settings → Set Guided Access Passcode** and set a simple one (write it down somewhere — you'll need it to exit Guided Access later). You can also enable "Face ID" or "Touch ID" here if you'd rather not type a passcode to exit, but this is a passcode-free phone so a simple numeric one is probably easiest for whoever's operating it.
3. Open the walk-on music app from the home screen.
4. **Triple-click the side button** (or Home button, if the phone has one). Guided Access should start — you'll see a yellow-ish border animation.
5. Tap **Start** in the top-right corner.

The phone is now locked into just this app — the Home button/gesture, Control Center, and notifications are all disabled until Guided Access is exited (triple-click again, enter the passcode, tap End).

## 5. Before every game

- Confirm the phone has enough battery (Guided Access + always-on screen will drain it faster than normal use).
- Confirm auto-lock is still set to Never (should persist, but worth a glance).
- **Check the ring/silent switch is on Ring** (no orange showing). Silent mode mutes the app entirely — see section 3.
- If you made roster changes since the last game, open the app once on Wi-Fi *before* Guided Access locks it in, so the service worker picks up the update (see the "Updating later" section of the GitHub Pages doc).
