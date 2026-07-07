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

**Guided Access is optional.** Game 1 (2026-07-06) showed its friction is real: exiting needs triple-click + passcode + an extra tap, and any settings mistake compounds mid-game. On a wiped, passcode-free phone operated by your own teammates, running *without* Guided Access is a legitimate choice — the risks are an accidental Home press (the app treats that as a clean stop; one tap reopens it) and teammates wandering off into Settings. If you skip it, sections 3 and 5 still apply in full. If you use it, the settings below remove the friction that bit at game 1.

1. **Settings → Accessibility → Guided Access → toggle On.**
2. **Settings → Accessibility → Guided Access → Display Auto-Lock → Never.** ⚠️ This is a *separate* setting from the system Auto-Lock in section 3, and it **overrides it while Guided Access is running** — this is why the phone slept between innings at game 1 despite system Auto-Lock being Never. Both must be set.
3. While you're there, tap **Passcode Settings → Set Guided Access Passcode**. A passcode (or Face ID/Touch ID) is required to exit — iOS has no "none" option, and biometrics need a device passcode, which this phone deliberately doesn't have. So set the lowest-friction passcode possible: something like `111111` that any teammate can type without thinking. Write it on a piece of tape on the back of the phone if you want — security is not the point here.
4. Open the walk-on music app from the home screen.
5. **Triple-click the side button** (or Home button, if the phone has one). Guided Access should start — you'll see a yellow-ish border animation.
6. On that start screen, tap **Options** (bottom-left) and turn **Volume Buttons → On**. Without this, the hardware volume buttons are dead inside Guided Access (another game-1 lesson — the only way to change volume was exiting the mode entirely).
7. Tap **Start** in the top-right corner.

The phone is now locked into just this app — the Home button/gesture, Control Center, and notifications are all disabled until Guided Access is exited (triple-click again, enter the passcode, tap End).

## 5. Before every game

- Confirm the phone has enough battery (always-on screen drains faster than normal use). **Battery tip:** the app needs zero network at the park, so turn on **Airplane Mode, then re-enable Bluetooth** (Control Center: tap Airplane, then tap Bluetooth back on for the speaker) — the cellular/Wi-Fi radios hunting for signal are a bigger drain than the screen.
- Confirm **both** auto-lock settings are still Never: Display & Brightness → Auto-Lock, *and* Accessibility → Guided Access → Display Auto-Lock (if using Guided Access). Either one alone lets the screen sleep.
- **Check the ring/silent switch is on Ring** (no orange showing). Silent mode mutes the app entirely — see section 3.
- If you made roster changes since the last game, open the app once on Wi-Fi *before* Guided Access locks it in, so the service worker picks up the update (see the "Updating later" section of the GitHub Pages doc). Do this before Airplane Mode, obviously.

## 6. If audio ever seems dead

As of the 2026-07-07 build the app self-heals a wedged audio engine: if the phone slept or the app was backgrounded and a play tap would previously do nothing, the same tap now rebuilds the audio engine and plays. No reboot, no re-adding to the home screen. If a tap ever *does* fall silent, tap once more — the app's internal watchdog also auto-retries once within a second.

**Field diagnosis:** tap the team wordmark (top-left) 5 times quickly to toggle a tiny one-line status readout at the bottom of the screen (audio state, rebuild count, last event). Tap 5 times again to hide it. If something goes wrong at a game, a photo of that line tells us exactly what happened.
